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
import sqlite3
from collections import defaultdict
from datetime import datetime

from compress import (  # noqa: E402
    compress_case_number, compress_case_name, compress_date, get_court_code,
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

    def __init__(self, db_path: str):
        self.db_path = db_path
        os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
        self.conn = sqlite3.connect(db_path)
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.conn.execute("PRAGMA synchronous=NORMAL;")
        self.conn.executescript(self.SCHEMA)
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

            serial = int(row["serial"]) if row["serial"] else 0
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

    def export_new(self, since_iso: str) -> tuple[dict, int]:
        """이번 실행에서 추가된 레코드만 → 압축 dict."""
        rows = self.get_new_since(since_iso)
        return self.compress_rows(rows)

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

        db.close()
        os.remove(test_db)
        print("✅ Test passed")

    _test()
