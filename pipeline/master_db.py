"""
Master DB 관리 모듈 — 영속 SQLite.

유지되는 master.db를 관리한다.
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

from compress import (  # noqa: E402
    compress_case_number,
    compress_case_name, compress_date, CourtCodeResolver,
)
from api import clean_case_number  # noqa: E402
from validate import sanitize_raw_case  # noqa: E402
from log_setup import get_logger  # noqa: E402

log = get_logger(__name__)


class MasterDB:
    """영속 SQLite master DB."""

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

        # 법원코드 변환기 — 인스턴스 로컬 상태(미등록 법원 동적 할당).
        # 전역 변이 없이 export 후 court_resolver.code_map으로 최종 맵 조회.
        self.court_resolver = CourtCodeResolver()

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
        """raw API 결과를 한 transaction으로 UPSERT.

        한 날짜/페이지 묶음 도중 SQLite 오류가 나면 그 호출에서 쓴 행을 모두
        rollback한다. 그렇지 않으면 다음 성공 호출의 commit이 앞선 부분 쓰기까지
        함께 확정해 durable backlog와 master DB의 완료 경계가 어긋날 수 있다.
        """
        cur = self.conn.cursor()
        inserted = 0
        updated = 0
        skipped = 0

        try:
            for raw in raw_cases:
                # 입력 검증/정제 (길이 상한·None 안전). serial 없으면 스킵.
                case = sanitize_raw_case(raw)
                if case is None:
                    skipped += 1
                    continue
                serial = case["serial"]

                # 블랙리스트 체크
                try:
                    if int(serial) in self.blacklist:
                        skipped += 1
                        continue
                except ValueError:
                    pass

                case_number_clean = clean_case_number(case["case_number"])

                # 존재 여부 확인
                existing = cur.execute(
                    "SELECT serial FROM cases WHERE serial = ?", (serial,)
                ).fetchone()

                if existing:
                    cur.execute("""
                        UPDATE cases SET
                            case_name = COALESCE(NULLIF(?, ''), case_name),
                            case_number = COALESCE(NULLIF(?, ''), case_number),
                            case_number_clean = COALESCE(
                                NULLIF(?, ''), case_number_clean
                            ),
                            date = COALESCE(NULLIF(?, ''), date),
                            court = COALESCE(NULLIF(?, ''), court)
                        WHERE serial = ?
                    """, (
                        case["case_name"],
                        case["case_number"],
                        case_number_clean,
                        case["date"],
                        case["court"],
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
                        case["case_name"],
                        case["case_number"],
                        case_number_clean,
                        case["date"],
                        case["court"],
                    ))
                    inserted += 1

            self.conn.commit()
            return inserted, updated, skipped
        except Exception:
            self.conn.rollback()
            raise
        finally:
            cur.close()

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

    def compress_rows(self, rows) -> dict:
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
            court_code = self.court_resolver.resolve(row["court"])
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
        """판례 + 헌재 레코드 → 압축 dict."""
        self.conn.row_factory = sqlite3.Row
        cur = self.conn.execute(
            "SELECT * FROM cases ORDER BY date"
        )
        rows = cur.fetchall()
        self.conn.row_factory = None
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
