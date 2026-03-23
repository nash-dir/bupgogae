"""
KIPRIS Runner — Slow Grazing 백필 전략 기반 심판사항 수집기.

KIPRIS Plus OpenAPI 월 무료 한도(1,000건) 내에서
특허심판원 심판사항 ~397,000건을 30일 내 100% 수집.

전략:
  - 심결일자 기준 Time Chunking (1956~1999: 1년, 2000~현재: 1월)
  - 1회 실행 당 최대 33 API 요청 (33 × 30일 = 990 ≤ 1,000)
  - SQLite kipris_backfill_log 테이블로 중단점 이어서 실행

Usage:
  python kipris_runner.py              # 백필 실행
  python kipris_runner.py --plan       # 청크 계획 출력 (dry-run)
  python kipris_runner.py --data-dir ./testdata

환경변수 (.env):
  KIPRIS_API_KEY
"""

import argparse
import math
import os
import random
import sys
import time
from datetime import datetime, date, timedelta

import requests as _requests

# 같은 디렉토리 의존성
from kipris_api import fetch_kipris_xml, parse_kipris_items, NUM_OF_ROWS  # noqa: E402
from master_db import MasterDB  # noqa: E402

# ── 설정 ──
DAILY_QUOTA = 33            # 1일 최대 API HTTP 요청 횟수
DELAY_MIN, DELAY_MAX = 0.8, 1.5
API_ERROR_THRESHOLD = 3     # API 에러 누적 임계치 (초과 시 KIPRIS 단계 스킵)


# ════════════════════════════════════════════════════════════
# 1. Time Chunking — 기간 분할
# ════════════════════════════════════════════════════════════

def generate_chunks() -> list[tuple[str, str]]:
    """심결일자 기준 기간 청크 목록 생성.

    Returns:
        [(start_date, end_date), ...] — YYYYMMDD 형식
    """
    chunks = []
    today = date.today()

    # 1956~1999: 1년 단위
    for year in range(1956, 2000):
        chunks.append((f"{year}0101", f"{year}1231"))

    # 2000~현재: 1월 단위
    year = 2000
    month = 1
    while True:
        start = date(year, month, 1)
        if start > today:
            break

        # 다음 달 1일 - 1일 = 이번 달 말일
        if month == 12:
            next_month_start = date(year + 1, 1, 1)
        else:
            next_month_start = date(year, month + 1, 1)

        end = next_month_start - timedelta(days=1)

        # 미래 날짜 클리핑
        if end > today:
            end = today

        chunks.append((start.strftime("%Y%m%d"), end.strftime("%Y%m%d")))

        year = next_month_start.year
        month = next_month_start.month

    return chunks


# ════════════════════════════════════════════════════════════
# 1-B. 텔레그램 긴급 알림
# ════════════════════════════════════════════════════════════

def send_kipris_alert(message: str):
    """KIPRIS 에러 발생 시 텔레그램으로 즉시 알림."""
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")

    if not bot_token or not chat_id:
        print("⚠️ Telegram 미설정 — 알림 스킵")
        return

    text = f"🚨 *KIPRIS Circuit Breaker*\n`{date.today()}`\n\n{message}"

    try:
        resp = _requests.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "Markdown"},
            timeout=10,
        )
        if resp.status_code == 200:
            print("📨 텔레그램 긴급 알림 전송 완료")
        else:
            print(f"⚠️ 텔레그램 전송 실패: {resp.status_code}")
    except Exception as e:
        print(f"⚠️ 텔레그램 전송 실패: {e}")


# ════════════════════════════════════════════════════════════
# 2. 백필 실행
# ════════════════════════════════════════════════════════════

