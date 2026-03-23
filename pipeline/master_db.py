"""
Master DB 관리 모듈 — NAS 영속 SQLite.

NAS에 유지되는 master.db를 관리한다.
- 판례 UPSERT (serial 기준 중복 방지)
- 날짜별 / 전체 조회
- 압축 JSON 포맷 변환
- 블랙리스트 기반 불량 데이터 필터링

공개 API:
  MasterDB(db_path)      -> DB 열기/생성
  db.upsert_raw(cases)   -> (삽입, 갱신, 스킵) 튜플 반환
  db.export_all()        -> 압축 dict + 스킵 수
  db.export_since(date)  -> 특정 날짜 이후 레코드 압축
  db.stats()             -> DB 통계 dict

[보안 참고]
  순수 로컬 SQLite 작업만 수행. 외부 네트워크 요청 없음.
  blacklist.json은 API에서 받은 불량 데이터의 serial 목록.
"""

import json
import os
import re
import sqlite3
from collections import defaultdict
from datetime import datetime

from compress import (  # noqa: E402
    compress_case_number, compress_tax_case_number,
    compress_case_name, compress_date, get_court_code,
)
from api import clean_case_number  # noqa: E402


class MasterDB:
    """NAS 영속 SQLite master DB."""

    SCHEMA = """
    CREATE TABLE IF NOT EXISTS cases (
        serial      TEXT PRIMARY KEY,
        case_name   TEXT,
        case_number TEXT,
        case_number_clean TEXT,
        date        TEXT,
        court       TEXT,
        inserted_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cases_date ON cases(date);
    CREATE INDEX IF NOT EXISTS idx_cases_inserted ON cases(inserted_at);
    """

    KIPRIS_SCHEMA = """
    CREATE TABLE IF NOT EXISTS kipris_cases (
        serial        TEXT PRIMARY KEY,
        case_name     TEXT,
        case_number   TEXT,
        decision_date TEXT,
        trial_type    TEXT,
        inserted_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_kipris_date ON kipris_cases(decision_date);

    CREATE TABLE IF NOT EXISTS kipris_backfill_log (
        chunk_start    TEXT,
        chunk_end      TEXT,
        total_cnt      INTEGER DEFAULT 0,
        pages_fetched  INTEGER DEFAULT 0,
        is_completed   INTEGER DEFAULT 0,
        updated_at     TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (chunk_start, chunk_end)
    );
    """

    def __init__(self, db_path: str):
        self.db_path = db_path
        os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
        self.conn = sqlite3.connect(db_path)
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.conn.execute("PRAGMA synchronous=NORMAL;")
        self.conn.executescript(self.SCHEMA)
        self.conn.executescript(self.KIPRIS_SCHEMA)
        self.conn.commit()

        # 블랙리스트 로드 (잘못된 레이블 serial)
        bl_path = os.path.join(os.path.dirname(__file__), "blacklist.json")
        if os.path.exists(bl_path):
            with open(bl_path, encoding="utf-8") as f:
                self.blacklist = set(json.load(f))
        else:
            self.blacklist = set()

    def close(self):
        self.conn.close()

    def count(self) -> int:
        """전체 레코드 수."""
        return self.conn.execute("SELECT COUNT(*) FROM cases").fetchone()[0]

    # ════════════════════════════════════════════════
    # UPSERT
    # ════════════════════════════════════════════════

    def upsert_raw(self, raw_cases: list[dict]) -> tuple[int, int, int]:
        """raw API 결과를 UPSERT. (inserted, updated, skipped) 반환."""
        cur = self.conn.cursor()
        inserted = 0
        updated = 0
        skipped = 0

        for case in raw_cases:
            serial = case.get("serial", "")
            if not serial:
                continue

            # 블랙리스트 체크
            try:
                if int(serial) in self.blacklist:
                    skipped += 1
                    continue
            except ValueError:
                pass

            case_number_clean = clean_case_number(case.get("case_number", ""))

            # 존재 여부 확인
            existing = cur.execute(
                "SELECT serial FROM cases WHERE serial = ?", (serial,)
            ).fetchone()

            if existing:
                cur.execute("""
                    UPDATE cases SET
                        case_name = ?, case_number = ?, case_number_clean = ?,
                        date = ?, court = ?
                    WHERE serial = ?
                """, (
                    case.get("case_name", ""),
                    case.get("case_number", ""),
                    case_number_clean,
                    case.get("date", ""),
                    case.get("court", ""),
                    serial,
                ))
                updated += 1
            else:
                cur.execute("""
                    INSERT INTO cases
                        (serial, case_name, case_number, case_number_clean, date, court)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (
                    serial,
                    case.get("case_name", ""),
                    case.get("case_number", ""),
                    case_number_clean,
                    case.get("date", ""),
                    case.get("court", ""),
                ))
                inserted += 1

        self.conn.commit()
        return inserted, updated, skipped

    # ════════════════════════════════════════════════
    # 조회
    # ════════════════════════════════════════════════

    def get_cases_since(self, date_str: str) -> list[sqlite3.Row]:
        """특정 날짜 이후 (>=) 레코드 조회."""
        self.conn.row_factory = sqlite3.Row
        cur = self.conn.execute(
            "SELECT * FROM cases WHERE date >= ? ORDER BY date",
            (date_str,),
        )
        rows = cur.fetchall()
        self.conn.row_factory = None
        return rows

    def get_all_cases(self) -> list[sqlite3.Row]:
        """전체 레코드 조회."""
        self.conn.row_factory = sqlite3.Row
        cur = self.conn.execute("SELECT * FROM cases ORDER BY date")
        rows = cur.fetchall()
        self.conn.row_factory = None
        return rows

    def get_new_since(self, since_iso: str) -> list[sqlite3.Row]:
        """inserted_at >= since_iso 인 레코드 (이번 실행에서 추가된 것들)."""
        self.conn.row_factory = sqlite3.Row
        cur = self.conn.execute(
            "SELECT * FROM cases WHERE inserted_at >= ? ORDER BY date",
            (since_iso,),
        )
        rows = cur.fetchall()
        self.conn.row_factory = None
        return rows

    # ════════════════════════════════════════════════
    # 압축 JSON 변환
    # ════════════════════════════════════════════════

    @staticmethod
    def compress_rows(rows) -> dict:
        """sqlite3.Row 리스트 → 압축 JSON dict."""
        compressed = defaultdict(list)
        skipped = 0

        for row in rows:
            key = compress_case_number(row["case_number_clean"])
            if not key:
                skipped += 1
                continue

            # serial: 숫자만이면 int, D/T prefix면 string 유지
            raw_serial = row["serial"] or "0"
            serial = int(raw_serial) if raw_serial.isdigit() else raw_serial
            court_code = get_court_code(row["court"])
            date_int = compress_date(row["date"])
            name_raw = compress_case_name(row["case_name"] or "")

            compressed[key].append([serial, court_code, date_int, name_raw])

        return dict(compressed), skipped

    def export_since(self, date_str: str) -> tuple[dict, int]:
        """특정 날짜 이후 레코드 → 압축 dict."""
        rows = self.get_cases_since(date_str)
        return self.compress_rows(rows)

    def export_all(self) -> tuple[dict, int]:
        """전체 레코드 → 압축 dict."""
        rows = self.get_all_cases()
        return self.compress_rows(rows)

    def export_core(self) -> tuple[dict, int]:
        """판례 + 헌재 레코드 → 압축 dict (조세심판 제외)."""
        self.conn.row_factory = sqlite3.Row
        cur = self.conn.execute(
            "SELECT * FROM cases WHERE serial NOT LIKE 'T%' ORDER BY date"
        )
        rows = cur.fetchall()
        self.conn.row_factory = None
        return self.compress_rows(rows)

    def export_tax(self) -> tuple[dict, int]:
        """조세심판 레코드만 → 압축 dict (TX prefix 보장)."""
        self.conn.row_factory = sqlite3.Row
        cur = self.conn.execute(
            "SELECT * FROM cases WHERE serial LIKE 'T%' ORDER BY date"
        )
        rows = cur.fetchall()
        self.conn.row_factory = None
        return self.compress_rows_tax(rows)

    @staticmethod
    def compress_rows_tax(rows) -> tuple[dict, int]:
        """조세심판 전용 압축 — TX prefix + 한글 부호 보장."""
        compressed = defaultdict(list)
        skipped = 0

        for row in rows:
            key = compress_tax_case_number(row["case_number_clean"])
            if not key:
                skipped += 1
                continue

            raw_serial = row["serial"] or "0"
            serial = int(raw_serial) if raw_serial.isdigit() else raw_serial
            court_code = get_court_code(row["court"])
            date_int = compress_date(row["date"])
            name_raw = compress_case_name(row["case_name"] or "")

            compressed[key].append([serial, court_code, date_int, name_raw])

        return dict(compressed), skipped

    def export_new(self, since_iso: str) -> tuple[dict, int]:
        """이번 실행에서 추가된 레코드만 → 압축 dict."""
        rows = self.get_new_since(since_iso)
        return self.compress_rows(rows)

    # ════════════════════════════════════════════════
    # KIPRIS 특허심판원
    # ════════════════════════════════════════════════

    def upsert_kipris(self, items: list[dict]) -> tuple[int, int]:
        """KIPRIS 심판 아이템 UPSERT. (inserted, updated) 반환."""
        cur = self.conn.cursor()
        inserted = 0
        updated = 0

        for item in items:
            serial = item.get("serial", "")
            if not serial:
                continue

            existing = cur.execute(
                "SELECT serial FROM kipris_cases WHERE serial = ?",
                (serial,),
            ).fetchone()

            if existing:
                cur.execute("""
                    UPDATE kipris_cases SET
                        case_name = ?, case_number = ?,
                        decision_date = ?, trial_type = ?
                    WHERE serial = ?
                """, (
                    item.get("case_name", ""),
                    item.get("case_number", ""),
                    item.get("decision_date", ""),
                    item.get("trial_type", ""),
                    serial,
                ))
                updated += 1
            else:
                cur.execute("""
                    INSERT INTO kipris_cases
                        (serial, case_name, case_number,
                         decision_date, trial_type)
                    VALUES (?, ?, ?, ?, ?)
                """, (
                    serial,
                    item.get("case_name", ""),
                    item.get("case_number", ""),
                    item.get("decision_date", ""),
                    item.get("trial_type", ""),
                ))
                inserted += 1

        self.conn.commit()
        return inserted, updated

    def kipris_count(self) -> int:
        """KIPRIS 특허심판 전체 레코드 수."""
        return self.conn.execute(
            "SELECT COUNT(*) FROM kipris_cases"
        ).fetchone()[0]

    def export_kipris(self) -> tuple[dict, int]:
        """KIPRIS 특허심판 레코드 → 압축 dict.

        키 형식: KP{연도2자리}{심판종류}{일련번호}
        예: "2023당1234" → "KP23당1234"
        """
        cur = self.conn.execute(
            "SELECT serial, case_name, case_number, decision_date, trial_type "
            "FROM kipris_cases ORDER BY decision_date"
        )
        compressed = {}
        skipped = 0

        for serial, case_name, case_number, decision_date, trial_type in cur:
            if not case_number:
                skipped += 1
                continue

            # 심판번호 → KP + 2자리연도 + 나머지 (프론트엔드 compressCaseKey와 일치)
            # 예: "2023당1234" → "KP23당1234"
            _m = re.match(r'^(\d{2,4})(.+)$', case_number)
            if _m:
                year_2d = _m.group(1)[-2:]
                key = f"KP{year_2d}{_m.group(2)}"
            else:
                key = f"KP{case_number}"

            # 날짜 → 6자리 정수 (YYMMDD)
            date_int = 0
            if decision_date:
                clean_d = decision_date.replace("-", "").replace(".", "").replace("/", "")
                if len(clean_d) >= 8:
                    try:
                        y = int(clean_d[:4]) % 100
                        m = int(clean_d[4:6])
                        d = int(clean_d[6:8])
                        date_int = y * 10000 + m * 100 + d
                    except ValueError:
                        pass

            entry = [serial, trial_type or "", date_int, case_name or ""]

            if key not in compressed:
                compressed[key] = [entry]
            else:
                compressed[key].append(entry)

        return compressed, skipped

    # ════════════════════════════════════════════════
    # 유틸
    # ════════════════════════════════════════════════

    def stats(self) -> dict:
        """DB 통계."""
        total = self.count()
        oldest = self.conn.execute(
            "SELECT MIN(date) FROM cases"
        ).fetchone()[0]
        newest = self.conn.execute(
            "SELECT MAX(date) FROM cases"
        ).fetchone()[0]
        size_mb = os.path.getsize(self.db_path) / (1024 * 1024)

        return {
            "total": total,
            "oldest_date": oldest,
            "newest_date": newest,
            "size_mb": round(size_mb, 2),
        }


# 자체 테스트 (직접 실행 시)
if __name__ == "__main__":
    def _test():
        """간단한 통합 테스트. 완료 후 테스트 DB 자동 삭제."""
        test_db = "test_master.db"
        db = MasterDB(test_db)

        test_cases = [
            {"serial": "100001", "case_name": "손해배상(기)",
             "case_number": "2024다12345", "date": "20240115", "court": "대법원"},
            {"serial": "100002", "case_name": "부과처분취소",
             "case_number": "2023구합56789", "date": "20230610", "court": "서울행정법원"},
        ]

        ins, upd, skp = db.upsert_raw(test_cases)
        print(f"Inserted: {ins}, Updated: {upd}, Skipped: {skp}")
        print(f"Stats: {db.stats()}")

        compressed, skipped = db.export_all()
        print(f"Compressed keys: {len(compressed)}, Skipped: {skipped}")
        print(json.dumps(compressed, ensure_ascii=False, indent=2))

        # KIPRIS 테이블 테스트
        test_kipris = [
            {"serial": "2023당1234", "case_name": "거절결정취소",
             "case_number": "2023당1234", "decision_date": "20230915",
             "trial_type": "거절결정"},
            {"serial": "2022원5678", "case_name": "무효심판",
             "case_number": "2022원5678", "decision_date": "20220310",
             "trial_type": "무효"},
        ]
        k_ins, k_upd = db.upsert_kipris(test_kipris)
        print(f"KIPRIS Inserted: {k_ins}, Updated: {k_upd}")
        print(f"KIPRIS Count: {db.kipris_count()}")

        k_data, k_skip = db.export_kipris()
        print(f"KIPRIS Compressed keys: {len(k_data)}, Skipped: {k_skip}")
        print(json.dumps(k_data, ensure_ascii=False, indent=2))

        db.close()
        os.remove(test_db)
        print("✅ Test passed")

    _test()
