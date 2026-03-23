"""
법고개(Bupgogae) — 판례 DB → 초경량 JSON 압축 파이프라인
=========================================================
SQLite master.db를 브라우저 확장프로그램용 정적 JSON으로 변환한다.

[압축 전략]
  Key  : "15Da12345"  ← 연도 2자리 + 영문 사건부호 + 일련번호
  Value: [[serial_number, court_code, date_int, case_name], ...]  ← 1:N 배열

[실행]
  python compress.py                       # 실제 DB 변환
  python compress.py --mock                # Mock 데이터 테스트
  python compress.py --db /path/to/master.db --out ./output

[출력]
  db.json                ← 본문 (압축 판례 데이터)
  bupgogae_meta.json     ← 메타데이터 (case_code_map, court_code_map)

[보안 참고]
  이 스크립트는 SQLite → JSON 순수 변환만 수행한다.
  외부 네트워크 요청 없음. 파일 시스템 읽기/쓰기만 발생.
"""

import sqlite3
import json
import re
import os
import sys
from collections import defaultdict
from datetime import datetime


# ============================================================
# 1. 사건부호 한글→영문 매핑 테이블 (159개 사건부호 커버)
#    - 실제 DB에서 추출된 전체 부호 기반으로 작성
#    - 빈도순 상위 부호는 짧은 코드 할당
# ============================================================
CASE_CODE_MAP = {
    # === 상위 빈도 (1,000건 이상) ===
    "누": "Nu",       # 24,413건 — 행정 상고
    "다": "Da",       # 23,460건 — 민사 상고
    "구합": "Guh",    # 18,980건 — 행정 합의
    "도": "Do",       # 13,952건 — 형사 상고
    "두": "Du",       # 13,026건 — 행정 재항고
    "나": "Na",       # 10,312건 — 민사 항소
    "가단": "Gad",    #  5,247건 — 민사 단독
    "가합": "Gah",    #  4,920건 — 민사 합의
    "노": "No",       #  4,356건 — 형사 항소
    "구단": "Gud",    #  3,213건 — 행정 단독
    "구": "Gu",       #  2,973건 — 행정 1심
    "후": "Hu",       #  2,737건 — 특허 상고
    "다카": "Dak",    #  2,499건 — 민사 상고(구)
    "마": "Ma",       #  1,884건 — 민사 항고
    # === 중간 빈도 (100~999건) ===
    "고단": "God",    # 형사 단독
    "고합": "Goh",    # 형사 합의
    "민상": "Mis",    # 민사 상고(구)
    "허": "Heo",      # 특허 1심
    "므": "Meu",      # 가사 상고
    "모": "Mo",       # 형사 항고
    "라": "Ra",       # 민사 즉시항고
    "그": "Geu",      # 민사 기타
    "형상": "Hys",    # 형사 상고(구)
    "고정": "Goj",    # 형사 약식
    "행상": "Has",    # 행정 상고(구)
    "스": "Su",       # 가사 비송
    "추": "Chu",      # 추심
    "가소": "Gas",    # 민사 소액
    "르": "Reu",      # 가사 항소
    "감도": "Gmd",    # 군형법 상고
    "카합": "Kah",    # 비송 합의
    "드": "Deu",      # 행정 항소(신설)
    "민공": "Mig",    # 민공(구)
    "재누": "JNu",    # 재항고(행정)
    "사": "Sa",       # 사형 확인
    "브": "Beu",      # 가사 항소(신)
    "수": "Soo",      # 수용
    "무": "Mu",       # 형사 재심
    "로": "Ro",       # 형사 즉시항고
    "초": "Cho",      # 형사 재정
    "드단": "Ded",    # 행정 항소 단독
    "재두": "JDu",    # 재항고(행정2)
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
    "헌가": "HG",      # 위헌법률심판 (법원 위헌제청)
    "헌나": "HN",      # 탄핵심판
    "헌다": "HD",      # 정당해산심판
    "헌라": "HR",      # 권한쟁의심판
    "헌마": "HM",      # 권리구제 헌법소원 (68조1항)
    "헌바": "HB",      # 위헌심사형 헌법소원 (68조2항)
    "헌사": "HS",      # 각종 신청 (국선대리인, 가처분, 기피 등)
    "헌아": "HA",      # 각종 특별사건 (재심)
}

# 역방향 매핑 (디코딩용, 메타에 포함)
CODE_MAP_REVERSE = {v: k for k, v in CASE_CODE_MAP.items()}


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

