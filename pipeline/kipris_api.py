"""
KIPRIS Plus OpenAPI 클라이언트 — 특허심판원 심판사항 검색.

KIPRIS Plus 심판사항(DBII_000000000000019) 데이터를 가져오는 API 래퍼.
'심결일자' 기준 항목별검색(trialdecisionDateSearchInfo)을 사용한다.

2025-03 서비스명 변경: trialInfoSearchService → judgmentInfoSearchService
  - 파라미터: trialDecisionDate → trialDate
  - 페이징: pageNo/numOfRows → docsStart/docsCount
  - 구 서비스 자동 폴백 지원

공개 API:
  fetch_kipris_xml(start_date, end_date, page_no) → bytes | None
  parse_kipris_items(xml_bytes) → (list[dict], int)

[보안 참고]
  외부 통신: KIPRIS Plus REST API (read-only GET 요청만).
  인증 키는 환경변수(KIPRIS_API_KEY)로 주입되며 코드에 하드코딩되지 않음.
"""

import os
import random
import time
import xml.etree.ElementTree as ET

import requests

# 환경변수에서 API 키 로드
KIPRIS_API_KEY = os.getenv("KIPRIS_API_KEY", "")

# KIPRIS Plus 심판사항
# 2025-03 서비스명 변경: trialInfoSearchService → judgmentInfoSearchService
# getAdvancedSearch: 전체검색 (신규 추천 오퍼레이션)
# trialdecisionDateSearchInfo: 심결일자 기준 항목별검색
_SVC_NEW = "http://plus.kipris.or.kr/kipo-api/kipi/judgmentInfoSearchService"
_SVC_OLD = "http://plus.kipris.or.kr/kipo-api/kipi/trialInfoSearchService"

BASE_URL = f"{_SVC_NEW}/getAdvancedSearch"
BASE_URL_ALT = f"{_SVC_NEW}/trialdecisionDateSearchInfo"
LEGACY_BASE_URL = f"{_SVC_OLD}/trialdecisionDateSearchInfo"

# 페이지당 최대 출력 건수 (API 파라미터명과 무관한 범용 상수)
PAGE_SIZE = 500

# 요청 딜레이 (초)
DELAY_MIN = 0.8
DELAY_MAX = 1.5

# 봇 탐지 회피용 헤더
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
}

# 폴백 유도 키워드 — 이 문자열이 API 에러에 포함되면 다음 엔드포인트로 넘어감
_FALLBACK_KEYWORDS = ("EXPIRED", "INVALID REQUEST PARAMETER")


def _try_fetch(url: str, params: dict, retries: int = 3) -> bytes | None:
    """단일 엔드포인트 호출 시도 (내부용).

    API 에러 중 EXPIRED / INVALID PARAMETER가 포함되면 None을 반환하여
    상위 호출자가 다음 엔드포인트로 폴백할 수 있도록 한다.
    """
    for attempt in range(retries):
        try:
            response = requests.get(
                url, params=params, headers=HEADERS, timeout=30,
            )

            if response.status_code == 200:
                err = check_api_error(response.content)
                if err:
                    # 폴백 대상 에러인지 확인
                    upper = err.upper()
                    if any(kw in upper for kw in _FALLBACK_KEYWORDS):
                        return None  # 폴백 필요
                return response.content

            # 429 Too Many Requests / 500 / 504 → 재시도
            if response.status_code in (429, 500, 504):
                wait = 5 * (2 ** attempt)
                print(f"⚠️ [HTTP {response.status_code}] "
                      f"{wait}초 대기 후 재시도 ({attempt + 1}/{retries})...")
                time.sleep(wait)
                continue

            # 그 외 에러
            print(f"❌ [HTTP {response.status_code}] {response.text[:200]}")
            return None

        except requests.exceptions.RequestException as e:
            wait = 5 * (2 ** attempt)
            print(f"❌ [Network Error] {e}. {wait}초 후 재시도...")
            time.sleep(wait)

    return None


def fetch_kipris_xml(
    start_date: str,
    end_date: str,
    page_no: int = 1,
    access_key: str | None = None,
) -> bytes | None:
    """KIPRIS Plus 심결일자 기준 검색 API 호출.

    3단계 폴백 전략:
      1차: judgmentInfoSearchService/getAdvancedSearch (신규 전체검색)
      2차: judgmentInfoSearchService/trialdecisionDateSearchInfo (신규 항목별)
      3차: trialInfoSearchService/trialdecisionDateSearchInfo (구 서비스)

    Args:
        start_date: 검색 시작일 (YYYYMMDD)
        end_date:   검색 종료일 (YYYYMMDD)
        page_no:    페이지 번호 (기본 1)
        access_key: API 키 (None이면 환경변수 사용)

    Returns:
        XML bytes 또는 None (실패 시)
    """
    key = access_key or KIPRIS_API_KEY
    if not key:
        print("❌ KIPRIS_API_KEY 미설정")
        return None

    # ── 1차: 신규 getAdvancedSearch ──
    new_params = {
        "ServiceKey": key,
        "trialDate": f"{start_date}~{end_date}",
        "numOfRows": PAGE_SIZE,
        "pageNo": page_no,
    }
    result = _try_fetch(BASE_URL, new_params)
    if result is not None:
        return result

    # ── 2차: 신규 trialdecisionDateSearchInfo ──
    alt_params = {
        "ServiceKey": key,
        "trialDate": f"{start_date}~{end_date}",
        "docsCount": PAGE_SIZE,
        "docsStart": page_no,
    }
    result = _try_fetch(BASE_URL_ALT, alt_params)
    if result is not None:
        return result

    # ── 3차: 구 서비스 폴백 ──
    print("⚠️ 신규 서비스 실패 → 구 서비스 폴백 시도")
    legacy_params = {
        "ServiceKey": key,
        "trialDecisionDate": f"{start_date}~{end_date}",
        "numOfRows": PAGE_SIZE,
        "pageNo": page_no,
    }
    return _try_fetch(LEGACY_BASE_URL, legacy_params)


