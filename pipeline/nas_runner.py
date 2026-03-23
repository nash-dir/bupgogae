"""
NAS Runner — Date-Modulus 스케줄러 + 풀 DB 배포.

매일 ~1,420건의 균일 API 호출로 master.db를 갱신하고,
풀 DB를 db.json으로 덤프한 뒤 R2에 업로드한다.

스케줄링:
  Tier 1 (1948~1999): date_offset % 56 == today_serial % 56 → ~366일/day
  Tier 2 (2000~제작년): date_offset % 15 == today_serial % 15 → ~609일/day
  Tier 3 (작년~오늘): 전량 스캔                                → ~445일/day
  합계: ~1,420건/day (~21분)

Usage:
  python nas_runner.py              # 자동 스캔 + 풀 DB 배포
  python nas_runner.py --plan       # 오늘 스캔 계획만 출력 (dry-run)
  python nas_runner.py --data-dir ./testdata

환경변수 (.env):
  BUPGOGAE_API_KEY
  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2_BUCKET / CF_ACCOUNT_ID
  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID  (선택, 매 실행 리포트)
"""

import argparse
import gzip
import json
import math
import os
import random
import sys
import requests as _requests
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, date
from pathlib import Path

# 의존성 (같은 디렉토리)
from api import fetch_xml_safe, get_text  # noqa: E402
from compress import COURT_CODE_MAP  # noqa: E402
from master_db import MasterDB  # noqa: E402

# ── 설정 ──
DELAY_MIN, DELAY_MAX = 0.8, 1.0

# Date Serial: 1900-01-01 = 1 (Excel 호환)
SERIAL_EPOCH = date(1900, 1, 1)

# Tier 경계
TIER1_START = date(1948, 8, 15)  # 정부수립일
TIER1_END   = date(1999, 12, 31)
TIER1_MOD   = 56

TIER2_START = date(2000, 1, 1)
# TIER2_END = 작년 12/31 (동적)
TIER2_MOD   = 15

# TIER3_START = 올해 1/1 (동적)


# ════════════════════════════════════════════════════════════
# Date-Modulus 스케줄러
# ════════════════════════════════════════════════════════════

def date_serial(d: date) -> int:
    """1900-01-01 = 1 기준 Date Serial Number."""
    return (d - SERIAL_EPOCH).days + 1


def get_today_scan_ranges(today: date | None = None) -> list[tuple[str, str]]:
    """오늘 스캔할 날짜 범위 목록 반환.

    Returns:
        [(start_date, end_date), ...] — YYYYMMDD 문자열
        T1/T2: 넓은 윈도우 (1년/1월 단위)
        T3: 기존과 동일 (1일 단위)
    """
    if today is None:
        today = date.today()

    today_ser = date_serial(today)
    this_year = today.year
    year_before_last = this_year - 2  # 제작년
    tier3_start = date(this_year - 1, 1, 1)  # 작년 1/1부터

    ranges = []

    # Tier 1: 1948~1999 — 연 단위 윈도우 (year_offset % 56)
    # 52년 / mod 56 → 하루 0~1년 스캔
    bucket1 = today_ser % TIER1_MOD
    for year in range(TIER1_START.year, TIER1_END.year + 1):
        year_offset = year - TIER1_START.year
        if year_offset % TIER1_MOD == bucket1:
            ranges.append((f"{year}0101", f"{year}1231"))

    # Tier 2: 2000~제작년 — 월 단위 윈도우 (month_offset % 15)
    # ~300월 / mod 15 → 하루 ~20월 스캔
    bucket2 = today_ser % TIER2_MOD
    tier2_end = date(year_before_last, 12, 31)
    year, month = 2000, 1
    month_idx = 0
    while True:
        start = date(year, month, 1)
        if start > tier2_end:
            break
        if month == 12:
            next_start = date(year + 1, 1, 1)
        else:
            next_start = date(year, month + 1, 1)
        end = min(next_start - timedelta(days=1), tier2_end)

        if month_idx % TIER2_MOD == bucket2:
            ranges.append((start.strftime("%Y%m%d"), end.strftime("%Y%m%d")))

        month_idx += 1
        year = next_start.year
        month = next_start.month

    # Tier 3: 작년~오늘 (전량, 일 단위)
    d = tier3_start
    while d <= today:
        ds = d.strftime("%Y%m%d")
        ranges.append((ds, ds))
        d += timedelta(days=1)

    return ranges