# 지원(branch) 법원은 본원 코드 + 100~199 범위에서 자동 할당
_branch_auto_code = 100


def get_court_code(court_name: str) -> int:
    """법원명을 정수 코드로 변환. 미등록 법원은 동적 할당."""
    global _branch_auto_code
    if not court_name:
        return 0
    if court_name in COURT_CODE_MAP:
        return COURT_CODE_MAP[court_name]
    # 동적 할당 (지원 등 미등록 법원)
    _branch_auto_code += 1
    COURT_CODE_MAP[court_name] = _branch_auto_code
    return _branch_auto_code


# ============================================================
# 3. 핵심 변환 함수
# ============================================================

def compress_case_number(case_number: str) -> str | None:
    """
    사건번호 → 압축 키 변환.
    "2015다12345" → "15Da12345"
    "92가단28561" → "92Gad28561"
    "조심 2025중2548" → "TX25중2548"
    """
    if not case_number:
        return None

    # 공백, 콤마 제거 (병합 사건)
    clean = case_number.strip()

    # 조세심판원: "조심 YYYY[지역코드]NNNN"
    tax_match = re.match(r'^조심\s*(\d{2,4})([가-힣])(\d+)$', clean)
    if tax_match:
        year_2d = tax_match.group(1)[-2:]
        code = tax_match.group(2)
        serial = tax_match.group(3)
        return f"TX{year_2d}{code}{serial}"

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


def compress_tax_case_number(case_number: str) -> str | None:
    """조세심판 사건번호 → TX 키 변환 (조심 prefix 유무 무관).

    법제처 API의 '청구번호' 필드는 '조심' 접두사가 없는 경우가 대부분이므로,
    접두사 유무와 관계없이 TX 키를 생성한다.

    "조심 2025중2548" → "TX25중2548"  (기존 로직)
    "90서1671"        → "TX90서1671"  (raw 청구번호)
    """
    if not case_number:
        return None

    clean = case_number.strip()

    # 조심 prefix가 있으면 기존 로직 사용
    if clean.startswith("조심"):
        return compress_case_number(clean)

    # Raw 형식: "90서1671" → "TX90서1671" (한글 부호 유지)
    clean = clean.replace(" ", "")
    m = re.match(r'^(\d{2,4})([가-힣]{1,4})(\d+)$', clean)
    if not m:
        return None

    year_2d = m.group(1)[-2:]
    code_kr = m.group(2)
    serial = m.group(3)
    return f"TX{year_2d}{code_kr}{serial}"


def compress_date(date_str: str) -> int:
    """
    선고일 → 6자리 정수.
    "2023.10.25" → 231025
    "1995.01.15" → 950115
    """
    if not date_str:
        return 0
    # "YYYY.MM.DD" 또는 "YYYY-MM-DD"
    clean = date_str.replace("-", ".").replace("/", ".")
    parts = clean.split(".")
    if len(parts) != 3:
        return 0
    try:
        y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
        return (y % 100) * 10000 + m * 100 + d
    except ValueError:
        return 0


def compress_case_name(name: str) -> str:
    """사건명은 원문 그대로 저장 (gzip이 충분히 압축)."""
    return name.strip() if name else ""


# ============================================================
# 4. 메인 파이프라인
# ============================================================

def build_from_sqlite(db_path: str) -> dict:
    """SQLite DB → 압축 딕셔너리 변환."""
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    tables = [t[0] for t in cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall() if t[0].startswith("cases_")]

    result = defaultdict(list)
    stats = {"total": 0, "skipped": 0, "collisions": 0}

    for table in sorted(tables):
        rows = cur.execute(
            f"SELECT serial_number, court, decision_date, case_number, case_name "
            f"FROM {table}"
        ).fetchall()

        for serial, court, date, case_num, case_name in rows:
            stats["total"] += 1

            key = compress_case_number(case_num)
            if not key:
                stats["skipped"] += 1
                continue

            court_code = get_court_code(court)
            date_int = compress_date(date)
            name_compressed = compress_case_name(case_name or "")
            entry = [int(serial), court_code, date_int, name_compressed]

            if key in result:
                stats["collisions"] += 1
            result[key].append(entry)

    conn.close()
    return dict(result), stats


