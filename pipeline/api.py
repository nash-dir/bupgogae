"""
법제처 Open API 클라이언트 — 판례/헌재결정례 검색 API 래퍼.

법고개 파이프라인의 API 레이어. 다른 모듈(nas_runner, master_db 등)이
법제처 API와 통신할 때 이 모듈의 함수를 사용한다.

공개 API:
  fetch_xml_safe(date_str, page, target, query) → bytes | None
  get_text(element, tag) → str
  clean_case_number(raw_no) → str
"""

import os
import random
import time

import requests

# 환경변수에서 API 키 로드
API_KEY = os.getenv("BUPGOGAE_API_KEY", "test")

# 요청 딜레이 (초)
DELAY_MIN = 0.8
DELAY_MAX = 1.0

# 봇 탐지 회피용 헤더
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.law.go.kr/",
}


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
    """법제처 API 호출 (재시도 로직 포함).

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

    retries = 3
    for i in range(retries):
        try:
            response = requests.get(
                base_url, params=params, headers=HEADERS, timeout=15,
            )
            if response.status_code == 200:
                return response.content

            print(f"⚠️ [HTTP {response.status_code}] "
                  f"잠시 대기 후 재시도 ({i + 1}/{retries})...")
            time.sleep(5 * (i + 1))

        except requests.exceptions.RequestException as e:
            print(f"❌ [Network Error] {e}. 재시도 중...")
            time.sleep(5)

    return None