"""Build a court-only local candidate from pinned, immutable reviewed inputs.

Never edits inputs or publishes. Resume revalidates hashes and rebuilds staging.
Unpublished legacy court rows remain bound raw evidence pending source review;
new unknown rows cannot inherit that quarantine.
"""
import argparse
from collections import Counter
from contextlib import closing
import gzip
import hashlib
import json
from pathlib import Path
import re
import sqlite3

from manifest import CORE_CASE_KEY_RE, build_manifest, validate_payload
from master_db import MasterDB
from recover_missing import atomic_json, file_hash, readonly, run_lock, verify_pinned_input
from serving_policy import RAW_COLUMNS, SCHEMA, quarantine_digest, row_hash

OUTPUT_NAMES = {"master.db", "db.json", "db.json.gz", "manifest.json", "removed-non-court-raw.json"}


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def prepare(master, reference, output, *, master_sha256, reference_sha256):
    master, reference, output = map(lambda p: Path(p).resolve(), (master, reference, output))
    if any(output == p or output in p.parents for p in (master, reference)):
        raise ValueError("output_must_not_contain_inputs")
    output.mkdir(parents=True, exist_ok=True)
    with run_lock(output / "prepare.lock"):
        for path, expected in ((master, master_sha256), (reference, reference_sha256)):
            verify_pinned_input(path, expected)
        inputs = {"masterSha256": master_sha256, "referenceSha256": reference_sha256}
        checkpoint = output / "continuation.json"
        if checkpoint.exists():
            previous = json.loads(checkpoint.read_bytes())
            if previous["inputs"] != inputs:
                raise ValueError("resume_input_mismatch")
            if previous["stage"] == "verified_local_candidate":
                outputs = previous.get("outputs")
                if (previous.get("schema", 1) != 1 or previous.get("published") is not False
                        or not isinstance(outputs, dict) or set(outputs) != OUTPUT_NAMES
                        or any(not isinstance(v, str) or re.fullmatch(r"[0-9a-f]{64}", v) is None
                               for v in outputs.values())):
                    raise ValueError("invalid_completed_receipt")
                for name, expected in previous["outputs"].items():
                    if not (output / name).is_file() or file_hash(output / name) != expected:
                        raise ValueError("completed_candidate_changed")
                return previous
        atomic_json(checkpoint, {"inputs": inputs, "stage": "building", "published": False})
        old = json.loads(reference.read_bytes())
        core = dict(old)
        # Only the obsolete non-court format is removed. No subject/source filter.
        core["cases"] = {k: v for k, v in old["cases"].items() if CORE_CASE_KEY_RE.fullmatch(k)}
        removed_keys = set(old["cases"]) - core["cases"].keys()
        if any(not k.startswith(("TX", "KP")) for k in removed_keys):
            raise ValueError("unexpected_reference_key")
        core["total"] = len(core["cases"])
        if "keys" in core:
            core["keys"] = core["total"]
        core["court_code_map"] = {k: v for k, v in old["court_code_map"].items()
                                  if k not in ("조세심판원", "특허심판원")}
        payload = encode(core)
        validate_payload(payload)
        approved = {str(r[0]) for records in core["cases"].values() for r in records}
        stage = output / "staging.db"
        # SQLite backup replaces only this staging copy, never the archived input.
        with readonly(master) as source, closing(sqlite3.connect(stage)) as target:
            source.backup(target)
        for path, expected in ((master, master_sha256), (reference, reference_sha256)):
            verify_pinned_input(path, expected)
        with closing(sqlite3.connect(stage)) as conn:
            conn.row_factory = sqlite3.Row
            before = conn.execute("SELECT * FROM cases ORDER BY serial").fetchall()
            removed = [r for r in before if not re.fullmatch(r"(?:[0-9]+|D[0-9]+)", r["serial"])]
            if any(r["court"] not in ("조세심판원", "특허심판원") for r in removed):
                raise ValueError("unreviewed_non_court_serial")
            if approved & {r["serial"] for r in removed}:
                raise ValueError("scope_would_remove_court_record")
            removed_inventory = [{"serial": r["serial"], "rawSha256": row_hash(r), "court": r["court"]}
                                 for r in removed]
            atomic_json(output / "removed-non-court-raw.json", removed_inventory)
            conn.executescript(SCHEMA)
            conn.execute("BEGIN")
            for r in removed:
                for table in ("known_error_provenance", "reviewed_recovery_provenance"):
                    conn.execute(f"DELETE FROM {table} WHERE serial=?", (r["serial"],))
                conn.execute("DELETE FROM cases WHERE serial=?", (r["serial"],))
            for table in ("kipris_cases", "kipris_backfill_log"):
                conn.execute(f"DROP TABLE IF EXISTS {table}")
            retained = conn.execute("SELECT * FROM cases ORDER BY serial").fetchall()
            # Exact seven-field preservation for every retained court raw row.
            removed_ids = {r["serial"] for r in removed}
            expected = [[r[k] for k in RAW_COLUMNS] for r in before if r["serial"] not in removed_ids]
            if expected != [[r[k] for k in RAW_COLUMNS] for r in retained]:
                raise ValueError("retained_raw_changed")
            review_id = hashlib.sha256(encode(inputs)).hexdigest()
            quarantine = [(r["serial"], row_hash(r), "legacy_not_in_reviewed_snapshot", review_id)
                          for r in retained if r["serial"] not in approved]
            conn.execute("DELETE FROM export_quarantine")
            conn.executemany("INSERT INTO export_quarantine VALUES(?,?,?,?)", quarantine)
            review = {"schema": 1, **inputs, "referenceSha256": hashlib.sha256(payload).hexdigest(),
                      "quarantinedRows": len(quarantine), "quarantineSha256": quarantine_digest(quarantine),
                      "scope": "courts_and_constitutional_court", "removedRawRows": len(removed)}
            conn.execute("INSERT OR REPLACE INTO serving_policy VALUES(1,?,?,?)",
                         (payload, review["referenceSha256"], json.dumps(review)))
            conn.execute("PRAGMA user_version=1")
            conn.commit()
            conn.execute("PRAGMA journal_mode=DELETE")
            if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("candidate_integrity_failed")
        db = MasterDB(str(stage), read_only=True)
        try:
            cases, skipped = db.export_core()
            actual = dict(core, cases=cases, total=len(cases), court_code_map=db.court_resolver.code_map)
            if "keys" in actual:
                actual["keys"] = len(cases)
            if actual != core:
                raise ValueError("standard_export_differs_from_reviewed_court_snapshot")
        finally:
            db.close()
        from baseline_health import core_coverage
        from crawler_runner import require_healthy_baseline
        from datetime import date
        from sync_state import _verify_incremental_health
        require_healthy_baseline(str(stage), date.today())
        _verify_incremental_health(str(stage))
        coverage = core_coverage(str(stage))
        (output / "db.json").write_bytes(payload)
        (output / "db.json.gz").write_bytes(gzip.compress(payload, mtime=0))
        atomic_json(output / "manifest.json", build_manifest(payload))
        candidate = output / "master.db"
        stage.replace(candidate)
        receipt = {"schema": 1, "inputs": inputs, "stage": "verified_local_candidate", "published": False,
                   "removedKeys": len(removed_keys), "removedRawRows": len(removed),
                   "retainedRawRows": len(retained), "quarantinedRows": len(quarantine),
                   "keys": core["total"], "records": sum(map(len, core["cases"].values())),
                   "courts": len(core["court_code_map"]), "skippedBoundArchive": skipped,
                   "masterSha256": file_hash(candidate), "payloadSha256": file_hash(output / "db.json"),
                   "coverage": coverage, "removalCourts": dict(Counter(r["court"] for r in removed))}
        receipt["outputs"] = {name: file_hash(output / name) for name in sorted(OUTPUT_NAMES)}
        atomic_json(output / "validation.json", receipt)
        atomic_json(checkpoint, receipt)
        return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("master", "reference", "output", "master-sha256", "reference-sha256"):
        parser.add_argument("--" + name, required=True)
    args = vars(parser.parse_args())
    print(json.dumps(prepare(**args), ensure_ascii=False, indent=2))
