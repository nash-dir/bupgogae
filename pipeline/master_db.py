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
from pathlib import Path

from compress import (  # noqa: E402
    compress_case_number,
    compress_case_name, compress_date, CourtCodeResolver,
)
from api import clean_case_number  # noqa: E402
from validate import sanitize_raw_case  # noqa: E402
from law_normalization import (is_merged_case_number, expand_merged_case_numbers,
                               normalize_decision_date, normalize_precedent_identity)
from log_setup import get_logger  # noqa: E402
from serving_policy import SCHEMA as SERVING_SCHEMA, load_policy, table_exists, RAW_COLUMNS

log = get_logger(__name__)


def _same_source_fields(observed, archived):
    if observed == archived:
        return True
    if not isinstance(observed, dict) or set(observed) != set(archived):
        return False
    # The API alternates YYYYMMDD and YYYY.MM.DD. Compare only validated
    # calendar equivalents; unknown sentinels and actual date changes are not
    # interchangeable. Never mutate the archive to match a display format.
    if any(observed[k] != archived[k] for k in archived if k != "date"):
        return False
    if not isinstance(observed["date"], str) or not isinstance(archived["date"], str):
        return False
    left = normalize_decision_date(observed["date"])
    return left is not None and left == normalize_decision_date(archived["date"])


