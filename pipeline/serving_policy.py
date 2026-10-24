"""Explicit boundary between immutable legacy raw and verified serving data.

A quarantine is a pinned review of OLD rows, never a catch-all for new errors.
The reference snapshot protects every existing key, record and court code.
"""
from collections import Counter
import hashlib
import json

from manifest import validate_payload

RAW_COLUMNS = ("serial", "case_name", "case_number", "case_number_clean", "date", "court", "inserted_at")
SCHEMA = """
CREATE TABLE IF NOT EXISTS serving_policy (
    id INTEGER PRIMARY KEY CHECK(id=1),
    reference_payload BLOB NOT NULL,
    reference_sha256 TEXT NOT NULL,
    review_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS export_quarantine (
    serial TEXT PRIMARY KEY REFERENCES cases(serial),
    raw_sha256 TEXT NOT NULL,
    reason TEXT NOT NULL,
    review_sha256 TEXT NOT NULL
);
"""


def table_exists(conn, name):
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def row_hash(row):
    values = [row[k] for k in RAW_COLUMNS]
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def quarantine_digest(rows):
    digest = hashlib.sha256()
    for row in rows:
        digest.update(json.dumps(list(row), ensure_ascii=False, separators=(",", ":")).encode() + b"\n")
    return digest.hexdigest()


class ServingPolicy:
    def __init__(self, conn):
        row = conn.execute("SELECT reference_payload,reference_sha256,review_json FROM serving_policy WHERE id=1").fetchone()
        if row is None:
            raise ValueError("missing_serving_policy")
        payload, expected, encoded = row
        if not isinstance(payload, bytes) or hashlib.sha256(payload).hexdigest() != expected:
            raise ValueError("serving_reference_hash_mismatch")
        self.reference = validate_payload(payload, min_keys=1)
        self.review = json.loads(encoded)
        if self.review.get("schema") != 1 or self.review.get("referenceSha256") != expected:
            raise ValueError("invalid_serving_policy")
        rows = conn.execute("SELECT serial,raw_sha256,reason,review_sha256 FROM export_quarantine ORDER BY serial").fetchall()
        if (len(rows) != self.review.get("quarantinedRows")
                or quarantine_digest(rows) != self.review.get("quarantineSha256")):
            raise ValueError("quarantine_inventory_changed")
        self.quarantine = {r[0]: (r[1], r[2], r[3]) for r in rows}
        self.reference_titles = {}
        for records in self.reference["cases"].values():
            for record in records:
                sid, title = str(record[0]), record[3]
                if sid in self.reference_titles and self.reference_titles[sid] != title:
                    self.reference_titles[sid] = None
                else:
                    self.reference_titles[sid] = title
        reference_ids = {str(record[0]) for records in self.reference["cases"].values() for record in records}
        for sid in reference_ids & self.quarantine.keys():
            # A later full reference can include an ALREADY verified historical
            # overlay. Physical quarantine and immutable raw stay pinned; absence
            # or alteration of its proof must still block the entire export.
            from historical_recovery import verify_receipt
            from compress import compress_case_number, compress_date, compress_case_name
            if not table_exists(conn, "historical_recovery_provenance"):
                raise ValueError("quarantine_would_remove_reference_record")
            receipt = conn.execute("SELECT receipt_json FROM historical_recovery_provenance WHERE serial=?", (sid,)).fetchone()
            raw = conn.execute("SELECT " + ",".join(RAW_COLUMNS) + " FROM cases WHERE serial=?", (sid,)).fetchone()
            if receipt is None or raw is None:
                raise ValueError("quarantine_would_remove_reference_record")
            raw = dict(zip(RAW_COLUMNS, raw))
            self.held(raw)
            corrected = verify_receipt(raw, json.loads(receipt[0]))
            court = self.reference["court_code_map"].get(corrected["court"])
            expected = [int(sid), court, compress_date(corrected["date"]), compress_case_name(corrected["case_name"])]
            actual = [(key, record) for key, records in self.reference["cases"].items()
                      for record in records if str(record[0]) == sid]
            if court is None or actual != [(compress_case_number(corrected["case_number"]), expected)]:
                raise ValueError("known_error_receipt_mismatch")

    def held(self, row):
        hold = self.quarantine.get(row["serial"])
        if hold is None:
            return False
        if row_hash(row) != hold[0]:
            raise ValueError("quarantined_raw_changed_requires_review")
        return True

    def preserve_reference(self, cases, court_map):
        if any(court_map.get(name) != code for name, code in self.reference["court_code_map"].items()):
            raise ValueError("reference_court_codes_changed")
        for key, expected in self.reference["cases"].items():
            actual = cases.get(key, [])
            remaining = Counter(tuple(record) for record in actual)
            for record in expected:
                value = tuple(record)
                if remaining[value] < 1:
                    raise ValueError("reference_record_removed_or_changed")
                remaining[value] -= 1
            # Preserve the entire reference array as an ordered prefix. New
            # verified publications may follow; no reference member is dropped.
            additions = []
            for record in actual:
                value = tuple(record)
                if remaining[value]:
                    additions.append(record)
                    remaining[value] -= 1
            cases[key] = list(expected) + additions
        return cases


def load_policy(conn):
    exists = table_exists(conn, "serving_policy")
    has_row = exists and conn.execute("SELECT 1 FROM serving_policy").fetchone() is not None
    if has_row:
        return ServingPolicy(conn)
    if (conn.execute("PRAGMA user_version").fetchone()[0] == 1
            or (table_exists(conn, "export_quarantine")
                and conn.execute("SELECT 1 FROM export_quarantine").fetchone())):
        raise ValueError("missing_serving_policy")
    return None