def scan_plan_summary(ranges: list[tuple[str, str]], today: date) -> dict:
    """스캔 계획 통계."""
    tier1 = [r for r in ranges if r[0] < "20000101"]
    tier2 = [r for r in ranges if "20000101" <= r[0] < f"{today.year - 1}0101"]
    tier3 = [r for r in ranges if r[0] >= f"{today.year - 1}0101"]

    return {
        "total": len(ranges),
        "tier1": len(tier1),
        "tier2": len(tier2),
        "tier3": len(tier3),
        "est_minutes": round(len(ranges) * 0.9 / 60, 1),
    }


# ════════════════════════════════════════════════════════════
# 파이프라인 긴급 알림
# ════════════════════════════════════════════════════════════

def send_pipeline_alert(source: str, message: str):
    """파이프라인 에러 시 텔레그램으로 즉시 알림."""
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")

    if not bot_token or not chat_id:
        print(f"⚠️ Telegram 미설정 — {source} 알림 스킵")
        return

    text = (
        f"🚨 *법고개 Circuit Breaker*\n"
        f"`{date.today()}` | *{source}*\n\n"
        f"{message}"
    )
    try:
        resp = _requests.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "Markdown"},
            timeout=10,
        )
        if resp.status_code == 200:
            print(f"📨 텔레그램 긴급 알림 전송 ({source})")
        else:
            print(f"⚠️ 텔레그램 전송 실패: {resp.status_code}")
    except Exception as e:
        print(f"⚠️ 텔레그램 전송 실패: {e}")


# ════════════════════════════════════════════════════════════
# API 크롤링
# ════════════════════════════════════════════════════════════

def fetch_cases_for_range(date_range: str) -> list[dict]:
    """날짜(범위) 판례 수집.

    Args:
        date_range: 단일 날짜 'YYYYMMDD' 또는 범위 'YYYYMMDD~YYYYMMDD'
    """
    cases = []
    xml_content = fetch_xml_safe(date_range, page=1)
    if not xml_content:
        return cases
    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError:
        return cases

    for item in root.findall("prec"):
        cases.append({
            "serial": get_text(item, "판례일련번호"),
            "case_name": get_text(item, "사건명"),
            "case_number": get_text(item, "사건번호"),
            "date": get_text(item, "선고일자"),
            "court": get_text(item, "법원명"),
        })

    total_cnt_node = root.find("totalCnt")
    total_cnt = int(total_cnt_node.text) if total_cnt_node is not None else 0
    total_pages = math.ceil(total_cnt / 100)

    for p in range(2, total_pages + 1):
        time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
        page_xml = fetch_xml_safe(date_range, page=p)
        if not page_xml:
            continue
        try:
            page_root = ET.fromstring(page_xml)
        except ET.ParseError:
            continue
        items = page_root.findall("prec")
        if not items:
            break  # 서버 데이터 변동 등으로 빈 페이지 → 조기 종료
        for item in items:
            cases.append({
                "serial": get_text(item, "판례일련번호"),
                "case_name": get_text(item, "사건명"),
                "case_number": get_text(item, "사건번호"),
                "date": get_text(item, "선고일자"),
                "court": get_text(item, "법원명"),
            })
    return cases


# ════════════════════════════════════════════════════════════
# 헌재결정례 크롤링 (sort=efdes, 듀얼존 스케줄)
# ════════════════════════════════════════════════════════════