def _same_source_replay(raw, case, original):
    if "_source_raw" not in raw:
        return case == original
    if not _same_source_fields(raw["_source_raw"], original):
        return False
    number, court = normalize_precedent_identity(
        original["case_number"], original["court"], raw.get("_source_name", ""),
    )
    expected = dict(original, case_number=number, court=court,
                    date=normalize_decision_date(original["date"]))
    return case == expected


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
    CREATE TABLE IF NOT EXISTS known_error_provenance (
        serial TEXT PRIMARY KEY REFERENCES cases(serial),
        receipt_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviewed_recovery_provenance (
        serial TEXT PRIMARY KEY REFERENCES cases(serial),
        recovery_sha256 TEXT NOT NULL,
        catalog_sha256 TEXT NOT NULL,
        record_json TEXT NOT NULL,
        raw_record_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_correction_provenance (
        serial TEXT PRIMARY KEY REFERENCES cases(serial),
        receipt_json TEXT NOT NULL
    );
    """ + SERVING_SCHEMA

    def __init__(self, db_path: str, *, read_only: bool = False):
        self.db_path = db_path
        if read_only:
            self.conn = sqlite3.connect(Path(db_path).resolve().as_uri() + "?mode=ro", uri=True)
        else:
            os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
            self.conn = sqlite3.connect(db_path)
            self.conn.execute("PRAGMA journal_mode=WAL;")
            self.conn.execute("PRAGMA synchronous=NORMAL;")
            self.conn.executescript(self.SCHEMA)
            self.conn.commit()

        # 법원코드 변환기 — 인스턴스 로컬 상태(미등록 법원 동적 할당).
        # 전역 변이 없이 export 후 court_resolver.code_map으로 최종 맵 조회.
        self.court_resolver = CourtCodeResolver()
        self.export_dates = {}
        self.last_export_report = {}

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
            policy = load_policy(self.conn)
            for raw in raw_cases:
                # 입력 검증/정제 (길이 상한·None 안전). serial 없으면 스킵.
                case = sanitize_raw_case(raw)
                if case is None:
                    skipped += 1
                    continue
                serial = case["serial"]
                if not re.fullmatch(r"(?:[0-9]+|D[0-9]+)", serial):
                    raise ValueError("unsupported_publication_serial")

                # 블랙리스트 체크
                try:
                    if int(serial) in self.blacklist:
                        skipped += 1
                        continue
                except ValueError:
                    pass

                case_number_clean = clean_case_number(case["case_number"])

                # One indexed lookup also checks whether a reviewed row is protected.
                existing = cur.execute(
                    "SELECT c.serial, c.case_number, c.case_number_clean, p.receipt_json, r.raw_record_json "
                    "FROM cases c LEFT JOIN known_error_provenance p ON p.serial=c.serial "
                    "LEFT JOIN reviewed_recovery_provenance r ON r.serial=c.serial "
                    "WHERE c.serial=?", (serial,)
                ).fetchone()

                if policy and serial in policy.quarantine:
                    # An exact replay of held raw is not a source change.
                    # Validate every archived byte through the pinned row hash,
                    # then compare ALL five incoming source fields (only
                    # validated equivalent date display forms may differ). Do not
                    # update, release, or reinterpret the archived row.
                    held_row = cur.execute(
                        f"SELECT {','.join(RAW_COLUMNS)} FROM cases WHERE serial=?", (serial,)
                    ).fetchone()
                    if held_row is not None:
                        held_row = dict(zip(RAW_COLUMNS, held_row))
                        policy.held(held_row)
                        original = {k: held_row[k] or "" for k in
                                    ("serial", "case_name", "case_number", "date", "court")}
                        if _same_source_replay(raw, case, original):
                            skipped += 1
                            continue
                    raise ValueError("quarantined_raw_changed_requires_review")

                receipt = raw.get("_known_error")
                serving_receipt = raw.get("_serving_correction")
                if serving_receipt is not None:
                    from source_corrections import verify_receipt
                    verify_receipt(raw, serving_receipt)
                if existing and existing[4]:
                    from known_errors import CorrectionError
                    # Serving corrections intentionally leave the raw row
                    # unchanged. An identical source/serving replay must not
                    # overwrite it with normalized fields or delete provenance.
                    recovery = cur.execute(
                        "SELECT record_json FROM reviewed_recovery_provenance WHERE serial=?", (serial,)
                    ).fetchone()
                    stored = cur.execute(
                        f"SELECT {','.join(RAW_COLUMNS)} FROM cases WHERE serial=?", (serial,)
                    ).fetchone()
                    stored = dict(zip(RAW_COLUMNS, stored))
                    original = json.loads(existing[4])
                    if ({k: stored[k] for k in original} != original
                            or stored["case_number_clean"] != clean_case_number(stored["case_number"])):
                        raise CorrectionError("known_error_receipt_mismatch")
                    if receipt is None and (
                        _same_source_replay(raw, case, original)
                        or (serving_receipt is not None and case == original and recovery
                            and json.loads(recovery[0]) == serving_receipt["record"])
                        or (_same_source_fields(raw.get("_source_raw"), original) and recovery
                            and case == json.loads(recovery[0]))
                    ):
                        skipped += 1
                        continue
                    raise CorrectionError("known_error_review_required")
                if receipt is not None:
                    from known_errors import registry
                    registry().verify_receipt(raw, receipt)
                elif existing and existing[3]:
                    # A plain response cannot erase a previously reviewed fix.
                    from known_errors import CorrectionError
                    raise CorrectionError("known_error_receipt_mismatch")

                # Protected exact replays above never write or publish their
                # invalid historical number. New/changed input must still pass
                # the complete merged-member check before any SQL mutation.
                raw_number = raw.get("case_number")
                if isinstance(raw_number, str) and is_merged_case_number(raw_number):
                    expand_merged_case_numbers(raw_number)

                if existing:
                    # An update containing only a leading member must not erase
                    # previously verified merged members. Corrections that remove
                    # members require explicit review rather than silent overwrite.
                    previous_number = existing[1] or existing[2] or ""
                    if case["case_number"] and is_merged_case_number(previous_number):
                        previous_members = set(expand_merged_case_numbers(previous_number))
                        next_members = (set(expand_merged_case_numbers(case["case_number"]))
                                        if is_merged_case_number(case["case_number"])
                                        else {case_number_clean})
                        if not previous_members.issubset(next_members):
                            raise ValueError("merged_case_members_removed")
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
                        # Constitutional API '0' means unknown, not a newer
                        # calendar value. Keep an existing known date intact.
                        "" if serial.startswith("D") and case["date"] == "0" else case["date"],
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

                if receipt is not None:
                    cur.execute(
                        "INSERT INTO known_error_provenance VALUES(?,?) "
                        "ON CONFLICT(serial) DO UPDATE SET receipt_json=excluded.receipt_json",
                        (serial, json.dumps(receipt, ensure_ascii=False, sort_keys=True)),
                    )
                if serving_receipt is not None:
                    from source_corrections import digest
                    cur.execute("INSERT INTO reviewed_recovery_provenance VALUES(?,?,?,?,?) "
                                "ON CONFLICT(serial) DO UPDATE SET recovery_sha256=excluded.recovery_sha256, "
                                "catalog_sha256=excluded.catalog_sha256, record_json=excluded.record_json, "
                                "raw_record_json=excluded.raw_record_json",
                                (serial, serving_receipt["entrySha256"], digest(serving_receipt["expectedList"]),
                                 json.dumps(serving_receipt["record"], ensure_ascii=False),
                                 json.dumps(case, ensure_ascii=False)))
                    cur.execute("INSERT INTO source_correction_provenance VALUES(?,?) "
                                "ON CONFLICT(serial) DO UPDATE SET receipt_json=excluded.receipt_json",
                                (serial, json.dumps(serving_receipt, ensure_ascii=False, sort_keys=True)))

            self.conn.commit()
            return inserted, updated, skipped
        except Exception:
            self.conn.rollback()
            raise
        finally:
            cur.close()

    def raw_replay_checker(self):
        """Recognize only unchanged pinned historical exclusions before parsing.

        Capture one validated inventory for this collection. Every matched row
        is re-read and hashed; calendar-equivalent date display forms are the
        only source-field equivalence. Final export revalidates the whole
        inventory. A new serial or any changed source field cannot inherit a
        historical exclusion.
        """
        policy = load_policy(self.conn)

        def check(original):
            if policy is None or original.get("serial") not in policy.quarantine:
                return None
            row = self.conn.execute(
                f"SELECT {','.join(RAW_COLUMNS)} FROM cases WHERE serial=?", (original["serial"],)
            ).fetchone()
            if row is None:
                raise ValueError("quarantined_raw_missing")
            row = dict(zip(RAW_COLUMNS, row))
            policy.held(row)
            archived = {key: row[key] or "" for key in
                        ("serial", "case_name", "case_number", "date", "court")}
            if not _same_source_fields(original, archived):
                raise ValueError("quarantined_raw_changed_requires_review")
            return archived

        return check

    # ════════════════════════════════════════════════
    # 조회
    # ════════════════════════════════════════════════

    def get_all_cases(self) -> list[sqlite3.Row]:
        """전체 레코드 조회."""
        self.conn.row_factory = sqlite3.Row
        cur = self.conn.execute("SELECT * FROM cases ORDER BY date")
        rows = cur.fetchall()
        self.conn.row_factory = None
        return rows

    # ════════════════════════════════════════════════
    # 압축 JSON 변환
    # ════════════════════════════════════════════════

    def _compress_rows(self, rows, policy, *, require_full=True) -> tuple[dict, int]:
        """sqlite3.Row 리스트 → 압축 JSON dict."""
        compressed = defaultdict(list)
        skipped = 0
        receipts = (dict(self.conn.execute("SELECT serial, receipt_json FROM known_error_provenance"))
                    if table_exists(self.conn, "known_error_provenance") else {})
        recoveries = {sid: (corrected, original) for sid, corrected, original in self.conn.execute(
            "SELECT serial, record_json, raw_record_json FROM reviewed_recovery_provenance")} if table_exists(
                self.conn, "reviewed_recovery_provenance") else {}
        held = 0
        source_receipts = (dict(self.conn.execute("SELECT serial, receipt_json FROM source_correction_provenance"))
                           if table_exists(self.conn, "source_correction_provenance") else {})
        from source_corrections import entries as source_correction_entries
        reviewed_source_ids = {entry["record"]["serial"] for entry in source_correction_entries().values()}
        checked = set()
        self.export_dates = {}

        for row in rows:
            if policy and policy.held(row):
                checked.add(row["serial"])
                held += 1
                skipped += 1
                continue
            recovered = recoveries.get(row["serial"])
            if recovered is not None and row["serial"] in reviewed_source_ids and row["serial"] not in source_receipts:
                raise ValueError("known_error_receipt_mismatch")
            if row["serial"] in source_receipts:
                from source_corrections import verify_receipt, digest
                source_receipt = json.loads(source_receipts[row["serial"]])
                verify_receipt(dict(row), source_receipt)
                if recovered is None or json.loads(recovered[0]) != source_receipt["record"]:
                    raise ValueError("known_error_receipt_mismatch")
                pins = self.conn.execute(
                    "SELECT recovery_sha256,catalog_sha256 FROM reviewed_recovery_provenance WHERE serial=?",
                    (row["serial"],),
                ).fetchone()
                if pins != (source_receipt["entrySha256"], digest(source_receipt["expectedList"])):
                    raise ValueError("known_error_receipt_mismatch")
            if recovered:
                from known_errors import CorrectionError, RECORD_FIELDS
                if ({k: row[k] for k in RECORD_FIELDS} != json.loads(recovered[1])
                        or row["case_number_clean"] != clean_case_number(row["case_number"])):
                    raise CorrectionError("known_error_receipt_mismatch")
                row = dict(row)
                row.update(json.loads(recovered[0]))
                row["case_number_clean"] = clean_case_number(row["case_number"])
            receipt = receipts.get(row["serial"])
            if receipt:
                from known_errors import registry, CorrectionError
                registry().verify_receipt(dict(row), json.loads(receipt))
                if row["case_number_clean"] != clean_case_number(row["case_number"]):
                    raise CorrectionError("known_error_receipt_mismatch")
            raw_number = row["case_number"] or row["case_number_clean"] or ""
            clean_number = row["case_number_clean"] or ""
            if is_merged_case_number(raw_number) or is_merged_case_number(clean_number):
                if clean_number != clean_case_number(raw_number):
                    raise ValueError("inconsistent_merged_case_number")
                keys = [compress_case_number(number)
                        for number in expand_merged_case_numbers(raw_number)]
            else:
                key = compress_case_number(clean_number)
                if not key:
                    raise ValueError("unreviewed_unexportable_case")
                keys = [key]

            # 법원 일련번호는 int, 헌재 D prefix는 string 유지.
            raw_serial = row["serial"] or "0"
            if not re.fullmatch(r"(?:[0-9]+|D[0-9]+)", raw_serial):
                raise ValueError("unsupported_publication_serial")
            serial = int(raw_serial) if raw_serial.isdigit() else raw_serial
            court_code = self.court_resolver.resolve(row["court"])
            date_int = compress_date(row["date"])
            name_raw = compress_case_name(row["case_name"] or "")

            for key in keys:
                compressed[key].append([serial, court_code, date_int, name_raw])
            self.export_dates[str(serial)] = row["date"]

        if require_full and policy and checked != policy.quarantine.keys():
            raise ValueError("quarantined_raw_missing")
        self.last_export_report = {"quarantinedRows": held, "legacyUnclassifiedSkips": skipped - held,
                                   "servingIds": len(self.export_dates)}
        return dict(compressed), skipped

    def compress_rows(self, rows) -> tuple[dict, int]:
        """Review-only subset conversion; publication must use export_core()."""
        self.conn.execute("SAVEPOINT reviewed_subset")
        try:
            policy = load_policy(self.conn)
            self.court_resolver = CourtCodeResolver(policy.reference["court_code_map"] if policy else None)
            return self._compress_rows(rows, policy, require_full=False)
        finally:
            self.conn.execute("RELEASE reviewed_subset")

    def export_core(self) -> tuple[dict, int]:
        """Validate one consistent SQLite snapshot; revalidate on every export."""
        self.conn.execute("SAVEPOINT verified_export")
        try:
            policy = load_policy(self.conn)
            self.court_resolver = CourtCodeResolver(policy.reference["court_code_map"] if policy else None)
            data, skipped = self._compress_rows(self.get_all_cases(), policy)
            if policy:
                data = policy.preserve_reference(data, self.court_resolver.code_map)
            return data, skipped
        finally:
            self.conn.execute("RELEASE verified_export")

    def export_all(self) -> tuple[dict, int]:
        return self.export_core()

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
