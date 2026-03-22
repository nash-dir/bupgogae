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


def get_today_scan_dates(today: date | None = None) -> list[str]:
    """오늘 스캔할 날짜 목록 (YYYYMMDD 문자열) 반환."""
    if today is None:
        today = date.today()

    today_ser = date_serial(today)
    this_year = today.year
    year_before_last = this_year - 2  # 제작년
    tier2_end = date(year_before_last, 12, 31)
    tier3_start = date(this_year - 1, 1, 1)  # 작년 1/1부터

    scan_dates = []

    # Tier 1: 1948~1999 (date_offset % 56)
    tier1_epoch = TIER1_START
    d = TIER1_START
    while d <= TIER1_END:
        offset = (d - tier1_epoch).days
        if offset % TIER1_MOD == today_ser % TIER1_MOD:
            scan_dates.append(d.strftime("%Y%m%d"))
        d += timedelta(days=1)

    # Tier 2: 2000~작년 (date_offset % 15)
    tier2_epoch = TIER2_START
    d = TIER2_START
    while d <= tier2_end:
        offset = (d - tier2_epoch).days
        if offset % TIER2_MOD == today_ser % TIER2_MOD:
            scan_dates.append(d.strftime("%Y%m%d"))
        d += timedelta(days=1)

    # Tier 3: 올해~오늘 (전량)
    d = tier3_start
    while d <= today:
        scan_dates.append(d.strftime("%Y%m%d"))
        d += timedelta(days=1)

    return scan_dates


def scan_plan_summary(scan_dates: list[str], today: date) -> dict:
    """스캔 계획 통계."""
    tier1 = [d for d in scan_dates if d < "20000101"]
    tier2 = [d for d in scan_dates if "20000101" <= d < f"{today.year - 1}0101"]
    tier3 = [d for d in scan_dates if d >= f"{today.year - 1}0101"]

    return {
        "total": len(scan_dates),
        "tier1": len(tier1),
        "tier2": len(tier2),
        "tier3": len(tier3),
        "est_minutes": round(len(scan_dates) * 0.9 / 60, 1),
    }


# ════════════════════════════════════════════════════════════
# API 크롤링
# ════════════════════════════════════════════════════════════

def fetch_cases_for_date(date_str: str) -> list[dict]:
    """단일 날짜 판례 수집."""
    cases = []
    xml_content = fetch_xml_safe(date_str, page=1)
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
        page_xml = fetch_xml_safe(date_str, page=p)
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
# 풀 DB 덤프
# ════════════════════════════════════════════════════════════

