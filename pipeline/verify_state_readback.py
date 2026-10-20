"""Read-only verification of a downloaded private state against the reviewed bundle."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3

from master_db import MasterDB


def verify(data_dir: Path, expected_sha256: str, reference_path: Path) -> dict:
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("expected_state_sha256_required")
    master = data_dir / "master.db"
    # Python 3.10 on Actions does not provide hashlib.file_digest.
    checksum = hashlib.sha256()
    with master.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    digest = checksum.hexdigest()
    if digest != expected_sha256:
        # Both are validated/computed SHA-256 values, never source data or keys.
        raise ValueError(f"state_checksum_mismatch expected={expected_sha256} actual={digest}")
    conn = sqlite3.connect(master.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        if conn.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("state_integrity_failed")
        rows = conn.execute("SELECT count(*) FROM cases").fetchone()[0]
    finally:
        conn.close()
    reference = json.loads(reference_path.read_bytes())
    db = MasterDB(str(master), read_only=True)
    try:
        cases, _ = db.export_core()
        if cases != reference["cases"]:
            raise ValueError("reviewed_cases_mismatch")
        if db.court_resolver.code_map != reference["court_code_map"]:
            raise ValueError("reviewed_courts_mismatch")
    finally:
        db.close()
    return {"sha256": digest, "integrity": "ok", "rawRows": rows,
            "keys": len(cases), "records": sum(map(len, cases.values())),
            "reviewedCasesAndCourtsMatch": True, "publication": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.dir, os.environ.get("EXPECTED_STATE_SHA256", ""),
                            Path(__file__).resolve().parents[1] / "extension/data/db.json")))