def run_backfill(db: MasterDB, dry_run: bool = False):
    """Slow Grazing 백필 메인 루프.

    Args:
        db: MasterDB 인스턴스 (kipris 테이블 사용)
        dry_run: True이면 API 호출 없이 계획만 출력
    """
    all_chunks = generate_chunks()
    total_chunks = len(all_chunks)

    # DB에서 완료된 청크 확인
    completed = set()
    cur = db.conn.execute(
        "SELECT chunk_start, chunk_end FROM kipris_backfill_log "
        "WHERE is_completed = 1"
    )
    for row in cur.fetchall():
        completed.add((row[0], row[1]))

    # 미완료 청크 필터링
    pending = [(s, e) for s, e in all_chunks if (s, e) not in completed]

    print(f"\n📊 백필 상태:")
    print(f"   전체 청크: {total_chunks}")
    print(f"   완료:     {len(completed)}")
    print(f"   미완료:   {len(pending)}")
    print(f"   진행률:   {len(completed) / total_chunks * 100:.1f}%")

    if not pending:
        print("\n🎉 모든 청크 완료! 백필이 끝났습니다.")
        return

    if dry_run:
        print(f"\n📋 다음 실행 시 처리할 청크 (최대 {DAILY_QUOTA}건):")
        for i, (s, e) in enumerate(pending[:10]):
            print(f"  {i+1}. {s[:4]}-{s[4:6]}-{s[6:]} ~ {e[:4]}-{e[4:6]}-{e[6:]}")
        if len(pending) > 10:
            print(f"  ... ({len(pending) - 10}개 추가)")
        est_days = math.ceil(len(pending) / DAILY_QUOTA)
        print(f"\n⏰ 예상 완료: ~{est_days}일 ({est_days / 30:.1f}개월)")
        return

    # API 키 확인
    api_key = os.environ.get("KIPRIS_API_KEY", "")
    if not api_key:
        print("❌ KIPRIS_API_KEY 미설정")
        sys.exit(1)

    api_calls_made = 0
    total_inserted = 0
    total_updated = 0
    chunks_completed = 0
    api_errors = 0           # API 에러 누적 카운터
    last_error_msg = ""      # 마지막 에러 메시지

    print(f"\n🚀 백필 시작 (일일 쿼터: {DAILY_QUOTA}, 에러 임계치: {API_ERROR_THRESHOLD})")
    print("=" * 55)

    for chunk_idx, (start_date, end_date) in enumerate(pending):
        if api_calls_made >= DAILY_QUOTA:
            break

        # ── Circuit Breaker: API 에러 누적 임계치 초과 ──
        if api_errors >= API_ERROR_THRESHOLD:
            msg = (
                f"⚠️ KIPRIS API 에러 {api_errors}회 누적 — 백필 중단\n"
                f"마지막 에러: {last_error_msg}\n"
                f"API 호출: {api_calls_made}회, 신규: {total_inserted}건"
            )
            print(f"\n🚨 {msg}")
            send_kipris_alert(msg)
            break

        display = (f"{start_date[:4]}-{start_date[4:6]}-{start_date[6:]} ~ "
                   f"{end_date[:4]}-{end_date[4:6]}-{end_date[6:]}")

        # 기존 부분 완료 로그 확인
        partial = db.conn.execute(
            "SELECT pages_fetched, total_cnt FROM kipris_backfill_log "
            "WHERE chunk_start = ? AND chunk_end = ? AND is_completed = 0",
            (start_date, end_date),
        ).fetchone()

        pages_fetched = partial[0] if partial else 0
        known_total = partial[1] if partial else 0

        # 페이지 1 (또는 이어서)
        current_page = pages_fetched + 1

        # 첫 페이지 fetch
        if api_calls_made >= DAILY_QUOTA:
            break

        time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
        xml = fetch_kipris_xml(start_date, end_date, page_no=current_page)
        api_calls_made += 1

        if not xml:
            api_errors += 1
            last_error_msg = "HTTP 응답 없음 (None)"
            print(f"  ⚠️ [{display}] 빈 응답 (API 에러 {api_errors}/{API_ERROR_THRESHOLD})")
            continue

        items, total_cnt, err_msg = parse_kipris_items(xml)

        # API 에러 vs 정상 0건 구분
        if err_msg:
            api_errors += 1
            last_error_msg = err_msg
            print(f"  ❌ [{display}] API 에러: {err_msg} "
                  f"({api_errors}/{API_ERROR_THRESHOLD})")
            continue

        if total_cnt == 0 and not items:
            # 데이터 없는 기간
            db.conn.execute(
                "INSERT OR REPLACE INTO kipris_backfill_log "
                "(chunk_start, chunk_end, total_cnt, pages_fetched, "
                "is_completed, updated_at) VALUES (?,?,0,0,1,datetime('now'))",
                (start_date, end_date),
            )
            db.conn.commit()
            chunks_completed += 1
            print(f"  [{display}] 0건 — 완료")
            continue

        # DB에 삽입
        if items:
            ins, upd = db.upsert_kipris(items)
            total_inserted += ins
            total_updated += upd

        total_pages = math.ceil(total_cnt / NUM_OF_ROWS)
        pages_done = current_page

        print(f"  [{display}] p{current_page}/{total_pages} "
              f"총{total_cnt}건, {len(items)}건 수집 "
              f"(API: {api_calls_made}/{DAILY_QUOTA})")

        # 나머지 페이지 fetch
        while pages_done < total_pages:
            if api_calls_made >= DAILY_QUOTA:
                # 쿼터 소진 → 부분 저장
                db.conn.execute(
                    "INSERT OR REPLACE INTO kipris_backfill_log "
                    "(chunk_start, chunk_end, total_cnt, pages_fetched, "
                    "is_completed, updated_at) VALUES (?,?,?,?,0,datetime('now'))",
                    (start_date, end_date, total_cnt, pages_done),
                )
                db.conn.commit()
                print(f"  ⏸️ [{display}] 쿼터 소진 — {pages_done}/{total_pages} 저장")
                break

            time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
            next_page = pages_done + 1
            xml = fetch_kipris_xml(start_date, end_date, page_no=next_page)
            api_calls_made += 1
            pages_done = next_page

            if not xml:
                api_errors += 1
                last_error_msg = "HTTP 응답 없음 (None)"
                continue

            page_items, _, page_err = parse_kipris_items(xml)

            if page_err:
                api_errors += 1
                last_error_msg = page_err
                print(f"  ❌ [{display}] p{next_page} API 에러: {page_err}")
                if api_errors >= API_ERROR_THRESHOLD:
                    break
                continue

            if not page_items:
                break  # 빈 페이지 → 조기 종료

            ins, upd = db.upsert_kipris(page_items)
            total_inserted += ins
            total_updated += upd

            print(f"  [{display}] p{next_page}/{total_pages} "
                  f"+{len(page_items)}건 (API: {api_calls_made}/{DAILY_QUOTA})")
        else:
            # 모든 페이지 완료
            db.conn.execute(
                "INSERT OR REPLACE INTO kipris_backfill_log "
                "(chunk_start, chunk_end, total_cnt, pages_fetched, "
                "is_completed, updated_at) VALUES (?,?,?,?,1,datetime('now'))",
                (start_date, end_date, total_cnt, pages_done),
            )
            db.conn.commit()
            chunks_completed += 1

    # 결과 출력
    kipris_total = db.kipris_count()
    completed_now = len(completed) + chunks_completed
    progress = completed_now / total_chunks * 100

    print(f"\n{'=' * 55}")
    print(f"  🏁 백필 결과")
    print(f"     API 호출:  {api_calls_made}/{DAILY_QUOTA}")
    print(f"     신규 삽입: {total_inserted:,}건")
    print(f"     갱신:      {total_updated:,}건")
    print(f"     청크 완료: {chunks_completed}개 (이번 실행)")
    print(f"     총 진행률: {progress:.1f}% ({completed_now}/{total_chunks})")
    print(f"     KIPRIS DB: {kipris_total:,}건")
    print(f"{'=' * 55}")


# ════════════════════════════════════════════════════════════
# 3. Main
# ════════════════════════════════════════════════════════════

def main():
    default_data_dir = os.environ.get("DATA_DIR", "/app/data")

    parser = argparse.ArgumentParser(description="KIPRIS Slow Grazing Runner")
    parser.add_argument("--plan", action="store_true",
                        help="백필 계획만 출력 (dry-run)")
    parser.add_argument("--data-dir", default=default_data_dir,
                        help=f"Data directory (default: {default_data_dir})")
    args = parser.parse_args()

    data_dir = args.data_dir
    master_db_path = os.path.join(data_dir, "master.db")

    print("=" * 55)
    print("  🔬 KIPRIS Slow Grazing Runner")
    print(f"     날짜: {date.today()}")
    print(f"     일일 쿼터: {DAILY_QUOTA}")
    print(f"     DB: {master_db_path}")
    print("=" * 55)

    # Master DB 열기
    db = MasterDB(master_db_path)

    run_backfill(db, dry_run=args.plan)

    db.close()


if __name__ == "__main__":
    main()