def export_full_db(db: MasterDB, output_path: str) -> float:
    """master.db → db.json (gzip) 풀 덤프. 파일 크기(MB) 반환."""
    compressed, skipped = db.export_all()
    stats = db.stats()

    payload = {
        "version": datetime.now().strftime("%Y%m%d"),
        "total": stats["total"],
        "keys": len(compressed),
        "cases": compressed,
    }

    json_bytes = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    # gzip 압축 저장
    gz_path = output_path + ".gz" if not output_path.endswith(".gz") else output_path
    os.makedirs(os.path.dirname(gz_path) or ".", exist_ok=True)

    with gzip.open(gz_path, "wb", compresslevel=9) as f:
        f.write(json_bytes)

    # 비압축 JSON도 저장 (디버깅용)
    raw_path = gz_path.replace(".gz", "")
    with open(raw_path, "wb") as f:
        f.write(json_bytes)

    gz_mb = os.path.getsize(gz_path) / (1024 * 1024)
    raw_mb = os.path.getsize(raw_path) / (1024 * 1024)
    print(f"  📄 {raw_path} ({raw_mb:.2f} MB raw, {gz_mb:.2f} MB gzip)")

    return gz_mb


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
    db_json_path = os.path.join(data_dir, "db.json")
    today = date.today()

    # 스캔 계획
    scan_dates = get_today_scan_dates(today)
    summary = scan_plan_summary(scan_dates, today)

    print("=" * 55)
    print(f"  🚀 NAS Runner (Date-Modulus)")
    print(f"     날짜: {today}")
    print(f"     Serial: {date_serial(today)}")
    print(f"     스캔: {summary['total']:,}일"
          f" (T1:{summary['tier1']} T2:{summary['tier2']} T3:{summary['tier3']})")
    print(f"     예상: ~{summary['est_minutes']}분")
    print("=" * 55)

    if args.plan:
        print(f"\n📋 스캔 계획 ({len(scan_dates)}일):")
        for i, d in enumerate(scan_dates[:20]):
            print(f"  {i+1:4d}. {d[:4]}-{d[4:6]}-{d[6:]}")
        if len(scan_dates) > 20:
            print(f"  ... ({len(scan_dates) - 20}일 생략)")
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
    for i, date_str in enumerate(scan_dates):
        display = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:]}"
        pct = (i + 1) / len(scan_dates) * 100

        if (i + 1) % 100 == 0 or i == 0:
            print(f"  [{i+1:4d}/{len(scan_dates)}] {display} ({pct:.0f}%)")

        try:
            raw = fetch_cases_for_date(date_str)
            if raw:
                ins, upd, skp = db.upsert_raw(raw)
                total_ins += ins
                total_upd += upd
                total_skip += skp
                if ins > 0:
                    print(f"  [{i+1:4d}/{len(scan_dates)}] {display}"
                          f"  +{ins} 신규, ={upd} 갱신, -{skp} 스킵")
        except Exception as e:
            errors += 1
            print(f"  [{i+1:4d}/{len(scan_dates)}] {display}  ❌ {e}")

        time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))

    after = db.count()
    delta = after - before
    print(f"\n📊 Master DB: {after:,}건 (Δ {delta:+,}, 에러 {errors}건, 스킵 {total_skip}건)")

    # 풀 DB 덤프
    print(f"\n📦 풀 DB 덤프")
    gz_mb = export_full_db(db, db_json_path)
    db.close()

    # R2 업로드
    r2_vars = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
               "R2_BUCKET", "CF_ACCOUNT_ID"]
    missing_r2 = [v for v in r2_vars if not os.environ.get(v)]

    if missing_r2:
        print(f"\n⚠️ R2 변수 누락 ({', '.join(missing_r2)}) — 업로드 스킵")
    else:
        from upload_r2 import upload_db_to_r2  # noqa: E402
        upload_db_to_r2(db_json_path + ".gz")

    elapsed = (datetime.now() - now).total_seconds()
    minutes = int(elapsed // 60)
    seconds = int(elapsed % 60)

    print(f"\n{'=' * 55}")
    print(f"  🏁 완료 ({minutes}분 {seconds}초)")
    print(f"     DB: {after:,}건 (Δ {delta:+,})")
    print(f"     db.json: {gz_mb:.2f} MB (gzip)")
    print(f"{'=' * 55}")

    # 텔레그램 리포트
    send_telegram_report(
        today=today,
        scan_count=len(scan_dates),
        summary=summary,
        total_ins=total_ins,
        total_upd=total_upd,
        total_skip=total_skip,
        errors=errors,
        db_total=after,
        db_delta=delta,
        gz_mb=gz_mb,
        elapsed_sec=elapsed,
        r2_uploaded=not missing_r2,
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

    msg = (
        f"{status} *법고개 NAS Runner*\n"
        f"`{today}` | {minutes}분 {seconds}초\n"
        f"\n"
        f"📊 *스캔*: {scan_count:,}일\n"
        f"  T1: {summary.get('tier1', 0)} | "
        f"T2: {summary.get('tier2', 0)} | "
        f"T3: {summary.get('tier3', 0)}\n"
        f"\n"
        f"🗄 *Master DB*: {db_total:,}건 (Δ {db_delta:+,})\n"
        f"  +{total_ins} 신규 | ={total_upd} 갱신 | ⛔{total_skip} 스킵 | ❌{errors} 에러\n"
        f"\n"
        f"📦 *db.json*: {gz_mb:.2f} MB (gzip)\n"
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
