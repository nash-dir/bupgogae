"""Coverage of actual exportable core, using real canonical calendar dates."""
from datetime import date
import re

from law_normalization import normalize_decision_date


def core_coverage(db_path, today=None):
    # Deferred import avoids api/law_normalization/master import cycles.
    from master_db import MasterDB
    today = today or date.today()
    db = MasterDB(db_path, read_only=True)
    try:
        db.export_core()  # Includes all raw bindings and reference preservation.
        dates = dict(db.export_dates)
        report = dict(db.last_export_report)
    finally:
        db.close()
    precedents, detc, unknown_dates = [], [], 0
    upper = today.strftime("%Y%m%d")
    for serial, value in dates.items():
        normalized = normalize_decision_date(str(value or ""))
        if normalized is None or not "19000101" <= normalized <= upper:
            unknown_dates += 1
            continue
        if re.fullmatch(r"[0-9]+", serial) and int(serial) > 0:
            precedents.append(normalized)
        elif re.fullmatch(r"D[0-9]+", serial):
            detc.append(normalized)
    return {"precedent_count": len(precedents), "detc_count": len(detc),
            "oldest": min(precedents, default=None), "newest": max(precedents, default=None),
            "unknown_core_dates": unknown_dates, **report}


def require_coverage(coverage, *, minimum_precedents, earliest_cutoff, today=None, require_detc=True):
    today = today or date.today()
    if coverage["precedent_count"] < minimum_precedents:
        raise ValueError("insufficient_precedent_count")
    if not coverage["oldest"] or coverage["oldest"] > earliest_cutoff:
        raise ValueError("historical_coverage_missing")
    if not coverage["newest"] or coverage["newest"] < f"{today.year - 2}0101":
        raise ValueError("recent_coverage_missing")
    if require_detc and coverage["detc_count"] < 1:
        raise ValueError("detc_coverage_missing")
    return coverage
