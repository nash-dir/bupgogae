"""Read-only verification of private state against the hash-verified published snapshot."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3

import requests

from master_db import MasterDB
from manifest import MIN_CORE_KEYS, validate_payload


PUBLIC_BASE = "https://api.bup.live/bupgogae/"


def fetch_published_reference(*, get=None, min_keys=MIN_CORE_KEYS):
    get = get or requests.get
    def bounded(path, limit):
        with get(PUBLIC_BASE + path, stream=True, allow_redirects=False, timeout=(10, 60),
                 headers={"Cache-Control": "no-cache"}) as response:
            if response.status_code != 200:
                raise ValueError("published_reference_unavailable")
            chunks, total = [], 0
            for chunk in response.iter_content(chunk_size=65536):
                total += len(chunk)
                if total > limit:
                    raise ValueError("published_reference_too_large")
                chunks.append(chunk)
            return b"".join(chunks)
    manifest = json.loads(bounded("manifest-v0.9.0.json", 65536))
    core = manifest.get("core", {})
    sha = core.get("sha256", "")
    if (manifest.get("schema") != 1 or manifest.get("contract") != "v0.9.0"
            or not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha)
            or core.get("object_path") != "objects/" + sha + ".json.gz"):
        raise ValueError("published_reference_invalid_manifest")
    body = bounded(core["object_path"], 50 * 1024 * 1024)
    data = validate_payload(body, min_keys=min_keys)
    if (hashlib.sha256(body).hexdigest() != sha or len(body) != core.get("bytes_raw")
            or data["version"] != core.get("version") or len(data["cases"]) != core.get("total")):
        raise ValueError("published_reference_integrity_failed")
    return data, sha


def verify(data_dir: Path, expected_sha256: str, reference_path: Path | None = None) -> dict:
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
    if reference_path is None:
        reference, reference_sha = fetch_published_reference()
    else:
        body = reference_path.read_bytes()
        reference, reference_sha = json.loads(body), hashlib.sha256(body).hexdigest()
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
            "reviewedCasesAndCourtsMatch": True, "referenceSha256": reference_sha, "publication": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.dir, os.environ.get("EXPECTED_STATE_SHA256", ""))))