# 헌재결정례는 date 파라미터를 지원하지 않으므로,
# sort=efdes(종국일자 내림차순) + 듀얼존 페이지 스캔:
#   Zone A (1~10):  매일 스캔 — 최신 ~1,000건, 신규분 즉시 반영
#   Zone B (11~):   mod 15 — 과거 ~36,400건, 15일 1회전
#
# 최초 실행(DB에 D-prefix없음): 전량 크롤링 (~6분)

DETC_DAILY_PAGES = 10                # Zone A (매일)
DETC_MOD = 15                        # Zone B 분할 주기
DETC_FIRST_DATE = date(1988, 11, 24) # 최초 헌재 결정일


def get_detc_pages_for_today(today: date) -> list[int]:
    """오늘 스캔할 detc 페이지 목록 반환 (1-indexed).

    Zone A: 1~10 (매일)
    Zone B: 11+ (mod 15)
    """
    today_ser = date_serial(today)
    bucket = today_ser % DETC_MOD

    # Zone A: 매일
    pages = list(range(1, DETC_DAILY_PAGES + 1))

    # Zone B: mod 15
    max_pages = 400  # 37,407건 / 100 + 여유
    for p in range(DETC_DAILY_PAGES + 1, max_pages + 1):
        if (p - DETC_DAILY_PAGES - 1) % DETC_MOD == bucket:
            pages.append(p)

    return pages


def _fetch_detc_page(page: int) -> list[dict]:
    """단일 detc 페이지 수집 (sort=efdes)."""
    xml_content = fetch_xml_safe(
        target="detc", query="*", page=page, sort="efdes",
    )
    if not xml_content:
        return []
    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError:
        return []

    items = root.findall("Detc")
    cases = []
    for item in items:
        raw_serial = get_text(item, "헌재결정례일련번호")
        if not raw_serial:
            continue
        cases.append({
            "serial": f"D{raw_serial}",
            "case_name": get_text(item, "사건명"),
            "case_number": get_text(item, "사건번호"),
            "date": get_text(item, "종국일자"),
            "court": "헌법재판소",
        })
    return cases


def crawl_detc_pages(pages: list[int]) -> list[dict]:
    """지정된 페이지들만 스캔 (sort=efdes)."""
    cases = []
    for page in pages:
        page_cases = _fetch_detc_page(page)
        if not page_cases and page > DETC_DAILY_PAGES:
            break  # Zone B에서 빈 페이지 → 끝
        cases.extend(page_cases)
        time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
    return cases


def crawl_detc_full() -> list[dict]:
    """헌재결정례 전량 수집 (최초 실행 시 1회, sort=efdes)."""
    cases = []
    page = 1
    while True:
        page_cases = _fetch_detc_page(page)
        if not page_cases:
            break
        cases.extend(page_cases)
        if page % 50 == 0:
            print(f"  [detc] {page}페이지, {len(cases):,}건")
        page += 1
        time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
    return cases


# ════════════════════════════════════════════════════════════
# 조세심판원 크롤링 (sort=efdes, 듀얼존 스케줄)
# ════════════════════════════════════════════════════════════

# target=ttSpecialDecc, ~139,000건, ~1,391페이지
# Zone A (1~10):  매일 — 최신 ~1,000건
# Zone B (11~):   mod 15 — 15일 1회전

TAX_DAILY_PAGES = 10
TAX_MOD = 15


def get_tax_pages_for_today(today: date) -> list[int]:
    """오늘 스캔할 조세심판 페이지 목록 (1-indexed)."""
    today_ser = date_serial(today)
    bucket = today_ser % TAX_MOD

    pages = list(range(1, TAX_DAILY_PAGES + 1))
    max_pages = 1500  # 139,062건 / 100 + 여유
    for p in range(TAX_DAILY_PAGES + 1, max_pages + 1):
        if (p - TAX_DAILY_PAGES - 1) % TAX_MOD == bucket:
            pages.append(p)
    return pages


