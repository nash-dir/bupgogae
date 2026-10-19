"""Convert a hash-pinned review dictionary to the permanent pipeline registry.

Local files only. Full originals remain in the review archive; no party names,
addresses, API links/keys or body text are copied into the runtime dictionary.
"""
import argparse
from contextlib import closing
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
from known_errors import CorrectionRegistry, LIST_FIELDS, LAW_COMPARISON_PROFILE, law_comparison_hash  # noqa: E402


def _file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepare(dictionary, catalog, expected_sha256, proof_inventory, source_root,
            expected_catalog_sha256, expected_inventory_sha256):
    body = Path(dictionary).read_bytes()
    if hashlib.sha256(body).hexdigest() != expected_sha256:
        raise ValueError("review_dictionary_hash_mismatch")
    if _file_hash(catalog) != expected_catalog_sha256 or _file_hash(proof_inventory) != expected_inventory_sha256:
        raise ValueError("review_source_inputs_changed")
    review = json.loads(body)
    root = Path(source_root).resolve()
    proofs = {p["url"]: p for p in json.loads(Path(proof_inventory).read_bytes())["proofs"]}
    entries = {}
    with closing(sqlite3.connect(Path(catalog).resolve().as_uri() + "?mode=ro", uri=True)) as db:
        for key, entry in review["entries"].items():
            row = db.execute("SELECT record_json FROM records WHERE serial=?", (entry["serial"],)).fetchone()
            if not row:
                raise ValueError("missing_reviewed_catalog_row")
            original = json.loads(row[0])
            entries[key] = {
                "source": entry["source"], "serial": entry["serial"],
                "expectedList": {k: original.get(k, "") for k in LIST_FIELDS},
                "status": entry["validationStatus"], "disposition": entry["recoveryDisposition"],
                "record": entry["correctedRecord"],
                "urls": entry["sourceUrls"][:2],
                "bodyHashes": [entry["applyIf"].get("lawBodySha256"), entry["applyIf"].get("originalBodySha256")],
                "reason": entry["reason"], "rules": entry["rules"],
            }
            if entry["validationStatus"] == "verified":
                proof = proofs[entry["sourceUrls"][0]]
                path = (root / proof["path"]).resolve()
                if not path.is_relative_to(root / "backfill"):
                    raise ValueError("proof_outside_recovery_directory")
                raw = gzip.decompress(path.read_bytes())
                if hashlib.sha256(raw).hexdigest() != entry["applyIf"]["lawBodySha256"]:
                    raise ValueError("law_source_evidence_changed")
                entries[key]["lawComparisonSha256"] = law_comparison_hash(raw)
    result = {"schema": 3, "version": review["version"], "reviewDictionarySha256": expected_sha256,
              "lawComparisonProfile": LAW_COMPARISON_PROFILE,
              "normalizationProfileSha256": review["normalizationProfileSha256"], "entries": entries}
    # Rules can contain retained excerpts of a judgment. Keep only the rule name
    # here; the full hash-bound review dictionary retains all detailed evidence.
    for entry in entries.values():
        entry["rules"] = {k: v.get("rule", "reviewed_source_identity")
                          for k, v in entry["rules"].items() if isinstance(v, dict)}
    output = json.dumps(result, ensure_ascii=False, indent=2).encode() + b"\n"
    CorrectionRegistry(output)
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dictionary", required=True)
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--proof-inventory", required=True)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--expected-catalog-sha256", required=True)
    parser.add_argument("--expected-inventory-sha256", required=True)
    args = parser.parse_args()
    output = prepare(args.dictionary, args.catalog, args.expected_sha256, args.proof_inventory, args.source_root,
                     args.expected_catalog_sha256, args.expected_inventory_sha256)
    Path(args.out).write_bytes(output)
    print(json.dumps({"sha256": hashlib.sha256(output).hexdigest(), "bytes": len(output)}))
