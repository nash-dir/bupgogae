"""Explicit, source-verified metadata migration; never edits archived raw rows."""
import argparse
import copy
import hashlib
import json
from pathlib import Path

from apply_historical_recovery import current_item
from compress import CourtCodeResolver, compress_case_number, compress_case_name, compress_date
from known_errors import CorrectionError, LIST_FIELDS
from api import get_text
from master_db import MasterDB
from serving_policy import RAW_COLUMNS, load_policy, table_exists
import source_corrections as sources

MIGRATION = "official_metadata_20261024"
SCHEMA = """CREATE TABLE IF NOT EXISTS reference_metadata_migrations (
    id TEXT PRIMARY KEY, before_payload BLOB NOT NULL, before_review TEXT NOT NULL,
    before_sha256 TEXT NOT NULL, after_sha256 TEXT NOT NULL,
    corrections_sha256 TEXT NOT NULL, raw_sha256 TEXT NOT NULL
)"""


def raw_digest(conn):
    digest = hashlib.sha256()
    for row in conn.execute("SELECT " + ",".join(RAW_COLUMNS) + " FROM cases ORDER BY serial"):
        digest.update(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode() + b"\n")
    return digest.hexdigest()


def migrate(path, *, apply=False, fetch=current_item, fetch_judgment=None):
    entries = {key: entry for key, entry in sources.entries().items()
               if entry["profile"] == sources.METADATA_PROFILE}
    if {entry["record"]["serial"] for entry in entries.values()} != {"69909", "185122"}:
        raise ValueError("metadata_migration_inventory_mismatch")
    pins = sources.digest(entries)
    # Network verification finishes before opening a writable connection.
    receipts = {}
    for entry in entries.values():
        item = fetch(entry["expectedList"])
        fields = {key: get_text(item, key) for key in LIST_FIELDS}
        receipt = sources.resolve(fields, fetch=fetch_judgment or sources.fetch_judgment)
        if receipt is None or receipt["profile"] != sources.METADATA_PROFILE:
            raise CorrectionError("known_error_receipt_mismatch")
        receipts[entry["record"]["serial"]] = receipt
    db = MasterDB(str(path), read_only=True)
    try:
        before_payload, before_sha, before_review = db.conn.execute(
            "SELECT reference_payload,reference_sha256,review_json FROM serving_policy WHERE id=1").fetchone()
        policy = load_policy(db.conn)
        # A normal full export must pass both before and after the migration.
        # Corrupt failed-run artifacts are diagnostic inputs, never repair inputs.
        db.export_core()
        audit = db.conn.execute("SELECT before_payload,before_review,before_sha256,after_sha256,corrections_sha256 "
                                "FROM reference_metadata_migrations WHERE id=?", (MIGRATION,)).fetchone() \
            if table_exists(db.conn, "reference_metadata_migrations") else None
        if audit:
            if (hashlib.sha256(audit[0]).hexdigest() != audit[2] or audit[3] != before_sha or audit[4] != pins
                    or json.loads(audit[1])["referenceSha256"] != audit[2]):
                raise ValueError("metadata_migration_receipt_mismatch")
            return {"applied": False, "alreadyApplied": True, "sourceProofsVerified": True,
                    "beforeSha256": audit[2], "afterSha256": audit[3], "correctionsSha256": pins}
        updated = copy.deepcopy(policy.reference)
        resolver = CourtCodeResolver(updated["court_code_map"])
        changes = []
        for entry in entries.values():
            record, old = entry["record"], entry["expectedPreviousRaw"]
            sid = record["serial"]
            if db.conn.execute("SELECT 1 FROM reviewed_recovery_provenance WHERE serial=?", (sid,)).fetchone():
                raise ValueError("metadata_migration_receipt_mismatch")
            stored = db.conn.execute("SELECT serial,case_name,case_number,date,court FROM cases WHERE serial=?", (sid,)).fetchone()
            if stored is None or dict(zip(("serial", "case_name", "case_number", "date", "court"), stored)) != old:
                raise ValueError("metadata_migration_raw_mismatch")
            key, expected = entry["expectedReferenceKey"], entry["expectedReferenceRecord"]
            occurrences = [(k, i) for k, rows in updated["cases"].items() for i, row in enumerate(rows) if str(row[0]) == sid]
            if len(occurrences) != 1 or updated["cases"].get(key, []).count(expected) != 1:
                raise ValueError("metadata_migration_reference_mismatch")
            if compress_case_number(record["case_number"]) != key:
                raise ValueError("metadata_migration_identity_changed")
            replacement = [int(sid), resolver.resolve(record["court"]), compress_date(record["date"]), compress_case_name(record["case_name"])]
            if replacement == expected:
                raise ValueError("metadata_migration_no_change")
            index = updated["cases"][key].index(expected)
            updated["cases"][key][index] = replacement
            changes.append({"key": key, "before": expected, "after": replacement})
        updated["court_code_map"] = dict(resolver.code_map)
        after_payload = json.dumps(updated, ensure_ascii=False, separators=(",", ":")).encode()
        after_sha = hashlib.sha256(after_payload).hexdigest()
        raw_sha = raw_digest(db.conn)
    finally:
        db.close()
    report = {"applied": False, "sourceProofsVerified": True, "beforeSha256": before_sha,
              "afterSha256": after_sha, "correctionsSha256": pins, "rawSha256": raw_sha, "changes": changes}
    if not apply:
        return report
    db = MasterDB(str(path))
    try:
        db.conn.execute("BEGIN IMMEDIATE")
        current = db.conn.execute("SELECT reference_payload,reference_sha256,review_json FROM serving_policy WHERE id=1").fetchone()
        if current != (before_payload, before_sha, before_review) or raw_digest(db.conn) != raw_sha:
            raise ValueError("metadata_migration_input_changed")
        for entry in entries.values():
            sid = entry["record"]["serial"]
            receipt = receipts[sid]
            encoded = json.dumps(receipt, ensure_ascii=False, sort_keys=True)
            db.conn.execute("INSERT INTO reviewed_recovery_provenance VALUES(?,?,?,?,?)",
                            (sid, receipt["entrySha256"], sources.digest(receipt["expectedList"]),
                             json.dumps(entry["record"], ensure_ascii=False),
                             json.dumps(entry["expectedPreviousRaw"], ensure_ascii=False)))
            db.conn.execute("INSERT INTO source_correction_provenance VALUES(?,?)", (sid, encoded))
        review = json.loads(before_review)
        review["referenceSha256"] = after_sha
        db.conn.execute("UPDATE serving_policy SET reference_payload=?,reference_sha256=?,review_json=? WHERE id=1",
                        (after_payload, after_sha, json.dumps(review, ensure_ascii=False)))
        # Only the reference hash changes: existing title/raw bindings remain exact.
        db.conn.execute("UPDATE reference_title_provenance SET reference_sha256=? WHERE reference_sha256=?", (after_sha, before_sha))
        db.conn.execute(SCHEMA)
        db.conn.execute("INSERT INTO reference_metadata_migrations VALUES(?,?,?,?,?,?,?)",
                        (MIGRATION, before_payload, before_review, before_sha, after_sha, pins, raw_sha))
        db.export_core()
        if raw_digest(db.conn) != raw_sha:
            raise ValueError("metadata_migration_raw_changed")
        db.conn.commit()
        report["applied"] = True
        return report
    except Exception:
        db.conn.rollback()
        raise
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    result = migrate(args.data_dir / "master.db", apply=args.apply)
    (args.data_dir / "metadata-migration-report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never include source URLs, HTTP exception chains, or private state text.
        safe = {
            "metadata_migration_inventory_mismatch", "metadata_migration_receipt_mismatch",
            "metadata_migration_raw_mismatch", "metadata_migration_reference_mismatch",
            "metadata_migration_identity_changed", "metadata_migration_no_change",
            "metadata_migration_input_changed", "metadata_migration_raw_changed",
            "known_error_source_changed", "known_error_source_unavailable", "known_error_input_changed",
            "known_error_receipt_mismatch", "reference_record_removed_or_changed",
        }
        reason = str(error) if str(error) in safe else type(error).__name__
        print(json.dumps({"applied": False, "error": reason}))
        raise SystemExit(1) from None
