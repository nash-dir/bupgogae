"""
법고개(Bupgogae) — 판례 DB → 초경량 JSON 압축 파이프라인
=========================================================
SQLite master.db를 브라우저 확장프로그램용 정적 JSON으로 변환한다.

[압축 전략]
  Key  : "15Da12345"  ← 연도 2자리 + 영문 사건부호 + 일련번호
  Value: [[serial_number, court_code, date_int, case_name], ...]  ← 1:N 배열

공용 압축 함수와 사건부호 사전이다. DB export는 MasterDB.export_core()를 사용한다.

[보안 참고]
  이 스크립트는 SQLite → JSON 순수 변환만 수행한다.
  외부 네트워크 요청 없음. 파일 시스템 읽기/쓰기만 발생.
"""

import re

from public_contract import derive_short_case_keys as _derive_short_case_keys

from log_setup import get_logger

log = get_logger(__name__)


# ============================================================
# 1. 사건부호 한글→영문 매핑 테이블 (159개 사건부호 커버)
#    - 실제 DB에서 추출된 전체 부호 기반으로 작성
#    - 빈도순 상위 부호는 짧은 코드 할당
#    - 이 테이블은 저장 codec이지 사건 분류 사전이 아니다. 사건 의미·사용 시기는
#      docs/case-code-sources.md의 공식 출처를 기준으로 별도 관리한다.
# ============================================================
CASE_CODE_MAP = {
    # === 상위 빈도 (1,000건 이상) ===
    "누": "Nu",       # 24,413건
    "다": "Da",       # 23,460건
    "구합": "Guh",    # 18,980건
    "도": "Do",       # 13,952건
    "두": "Du",       # 13,026건
    "나": "Na",       # 10,312건
    "가단": "Gad",    #  5,247건
    "가합": "Gah",    #  4,920건
    "노": "No",       #  4,356건
    "구단": "Gud",    #  3,213건
    "구": "Gu",       #  2,973건
    "후": "Hu",       #  2,737건
    "다카": "Dak",    #  2,499건
    "마": "Ma",       #  1,884건
    # === 중간 빈도 (100~999건) ===
    "고단": "God", "고합": "Goh", "민상": "Mis", "허": "Heo",
    "므": "Meu", "모": "Mo", "라": "Ra", "그": "Geu",
    "형상": "Hys", "고정": "Goj", "행상": "Has", "스": "Su",
    "추": "Chu", "가소": "Gas", "르": "Reu", "감도": "Gmd",
    "카합": "Kah", "드": "Deu", "민공": "Mig", "재누": "JNu",
    "사": "Sa", "브": "Beu", "수": "Soo", "무": "Mu",
    "로": "Ro", "초": "Cho", "드단": "Ded", "재두": "JDu",
    # === 하위 빈도 (10~99건) ===
    "아": "Ah",
    "카기": "Kag",
    "재다": "JDa",
    "카": "Ka",
    "재나": "JNa",
    "행": "Hae",
    "드합": "Deh",
    "오": "Oh",
    "초기": "Chg",
    "민재항": "MJh",
    "부": "Bu",
    "느단": "Ned",
    "재구합": "JGuh",
    "재노": "JNo",
    "보": "Bo",
    "느합": "Neh",
    "파": "Pa",
    "느": "Ne",
    "프": "Peu",
    "으": "Eu",
    "재고합": "JGoh",
    "우": "U",
    "마카": "Mak",
    "주": "Ju",
    "코": "Ko",
    "루": "Ru",
    "즈기": "Jg",
    "카단": "Kad",
    "고": "Go",
    "형공": "Hyg",
    "소": "So",
    "재도": "JDo",
    "타기": "Tag",
    "카담": "Kam",
    "재다카": "JDak",
    "감노": "Gmn",
    "비합": "Bih",
    # === 극소 빈도 (<10건) — 포괄 처리 ===
    "민재": "MJ",     "재마": "JMa",    "과": "Gwa",
    "카확": "Kak",    "카경": "Kgy",    "즈": "Jeu",
    "비단": "Bid",    "형비상": "HBS",  "형재항": "HJh",
    "형항": "Hyh",    "슈": "Syu",      "재가합": "JGah",
    "재구단": "JGud", "어": "Eo",       "인라": "InR",
    "쿠": "Ku",       "타": "Ta",       "트": "Teu",
    "재후": "JHu",    "타채": "Tac",    "인마": "InM",
    "회합": "Hwh",    "비상": "BS",     "민항": "Mih",
    "특상": "Tks",    "재구": "JGu",    "하합": "Hah",
    "토": "To",       "하면": "Ham",    "재고단": "JGod",
    "형재": "HyJ",    "가": "Ga",       "행항": "Hah2",
    "흐": "Heu",      "타경": "Tgy",    "머": "Meo",
    "하": "Ha",       "거": "Geo",      "즈합": "Jeh",
    "서": "Seo",      "초재": "ChJ",    "카정": "Kaj",
    "형비": "HyB",    "형": "Hy",       "민": "Mi",
    "노형공": "NHG",  "민특상": "MTS",  "민준재": "MJJ",
    "이": "Yi",       "특재": "TkJ",    "노합": "Noh",
    "휴": "Hyu",      "감고": "Gmg",    "나합": "Nah",
    "재감도": "JGmd", "푸": "Pu",       "영장": "YJ",
    "재감노": "JGmn", "재수": "JSo",    "재자": "JJa",
    "재보군형": "JBG", "정로": "JRo",   "즈단": "Jed",
    "준재가단": "JJGd","정모": "JMo",   "중해심": "JHS",
    "인": "In",       "하단": "Had",    "재가단": "JGad",
    "전도": "JeD",    "카허": "KaH",    "개기": "GaG",
    "재드단": "JDed", "기": "Gi",       "고약": "GoY",
    "재르": "JRe",    "정스": "JSu",    "수흐": "SuH",
    "터": "Teo",      "커": "Keo",
    # === 헌법재판소 사건부호 (8종) ===
    "헌가": "HG", "헌나": "HN", "헌다": "HD", "헌라": "HR",
    "헌마": "HM", "헌바": "HB", "헌사": "HS", "헌아": "HA",
}

