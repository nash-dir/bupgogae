"""
Crawler Runner — Date-Modulus 스케줄러 + 풀 DB 배포.

매일 ~1,420건의 균일 API 호출로 master.db를 갱신하고,
검증된 db.json/manifest.json과 secret-free 실행 보고서를 로컬에 생성한다.
분리 publish job이 기본 운영 경로이며, credential이 있는 기존 Docker 실행에서는
호환을 위해 DB→manifest 순서의 직접 업로드도 지원한다. CORS 정책 설정은 배포 시
1회 수행하며 crawler 런타임의 책임이 아니다.

스케줄링:
  Tier 1 (1948~1999): date_offset % 56 == today_serial % 56 → ~366일/day
  Tier 2 (2000~제작년): date_offset % 15 == today_serial % 15 → ~609일/day
  Tier 3 (작년~오늘): 전량 스캔                                → ~445일/day
  합계: ~1,420건/day (~21분)

Usage:
  python crawler_runner.py              # 자동 스캔 + 풀 DB 배포
  python crawler_runner.py --plan       # 오늘 스캔 계획만 출력 (dry-run)
  python crawler_runner.py --data-dir ./testdata

환경변수 (.env):
  BUPGOGAE_API_KEY
  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2_BUCKET / CF_ACCOUNT_ID
      (선택, 기존 Docker 직접 게시 경로에서만 사용)
  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
      (선택, 기존 Docker 직접 알림 경로에서만 사용)
"""

import argparse
import gzip
import json
import math
import os
import random
import sqlite3
import sys
import requests as _requests
import time
import xml.etree.ElementTree as ET  # 타입 힌트·예외(ET.ParseError)용
from defusedxml.ElementTree import fromstring as _safe_fromstring  # XXE 방어 파싱
from datetime import datetime, timedelta, date, timezone
from pathlib import Path

# 의존성 (같은 디렉토리)
from api import (  # noqa: E402
    clean_case_number,
    fetch_xml_safe,
    get_network_stats,
    get_text,
    reset_network_stats,
)
from compress import compress_case_number  # noqa: E402
from master_db import MasterDB  # noqa: E402
from manifest import MIN_CORE_KEYS as MIN_PUBLIC_CORE_KEYS  # noqa: E402
from log_setup import get_logger  # noqa: E402
from config import (  # noqa: E402
    CRAWLER_DELAY_MIN as DELAY_MIN,
    CRAWLER_DELAY_MAX as DELAY_MAX,
    TIER1_MOD, TIER2_MOD, RECENT_SCAN_PAGES, CIRCUIT_BREAKER_THRESHOLD,
)

log = get_logger(__name__)

# ── 설정 ── (DELAY/MOD/RECENT_SCAN_PAGES/CIRCUIT_BREAKER는 config.py, env 조정 가능)

# Date Serial: 1900-01-01 = 1 (Excel 호환)
SERIAL_EPOCH = date(1900, 1, 1)

# Tier 경계
TIER1_START = date(1948, 8, 15)  # 정부수립일
TIER1_END   = date(1999, 12, 31)

TIER2_START = date(2000, 1, 1)
# TIER2_END = 작년 12/31 (동적)
# TIER3_START = 올해 1/1 (동적)
# RECENT_SCAN_PAGES: 최근 N페이지 (100건/page)
# CIRCUIT_BREAKER_THRESHOLD: 연속 N건 실패 시 크롤링 중단

BASELINE_MIN_PRECEDENTS = MIN_PUBLIC_CORE_KEYS
BASELINE_EARLIEST_CUTOFF = "19600101"
DETC_MAX_PAGES = 400
PRECEDENT_MAX_PAGES_PER_RANGE = 1_000
PIPELINE_REPORT_SCHEMA = 1
PIPELINE_REPORT_REASONS = {
    "artifact_validation_failed",
    "complete",
    "direct_publish_failed",
    "incomplete_direct_publish_config",
    "initial_network_failure",
    "insufficient_public_payload",
    "internal_failure",
    "invalid_backlog",
    "invalid_baseline",
    "invalid_completed_baseline",
    "missing_api_key",
    "partial_crawl",
}
BACKLOG_FAILURE_REASONS = {
    "api_error_envelope",
    "bootstrap_not_attempted",
    "circuit_breaker_not_attempted",
    "configured_page_limit_exceeded",
    "duplicate_case_serial",
    "empty_response",
    "initial_detc_scan_not_attempted",
    "internal_error",
    "invalid_case_date",
    "invalid_case_number",
    "invalid_case_serial",
    "invalid_total_count",
    "legacy_state",
    "missing_case_court",
    "missing_case_date",
    "missing_case_number",
    "missing_case_serial",
    "missing_total_count",
    "page_count_mismatch",
    "range_fetch_error",
    "request_failed",
    "result_count_mismatch",
    "scheduled_not_attempted",
    "total_count_changed",
    "out_of_range_case_date",
    "unexpected_items_after_last_page",
    "unexpected_xml_root",
    "xml_parse_failed",
}


class RangeFetchError(RuntimeError):
    """날짜 범위 또는 헌재 페이지를 완전하게 수집하지 못한 상태."""

    def __init__(self, date_range: str, page: int, reason: str):
        self.date_range = date_range
        self.page = page
        self.reason = reason
        super().__init__(f"{date_range} page={page}: {reason}")


class BacklogStateError(RuntimeError):
    """backlog가 손상되었거나 지원하지 않는 형식인 상태."""


class BaselineStateError(RuntimeError):
    """증분 수집의 기준 master DB를 신뢰할 수 없는 상태."""


class PublicationStateError(RuntimeError):
    """사용자용 payload가 안전한 게시 기준을 충족하지 못한 상태."""


def _xml_local_name(tag: str) -> str:
    """namespace 유무와 무관하게 XML local name을 반환한다."""
    return tag.rsplit("}", 1)[-1]


def _direct_xml_children(root, local_name: str) -> list:
    return [child for child in root if _xml_local_name(child.tag) == local_name]


def _parse_search_page(
    xml_content: bytes,
    *,
    expected_root: str,
    item_tag: str,
    source: str,
    page: int,
) -> tuple[list, int]:
    """검색 API 한 페이지의 envelope/schema/count를 엄격하게 검증한다."""
    try:
        root = _safe_fromstring(xml_content)
    except ET.ParseError as exc:
        raise RangeFetchError(source, page, "xml_parse_failed") from exc

    if _xml_local_name(root.tag) != expected_root:
        raise RangeFetchError(source, page, "unexpected_xml_root")
    if any(
        _xml_local_name(child.tag).lower() in {"error", "fault"}
        for child in root
    ):
        raise RangeFetchError(source, page, "api_error_envelope")

    total_nodes = _direct_xml_children(root, "totalCnt")
    if len(total_nodes) != 1 or total_nodes[0].text is None:
        raise RangeFetchError(source, page, "missing_total_count")
    try:
        total_count = int(total_nodes[0].text.strip())
    except (AttributeError, TypeError, ValueError) as exc:
        raise RangeFetchError(source, page, "invalid_total_count") from exc
    if total_count < 0:
        raise RangeFetchError(source, page, "invalid_total_count")

    items = _direct_xml_children(root, item_tag)
    total_pages = math.ceil(total_count / 100)
    expected_on_page = max(0, min(100, total_count - ((page - 1) * 100)))
    if page <= total_pages and len(items) != expected_on_page:
        raise RangeFetchError(source, page, "page_count_mismatch")
    if page > total_pages and items:
        raise RangeFetchError(source, page, "unexpected_items_after_last_page")
    return items, total_count

