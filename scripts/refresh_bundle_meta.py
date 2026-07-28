"""정적 fallback DB에서 파생 메타데이터를 결정적으로 다시 만든다."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "extension" / "data" / "db.json"
META_PATH = ROOT / "extension" / "data" / "bupgogae_meta.json"


def main() -> int:
    db_bytes = DB_PATH.read_bytes()
    db = json.loads(db_bytes)
    meta = json.loads(META_PATH.read_text(encoding="utf-8"))

    version = str(db["version"])
    cases = db["cases"]
    total = db["total"]
    court_map = db["court_code_map"]
    if (
        len(version) != 8
        or not version.isdigit()
        or not isinstance(cases, dict)
        or len(cases) != total
        or not isinstance(court_map, dict)
        or not court_map
    ):
        raise ValueError("bundle DB schema or counts are invalid")

    record_count = sum(
        len(records) for records in cases.values() if isinstance(records, list)
    )
    if record_count < total:
        raise ValueError("bundle record count is smaller than unique case count")

    meta["version"] = f"{version[:4]}.{version[4:6]}.{version[6:8]}"
    # DB version is the canonical build date; using it keeps regenerated source
    # deterministic rather than changing the file on every packaging run.
    meta["generated_at"] = (
        f"{version[:4]}-{version[4:6]}-{version[6:8]}T00:00:00+09:00"
    )
    meta["stats"] = {
        "total": record_count,
        "skipped": 0,
        "collisions": record_count - total,
        "unique_keys": total,
        "file_size_bytes": len(db_bytes),
        "file_size_mb": round(len(db_bytes) / 1048576, 2),
    }
    meta["court_code_map"] = court_map

    temp_path = META_PATH.with_suffix(".json.tmp")
    with temp_path.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(meta, ensure_ascii=False, indent=2))
        stream.write("\n")
    temp_path.replace(META_PATH)
    print(
        f"bundle meta refreshed: version={version} "
        f"cases={total:,} courts={len(court_map):,}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