# 역방향 매핑 (디코딩용, 메타에 포함)


# ============================================================
# 1-B. 사건명 처리
#    사건명 토큰 압축(BPE 등)은 gzip 후 실익 < 0.5MB로 판단되어 미적용.
#    원문 그대로 저장하여 가독성과 디버깅 편의성을 유지한다.
# ============================================================


# ============================================================
# 2. 법원명 → 정수 코드 매핑 (빈도순, 1바이트 범위 우선)
# ============================================================
COURT_CODE_MAP = {
    "대법원": 1,
    "헌법재판소": 2,
    # --- 고등법원 (10~19) ---
    "서울고등법원": 10,
    "부산고등법원": 11,
    "대구고등법원": 12,
    "광주고등법원": 13,
    "대전고등법원": 14,
    "수원고등법원": 15,
    "서울고등법원(춘천)": 16,
    "서울고등법원(인천)": 17,
    "부산고등법원(창원)": 18,
    "대전고등법원(청주)": 19,
    "광주고등법원(전주)": 20,
    "광주고등법원(제주)": 21,
    # --- 특수법원 (30~39) ---
    "서울행정법원": 30,
    "특허법원": 31,
    "서울가정법원": 32,
    # --- 지방법원 (40~59) ---
    "서울중앙지방법원": 40,
    "서울남부지방법원": 41,
    "서울동부지방법원": 42,
    "서울서부지방법원": 43,
    "서울북부지방법원": 44,
    "수원지방법원": 45,
    "인천지방법원": 46,
    "의정부지방법원": 47,
    "부산지방법원": 48,
    "대구지방법원": 49,
    "대전지방법원": 50,
    "광주지방법원": 51,
    "창원지방법원": 52,
    "울산지방법원": 53,
    "청주지방법원": 54,
    "전주지방법원": 55,
    "춘천지방법원": 56,
    "제주지방법원": 57,
    # --- 폐지/구 법원 (60~69) ---
    "서울지방법원": 60,
    "서울민사지방법원": 61,
    "서울형사지방법원": 62,
    # 미등록 법원은 0 (unknown)
}