def _fetch_tax_page(page: int) -> list[dict]:
    """단일 조세심판원 페이지 수집 (sort=efdes)."""
    xml_content = fetch_xml_safe(
        target="ttSpecialDecc", query="*", page=page, sort="efdes",
    )
    if not xml_content:
        return []
    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError:
        return []

    cases = []
    for item in root.findall("decc"):
        raw_serial = get_text(item, "특별행정심판재결례일련번호")
        if not raw_serial:
            continue
        cases.append({
            "serial": f"T{raw_serial}",  # T prefix
            "case_name": get_text(item, "사건명"),
            "case_number": f"조심 {get_text(item, '청구번호')}",
            "date": get_text(item, "의결일자"),
            "court": "조세심판원",
        })
    return cases


def crawl_tax_pages(pages: list[int]) -> list[dict]:
    """지정된 페이지들만 스캔 (sort=efdes)."""
    cases = []
    for page in pages:
        page_cases = _fetch_tax_page(page)
        if not page_cases and page > TAX_DAILY_PAGES:
            break
        cases.extend(page_cases)
        time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
    return cases


def crawl_tax_full() -> list[dict]:
    """조세심판원 전량 수집 (최초 실행 시 1회, sort=efdes)."""
    cases = []
    page = 1
    while True:
        page_cases = _fetch_tax_page(page)
        if not page_cases:
            break
        cases.extend(page_cases)
        if page % 100 == 0:
            print(f"  [tax] {page}페이지, {len(cases):,}건")
        page += 1
        time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
    return cases


# ════════════════════════════════════════════════════════════
# 풀 DB 덤프
# ════════════════════════════════════════════════════════════

def _write_gzipped_json(payload: dict, output_path: str) -> float:
    """딥셔너리를 gzip JSON으로 저장. 파일 크기(MB) 반환."""
    json_bytes = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    gz_path = output_path + ".gz" if not output_path.endswith(".gz") else output_path
    os.makedirs(os.path.dirname(gz_path) or ".", exist_ok=True)

    with gzip.open(gz_path, "wb", compresslevel=9) as f:
        f.write(json_bytes)

    raw_path = gz_path.replace(".gz", "")
    with open(raw_path, "wb") as f:
        f.write(json_bytes)

    gz_mb = os.path.getsize(gz_path) / (1024 * 1024)
    raw_mb = os.path.getsize(raw_path) / (1024 * 1024)
    print(f"  📄 {os.path.basename(raw_path)} ({raw_mb:.2f} MB raw, {gz_mb:.2f} MB gzip)")
    return gz_mb


def export_split_db(db: MasterDB, data_dir: str) -> tuple[float, float, float]:
    """master.db → Core(db.json.gz) + DLC(db_tax.json.gz) + DLC(db_patent.json.gz) 분리 덤프.

    Returns: (core_gz_mb, tax_gz_mb, patent_gz_mb)
    """
    version = datetime.now().strftime("%Y%m%d")

    # Core: 판례 + 헌재
    core_data, core_skip = db.export_core()

    # DLC: 조세심판
    tax_data, tax_skip = db.export_tax()

    # DLC: 특허심판
    patent_data, patent_skip = db.export_kipris()

    # 압축 후 확정된 court_code_map (auto-assigned 포함)
    court_map = dict(COURT_CODE_MAP)  # name → code

    core_mb = _write_gzipped_json({
        "version": version,
        "total": len(core_data),
        "keys": len(core_data),
        "cases": core_data,
        "court_code_map": court_map,
    }, os.path.join(data_dir, "db.json"))

    tax_mb = _write_gzipped_json({
        "version": version,
        "total": len(tax_data),
        "keys": len(tax_data),
        "cases": tax_data,
        "court_code_map": court_map,
    }, os.path.join(data_dir, "db_tax.json"))

    patent_mb = _write_gzipped_json({
        "version": version,
        "total": len(patent_data),
        "keys": len(patent_data),
        "cases": patent_data,
    }, os.path.join(data_dir, "db_patent.json"))

    print(f"  └ Core: {len(core_data):,}건, DLC(Tax): {len(tax_data):,}건, "
          f"DLC(Patent): {len(patent_data):,}건, 법원: {len(court_map)}개")
    return core_mb, tax_mb, patent_mb