def build_from_mock() -> dict:
    """Mock 데이터로 변환 테스트."""
    mock_data = [
        # serial, court, date, case_number, case_name
        (176651, "대법원",         "2015.01.15", "2013다215133", "손해배상(기)"),
        (179872, "대법원",         "2016.01.14", "2015다6302",  "양도소득세부과처분취소"),
        (233567, "대법원",         "2023.01.12", "2022다266874", "소유권이전등기말소"),
        (119263, "서울민사지방법원", "1992.04.14", "91나13075",   "소유권이전등기청구사건"),
        (71773,  "대구고등법원",    "1951.08.22", "4283민공237",  "부동산소유권이전등기"),
        (85830,  "대법원",         "1947.03.23", "4280민상278",  "가옥명도"),
        # --- 충돌 테스트: 같은 사건번호, 다른 법원 ---
        (999901, "서울중앙지방법원", "2020.05.10", "2020가단12345", "대여금"),
        (999902, "부산지방법원",    "2020.06.15", "2020가단12345", "부당이득금반환"),
        # --- 동일 2자리 연도 충돌 (1923 vs 2023) ---
        (888801, "대법원",         "2023.03.01", "2023다100",    "사해행위취소"),
        (888802, "대법원",         "1923.03.01", "4256민상100",   "가옥명도"),
    ]

    result = defaultdict(list)
    stats = {"total": 0, "skipped": 0, "collisions": 0}

    for serial, court, date, case_num, case_name in mock_data:
        stats["total"] += 1
        key = compress_case_number(case_num)
        if not key:
            stats["skipped"] += 1
            continue
        court_code = get_court_code(court)
        date_int = compress_date(date)
        name_compressed = compress_case_name(case_name or "")
        entry = [int(serial), court_code, date_int, name_compressed]
        if key in result:
            stats["collisions"] += 1
        result[key].append(entry)

    return dict(result), stats


def save_output(data: dict, stats: dict, output_dir: str):
    """결과물 JSON 저장."""
    os.makedirs(output_dir, exist_ok=True)

    # 본문 (compact, no spaces)
    lookup_path = os.path.join(output_dir, "db.json")
    with open(lookup_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

    size_bytes = os.path.getsize(lookup_path)
    size_mb = size_bytes / (1024 * 1024)

    # 메타데이터
    meta = {
        "version": datetime.now().strftime("%Y.%m.%d"),
        "generated_at": datetime.now().isoformat(),
        "stats": {
            **stats,
            "unique_keys": len(data),
            "file_size_bytes": size_bytes,
            "file_size_mb": round(size_mb, 2),
        },
        "case_code_map": CASE_CODE_MAP,
        "court_code_map": COURT_CODE_MAP,
    }

    meta_path = os.path.join(output_dir, "bupgogae_meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    return size_mb


# ============================================================
# 5. 엔트리포인트
# ============================================================

if __name__ == "__main__":
    import argparse as _ap

    _parser = _ap.ArgumentParser(description="판례 DB → JSON 압축 변환")
    _parser.add_argument("--mock", action="store_true", help="Mock 데이터로 테스트")
    _parser.add_argument("--db", default=None, help="SQLite DB 경로 (기본: /app/data/master.db)")
    _parser.add_argument("--out", default=None, help="출력 디렉토리 (기본: ./output)")
    _args = _parser.parse_args()

    if _args.mock:
        print("=" * 60)
        print("  [MOCK MODE] 테스트 데이터로 변환 파이프라인 검증")
        print("=" * 60)
        data, stats = build_from_mock()
        output_dir = _args.out or os.path.join(os.path.dirname(__file__), "output")
    else:
        db_path = _args.db or os.path.join("/app", "data", "master.db")
        if not os.path.exists(db_path):
            print(f"❌ DB 파일을 찾을 수 없습니다: {db_path}")
            sys.exit(1)
        print("=" * 60)
        print(f"  [PRODUCTION] {db_path}")
        print("=" * 60)
        data, stats = build_from_sqlite(db_path)
        output_dir = _args.out or os.path.join(os.path.dirname(__file__), "output")

    size_mb = save_output(data, stats, output_dir)

    print(f"\n📊 변환 통계:")
    print(f"   총 레코드:       {stats['total']:,}")
    print(f"   고유 키:         {len(data):,}")
    print(f"   건너뛴 레코드:   {stats['skipped']:,}")
    print(f"   키 충돌(1:N):    {stats['collisions']:,}")
    print(f"   출력 파일 크기:  {size_mb:.2f} MB")
    print(f"   출력 경로:       {output_dir}")

    if _args.mock:
        # Mock 결과 상세 출력
        print("\n📋 변환 결과 (Mock):")
        print(json.dumps(data, ensure_ascii=False, indent=2))
