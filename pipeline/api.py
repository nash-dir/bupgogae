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
import random
import time

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from log_setup import get_logger
from config import LAW_DELAY_MIN as DELAY_MIN, LAW_DELAY_MAX as DELAY_MAX, LAW_TIMEOUT

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
_stats = {"requests": 0, "success": 0, "retries": 0, "failures": 0}


def get_network_stats() -> dict:
    """현재 세션의 네트워크 통계 반환."""
    return dict(_stats)


def reset_network_stats():
    """네트워크 통계 초기화."""
    _stats.update({"requests": 0, "success": 0, "retries": 0, "failures": 0})


# ── 커넥션 풀 세션 (TCP/TLS 핸드셰이크 재사용) ──
_session = None


def _get_session() -> requests.Session:
    """커넥션 풀링 + 자동 재시도 세션 반환 (lazy init)."""
    global _session
    if _session is None:
        _session = requests.Session()
        retry = Retry(
            total=3,
            backoff_factor=1,           # 1, 2, 4초 자동 백오프
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["GET"],
            raise_on_status=False,
        )
        adapter = HTTPAdapter(
            max_retries=retry,
            pool_connections=5,
            pool_maxsize=5,
        )
        _session.mount("https://", adapter)
        _session.headers.update(HEADERS)
    return _session


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
    retries = 5
    for i in range(retries):
        try:
            response = session.get(
                base_url, params=params, timeout=LAW_TIMEOUT,
            )
            if response.status_code == 200:
                _stats["success"] += 1
                return response.content

            _stats["retries"] += 1
            backoff = min(5 * (2 ** i), 60)  # 5, 10, 20, 40, 60초
            log.warning(f"⚠️ [HTTP {response.status_code}] "
                  f"대기 {backoff}초 후 재시도 ({i + 1}/{retries})...")
            time.sleep(backoff)

        except requests.exceptions.RequestException as e:
            _stats["retries"] += 1
            backoff = min(5 * (2 ** i), 60)
            log.error(f"❌ [Network Error] {e}. "
                  f"대기 {backoff}초 후 재시도 ({i + 1}/{retries})...")
            time.sleep(backoff)

    _stats["failures"] += 1
    return None