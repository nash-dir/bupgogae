"""Explicit manual recovery using current official lists and pinned original judgments."""
import argparse
import json
import math
from pathlib import Path

from api import fetch_xml_safe, get_text
import crawler_runner as runner
import historical_recovery
from known_errors import LIST_FIELDS, CorrectionError
from law_normalization import normalize_decision_date
from master_db import MasterDB
import source_corrections


def current_item(expected, fetch=fetch_xml_safe):
    date = normalize_decision_date(expected["선고일자"])
    found, count, observed = [], None, 0
    page = 1
    while True:
        body = fetch(date, page=page)
        if not body:
            raise CorrectionError("known_error_source_unavailable")
        items, total = runner._parse_search_page(body, expected_root="PrecSearch", item_tag="prec",
                                                source=date, page=page)
        if count is not None and total != count:
            raise CorrectionError("known_error_source_changed")
        count = total
        observed += len(items)
        found.extend(item for item in items if get_text(item, "판례일련번호") == expected["판례일련번호"])
        pages = max(1, math.ceil(count / 100))
        if pages > runner.PRECEDENT_MAX_PAGES_PER_RANGE:
            raise CorrectionError("known_error_source_changed")
        if page == pages:
            break
        page += 1
    if (observed != count or len(found) != 1
            or {k: get_text(found[0], k) for k in LIST_FIELDS} != expected):
        raise CorrectionError("known_error_input_changed")
    return found[0]


def recover(path, *, apply=False, fetch=current_item):
    # Collect and verify ALL proofs before the first recovery write.
    db = MasterDB(str(path), read_only=True)
    try:
        rows = []
        replay = db.raw_replay_checker()
        for entry in historical_recovery.entries().values():
            fields = entry["expectedList"]
            item = fetch(fields)
            rows.append(runner._precedent_case(item, normalize_decision_date(fields["선고일자"]), 1, replay))
        entry = source_corrections.entries()["국세법령정보시스템:617561"]
        fields = entry["expectedList"]
        rows.append(runner._precedent_case(fetch(fields), normalize_decision_date(fields["선고일자"]), 1))
    finally:
        db.close()
    result = {"serials": [row["serial"] for row in rows], "sourceProofsVerified": True, "applied": apply}
    if apply:
        db = MasterDB(str(path))
        try:
            result["upsert"] = db.upsert_raw(rows)
            cases, skipped = db.export_core()
            result.update(keys=len(cases), skipped=skipped, export=db.last_export_report)
        finally:
            db.close()
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    report = recover(args.data_dir / "master.db", apply=args.apply)
    (args.data_dir / "historical-recovery-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
