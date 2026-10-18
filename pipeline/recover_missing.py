"""Add a reviewed recovery subset to a COPY of a full master. Never publishes.

All inputs are hash-pinned and readonly. Existing conflicts block the merge
unless an exact, separately pinned review preserves their raw records/source
IDs. Interrupted transactions roll back; --resume replays the pinned baseline.
"""
import argparse
from contextlib import closing, contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time

from api import clean_case_number
from compress import compress_case_number
from known_errors import RECORD_FIELDS, validate_record
from law_normalization import expand_merged_case_numbers, is_merged_case_number
from master_db import MasterDB


def file_hash(path):
    with Path(path).open("rb") as stream:
        result = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
        return result.hexdigest()


def verify_pinned_input(path, expected):
    wal = Path(str(path) + "-wal")
    if wal.exists() and wal.stat().st_size:
        raise ValueError("checkpoint_inputs_before_hashing")
    if file_hash(path) != expected:
        raise ValueError("pinned_input_hash_mismatch")


@contextmanager
def readonly(path):
    with closing(sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)) as db:
        yield db


def atomic_json(path, data):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     prefix=path.stem + "-", suffix=".tmp", delete=False) as stream:
        stream.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
        temporary = Path(stream.name)
    try:
        # Windows readers that omit FILE_SHARE_DELETE can briefly deny rename
        # even after our writer is closed. Keep atomic replacement; never unlink
        # the old receipt or turn a failed checkpoint into success.
        for attempt in range(4):
            try:
                temporary.replace(path)
                break
            except PermissionError as error:
                if getattr(error, "winerror", None) not in (5, 32, 33) or attempt == 3:
                    raise
                time.sleep(0.05 * (2 ** attempt))
    finally:
        temporary.unlink(missing_ok=True)


def keys(number):
    members = expand_merged_case_numbers(number) if is_merged_case_number(number) else (number,)
    values = tuple(compress_case_number(clean_case_number(n)) for n in members)
    if None in values:
        raise ValueError("unexportable_baseline_or_recovery_number")
    return values


@contextmanager
def run_lock(path):
    with path.open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise ValueError("another_merge_process_is_running") from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def merge(baseline, recovery, catalog, output, **options):
    destination = Path(output).resolve()
    if any(destination == Path(p).resolve() or destination in Path(p).resolve().parents
           for p in (baseline, recovery, catalog)):
        raise ValueError("output_must_not_contain_an_input")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with run_lock(destination.with_name(destination.name + ".recovery.lock")):
        return _merge(baseline, recovery, catalog, output, **options)