def check_api_error(xml_bytes: bytes) -> str | None:
    """API 응답 XML 헤더의 에러 여부 확인.

    Returns:
        에러 메시지 문자열 (에러 시), None (정상 시)
    """
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return "XML 파싱 오류"

    header = root.find("header")
    if header is None:
        # 자식 요소가 전혀 없는 빈 응답 (<response/>) 감지
        if len(root) == 0:
            return "EMPTY_RESPONSE"
        return None  # 헤더 없으면 정상 취급

    success = _get_text(header, "successYN")
    if success == "N":
        code = _get_text(header, "resultCode")
        msg = _get_text(header, "resultMsg")
        return f"[{code}] {msg}" if code else msg or "UNKNOWN API ERROR"

    return None


def parse_kipris_items(xml_bytes: bytes) -> tuple[list[dict], int, str | None]:
    """XML 응답을 파싱하여 심판 아이템 리스트, totalCount, 에러메시지를 반환.

    Args:
        xml_bytes: API 응답 XML 바이트

    Returns:
        (items, total_count, error_msg) 튜플
          items: [{"serial": ..., "case_name": ..., "case_number": ...,
                   "decision_date": ..., "trial_type": ...}, ...]
          total_count: 전체 검색 건수
          error_msg: API 에러 메시지 (정상 시 None)
    """
    # 먼저 API 에러 확인
    api_error = check_api_error(xml_bytes)
    if api_error:
        return [], 0, api_error

    items = []
    total_count = 0

    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        return items, total_count, f"XML 파싱 오류: {e}"

    # totalCount 추출
    count_el = root.find(".//count/totalCount")
    if count_el is not None and count_el.text:
        try:
            total_count = int(count_el.text)
        except ValueError:
            pass

    # 아이템 추출 — 신규/구 서비스 양쪽 호환
    for tag in ("judgmentInfoSearchService", "trialInfoSearchService"):
        for item in root.iter(tag):
            serial = _get_text(item, "trialNumber")  # 심판번호
            if not serial:
                continue

            items.append({
                "serial": serial,
                "case_name": _get_text(item, "inventionTitle"),  # 명칭
                "case_number": _get_text(item, "trialNumber"),  # 심판번호
                "decision_date": _get_text(item, "trialDecisionDate"),  # 심결일자
                "trial_type": _get_text(item, "trialType"),  # 심판종류
            })
        if items:
            break  # 한 태그에서 찾았으면 다른 태그 스킵

    # 메모리 해제
    del root

    return items, total_count, None


def _get_text(element: ET.Element, tag: str) -> str:
    """XML 태그 텍스트 안전 추출."""
    found = element.find(tag)
    if found is not None and found.text:
        return found.text.strip()
    return ""


# 자체 테스트 (직접 실행 시)
if __name__ == "__main__":
    key = KIPRIS_API_KEY
    if not key:
        print("❌ KIPRIS_API_KEY 환경변수를 설정해주세요.")
        print("   예: set KIPRIS_API_KEY=your_key_here")
    else:
        print(f"🔑 API Key: {key[:8]}...{key[-4:]}")

        # 신규 엔드포인트 직접 테스트
        print(f"\n📡 [신규] judgmentInfoSearchService 테스트...")
        print(f"   URL: {BASE_URL}")
        xml = fetch_kipris_xml("20240101", "20240131", page_no=1)
        if xml:
            items, total, err = parse_kipris_items(xml)
            if err:
                print(f"   ❌ API 에러: {err}")
            else:
                print(f"   ✅ totalCount={total}, items={len(items)}")
                if items:
                    print(f"   📄 첫번째: {items[0]}")
        else:
            print("   ❌ API 호출 실패 (폴백 포함)")

        # 구 엔드포인트 직접 테스트
        print(f"\n📡 [구] trialInfoSearchService 테스트...")
        print(f"   URL: {LEGACY_BASE_URL}")
        legacy_params = {
            "ServiceKey": key,
            "trialDecisionDate": "20240101~20240131",
            "numOfRows": 5,
            "pageNo": 1,
        }
        result = _try_fetch(LEGACY_BASE_URL, legacy_params)
        if result:
            items2, total2, err2 = parse_kipris_items(result)
            if err2:
                print(f"   ❌ API 에러: {err2}")
            else:
                print(f"   ✅ totalCount={total2}, items={len(items2)}")
        else:
            print("   ❌ 구 서비스도 실패")
