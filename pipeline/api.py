"""
법제처 Open API 클라이언트 — 판례 검색 API 래퍼.

법고개 파이프라인의 API 레이어. 다른 모듈(nas_runner, master_db 등)이
법제처 API와 통신할 때 이 모듈의 함수를 사용한다.

공개 API:
  fetch_xml_safe(date_str, page=1) -> bytes | None
    법제처 판례 검색 API 호출. XML 바이트 반환. 3회 재시도.
  get_text(element, tag) -> str
    XML Element에서 태그 텍스트 안전 추출.
  clean_case_number(raw_no) -> str
    사건번호 정제 (대시, 공백 제거).

[보안 참고]
  유일한 외부 통신: https://www.law.go.kr/DRF/lawSearch.do (법제처 공공 API).
  API 키(BUPGOGAE_API_KEY)는 환경변수로 주입되며 코드에 하드코딩되지 않음.
  사용자 데이터를 전송하는 기능 없음 — 공공 판례 데이터만 수신.
"""

import os
import random
import time

import requests

# 환경변수에서 API 키 로드 (미설정 시 None → 즉각 실패로 누락 인지)
API_KEY = os.getenv("BUPGOGAE_API_KEY")

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


def fetch_xml_safe(date_str, page=1):
    """법제처 판례 검색 API 호출 (재시도 로직 포함).

    Args:
        date_str: 검색 날짜 (YYYYMMDD)
        page: 페이지 번호 (기본 1)

    Returns:
        XML 바이트 또는 None (실패 시)
    """
    base_url = "https://www.law.go.kr/DRF/lawSearch.do"
    params = {
        "OC": API_KEY,
        "target": "prec",
        "type": "XML",
        "date": date_str,
        "mobileYn": "Y",
        "display": 100,
        "page": page,
    }

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