def _merge(baseline, recovery, catalog, output, *, baseline_sha256, recovery_sha256,
          catalog_sha256, resume=False, min_baseline_rows=100_000,
          overlays_path=None, overlays_sha256=None):
    paths = [Path(p).resolve() for p in (baseline, recovery, catalog)]
    output = Path(output).resolve()
    if any(output == p or output in p.parents for p in paths):
        raise ValueError("output_must_not_contain_an_input")
    expected = dict(zip(("baseline", "recovery", "catalog"),
                        (baseline_sha256, recovery_sha256, catalog_sha256)))
    for name, path in zip(expected, paths):
        # A hash of just the main file cannot pin uncheckpointed WAL contents.
        try:
            verify_pinned_input(path, expected[name])
        except ValueError as error:
            if str(error) == "pinned_input_hash_mismatch":
                raise ValueError(name + "_hash_mismatch") from error
            raise
    configuration = {"inputPaths": [str(p) for p in paths], "inputSha256": expected,
                     "minimumBaselineRows": min_baseline_rows, "overlaysSha256": overlays_sha256}
    overlays, collision_reviews = {}, {}
    if overlays_path is not None:
        if file_hash(overlays_path) != overlays_sha256:
            raise ValueError("existing_overlay_hash_mismatch")
        overlay_data = json.loads(Path(overlays_path).read_bytes())
        if overlay_data["baselineSha256"] != baseline_sha256:
            raise ValueError("existing_overlay_baseline_changed")
        overlays = overlay_data["entries"]
        collision_reviews = overlay_data.get("collisionReviews", {})
    receipt_path = output / "recovery-merge-receipt.json"
    if output.exists():
        if not resume or not receipt_path.exists():
            raise ValueError("output_exists_use_matching_resume")
        receipt = json.loads(receipt_path.read_bytes())
        if receipt["configuration"] != configuration:
            raise ValueError("resume_input_changed")
        if receipt["phase"] == "validated_local_master":
            if file_hash(output / "master.db") != receipt["masterSha256"]:
                raise ValueError("completed_output_changed")
            return receipt
    else:
        output.mkdir(parents=True)
        receipt = {"schema": 1, "configuration": configuration, "phase": "preparing_baseline_copy",
                   "operationalPublication": False, "publishBlocked": True}
        atomic_json(receipt_path, receipt)
    staging = output / "merge-staging.db"
    final = output / "master.db"
    if final.exists():
        if (receipt["phase"] != "merged_validated_before_rename" or staging.exists()
                or file_hash(final) != receipt["masterSha256"]):
            raise ValueError("unexpected_final_output")
        receipt["phase"] = "validated_local_master"
        atomic_json(receipt_path, receipt)
        return receipt
    # Replay from the same immutable baseline. Never trust a progress count as
    # proof that partially written staging data passed validation.
    with readonly(paths[0]) as src, closing(sqlite3.connect(staging)) as dst:
        src.backup(dst)
    receipt["phase"] = "baseline_copied"
    atomic_json(receipt_path, receipt)
    db = MasterDB(str(staging))
    db.conn.execute("PRAGMA synchronous=FULL")
    try:
        if db.conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("baseline_integrity_failed")
        db.conn.row_factory = sqlite3.Row
        existing = {row["serial"]: {k: row[k] for k in RECORD_FIELDS}
                    for row in db.conn.execute("SELECT * FROM cases")}
        db.conn.row_factory = None
        if len(existing) < min_baseline_rows:
            raise ValueError("full_baseline_master_required")
        identities, baseline_holds = {}, []
        for row in existing.values():
            try:
                baseline_keys = keys(row["case_number"] or "")
            except ValueError as exc:
                baseline_holds.append({"serial": row["serial"], "reason": str(exc)})
                continue
            for key in baseline_keys:
                identities.setdefault((key, row["court"], row["date"]), set()).add(row["serial"])
        pending, conflicts, identical, reviewed_overlays, reviewed_collisions = [], [], [], [], []
        pending_by_id = {}
        with readonly(paths[1]) as source, readonly(paths[2]) as catalog_db:
            source.row_factory = sqlite3.Row
            for row in source.execute("SELECT * FROM cases ORDER BY serial"):
                record = {k: row[k] for k in RECORD_FIELDS}
                validate_record(record)
                sid = record["serial"]
                item = catalog_db.execute("SELECT record_json FROM records WHERE serial=?", (sid,)).fetchone()
                if not item:
                    raise ValueError("recovery_source_missing_from_catalog")
                if sid in existing:
                    if existing[sid] != record:
                        overlay = overlays.get(sid)
                        if (not overlay or overlay["expectedRaw"] != existing[sid]
                                or overlay["record"] != record or not overlay.get("evidence")):
                            conflicts.append({"serial": sid, "reason": "existing_serial_fields_differ"})
                        else:
                            reviewed_overlays.append(record)
                    else:
                        identical.append(sid)
                    continue
                overlaps = set()
                for key in keys(record["case_number"]):
                    overlaps.update(identities.get((key, record["court"], record["date"]), set()))
                if overlaps:
                    review = collision_reviews.get(sid)
                    # These are distinct, individually verified publication IDs.
                    # Only a pinned review of these exact records may retain both.
                    if (overlaps & set(existing) or not review or not review.get("evidence")
                            or review.get("overlappingSerials") != sorted(overlaps)
                            or review.get("record") != record
                            or review.get("overlappingRecords") != {s: pending_by_id.get(s) for s in sorted(overlaps)}):
                        conflicts.append({"serial": sid, "reason": "key_court_date_collision",
                                          "existingSerials": sorted(overlaps)})
                        continue
                    reviewed_collisions.append(sid)
                if int(sid) in db.blacklist:
                    conflicts.append({"serial": sid, "reason": "existing_blacklist"})
                else:
                    pending.append(record)
                    pending_by_id[sid] = record
                    for key in keys(record["case_number"]):
                        identities.setdefault((key, record["court"], record["date"]), set()).add(sid)
        receipt.update(phase="preflight_complete", baselineRows=len(existing), identicalIds=identical,
                       pendingRows=len(pending), conflicts=conflicts, existingReviewedOverlays=len(reviewed_overlays),
                       reviewedPublicationCollisions=reviewed_collisions, baselineUnexportableRows=len(baseline_holds))
        atomic_json(output / "baseline-export-holds.json", baseline_holds)
        atomic_json(receipt_path, receipt)
        if conflicts:
            raise ValueError("merge_conflicts_require_review")
        # One transaction for all insertions. Store the source identity with every
        # row in a separate provenance table; never overwrite a baseline record.
        db.conn.execute("BEGIN IMMEDIATE")
        try:
            for record in pending:
                db.conn.execute("INSERT INTO cases(serial,case_name,case_number,case_number_clean,date,court) "
                                "VALUES(?,?,?,?,?,?)", (record["serial"], record["case_name"], record["case_number"],
                                                       clean_case_number(record["case_number"]), record["date"], record["court"]))
                db.conn.execute("INSERT INTO reviewed_recovery_provenance VALUES(?,?,?,?,?)",
                                (record["serial"], recovery_sha256, catalog_sha256,
                                 json.dumps(record, ensure_ascii=False, sort_keys=True),
                                 json.dumps(record, ensure_ascii=False, sort_keys=True)))
            for record in reviewed_overlays:
                db.conn.execute("INSERT INTO reviewed_recovery_provenance VALUES(?,?,?,?,?)",
                                (record["serial"], recovery_sha256, catalog_sha256,
                                 json.dumps(record, ensure_ascii=False, sort_keys=True),
                                 json.dumps(existing[record["serial"]], ensure_ascii=False, sort_keys=True)))
            db.conn.commit()
        except BaseException:
            db.conn.rollback()
            raise
        # Re-opened staged data is compared field-by-field, not just by counts.
        db.conn.row_factory = sqlite3.Row
        actual = {row["serial"]: {k: row[k] for k in RECORD_FIELDS}
                  for row in db.conn.execute("SELECT * FROM cases")}
        db.conn.row_factory = None
        if actual != {**existing, **{r["serial"]: r for r in pending}}:
            raise ValueError("post_merge_records_differ")
        db.conn.row_factory = sqlite3.Row
        selected = [db.conn.execute("SELECT * FROM cases WHERE serial=?", (row["serial"],)).fetchone()
                    for row in pending + reviewed_overlays]
        db.conn.row_factory = None
        exported, skipped = db.compress_rows(selected)
        if skipped or db.conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("post_merge_export_failed")
        receipt.update(phase="merged_validated_before_rename", insertedRows=len(pending),
                       totalRows=len(actual), recoveryExportedKeys=len(exported), exportSkipped=skipped,
                       previousRecordsPreserved=True, recoveryExportVerified=True, fullMasterExportVerified=False)
        atomic_json(receipt_path, receipt)
        db.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        db.close()
    # No operational pointer is touched. This is a new local artifact only.
    receipt["masterSha256"] = file_hash(staging)
    atomic_json(receipt_path, receipt)
    staging.replace(output / "master.db")
    receipt.update(phase="validated_local_master", masterSha256=file_hash(output / "master.db"),
                   finishedAt=datetime.now(timezone.utc).isoformat())
    atomic_json(receipt_path, receipt)
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("baseline", "recovery", "catalog", "out", "baseline-sha256", "recovery-sha256", "catalog-sha256"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--existing-overlays")
    parser.add_argument("--overlays-sha256")
    args = parser.parse_args()
    result = merge(args.baseline, args.recovery, args.catalog, args.out,
                   baseline_sha256=args.baseline_sha256, recovery_sha256=args.recovery_sha256,
                   catalog_sha256=args.catalog_sha256, resume=args.resume,
                   overlays_path=args.existing_overlays, overlays_sha256=args.overlays_sha256)
    print(json.dumps(result, ensure_ascii=False))