# ════════════════════════════════════════════════════════════
# Main
# ════════════════════════════════════════════════════════════

def main():
    default_data_dir = os.environ.get("DATA_DIR", "/app/data")

    parser = argparse.ArgumentParser(description="NAS Date-Modulus Runner")
    parser.add_argument("--plan", action="store_true",
                        help="스캔 계획만 출력 (dry-run)")
    parser.add_argument("--data-dir", default=default_data_dir,
                        help=f"Data directory (default: {default_data_dir})")
    args = parser.parse_args()

    data_dir = args.data_dir
    master_db_path = os.path.join(data_dir, "master.db")
    today = date.today()

    # 스캔 계획
    scan_ranges = get_today_scan_ranges(today)
    summary = scan_plan_summary(scan_ranges, today)

    # 헌재/조세심판 스케줄 계산
    detc_pages = get_detc_pages_for_today(today)
    tax_pages = get_tax_pages_for_today(today)

    print("=" * 55)
    print(f"  🚀 NAS Runner (Range-Modulus)")
    print(f"     날짜: {today}")
    print(f"     Serial: {date_serial(today)}")
    print(f"     판례: {summary['total']:,}건"
          f" (T1:{summary['tier1']} T2:{summary['tier2']} T3:{summary['tier3']})")
    print(f"     헌재: {len(detc_pages)}페이지 (mod {DETC_MOD})")
    print(f"     조세: {len(tax_pages)}페이지 (mod {TAX_MOD})")
    print(f"     예상: ~{summary['est_minutes']}분")
    print("=" * 55)

    if args.plan:
        print(f"\n📋 판례 스캔 계획 ({len(scan_ranges)}건):")
        for i, (s, e) in enumerate(scan_ranges[:20]):
            if s == e:
                print(f"  {i+1:4d}. {s[:4]}-{s[4:6]}-{s[6:]}")
            else:
                print(f"  {i+1:4d}. {s[:4]}-{s[4:6]}-{s[6:]} ~ {e[:4]}-{e[4:6]}-{e[6:]}")
        if len(scan_ranges) > 20:
            print(f"  ... ({len(scan_ranges) - 20}건 생략)")
        print(f"\n📜 헌재 스캔: {len(detc_pages)}페이지 {detc_pages[:5]}...")
        print(f"💰 조세 스캔: {len(tax_pages)}페이지 {tax_pages[:5]}...")
        return

    # 환경변수 검증
    api_key = os.environ.get("BUPGOGAE_API_KEY", "")
    if not api_key or api_key == "test":
        print("❌ BUPGOGAE_API_KEY 미설정")
        sys.exit(1)

    now = datetime.now()

    # Master DB 열기
    db = MasterDB(master_db_path)
    before = db.count()
    print(f"\n📊 Master DB: {before:,}건")

    # 크롤링
    total_ins, total_upd, total_skip, errors = 0, 0, 0, 0
    for i, (start_date, end_date) in enumerate(scan_ranges):
        if start_date == end_date:
            display = f"{start_date[:4]}-{start_date[4:6]}-{start_date[6:]}"
        else:
            display = (f"{start_date[:4]}-{start_date[4:6]}-{start_date[6:]} ~ "
                       f"{end_date[:4]}-{end_date[4:6]}-{end_date[6:]}")
        pct = (i + 1) / len(scan_ranges) * 100

        if (i + 1) % 50 == 0 or i == 0:
            print(f"  [{i+1:4d}/{len(scan_ranges)}] {display} ({pct:.0f}%)")

        try:
            date_param = start_date if start_date == end_date else f"{start_date}~{end_date}"
            raw = fetch_cases_for_range(date_param)
            if raw:
                ins, upd, skp = db.upsert_raw(raw)
                total_ins += ins
                total_upd += upd
                total_skip += skp
                if ins > 0:
                    print(f"  [{i+1:4d}/{len(scan_ranges)}] {display}"
                          f"  +{ins} 신규, ={upd} 갱신, -{skp} 스킵")
        except Exception as e:
            errors += 1
            print(f"  [{i+1:4d}/{len(scan_ranges)}] {display}  ❌ {e}")

        time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))

    after_prec = db.count()
    prec_delta = after_prec - before
    print(f"\n📊 Master DB (판례): {after_prec:,}건 (Δ {prec_delta:+,})")

    # 헌재결정례 크롤링 — 최초 실행 감지
    has_detc = db.conn.execute(
        "SELECT 1 FROM cases WHERE serial LIKE 'D%' LIMIT 1"
    ).fetchone()

    if not has_detc:
        print(f"\n📜 헌재결정례 최초 실행 — 전량 크롤링")
        detc_cases = crawl_detc_full()
    else:
        print(f"\n📜 헌재결정례 스캔 ({len(detc_pages)}페이지, mod {DETC_MOD})")
        detc_cases = crawl_detc_pages(detc_pages)

    detc_ins, detc_upd, detc_skip = 0, 0, 0
    if detc_cases:
        detc_ins, detc_upd, detc_skip = db.upsert_raw(detc_cases)
        print(f"  헌재: {len(detc_cases):,}건 수집"
              f" → +{detc_ins} 신규, ={detc_upd} 갱신, ⛔{detc_skip} 스킵")

    # 조세심판원 크롤링 — 최초 실행 감지
    has_tax = db.conn.execute(
        "SELECT 1 FROM cases WHERE serial LIKE 'T%' LIMIT 1"
    ).fetchone()

    if not has_tax:
        print(f"\n💰 조세심판원 최초 실행 — 전량 크롤링")
        tax_cases = crawl_tax_full()
    else:
        print(f"\n💰 조세심판원 스캔 ({len(tax_pages)}페이지, mod {TAX_MOD})")
        tax_cases = crawl_tax_pages(tax_pages)

    tax_ins, tax_upd, tax_skip = 0, 0, 0
    if tax_cases:
        tax_ins, tax_upd, tax_skip = db.upsert_raw(tax_cases)
        print(f"  조세: {len(tax_cases):,}건 수집"
              f" → +{tax_ins} 신규, ={tax_upd} 갱신, ⛔{tax_skip} 스킵")
    after = db.count()
    delta = after - before
    print(f"\n📊 Master DB (통합): {after:,}건 (Δ {delta:+,})")

    # 풀 DB 덤프 (Core + DLC 분리)
    print(f"\n📦 DB 덤프 (Core + DLC)")
    core_mb, tax_mb, patent_mb = export_split_db(db, data_dir)
    db.close()

    # R2 업로드
    r2_vars = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
               "R2_BUCKET", "CF_ACCOUNT_ID"]
    missing_r2 = [v for v in r2_vars if not os.environ.get(v)]

    if missing_r2:
        print(f"\n⚠️ R2 변수 누락 ({', '.join(missing_r2)}) — 업로드 스킵")
    else:
        from upload_r2 import upload_db_to_r2  # noqa: E402
        upload_db_to_r2(os.path.join(data_dir, "db.json.gz"))
        upload_db_to_r2(os.path.join(data_dir, "db_tax.json.gz"),
                        r2_key="bupgogae/db_tax.json.gz")
        upload_db_to_r2(os.path.join(data_dir, "db_patent.json.gz"),
                        r2_key="bupgogae/db_patent.json.gz")

    elapsed = (datetime.now() - now).total_seconds()
    minutes = int(elapsed // 60)
    seconds = int(elapsed % 60)

    print(f"\n{'=' * 55}")
    print(f"  🏁 완료 ({minutes}분 {seconds}초)")
    print(f"     DB: {after:,}건 (Δ {delta:+,})")
    print(f"     Core: {core_mb:.2f} MB | DLC(Tax): {tax_mb:.2f} MB | DLC(Patent): {patent_mb:.2f} MB")
    print(f"{'=' * 55}")

    # 텔레그램 리포트
    send_telegram_report(
        today=today,
        scan_count=len(scan_ranges),
        summary=summary,
        total_ins=total_ins,
        total_upd=total_upd,
        total_skip=total_skip,
        errors=errors,
        db_total=after,
        db_delta=delta,
        gz_mb=core_mb,
        tax_gz_mb=tax_mb,
        patent_gz_mb=patent_mb,
        elapsed_sec=elapsed,
        r2_uploaded=not missing_r2,
        detc_total=len(detc_cases),
        detc_ins=detc_ins,
        tax_total=len(tax_cases),
        tax_ins=tax_ins,
    )


# ════════════════════════════════════════════════════════════
# 텔레그램 리포트
# ════════════════════════════════════════════════════════════

def send_telegram_report(**kwargs):
    """텔레그램 메시지 발송. 환경변수 미설정 시 스킵."""
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")

    if not bot_token or not chat_id:
        print("⚠️ Telegram 미설정 — 리포트 스킵")
        return

    today = kwargs.get("today", date.today())
    scan_count = kwargs.get("scan_count", 0)
    summary = kwargs.get("summary", {})
    total_ins = kwargs.get("total_ins", 0)
    total_upd = kwargs.get("total_upd", 0)
    total_skip = kwargs.get("total_skip", 0)
    errors = kwargs.get("errors", 0)
    db_total = kwargs.get("db_total", 0)
    db_delta = kwargs.get("db_delta", 0)
    gz_mb = kwargs.get("gz_mb", 0)
    elapsed_sec = kwargs.get("elapsed_sec", 0)
    r2_uploaded = kwargs.get("r2_uploaded", False)

    minutes = int(elapsed_sec // 60)
    seconds = int(elapsed_sec % 60)
    status = "✅" if errors == 0 else "⚠️"
    r2_status = "✅ 업로드" if r2_uploaded else "⏭️ 스킵"

    detc_total = kwargs.get("detc_total", 0)
    detc_ins_cnt = kwargs.get("detc_ins", 0)
    tax_total = kwargs.get("tax_total", 0)
    tax_ins_cnt = kwargs.get("tax_ins", 0)

    msg = (
        f"{status} *법고개 NAS Runner*\n"
        f"`{today}` | {minutes}분 {seconds}초\n"
        f"\n"
        f"📊 *판례*: {scan_count:,}일\n"
        f"  T1: {summary.get('tier1', 0)} | "
        f"T2: {summary.get('tier2', 0)} | "
        f"T3: {summary.get('tier3', 0)}\n"
        f"📜 *헌재*: {detc_total:,}건 (+{detc_ins_cnt} 신규)\n"
        f"💰 *조세심판*: {tax_total:,}건 (+{tax_ins_cnt} 신규)\n"
        f"\n"
        f"🗄 *Master DB*: {db_total:,}건 (Δ {db_delta:+,})\n"
        f"  +{total_ins} 신규 | ={total_upd} 갱신 | ⛔{total_skip} 스킵 | ❌{errors} 에러\n"
        f"\n"
        f"📦 *Core*: {gz_mb:.2f} MB | *DLC(Tax)*: {kwargs.get('tax_gz_mb', 0):.2f} MB | "
        f"*DLC(Patent)*: {kwargs.get('patent_gz_mb', 0):.2f} MB\n"
        f"☁️ *R2*: {r2_status}"
    )

    try:
        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        resp = _requests.post(url, json={
            "chat_id": chat_id,
            "text": msg,
            "parse_mode": "Markdown",
        }, timeout=10)
        if resp.status_code == 200:
            print("📨 텔레그램 리포트 전송 완료")
        else:
            print(f"⚠️ 텔레그램 전송 실패: {resp.status_code} {resp.text[:100]}")
    except Exception as e:
        print(f"⚠️ 텔레그램 전송 실패: {e}")


if __name__ == "__main__":
    main()
