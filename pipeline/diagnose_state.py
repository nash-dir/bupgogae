"""Read-only state diagnosis. Output only enum errors and public case records."""
import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import re

from master_db import MasterDB
from serving_policy import load_policy
from source_corrections import KNOWN_METADATA_ERRORS


def safe_error(error):
    value = str(error)
    return value if re.fullmatch(r"[a-z0-9_]{1,80}", value) else type(error).__name__


def diagnose(path):
    path = Path(path)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    db = MasterDB(str(path), read_only=True)
    try:
        report = {"masterSha256": before, "rawRows": db.count(), "exportError": None}
        try:
            db.export_core()
        except ValueError as error:
            report["exportError"] = safe_error(error)
        policy = load_policy(db.conn)
        report["referenceSha256"] = policy.review["referenceSha256"] if policy else None
        report["reviewedMetadataRaw"] = {}
        for sid in KNOWN_METADATA_ERRORS:
            row = db.conn.execute("SELECT serial,case_name,case_number,date,court FROM cases WHERE serial=?", (sid,)).fetchone()
            if row is not None:
                report["reviewedMetadataRaw"][sid] = dict(zip(
                    ("serial", "case_name", "case_number", "date", "court"), row))

        try:
            cases, skipped = db.compress_rows(db.get_all_cases())
        except ValueError as error:
            report["conversionError"] = safe_error(error)
            return report
        report.update(keys=len(cases), skipped=skipped)
        by_serial = defaultdict(list)
        for key, records in cases.items():
            for record in records:
                by_serial[str(record[0])].append({"key": key, "record": record})
        differences = []
        if policy:
            for key, records in policy.reference["cases"].items():
                for record in records:
                    if record not in cases.get(key, []):
                        differences.append({"key": key, "expected": record,
                                            "actual": by_serial[str(record[0])]})
            report["changedCourtCodes"] = {
                name: [code, db.court_resolver.code_map.get(name)]
                for name, code in policy.reference["court_code_map"].items()
                if db.court_resolver.code_map.get(name) != code}
        report.update(differenceCount=len(differences), differences=differences[:100])
        return report
    finally:
        db.close()
        if hashlib.sha256(path.read_bytes()).hexdigest() != before:
            raise ValueError("diagnostic_modified_master")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--master", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = diagnose(args.master)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
