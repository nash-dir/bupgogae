"""
법제처 Open API 클라이언트 — 판례/헌재결정례 검색 API 래퍼.

법고개 파이프라인의 API 레이어. 다른 모듈(crawler_runner, master_db 등)이
법제처 API와 통신할 때 이 모듈의 함수를 사용한다.

공개 API:
  fetch_xml_safe(date_str, page, target, query) → bytes | None
  get_text(element, tag) → str
  clean_case_number(raw_no) → str
  get_network_stats() → dict
  reset_network_stats() → None
"""

import os
import time

import requests
from requests.adapters import HTTPAdapter

from log_setup import get_logger
from config import LAW_TIMEOUT

log = get_logger(__name__)

# 환경변수에서 API 키 로드
API_KEY = os.getenv("BUPGOGAE_API_KEY", "test")

# 봇 탐지 회피용 헤더
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.law.go.kr/",
}

# ── 네트워크 통계 (모듈 수준) ──
_stats = {
    "requests": 0,  # logical fetch_xml_safe calls
    "attempts": 0,  # physical HTTP requests
    "success": 0,
    "retries": 0,
    "failures": 0,
}

MAX_ATTEMPTS = 5
RETRYABLE_STATUS_CODES = {408, 429}
MAX_XML_BYTES = 5 * 1024 * 1024


class ResponseBodyTooLarge(Exception):
    """법제처 응답이 페이지별 안전 상한을 초과함."""


def get_network_stats() -> dict:
    """현재 세션의 네트워크 통계 반환."""
    return dict(_stats)


def reset_network_stats():
    """네트워크 통계 초기화."""
    _stats.update({
        "requests": 0,
        "attempts": 0,
        "success": 0,
        "retries": 0,
        "failures": 0,
    })


# ── 커넥션 풀 세션 (TCP/TLS 핸드셰이크 재사용) ──
_session = None


def _get_session() -> requests.Session:
    """자동 재시도 없이 커넥션 풀링만 제공하는 세션 반환."""
    global _session
    if _session is None:
        _session = requests.Session()
        adapter = HTTPAdapter(
            # 재시도는 fetch_xml_safe 한 곳에서만 수행한다. urllib3의 숨은
            # 재시도와 중첩하지 않아 실제 요청 횟수와 telemetry를 일치시킨다.
            max_retries=0,
            pool_connections=5,
            pool_maxsize=5,
        )
        _session.mount("https://", adapter)
        _session.headers.update(HEADERS)
    return _session


def _backoff_seconds(attempt_index: int) -> int:
    """0-based 실패 attempt 뒤의 bounded backoff."""
    return min(5 * (2 ** attempt_index), 60)


def _request_error_kind(error: requests.exceptions.RequestException) -> str:
    """URL/요청 객체를 직렬화하지 않는 안전한 오류 분류."""
    if isinstance(error, requests.exceptions.Timeout):
        return "timeout"
    if isinstance(error, requests.exceptions.SSLError):
        return "tls"
    if isinstance(error, requests.exceptions.ConnectionError):
        return "connection"
    return "request"


def _is_retryable_status(status_code: int) -> bool:
    return status_code in RETRYABLE_STATUS_CODES or 500 <= status_code <= 599


def _read_bounded_body(response) -> bytes:
    raw_length = response.headers.get("Content-Length")
    if raw_length is not None:
        try:
            declared_length = int(raw_length)
        except (TypeError, ValueError):
            declared_length = None
        if declared_length is not None and declared_length > MAX_XML_BYTES:
            raise ResponseBodyTooLarge

    chunks = []
    total = 0
    for chunk in response.iter_content(chunk_size=64 * 1024):
        if not chunk:
            continue
        total += len(chunk)
        if total > MAX_XML_BYTES:
            raise ResponseBodyTooLarge
        chunks.append(chunk)
    return b"".join(chunks)


def get_text(element, tag):
    """XML 태그 텍스트 안전 추출."""
    found = element.find(tag)
    if found is not None and found.text:
        return found.text.strip()
    return ""


def clean_case_number(raw_no):
    """사건번호 정제 (대시, 공백 제거)."""
    if not raw_no:
        return ""
    return raw_no.replace("-", "").replace(" ", "")


def fetch_xml_safe(date_str=None, page=1, target="prec", query=None, sort=None):
    """법제처 API 호출 (지수 백오프 재시도 포함).

    Args:
        date_str: 검색 날짜 (YYYYMMDD) — prec 전용
        page: 페이지 번호 (기본 1)
        target: API 대상 ("prec"=판례, "detc"=헌재결정례 등)
        query: 검색어 — detc 등 query 기반 API용
        sort: 정렬 ("efdes"=종국일자 내림차순 등)

    Returns:
        XML 바이트 또는 None (실패 시)
    """
    base_url = "https://www.law.go.kr/DRF/lawSearch.do"
    params = {
        "OC": API_KEY,
        "target": target,
        "type": "XML",
        "display": 100,
        "page": page,
    }
    if date_str:
        params["date"] = date_str
        params["mobileYn"] = "Y"
    if query:
        params["query"] = query
    if sort:
        params["sort"] = sort

    _stats["requests"] += 1
    session = _get_session()
    for attempt_index in range(MAX_ATTEMPTS):
        _stats["attempts"] += 1
        response = None
        try:
            response = session.get(
                base_url,
                params=params,
                timeout=LAW_TIMEOUT,
                allow_redirects=False,
                stream=True,
            )
            if response.status_code == 200:
                content = _read_bounded_body(response)
                _stats["success"] += 1
                return content

            if not _is_retryable_status(response.status_code):
                log.error(
                    "❌ 법제처 API 요청 실패 "
                    f"(status={response.status_code}, attempts={attempt_index + 1}, "
                    "retryable=false)"
                )
                break

            if attempt_index == MAX_ATTEMPTS - 1:
                log.error(
                    "❌ 법제처 API 요청 실패 "
                    f"(status={response.status_code}, attempts={MAX_ATTEMPTS})"
                )
                break

            _stats["retries"] += 1
            backoff = _backoff_seconds(attempt_index)
            log.warning(
                "⚠️ 법제처 API 재시도 "
                f"(kind=transient, status={response.status_code}, "
                f"next_attempt={attempt_index + 2}/{MAX_ATTEMPTS}, "
                f"backoff={backoff}s)"
            )
            time.sleep(backoff)

        except ResponseBodyTooLarge:
            log.error(
                "❌ 법제처 API 요청 실패 "
                f"(kind=response_too_large, attempts={attempt_index + 1}, "
                "retryable=false)"
            )
            break
        except requests.exceptions.RequestException as e:
            kind = _request_error_kind(e)
            if attempt_index == MAX_ATTEMPTS - 1:
                log.error(
                    "❌ 법제처 API 요청 실패 "
                    f"(kind={kind}, attempts={MAX_ATTEMPTS})"
                )
                break

            _stats["retries"] += 1
            backoff = _backoff_seconds(attempt_index)
            # RequestException 문자열에는 OC query와 URL이 포함될 수 있다.
            # 예외 객체 자체는 절대 로그 포맷에 전달하지 않는다.
            log.warning(
                "⚠️ 법제처 API 재시도 "
                f"(kind={kind}, next_attempt={attempt_index + 2}/"
                f"{MAX_ATTEMPTS}, backoff={backoff}s)"
            )
            time.sleep(backoff)
        finally:
            if response is not None:
                response.close()

    _stats["failures"] += 1
    return None