# ════════════════════════════════════════════════════════════
# Date-Modulus 스케줄러
# ════════════════════════════════════════════════════════════

def fetch_recent_ruling_dates() -> set[str]:
    """최근 선고된 판례 표제부 날짜를 추출 (sort=ddes)."""
    dates = set()
    for page in range(1, RECENT_SCAN_PAGES + 1):
        xml_content = fetch_xml_safe(
            target="prec", query="*", page=page, sort="ddes",
        )
        if xml_content is None:
            raise ConnectionError("법제처 API 호출 실패 (네트워크 연결 끊김 또는 차단)")
        if not xml_content:
            raise ConnectionError(f"최근 선고 목록 빈 응답 (page={page})")
        items, _ = _parse_search_page(
            xml_content,
            expected_root="PrecSearch",
            item_tag="prec",
            source="recent_prec",
            page=page,
        )
        for item in items:
            raw_date = get_text(item, "선고일자")
            if raw_date and len(raw_date) == 8 and raw_date.isdigit():
                dates.add(raw_date)
        time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
    return dates


def date_serial(d: date) -> int:
    """1900-01-01 = 1 기준 Date Serial Number."""
    return (d - SERIAL_EPOCH).days + 1


def get_today_scan_ranges(today: date | None = None, recent_dates: set[str] | None = None) -> list[tuple[str, str]]:
    """오늘 스캔할 날짜 범위 목록 반환.

    Returns:
        [(start_date, end_date), ...] — YYYYMMDD 문자열
        T0: 최근 선고 날짜
        T1/T2: 넓은 윈도우 (1년/1월 단위)
        T3: 기존과 동일 (1일 단위, T0 제외)
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

    # Tier 0: 최신선고 날짜 — 리스트 선두에 삽입
    tier0_ranges = []
    if recent_dates:
        for d_str in sorted(recent_dates, reverse=True):
            tier0_ranges.append((d_str, d_str))

    # Tier 3: 작년~오늘 (전량, 일 단위 - Tier 0 제외)
    tier3_exclude = recent_dates or set()
    d = tier3_start
    while d <= today:
        ds = d.strftime("%Y%m%d")
        if ds not in tier3_exclude:
            ranges.append((ds, ds))
        d += timedelta(days=1)

    return tier0_ranges + ranges


def get_full_bootstrap_ranges(today: date | None = None) -> list[tuple[str, str]]:
    """정부 수립일부터 오늘까지 빠짐없는 연 단위 bootstrap 범위를 만든다."""
    today = today or date.today()
    ranges = []
    for year in range(TIER1_START.year, today.year + 1):
        start = max(TIER1_START, date(year, 1, 1))
        end = min(today, date(year, 12, 31))
        if start <= end:
            ranges.append((start.strftime("%Y%m%d"), end.strftime("%Y%m%d")))
    return ranges


def require_healthy_baseline(
    db_path: str,
    today: date | None = None,
    *,
    require_detc: bool = False,
) -> dict:
    """증분 수집 전에 기존 master DB의 최소 신뢰 조건을 검증한다."""
    today = today or date.today()
    if not os.path.isfile(db_path) or os.path.getsize(db_path) == 0:
        raise BaselineStateError("missing_or_empty_master_db")

    conn = None
    try:
        db_uri = Path(db_path).resolve().as_uri() + "?mode=ro"
        conn = sqlite3.connect(db_uri, uri=True)
        quick_check = conn.execute("PRAGMA quick_check").fetchone()
        if not quick_check or quick_check[0] != "ok":
            raise BaselineStateError("sqlite_integrity_check_failed")

        table_info = conn.execute("PRAGMA table_info(cases)").fetchall()
        columns = {row[1] for row in table_info}
        required_columns = {
            "serial",
            "case_name",
            "case_number",
            "case_number_clean",
            "date",
            "court",
            "inserted_at",
        }
        if not required_columns.issubset(columns):
            raise BaselineStateError("missing_cases_schema")
        serial_columns = [row for row in table_info if row[1] == "serial"]
        if not serial_columns or serial_columns[0][5] != 1:
            raise BaselineStateError("serial_primary_key_missing")
        indexes = {
            row[1] for row in conn.execute("PRAGMA index_list(cases)").fetchall()
        }
        if not {"idx_cases_date", "idx_cases_inserted"}.issubset(indexes):
            raise BaselineStateError("required_cases_indexes_missing")

        count, oldest, newest = conn.execute(
            "SELECT COUNT(*), MIN(date), MAX(date) FROM cases "
            "WHERE serial NOT LIKE 'D%'"
        ).fetchone()
        detc_count = conn.execute(
            "SELECT COUNT(*) FROM cases WHERE serial LIKE 'D%'"
        ).fetchone()[0]
    except BaselineStateError:
        raise
    except (OSError, sqlite3.Error) as exc:
        raise BaselineStateError("unreadable_master_db") from exc
    finally:
        if conn is not None:
            conn.close()

    if count < BASELINE_MIN_PRECEDENTS:
        raise BaselineStateError("insufficient_precedent_count")
    if not oldest or oldest > BASELINE_EARLIEST_CUTOFF:
        raise BaselineStateError("historical_coverage_missing")
    recent_cutoff = f"{today.year - 2}0101"
    if not newest or newest < recent_cutoff:
        raise BaselineStateError("recent_coverage_missing")
    if require_detc and detc_count < 1:
        raise BaselineStateError("detc_coverage_missing")
    return {
        "precedent_count": count,
        "detc_count": detc_count,
        "oldest": oldest,
        "newest": newest,
    }


def write_pipeline_report(
    data_dir: str,
    *,
    status: str,
    reason: str,
    db_total: int = 0,
    precedent_failed: int = 0,
    detc_failed: int = 0,
    circuit_broken: bool = False,
) -> str:
    """분리 job이 소비할 수 있는 secret-free 분류 보고서를 원자 저장한다."""
    if status not in {"success", "blocked"}:
        raise ValueError("invalid report status")
    classified_reason = str(reason)
    if classified_reason not in PIPELINE_REPORT_REASONS:
        classified_reason = "internal_failure"
    payload = {
        "schema": PIPELINE_REPORT_SCHEMA,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "status": status,
        "reason": classified_reason,
        "db_total": max(0, int(db_total)),
        "precedent_failed": max(0, int(precedent_failed)),
        "detc_failed": max(0, int(detc_failed)),
        "circuit_broken": bool(circuit_broken),
    }
    os.makedirs(data_dir, exist_ok=True)
    path = os.path.join(data_dir, "pipeline-report.json")
    temp_path = path + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
    os.replace(temp_path, path)
    return path


def scan_plan_summary(ranges: list[tuple[str, str]], today: date, recent_count: int = 0) -> dict:
    """스캔 계획 통계."""
    tier1 = [r for r in ranges if r[0] < "20000101"]
    tier2 = [r for r in ranges if "20000101" <= r[0] < f"{today.year - 1}0101"]
    tier3 = [r for r in ranges if r[0] >= f"{today.year - 1}0101"]

    return {
        "total": len(ranges),
        "tier0": recent_count,
        "tier1": len(tier1),
        "tier2": len(tier2),
        "tier3": max(0, len(tier3) - recent_count),
        "est_minutes": round(len(ranges) * 0.9 / 60, 1),
    }


# ════════════════════════════════════════════════════════════
# 실패 날짜 관리 (다음 실행 재시도)
# ════════════════════════════════════════════════════════════

FAILED_DATES_SCHEMA = 2
BACKLOG_MODE_INCREMENTAL = "incremental"
BACKLOG_MODE_FULL_BOOTSTRAP = "full_bootstrap"
BACKLOG_MODES = {
    BACKLOG_MODE_INCREMENTAL,
    BACKLOG_MODE_FULL_BOOTSTRAP,
}


def _backlog_key(item: dict) -> tuple:
    if item.get("kind") == "detc":
        return "detc", item["page"]
    return "precedent", item["start"], item["end"]


def _valid_date_string(value: str) -> bool:
    if len(value) != 8 or not value.isdigit():
        return False
    try:
        datetime.strptime(value, "%Y%m%d")
    except ValueError:
        return False
    return True


def _classified_backlog_reason(value) -> str:
    reason = str(value or "legacy_state")
    return reason if reason in BACKLOG_FAILURE_REASONS else "legacy_state"


def _normalize_backlog_item(item) -> dict | None:
    """구버전 tuple/list/dict를 현재 backlog record로 비파괴 migration."""
    if isinstance(item, (list, tuple)) and len(item) == 2:
        item = {"start": item[0], "end": item[1]}
    if not isinstance(item, dict):
        return None

    if item.get("kind") == "detc":
        raw_page = item.get("page")
        if isinstance(raw_page, bool) or not str(raw_page).isdigit():
            return None
        page = int(raw_page)
        if page < 1:
            return None
        try:
            attempts = max(0, int(item.get("attempts", 0) or 0))
        except (TypeError, ValueError):
            return None
        return {
            "kind": "detc",
            "page": page,
            "attempts": attempts,
            "last_error": _classified_backlog_reason(item.get("last_error")),
        }

    if item.get("kind") not in (None, "precedent"):
        return None
    start = str(item.get("start", ""))
    end = str(item.get("end", ""))
    if not _valid_date_string(start) or not _valid_date_string(end) or start > end:
        return None
    failed_pages = item.get("failed_pages", [])
    if not isinstance(failed_pages, list):
        return None
    normalized_pages = []
    for page in failed_pages:
        if isinstance(page, bool) or not str(page).isdigit() or int(page) < 1:
            return None
        normalized_pages.append(int(page))
    try:
        attempts = max(0, int(item.get("attempts", 0) or 0))
    except (TypeError, ValueError):
        return None
    return {
        "start": start,
        "end": end,
        "attempts": attempts,
        "failed_pages": sorted(set(normalized_pages)),
        "last_error": _classified_backlog_reason(item.get("last_error")),
    }


def load_failed_dates_state(data_dir: str) -> tuple[list[dict], str | None]:
    """이전 실행 backlog를 삭제하지 않고 로드한다.

    v1의 top-level list도 읽고 v2 record로 migration한다. 파일은 실행이 완전히
    끝나 save_failed_dates가 성공할 때까지 유지해 프로세스 중단 시 재시도를 보존한다.
    """
    path = os.path.join(data_dir, "failed_dates.json")
    if not os.path.exists(path):
        return [], None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            if data.get("schema") != FAILED_DATES_SCHEMA:
                raise BacklogStateError("unsupported_schema")
            raw_items = data.get("backlog")
            mode = data.get("mode", BACKLOG_MODE_INCREMENTAL)
            if mode not in BACKLOG_MODES:
                raise BacklogStateError("unsupported_mode")
        elif isinstance(data, list):
            raw_items = data
            mode = BACKLOG_MODE_INCREMENTAL
        else:
            raise BacklogStateError("invalid_top_level")
        if not isinstance(raw_items, list):
            raise BacklogStateError("backlog_not_list")
        items = []
        for raw in raw_items:
            normalized = _normalize_backlog_item(raw)
            if normalized is None:
                raise BacklogStateError("invalid_backlog_item")
            items.append(normalized)
        deduped = {_backlog_key(item): item for item in items}
        result = list(deduped.values())
        log.info(f"  🔄 이전 실패 {len(result)}건 재시도 대기열 로드")
        return result, mode
    except BacklogStateError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise BacklogStateError("unreadable_backlog") from exc


def load_failed_dates(data_dir: str) -> list[dict]:
    """기존 호출자용 backlog 목록 API."""
    backlog, _ = load_failed_dates_state(data_dir)
    return backlog


def save_failed_dates(
    data_dir: str,
    failed: list[dict],
    *,
    mode: str = BACKLOG_MODE_INCREMENTAL,
    retain_empty: bool = False,
):
    """현재 backlog를 원자적으로 교체한다. 완전 성공한 경우에만 파일을 제거한다."""
    if mode not in BACKLOG_MODES:
        raise BacklogStateError("refusing_to_write_invalid_mode")
    path = os.path.join(data_dir, "failed_dates.json")
    if not failed and not retain_empty:
        if os.path.exists(path):
            os.remove(path)
            log.info("  ✅ 실패 날짜 backlog 해소")
        return

    os.makedirs(data_dir, exist_ok=True)
    normalized = []
    for item in failed:
        record = _normalize_backlog_item(item)
        if record is None:
            raise BacklogStateError("refusing_to_write_invalid_backlog")
        normalized.append(record)
    deduped = list({_backlog_key(item): item for item in normalized}.values())
    payload = {
        "schema": FAILED_DATES_SCHEMA,
        "mode": mode,
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "backlog": deduped,
    }
    temp_path = path + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(temp_path, path)
    precedent_count = sum(item.get("kind") != "detc" for item in deduped)
    detc_count = sum(item.get("kind") == "detc" for item in deduped)
    failed_pages = sum(
        len(item.get("failed_pages", [])) for item in deduped
        if item.get("kind") != "detc"
    )
    log.warning(
        f"  💾 실패 날짜 {precedent_count}건/페이지 {failed_pages}건, "
        f"헌재 {detc_count}페이지 저장"
        " → 다음 실행 시 재시도"
    )


def prepare_full_bootstrap_work(
    today: date,
    prior_backlog: list[dict],
    persisted_mode: str | None,
) -> tuple[list[tuple[str, str]], list[int], list[dict]]:
    """신규 bootstrap은 전체 plan을 journal하고, 재개 시 pending만 반환한다.

    성공 항목은 backlog에서 제거되므로 full plan을 매 실행 다시 합치면 제한 시간
    안에 끝나지 않는 bootstrap이 영원히 첫 구간부터 반복된다. mode marker가 있는
    재개 실행에서는 남은 항목만 authoritative plan으로 사용한다.
    """
    pending = {_backlog_key(item): item for item in prior_backlog}
    if persisted_mode != BACKLOG_MODE_FULL_BOOTSTRAP:
        for start, end in get_full_bootstrap_ranges(today):
            pending.setdefault(
                ("precedent", start, end),
                {
                    "start": start,
                    "end": end,
                    "attempts": 0,
                    "failed_pages": [],
                    "last_error": "bootstrap_not_attempted",
                },
            )
        for page in range(1, DETC_MAX_PAGES + 1):
            pending.setdefault(
                ("detc", page),
                {
                    "kind": "detc",
                    "page": page,
                    "attempts": 0,
                    "last_error": "bootstrap_not_attempted",
                },
            )

    authoritative = list(pending.values())
    return (
        merge_scan_ranges([], authoritative),
        merge_detc_pages([], authoritative),
        authoritative,
    )


def resolve_full_bootstrap_resume_mode(
    master_db_path: str,
    today: date,
    prior_backlog: list[dict],
    persisted_mode: str | None,
) -> str | None:
    """빈 완료 marker가 실제 healthy baseline과 일치하는지 재검증한다.

    마지막 backlog 항목을 제거한 직후 종료되면 빈 full-bootstrap marker가 정상이다.
    반대로 upstream이 구조상 정상인 0건 응답을 계속 반환했거나 최종 baseline 검증이
    실패한 경우, 빈 marker를 완료로 신뢰하면 이후 실행이 영원히 아무 작업도 하지
    않는다. healthy DB일 때만 완료 marker를 유지하고, 아니면 전체 plan을 재-journal
    하도록 신규 bootstrap mode로 되돌린다.
    """
    if (
        persisted_mode != BACKLOG_MODE_FULL_BOOTSTRAP
        or prior_backlog
    ):
        return persisted_mode
    try:
        require_healthy_baseline(
            master_db_path, today, require_detc=True
        )
    except BaselineStateError as exc:
        log.warning(
            "  ⚠️ Full bootstrap 완료 marker와 baseline 불일치 "
            f"({exc}) — 전체 source를 다시 journal"
        )
        return None
    return persisted_mode


def merge_scan_ranges(
    scheduled: list[tuple[str, str]], backlog: list[dict]
) -> list[tuple[str, str]]:
    """backlog와 신규 스케줄의 순서 보존 합집합(backlog 우선)."""
    merged = []
    seen = set()
    for item in backlog:
        if item.get("kind") == "detc":
            continue
        pair = (item["start"], item["end"])
        if pair not in seen:
            merged.append(pair)
            seen.add(pair)
    for pair in scheduled:
        if pair not in seen:
            merged.append(pair)
            seen.add(pair)
    return merged


def merge_detc_pages(scheduled: list[int], backlog: list[dict]) -> list[int]:
    """헌재 backlog 페이지를 신규 스케줄보다 먼저, 중복 없이 재시도한다."""
    merged = []
    seen = set()
    for item in backlog:
        if item.get("kind") != "detc":
            continue
        page = item["page"]
        if page not in seen:
            merged.append(page)
            seen.add(page)
    for page in scheduled:
        if page not in seen:
            merged.append(page)
            seen.add(page)
    return merged


# ════════════════════════════════════════════════════════════
# 파이프라인 긴급 알림
# ════════════════════════════════════════════════════════════

def send_pipeline_alert(source: str, message: str):
    """파이프라인 에러 시 텔레그램으로 즉시 알림."""
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")

    if not bot_token or not chat_id:
        log.info(f"Telegram credential 없음 — {source} 로컬 알림 기록만 유지")
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
            log.info(f"📨 텔레그램 긴급 알림 전송 ({source})")
        else:
            log.warning(f"⚠️ 텔레그램 전송 실패: {resp.status_code}")
    except Exception as e:
        # 요청 URL에 bot token이 포함되므로 예외 문자열/응답 원문은 기록하지 않는다.
        log.warning(f"⚠️ 텔레그램 전송 실패: {type(e).__name__}")


# ════════════════════════════════════════════════════════════
# API 크롤링
# ════════════════════════════════════════════════════════════


def _required_numeric_serial(
    raw_serial: str,
    *,
    source: str,
    page: int,
    max_length: int,
) -> str:
    """일련번호 truncation/collision을 막고 upstream schema drift를 탐지한다."""
    if not raw_serial:
        raise RangeFetchError(source, page, "missing_case_serial")
    if not raw_serial.isdigit() or len(raw_serial) > max_length:
        raise RangeFetchError(source, page, "invalid_case_serial")
    return raw_serial


def _required_case_number(raw_number: str, source: str, page: int) -> str:
    if not raw_number:
        raise RangeFetchError(source, page, "missing_case_number")
    if compress_case_number(clean_case_number(raw_number)) is None:
        raise RangeFetchError(source, page, "invalid_case_number")
    return raw_number


def _precedent_case(item, date_range: str, page: int) -> dict:
    serial = _required_numeric_serial(
        get_text(item, "판례일련번호"),
        source=date_range,
        page=page,
        max_length=32,
    )
    case_number = _required_case_number(
        get_text(item, "사건번호"), date_range, page
    )
    case_date = get_text(item, "선고일자")
    if not case_date:
        raise RangeFetchError(date_range, page, "missing_case_date")
    if not _valid_date_string(case_date):
        raise RangeFetchError(date_range, page, "invalid_case_date")
    start_date, separator, end_date = date_range.partition("~")
    if not separator:
        end_date = start_date
    if not start_date <= case_date <= end_date:
        raise RangeFetchError(date_range, page, "out_of_range_case_date")
    court = get_text(item, "법원명")
    if not court:
        raise RangeFetchError(date_range, page, "missing_case_court")
    return {
        "serial": serial,
        "case_name": get_text(item, "사건명"),
        "case_number": case_number,
        "date": case_date,
        "court": court,
    }


def fetch_cases_for_range(date_range: str) -> list[dict]:
    """날짜(범위) 판례 수집.

    Args:
        date_range: 단일 날짜 'YYYYMMDD' 또는 범위 'YYYYMMDD~YYYYMMDD'
    """
    cases = []
    xml_content = fetch_xml_safe(date_range, page=1)
    if xml_content is None:
        raise RangeFetchError(date_range, 1, "request_failed")
    if not xml_content:
        raise RangeFetchError(date_range, 1, "empty_response")
    items, total_cnt = _parse_search_page(
        xml_content,
        expected_root="PrecSearch",
        item_tag="prec",
        source=date_range,
        page=1,
    )
    cases.extend(_precedent_case(item, date_range, 1) for item in items)
    total_pages = math.ceil(total_cnt / 100)
    if total_pages > PRECEDENT_MAX_PAGES_PER_RANGE:
        raise RangeFetchError(
            date_range, 1, "configured_page_limit_exceeded"
        )

    for p in range(2, total_pages + 1):
        time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
        page_xml = fetch_xml_safe(date_range, page=p)
        if page_xml is None:
            raise RangeFetchError(date_range, p, "request_failed")
        if not page_xml:
            raise RangeFetchError(date_range, p, "empty_response")
        items, page_total = _parse_search_page(
            page_xml,
            expected_root="PrecSearch",
            item_tag="prec",
            source=date_range,
            page=p,
        )
        if page_total != total_cnt:
            raise RangeFetchError(date_range, p, "total_count_changed")
        cases.extend(_precedent_case(item, date_range, p) for item in items)
    if len(cases) != total_cnt:
        raise RangeFetchError(date_range, total_pages or 1, "result_count_mismatch")
    if len({case["serial"] for case in cases}) != len(cases):
        raise RangeFetchError(date_range, total_pages or 1, "duplicate_case_serial")
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
    if xml_content is None:
        raise RangeFetchError("detc", page, "request_failed")
    if not xml_content:
        raise RangeFetchError("detc", page, "empty_response")
    items, total_count = _parse_search_page(
        xml_content,
        expected_root="DetcSearch",
        item_tag="Detc",
        source="detc",
        page=page,
    )
    if math.ceil(total_count / 100) > DETC_MAX_PAGES:
        raise RangeFetchError("detc", page, "configured_page_limit_exceeded")
    cases = []
    for item in items:
        raw_serial = _required_numeric_serial(
            get_text(item, "헌재결정례일련번호"),
            source="detc",
            page=page,
            max_length=31,
        )
        case_number = _required_case_number(
            get_text(item, "사건번호"), "detc", page
        )
        decision_date = get_text(item, "종국일자")
        # 실제 헌재 원천에는 종국일자 공란이 존재한다. 다만 값이 있으면
        # 반드시 calendar date여야 하며, 잘못된 값은 기존 정상 행을 덮지 않는다.
        if decision_date and not _valid_date_string(decision_date):
            raise RangeFetchError("detc", page, "invalid_case_date")
        cases.append({
            "serial": f"D{raw_serial}",
            "case_name": get_text(item, "사건명"),
            "case_number": case_number,
            "date": decision_date,
            "court": "헌법재판소",
        })
    if len({case["serial"] for case in cases}) != len(cases):
        raise RangeFetchError("detc", page, "duplicate_case_serial")
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


def crawl_detc_scan(
    db,
    pages: list[int],
    prior_backlog: list[dict] | None = None,
    fetcher=_fetch_detc_page,
    sleep_fn=None,
    persist_backlog=None,
) -> dict:
    """헌재 페이지를 개별 확정하고 미해결 페이지를 즉시 durable하게 만든다."""
    prior_by_key = {_backlog_key(item): item for item in (prior_backlog or [])}
    pending_by_key = dict(prior_by_key)
    total_cases = total_ins = total_upd = total_skip = errors = 0
    consecutive_failures = 0
    circuit_broken = False
    sleep_fn = sleep_fn or (
        lambda: time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
    )

    # 첫 요청 도중 강제 종료되어도 이번 실행의 모든 미시도 페이지가 남는다.
    for page in pages:
        key = ("detc", page)
        pending_by_key.setdefault(key, {
            "kind": "detc",
            "page": page,
            "attempts": 0,
            "last_error": "scheduled_not_attempted",
        })
    if persist_backlog is not None:
        persist_backlog(list(pending_by_key.values()))

    for index, page in enumerate(pages):
        key = ("detc", page)
        try:
            page_cases = fetcher(page)
            if page_cases:
                ins, upd, skp = db.upsert_raw(page_cases)
                total_cases += len(page_cases)
                total_ins += ins
                total_upd += upd
                total_skip += skp
            pending_by_key.pop(key, None)
            consecutive_failures = 0
        except Exception as exc:
            errors += 1
            consecutive_failures += 1
            previous = prior_by_key.get(key, {})
            pending_by_key[key] = {
                "kind": "detc",
                "page": page,
                "attempts": int(previous.get("attempts", 0) or 0) + 1,
                "last_error": _safe_failure_reason(exc),
            }
            log.error(
                f"  [detc {index + 1:3d}/{len(pages)}] page={page}  ❌ "
                f"{_safe_failure_reason(exc)}"
            )

        if persist_backlog is not None:
            persist_backlog(list(pending_by_key.values()))

        if consecutive_failures >= CIRCUIT_BREAKER_THRESHOLD:
            for remaining_page in pages[index + 1:]:
                remaining_key = ("detc", remaining_page)
                previous = prior_by_key.get(remaining_key, {})
                pending_by_key[remaining_key] = {
                    "kind": "detc",
                    "page": remaining_page,
                    "attempts": int(previous.get("attempts", 0) or 0),
                    "last_error": "circuit_breaker_not_attempted",
                }
            if persist_backlog is not None:
                persist_backlog(list(pending_by_key.values()))
            circuit_broken = True
            break

        sleep_fn()

    return {
        "cases": total_cases,
        "total_ins": total_ins,
        "total_upd": total_upd,
        "total_skip": total_skip,
        "errors": errors,
        "failed": list(pending_by_key.values()),
        "circuit_broken": circuit_broken,
    }


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
            log.info(f"  [detc] {page}페이지, {len(cases):,}건")
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

    # content-addressed object는 같은 raw payload가 언제 생성되더라도 byte-for-byte
    # 같아야 한다. gzip 기본 mtime은 실행 시각을 넣어 immutable key를 흔든다.
    with open(gz_path, "wb") as raw_stream:
        with gzip.GzipFile(
            filename="",
            mode="wb",
            fileobj=raw_stream,
            compresslevel=9,
            mtime=0,
        ) as gzip_stream:
            gzip_stream.write(json_bytes)

    raw_path = gz_path.replace(".gz", "")
    with open(raw_path, "wb") as f:
        f.write(json_bytes)

    gz_mb = os.path.getsize(gz_path) / (1024 * 1024)
    raw_mb = os.path.getsize(raw_path) / (1024 * 1024)
    log.info(f"  📄 {os.path.basename(raw_path)} ({raw_mb:.2f} MB raw, {gz_mb:.2f} MB gzip)")
    return gz_mb


def export_split_db(db: MasterDB, data_dir: str) -> float:
    """master.db → Core(db.json.gz) 덤프.

    Returns: core_gz_mb
    """
    version = datetime.now().strftime("%Y%m%d")

    # Core: 판례 + 헌재
    core_data, core_skip = db.export_core()
    core_keys = len(core_data)
    if core_keys < MIN_PUBLIC_CORE_KEYS:
        raise PublicationStateError("insufficient_core_keys")

    # 압축 후 확정된 court_code_map (auto-assigned 포함)
    court_map = db.court_resolver.code_map  # name → code

    core_mb = _write_gzipped_json({
        "version": version,
        "total": core_keys,
        "keys": core_keys,
        "cases": core_data,
        "court_code_map": court_map,
    }, os.path.join(data_dir, "db.json"))

    log.info(f"  └ Core: {core_keys:,}건, 법원: {len(court_map)}개")
    return core_mb


def write_local_manifest(
    data_dir: str, *, min_core_keys: int = MIN_PUBLIC_CORE_KEYS
) -> str:
    """R2 credential 유무와 무관하게 검증된 로컬 manifest를 생성한다."""
    from manifest import build_manifest, write_manifest  # noqa: E402

    with open(os.path.join(data_dir, "db.json"), "rb") as stream:
        core_bytes = stream.read()
    manifest_path = os.path.join(data_dir, "manifest.json")
    write_manifest(
        build_manifest(core_bytes, min_core_keys=min_core_keys), manifest_path
    )
    return manifest_path


def _safe_failure_reason(exc: Exception) -> str:
    """상태/로그에는 분류된 오류만 남기고 API key나 응답 원문은 남기지 않는다."""
    if isinstance(exc, RangeFetchError):
        return (
            exc.reason if exc.reason in BACKLOG_FAILURE_REASONS
            else "range_fetch_error"
        )
    return "internal_error"


def crawl_scan_ranges(
    db,
    scan_ranges: list[tuple[str, str]],
    prior_backlog: list[dict] | None = None,
    fetcher=fetch_cases_for_range,
    sleep_fn=None,
    persist_backlog=None,
) -> dict:
    """날짜 범위를 처리하고 성공/실패를 날짜 단위로 확정한다.

    fetcher가 모든 페이지를 반환한 뒤에만 upsert하므로 한 날짜의 부분 결과는
    master DB에도 적용되지 않는다. 반환된 failed가 비어야 public publication이 가능하다.
    """
    prior_by_key = {_backlog_key(item): item for item in (prior_backlog or [])}
    pending_by_key = dict(prior_by_key)
    total_ins = total_upd = total_skip = errors = 0
    consecutive_failures = 0
    circuit_broken = False
    sleep_fn = sleep_fn or (
        lambda: time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
    )

    # 첫 요청 도중 강제 종료되어도 이번 실행의 모든 미시도 범위가 남는다.
    for start_date, end_date in scan_ranges:
        key = ("precedent", start_date, end_date)
        pending_by_key.setdefault(key, {
            "start": start_date,
            "end": end_date,
            "attempts": 0,
            "failed_pages": [],
            "last_error": "scheduled_not_attempted",
        })
    if persist_backlog is not None:
        persist_backlog(list(pending_by_key.values()))

    for i, (start_date, end_date) in enumerate(scan_ranges):
        display = start_date if start_date == end_date else f"{start_date}~{end_date}"
        pct = (i + 1) / len(scan_ranges) * 100 if scan_ranges else 100
        if (i + 1) % 50 == 0 or i == 0:
            log.info(
                f"  [{i + 1:4d}/{len(scan_ranges)}] {display} ({pct:.0f}%)"
            )

        backlog_key = ("precedent", start_date, end_date)
        try:
            date_param = start_date if start_date == end_date else display
            raw = fetcher(date_param)
            if raw:
                ins, upd, skp = db.upsert_raw(raw)
                total_ins += ins
                total_upd += upd
                total_skip += skp
                if ins > 0:
                    log.info(
                        f"  [{i + 1:4d}/{len(scan_ranges)}] {display}"
                        f"  +{ins} 신규, ={upd} 갱신, -{skp} 스킵"
                    )
            # []는 totalCnt=0인 정상 응답. 예외만 실패다.
            consecutive_failures = 0
            pending_by_key.pop(backlog_key, None)
        except Exception as exc:
            errors += 1
            consecutive_failures += 1
            previous = prior_by_key.get(backlog_key, {})
            previous_pages = previous.get("failed_pages", [])
            page = exc.page if isinstance(exc, RangeFetchError) else None
            failed_pages = sorted(set(previous_pages + ([page] if page else [])))
            pending_by_key[backlog_key] = {
                "start": start_date,
                "end": end_date,
                "attempts": int(previous.get("attempts", 0) or 0) + 1,
                "failed_pages": failed_pages,
                "last_error": _safe_failure_reason(exc),
            }
            page_label = f", page={page}" if page else ""
            log.error(
                f"  [{i + 1:4d}/{len(scan_ranges)}] {display}  ❌ "
                f"{_safe_failure_reason(exc)}{page_label}"
            )

        if persist_backlog is not None:
            persist_backlog(list(pending_by_key.values()))

        if consecutive_failures >= CIRCUIT_BREAKER_THRESHOLD:
            remaining_ranges = scan_ranges[i + 1:]
            for remaining_pair in remaining_ranges:
                remaining_key = (
                    "precedent", remaining_pair[0], remaining_pair[1]
                )
                previous = prior_by_key.get(remaining_key, {})
                pending_by_key[remaining_key] = {
                    "start": remaining_pair[0],
                    "end": remaining_pair[1],
                    "attempts": int(previous.get("attempts", 0) or 0),
                    "failed_pages": previous.get("failed_pages", []),
                    "last_error": "circuit_breaker_not_attempted",
                }
            if persist_backlog is not None:
                persist_backlog(list(pending_by_key.values()))
            log.error(
                f"\n  🔌 Circuit Breaker 발동! 연속 {consecutive_failures}건 실패"
                f" — 잔여 {len(remaining_ranges)}건 backlog 유지"
            )
            circuit_broken = True
            break

        sleep_fn()

    return {
        "total_ins": total_ins,
        "total_upd": total_upd,
        "total_skip": total_skip,
        "errors": errors,
        "failed": list(pending_by_key.values()),
        "circuit_broken": circuit_broken,
    }


def publication_allowed(failed: list[dict]) -> bool:
    """사용자용 DB/manifest는 모든 날짜/헌재 페이지가 완료된 경우만 게시한다."""
    return len(failed) == 0


def backlog_counts(backlog: list[dict]) -> tuple[int, int, int]:
    """(판례 범위, 판례 실패 페이지, 헌재 페이지) 개수를 반환한다."""
    precedent = [item for item in backlog if item.get("kind") != "detc"]
    detc = [item for item in backlog if item.get("kind") == "detc"]
    failed_pages = sum(len(item.get("failed_pages", [])) for item in precedent)
    return len(precedent), failed_pages, len(detc)


def execute_local_crawl(
    *,
    master_db_path: str,
    data_dir: str,
    today: date,
    scan_ranges: list[tuple[str, str]],
    detc_pages: list[int],
    prior_backlog: list[dict],
    full_bootstrap: bool,
    backlog_mode: str = BACKLOG_MODE_INCREMENTAL,
) -> dict:
    """DB를 항상 닫으면서 판례/헌재 수집, gate, export를 수행한다."""
    db = MasterDB(master_db_path)
    try:
        before = db.count()
        log.info(f"\n📊 Master DB: {before:,}건")

        has_detc = db.conn.execute(
            "SELECT 1 FROM cases WHERE serial LIKE 'D%' LIMIT 1"
        ).fetchone()
        if not has_detc and not full_bootstrap:
            detc_pages = list(range(1, DETC_MAX_PAGES + 1))

        # 판례 스캔을 시작하기 전에 헌재 schedule까지 함께 journal한다.
        # 두 phase 사이에서 프로세스가 종료돼도 오늘 작업이 유실되지 않는다.
        pending = {_backlog_key(item): item for item in prior_backlog}
        detc_pending_reason = (
            "initial_detc_scan_not_attempted" if not has_detc
            else "scheduled_not_attempted"
        )
        for page in detc_pages:
            pending.setdefault(
                ("detc", page),
                {
                    "kind": "detc",
                    "page": page,
                    "attempts": 0,
                    "last_error": detc_pending_reason,
                },
            )
        prior_backlog = list(pending.values())
        retain_empty = backlog_mode == BACKLOG_MODE_FULL_BOOTSTRAP
        save_failed_dates(
            data_dir,
            prior_backlog,
            mode=backlog_mode,
            retain_empty=retain_empty,
        )

        def persist_backlog(pending):
            save_failed_dates(
                data_dir,
                pending,
                mode=backlog_mode,
                retain_empty=retain_empty,
            )

        crawl_result = crawl_scan_ranges(
            db,
            scan_ranges,
            prior_backlog,
            persist_backlog=persist_backlog,
        )
        total_ins = crawl_result["total_ins"]
        total_upd = crawl_result["total_upd"]
        total_skip = crawl_result["total_skip"]
        errors = crawl_result["errors"]
        current_backlog = crawl_result["failed"]
        circuit_broken = crawl_result["circuit_broken"]

        after_prec = db.count()
        prec_delta = after_prec - before
        log.info(
            f"\n📊 Master DB (판례): {after_prec:,}건 (Δ {prec_delta:+,})"
        )

        detc_pages = merge_detc_pages(detc_pages, current_backlog)
        log.info(f"\n📜 헌재결정례 스캔 ({len(detc_pages)}페이지)")
        detc_result = crawl_detc_scan(
            db,
            detc_pages,
            current_backlog,
            persist_backlog=persist_backlog,
        )
        detc_cases_count = detc_result["cases"]
        detc_ins = detc_result["total_ins"]
        detc_upd = detc_result["total_upd"]
        detc_skip = detc_result["total_skip"]
        current_backlog = detc_result["failed"]
        circuit_broken = circuit_broken or detc_result["circuit_broken"]
        errors += detc_result["errors"]
        save_failed_dates(
            data_dir,
            current_backlog,
            mode=backlog_mode,
            retain_empty=retain_empty,
        )
        log.info(
            f"  헌재: {detc_cases_count:,}건 수집"
            f" → +{detc_ins} 신규, ={detc_upd} 갱신, ⛔{detc_skip} 스킵"
        )

        after = db.count()
        delta = after - before
        log.info(f"\n📊 Master DB (통합): {after:,}건 (Δ {delta:+,})")

        baseline_error = None
        try:
            require_healthy_baseline(
                master_db_path, today, require_detc=True
            )
        except BaselineStateError as exc:
            baseline_error = exc

        if not publication_allowed(current_backlog) or baseline_error is not None:
            precedent_failed, failed_pages, detc_failed = backlog_counts(
                current_backlog
            )
            reason = (
                "invalid_completed_baseline" if baseline_error
                else "partial_crawl"
            )
            log.error(
                "❌ 수집이 완전하지 않아 사용자용 DB/manifest 게시를 차단합니다. "
                f"precedent={precedent_failed}, failed_pages={failed_pages}, "
                f"detc_pages={detc_failed}, baseline_ok={baseline_error is None}"
            )
            write_pipeline_report(
                data_dir,
                status="blocked",
                reason=reason,
                db_total=after,
                precedent_failed=precedent_failed,
                detc_failed=detc_failed,
                circuit_broken=circuit_broken,
            )
            send_pipeline_alert(
                "Circuit Breaker" if circuit_broken else "Partial Crawl",
                f"판례 {precedent_failed}범위/헌재 {detc_failed}페이지 미해결\n"
                "재개 state만 백업하고 사용자용 DB는 last-known-good를 유지",
            )
            sys.exit(1)

        log.info("\n📦 DB 덤프 (Core)")
        try:
            core_mb = export_split_db(db, data_dir)
        except PublicationStateError:
            write_pipeline_report(
                data_dir,
                status="blocked",
                reason="insufficient_public_payload",
                db_total=after,
            )
            send_pipeline_alert(
                "Publication Gate",
                "사용자용 DB가 최소 key 기준을 충족하지 않아 게시 차단",
            )
            sys.exit(1)
        return {
            "after": after,
            "delta": delta,
            "core_mb": core_mb,
            "total_ins": total_ins,
            "total_upd": total_upd,
            "total_skip": total_skip,
            "errors": errors,
            "detc_cases_count": detc_cases_count,
            "detc_ins": detc_ins,
            "circuit_broken": circuit_broken,
        }
    finally:
        db.close()


# ════════════════════════════════════════════════════════════
# Main
# ════════════════════════════════════════════════════════════

def main():
    default_data_dir = os.environ.get("DATA_DIR", "/app/data")

    parser = argparse.ArgumentParser(description="Crawler Date-Modulus Runner")
    parser.add_argument("--plan", action="store_true",
                        help="스캔 계획만 출력 (dry-run)")
    parser.add_argument(
        "--full-bootstrap",
        action="store_true",
        help="빈/불신 master DB를 정부수립일부터 전량 구축",
    )
    parser.add_argument("--data-dir", default=default_data_dir,
                        help=f"Data directory (default: {default_data_dir})")
    args = parser.parse_args()

    data_dir = args.data_dir
    master_db_path = os.path.join(data_dir, "master.db")
    today = date.today()

    if args.full_bootstrap:
        recent_dates = set()
        scan_ranges = get_full_bootstrap_ranges(today)
        detc_pages = list(range(1, DETC_MAX_PAGES + 1))
    else:
        recent_dates = set()
        scan_ranges = get_today_scan_ranges(today, recent_dates=recent_dates)
        detc_pages = get_detc_pages_for_today(today)
    summary = scan_plan_summary(scan_ranges, today, recent_count=len(recent_dates))

    log.info("=" * 55)
    mode = "Full Bootstrap" if args.full_bootstrap else "Range-Modulus"
    log.info(f"  🚀 Crawler Runner ({mode})")
    log.info(f"     날짜: {today}")
    log.info(f"     Serial: {date_serial(today)}")
    log.info(f"     판례: {summary['total']:,}건"
          f" (T0:{summary['tier0']} T1:{summary['tier1']} T2:{summary['tier2']} T3:{summary['tier3']})")
    log.info(f"     헌재: {len(detc_pages)}페이지 (mod {DETC_MOD})")
    log.info(f"     예상: ~{summary['est_minutes']}분")
    log.info("=" * 55)

    if args.plan:
        log.info(f"\n📋 판례 스캔 계획 ({len(scan_ranges)}건):")
        for i, (s, e) in enumerate(scan_ranges[:20]):
            if s == e:
                log.info(f"  {i+1:4d}. {s[:4]}-{s[4:6]}-{s[6:]}")
            else:
                log.info(f"  {i+1:4d}. {s[:4]}-{s[4:6]}-{s[6:]} ~ {e[:4]}-{e[4:6]}-{e[6:]}")
        if len(scan_ranges) > 20:
            log.info(f"  ... ({len(scan_ranges) - 20}건 생략)")
        log.info(f"\n📜 헌재 스캔: {len(detc_pages)}페이지 {detc_pages[:5]}...")
        return

    # 환경변수 검증
    api_key = os.environ.get("BUPGOGAE_API_KEY", "")
    if not api_key or api_key == "test":
        log.error("❌ BUPGOGAE_API_KEY 미설정")
        write_pipeline_report(
            data_dir, status="blocked", reason="missing_api_key"
        )
        sys.exit(1)

    if not args.full_bootstrap:
        try:
            require_healthy_baseline(master_db_path, today)
        except BaselineStateError as exc:
            log.error(f"❌ 증분 수집 기준 DB 차단: {exc}")
            write_pipeline_report(
                data_dir, status="blocked", reason="invalid_baseline"
            )
            send_pipeline_alert(
                "Baseline Failure",
                "증분 수집 기준 master DB가 신뢰 조건을 충족하지 않음",
            )
            sys.exit(1)

    try:
        prior_backlog, persisted_backlog_mode = load_failed_dates_state(data_dir)
    except BacklogStateError as exc:
        log.error(f"❌ backlog 상태 손상으로 게시 차단: {exc}")
        write_pipeline_report(
            data_dir, status="blocked", reason="invalid_backlog"
        )
        send_pipeline_alert(
            "Backlog Failure",
            "재시도 backlog를 안전하게 해석할 수 없어 게시 차단",
        )
        sys.exit(1)
    backlog_mode = persisted_backlog_mode or BACKLOG_MODE_INCREMENTAL

    # 최신 선고 목록 실패는 최근 2년 일 단위 Tier 3가 보완한다.
    if not args.full_bootstrap:
        log.info("🔍 최신선고판결 날짜 추출 중...")
        try:
            recent_dates = fetch_recent_ruling_dates()
            log.info(f"  Tier 0: {len(recent_dates)}개 선고일 감지")
        except ConnectionError:
            log.error("❌ 초기 네트워크 연결 실패")
            write_pipeline_report(
                data_dir, status="blocked", reason="initial_network_failure"
            )
            send_pipeline_alert(
                "Network Failure", "초기 네트워크 연결 실패 — 게시 차단"
            )
            sys.exit(1)
        except Exception as exc:
            log.warning(
                "  ⚠️ 최신선고 추출 실패 (Tier 3 폴백): "
                f"{type(exc).__name__}"
            )
            recent_dates = set()
        scheduled = get_today_scan_ranges(today, recent_dates=recent_dates)
        scan_ranges = merge_scan_ranges(scheduled, prior_backlog)
        summary = scan_plan_summary(
            scheduled, today, recent_count=len(recent_dates)
        )
        summary["total"] = len(scan_ranges)
    else:
        resolved_resume_mode = resolve_full_bootstrap_resume_mode(
            master_db_path,
            today,
            prior_backlog,
            persisted_backlog_mode,
        )
        scan_ranges, detc_pages, prior_backlog = prepare_full_bootstrap_work(
            today, prior_backlog, resolved_resume_mode
        )
        backlog_mode = BACKLOG_MODE_FULL_BOOTSTRAP
        save_failed_dates(
            data_dir,
            prior_backlog,
            mode=backlog_mode,
            # 마지막 item 성공 직후 중단돼도 다음 실행이 완료 상태를 재검증한다.
            retain_empty=True,
        )
        summary = scan_plan_summary(scan_ranges, today)
        if resolved_resume_mode == BACKLOG_MODE_FULL_BOOTSTRAP:
            log.info(
                "  🔄 Full bootstrap 재개: 완료 구간은 제외하고 "
                f"판례 {len(scan_ranges)}범위/헌재 {len(detc_pages)}페이지 처리"
            )

    reset_network_stats()

    now = datetime.now()

    local_result = execute_local_crawl(
        master_db_path=master_db_path,
        data_dir=data_dir,
        today=today,
        scan_ranges=scan_ranges,
        detc_pages=detc_pages,
        prior_backlog=prior_backlog,
        full_bootstrap=args.full_bootstrap,
        backlog_mode=backlog_mode,
    )
    after = local_result["after"]
    delta = local_result["delta"]
    core_mb = local_result["core_mb"]
    total_ins = local_result["total_ins"]
    total_upd = local_result["total_upd"]
    total_skip = local_result["total_skip"]
    errors = local_result["errors"]
    detc_cases_count = local_result["detc_cases_count"]
    detc_ins = local_result["detc_ins"]
    circuit_broken = local_result["circuit_broken"]

    # 분리 publish job에서도 사용할 수 있도록 manifest는 항상 로컬 생성한다.
    try:
        write_local_manifest(data_dir)
    except Exception:
        write_pipeline_report(
            data_dir,
            status="blocked",
            reason="artifact_validation_failed",
            db_total=after,
        )
        raise

    # Docker/기존 단일 프로세스 실행을 위한 선택적 R2 업로드
    r2_vars = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
               "R2_BUCKET", "CF_ACCOUNT_ID"]
    missing_r2 = [v for v in r2_vars if not os.environ.get(v)]
    configured_r2 = [v for v in r2_vars if os.environ.get(v)]

    if not configured_r2:
        log.info("\n📦 R2 credential 없음 — trusted publish job용 로컬 산출물 유지")
    elif missing_r2:
        log.error("❌ 직접 게시 credential 구성이 불완전해 게시 차단")
        write_pipeline_report(
            data_dir,
            status="blocked",
            reason="incomplete_direct_publish_config",
            db_total=after,
        )
        send_pipeline_alert(
            "Publication Configuration",
            "직접 게시 credential 구성이 불완전해 사용자용 게시 차단",
        )
        raise RuntimeError("incomplete direct publish configuration")
    else:
        try:
            # Actions trusted finalize와 같은 immutable-object → manifest commit
            # → legacy fixed mirror 계약을 사용한다. 두 실행 경로가 서로 다른
            # publication 원자성을 갖지 않게 검증/업로드를 한 구현으로 통일한다.
            from publish_outputs import publish_outputs  # noqa: E402
            publish_outputs(data_dir)
        except Exception:
            write_pipeline_report(
                data_dir,
                status="blocked",
                reason="direct_publish_failed",
                db_total=after,
            )
            send_pipeline_alert(
                "Publication Failure", "R2 사용자용 산출물 게시 실패"
            )
            raise

    elapsed = (datetime.now() - now).total_seconds()
    minutes = int(elapsed // 60)
    seconds = int(elapsed % 60)

    log.info(f"\n{'=' * 55}")
    log.info(f"  🏁 완료 ({minutes}분 {seconds}초)")
    log.info(f"     DB: {after:,}건 (Δ {delta:+,})")
    log.info(f"     Core: {core_mb:.2f} MB")
    log.info(f"{'=' * 55}")

    write_pipeline_report(
        data_dir,
        status="success",
        reason="complete",
        db_total=after,
        circuit_broken=False,
    )

    if backlog_mode == BACKLOG_MODE_FULL_BOOTSTRAP:
        # 검증 산출물(및 direct mode 게시)까지 성공한 뒤에만 resume marker를 해소한다.
        save_failed_dates(
            data_dir,
            [],
            mode=backlog_mode,
            retain_empty=False,
        )

    # 텔레그램 리포트
    net_stats = get_network_stats()
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
        elapsed_sec=elapsed,
        r2_uploaded=not missing_r2,
        detc_total=detc_cases_count,
        detc_ins=detc_ins,
        net_stats=net_stats,
        failed_count=0,
        circuit_broken=circuit_broken,
    )


# ════════════════════════════════════════════════════════════
# 텔레그램 리포트
# ════════════════════════════════════════════════════════════

def send_telegram_report(**kwargs):
    """텔레그램 메시지 발송. 환경변수 미설정 시 스킵."""
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")

    if not bot_token or not chat_id:
        log.info("Telegram credential 없음 — trusted notification job에 위임")
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
    r2_status = "✅ 업로드" if r2_uploaded else "⏭️ 스킵"

    detc_total = kwargs.get("detc_total", 0)
    detc_ins_cnt = kwargs.get("detc_ins", 0)

    # 네트워크 통계
    net_stats = kwargs.get("net_stats", {})
    failed_count = kwargs.get("failed_count", 0)
    circuit_broken = kwargs.get("circuit_broken", False)
    net_failures = net_stats.get("failures", 0)
    net_retries = net_stats.get("retries", 0)

    # 상태 이모지: 정상 / 네트워크 경고 / Circuit Breaker
    if circuit_broken:
        status = "🔌"
    elif failed_count > 0 or net_failures > 0:
        status = "⚠️"
    elif errors > 0:
        status = "⚠️"
    else:
        status = "✅"

    # 네트워크 경고 섹션 (실패 시에만 표시)
    net_warning = ""
    if failed_count > 0 or net_failures > 0:
        net_warning = (
            f"\n\n📡 *네트워크 경고*\n"
            f"  요청: {net_stats.get('requests', 0):,}"
            f" | 재시도: {net_retries}"
            f" | 실패: {net_failures}\n"
            f"  📋 누락 항목: {failed_count}건"
        )
        if failed_count > 0:
            net_warning += " → 다음 실행 재시도 예약"
    if circuit_broken:
        net_warning += "\n  🔌 *Circuit Breaker 발동*"

    msg = (
        f"{status} *법고개 Crawler Runner*\n"
        f"`{today}` | {minutes}분 {seconds}초\n"
        f"\n"
        f"📊 *판례*: {scan_count:,}건\n"
        f"  T0: {summary.get('tier0', 0)} | "
        f"T1: {summary.get('tier1', 0)} | "
        f"T2: {summary.get('tier2', 0)} | "
        f"T3: {summary.get('tier3', 0)}\n"
        f"📜 *헌재*: {detc_total:,}건 (+{detc_ins_cnt} 신규)\n"
        f"\n"
        f"🗄 *Master DB*: {db_total:,}건 (Δ {db_delta:+,})\n"
        f"  +{total_ins} 신규 | ={total_upd} 갱신 | ⛔{total_skip} 스킵 | ❌{errors} 에러\n"
        f"\n"
        f"📦 *Core*: {gz_mb:.2f} MB\n"
        f"☁️ *R2*: {r2_status}"
        f"{net_warning}"
    )

    try:
        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        resp = _requests.post(url, json={
            "chat_id": chat_id,
            "text": msg,
            "parse_mode": "Markdown",
        }, timeout=10)
        if resp.status_code == 200:
            log.info("📨 텔레그램 리포트 전송 완료")
        else:
            log.warning(f"⚠️ 텔레그램 전송 실패: HTTP {resp.status_code}")
    except Exception as e:
        # bot token이 포함된 요청 URL이 예외 문자열에 노출될 수 있어 타입만 기록한다.
        log.warning(f"⚠️ 텔레그램 전송 실패: {type(e).__name__}")


if __name__ == "__main__":
    main()