# 미등록(지원 등) 법원에 자동 부여하는 코드 시작값
BRANCH_CODE_START = 100


class CourtCodeResolver:
    """법원명 → 정수 코드 변환기.

    미등록 법원(지원 등)은 인스턴스 로컬에서 동적 할당한다.
    전역 가변 상태를 제거하기 위한 캡슐화로, 한 번의 변환 세션
    (예: 1회 DB 덤프)마다 독립 인스턴스를 사용하므로:
      - 스레드 안전 (전역 dict/카운터 공유 없음)
      - 실행 간 결정적 (기준 테이블 COURT_CODE_MAP을 변이하지 않음)

    기준 테이블은 복사본으로 보유하며 원본은 절대 수정하지 않는다.
    """

    def __init__(self, base_map: dict | None = None):
        self._map = dict(base_map if base_map is not None else COURT_CODE_MAP)
        self._next_branch_code = max([BRANCH_CODE_START - 1, *self._map.values()])

    def resolve(self, court_name: str) -> int:
        """법원명을 정수 코드로 변환. 미등록은 동적 할당."""
        if not court_name:
            return 0
        if court_name in self._map:
            return self._map[court_name]
        self._next_branch_code += 1
        self._map[court_name] = self._next_branch_code
        return self._next_branch_code

    @property
    def code_map(self) -> dict:
        """기준 + 동적 할당분을 포함한 최종 매핑 (읽기용 복사본)."""
        return dict(self._map)


# ============================================================
# 3. 핵심 변환 함수
# ============================================================

def compress_case_number(case_number: str) -> str | None:
    """
    사건번호 → 압축 키 변환.
    "2015다12345" → "15Da12345"
    "92가단28561" → "92Gad28561"
    """
    if not case_number:
        return None

    # 공백, 콤마 제거 (병합 사건)
    clean = case_number.strip()

    # 법원 판례/헌재: "YYYY[부호]NNNN"
    clean = clean.replace(" ", "")

    # 패턴: [연도 2~4자리][한글 사건부호 1~4자리][숫자 일련번호]
    m = re.match(r'^(\d{2,4})([가-힣]{1,4})(\d+)$', clean)
    if not m:
        return None

    year_str = m.group(1)
    code_kr = m.group(2)
    serial = m.group(3)

    # 연도 → 끝 2자리
    year_2d = year_str[-2:]

    # 한글 부호 → 영문
    code_en = CASE_CODE_MAP.get(code_kr)
    if not code_en:
        # 미등록 부호 → 한글 그대로 (fallback)
        code_en = code_kr

    return f"{year_2d}{code_en}{serial}"


def compress_date(date_str: str) -> int:
    """
    선고일 → 6자리 정수.
    "2023.10.25" → 231025
    "1995.01.15" → 950115
    "20230915"   → 230915  (구분자 없는 형식)
    """
    if not date_str:
        return 0
    # "YYYY.MM.DD" 또는 "YYYY-MM-DD" 또는 "YYYY/MM/DD"
    clean = date_str.replace("-", ".").replace("/", ".")
    parts = clean.split(".")
    if len(parts) == 3:
        try:
            y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
            return (y % 100) * 10000 + m * 100 + d
        except ValueError:
            return 0
    # "YYYYMMDD" 구분자 없는 형식
    digits = clean.replace(".", "")
    if len(digits) >= 8 and digits[:8].isdigit():
        try:
            y = int(digits[:4]) % 100
            m = int(digits[4:6])
            d = int(digits[6:8])
            return y * 10000 + m * 100 + d
        except ValueError:
            return 0
    return 0


def compress_case_name(name: str) -> str:
    """사건명은 원문 그대로 저장 (gzip이 충분히 압축)."""
    return name.strip() if name else ""


def derive_short_case_keys(cases: dict, case_code_map: dict | None = None) -> list[str]:
    return _derive_short_case_keys(cases, CASE_CODE_MAP if case_code_map is None else case_code_map)


if __name__ == "__main__":
    raise SystemExit("This obsolete converter is retired. Use crawler_runner.py and MasterDB.export_core().")
