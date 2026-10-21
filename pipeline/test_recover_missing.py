"""Recovery subsets must never replace a full master or silently overwrite it."""
import json
from contextlib import closing, contextmanager
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

from master_db import MasterDB
import recover_missing as recovery


@contextmanager
def connection(path):
    with closing(sqlite3.connect(path)) as db, db:
        yield db


def case(serial, number=None):
    return {"serial": str(serial), "case_name": "테스트", "case_number": number or f"2024다{serial}",
            "date": "20250101", "court": "대법원"}


class RecoveryMergeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.baseline, self.subset, self.catalog = (self.root / name for name in ("baseline.db", "subset.db", "catalog.db"))
        self.output = self.root / "output"
        self.write_master(self.baseline, [case(1)])
        self.write_master(self.subset, [case(1), case(2, "2024다2,2024다3(병합)")])
        with connection(self.catalog) as db:
            db.execute("CREATE TABLE records(serial TEXT PRIMARY KEY, record_json TEXT)")
            for sid in ("1", "2"):
                db.execute("INSERT INTO records VALUES(?,?)", (sid, json.dumps({"데이터출처명": "대법원"})))

    def write_master(self, path, rows):
        db = MasterDB(str(path))
        try:
            db.upsert_raw(rows)
            db.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            db.close()

    def test_atomic_receipt_retries_only_windows_lock_and_keeps_atomic_replace(self):
        target = self.root / "receipt.json"
        target.write_text('{"old": true}', encoding="utf-8")
        replace = Path.replace
        calls = []

        def locked_once(source, destination):
            calls.append(source)
            self.assertEqual(json.loads(target.read_bytes()), {"old": True})
            if len(calls) == 1:
                error = PermissionError("reader denies delete sharing")
                error.winerror = 5
                raise error
            return replace(source, destination)

        with mock.patch.object(Path, "replace", locked_once), mock.patch.object(recovery.time, "sleep") as sleep:
            recovery.atomic_json(target, {"new": True})
        self.assertEqual(len(calls), 2)
        sleep.assert_called_once_with(0.05)
        self.assertEqual(json.loads(target.read_bytes()), {"new": True})
        self.assertFalse(list(self.root.glob("receipt-*.tmp")))

    def test_atomic_receipt_persistent_lock_or_other_error_preserves_old_and_fails(self):
        target = self.root / "receipt.json"
        for code, attempts in ((5, 4), (32, 4), (33, 4), (None, 1)):
            with self.subTest(winerror=code):
                target.write_text('{"old": true}', encoding="utf-8")
                error = PermissionError("locked or forbidden")
                if code is not None:
                    error.winerror = code
                with mock.patch.object(Path, "replace", side_effect=error) as replace, \
                        mock.patch.object(recovery.time, "sleep"), self.assertRaises(PermissionError):
                    recovery.atomic_json(target, {"new": True})
                self.assertEqual(replace.call_count, attempts)
                self.assertEqual(json.loads(target.read_bytes()), {"old": True})
                self.assertFalse(list(self.root.glob("receipt-*.tmp")))

    def run_merge(self, **kwargs):
        return recovery.merge(self.baseline, self.subset, self.catalog, self.output,
                              baseline_sha256=recovery.file_hash(self.baseline),
                              recovery_sha256=recovery.file_hash(self.subset),
                              catalog_sha256=recovery.file_hash(self.catalog),
                              min_baseline_rows=1, **kwargs)

    def test_additive_merge_preserves_baseline_provenance_and_all_merged_members(self):
        before = recovery.file_hash(self.baseline)
        result = self.run_merge()
        self.assertEqual((result["insertedRows"], result["totalRows"], result["recoveryExportedKeys"]), (1, 2, 2))
        self.assertTrue(result["publishBlocked"])
        self.assertEqual(recovery.file_hash(self.baseline), before)
        db = MasterDB(str(self.output / "master.db"))
        try:
            self.assertEqual(set(db.export_all()[0]), {"24Da1", "24Da2", "24Da3"})
            self.assertEqual(db.conn.execute("SELECT COUNT(*) FROM reviewed_recovery_provenance").fetchone()[0], 1)
            changed = case(2)
            with self.assertRaisesRegex(ValueError, "known_error_review_required"):
                db.upsert_raw([changed])
            db.conn.execute("UPDATE cases SET case_number_clean='2024다2' WHERE serial='2'")
            with self.assertRaisesRegex(ValueError, "known_error_receipt_mismatch"):
                db.export_core()
        finally:
            db.close()

    def test_serial_conflict_blocks_all_additions(self):
        with connection(self.subset) as db:
            db.execute("UPDATE cases SET court='서울고등법원' WHERE serial='1'")
        with self.assertRaisesRegex(ValueError, "merge_conflicts_require_review"):
            self.run_merge()
        self.assertFalse((self.output / "master.db").exists())
        with connection(self.output / "merge-staging.db") as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM cases").fetchone()[0], 1)

    def test_key_court_date_collision_is_reviewed_without_dropping_members(self):
        with connection(self.subset) as db:
            db.execute("UPDATE cases SET case_number='2024다1,2024다3(병합)' WHERE serial='2'")
        with self.assertRaisesRegex(ValueError, "merge_conflicts_require_review"):
            self.run_merge()
        receipt = json.loads((self.output / "recovery-merge-receipt.json").read_bytes())
        self.assertEqual(receipt["conflicts"][0]["reason"], "key_court_date_collision")

    def test_court_judgments_are_not_excluded_by_tax_source(self):
        with connection(self.catalog) as db:
            db.execute("UPDATE records SET record_json=? WHERE serial='2'",
                       (json.dumps({"데이터출처명": "국세법령정보시스템"}),))
        self.run_merge()
        self.assertTrue((self.output / "master.db").exists())

    def test_partial_master_and_wrong_hash_are_rejected(self):
        args = dict(baseline_sha256=recovery.file_hash(self.baseline),
                    recovery_sha256=recovery.file_hash(self.subset), catalog_sha256=recovery.file_hash(self.catalog))
        with self.assertRaisesRegex(ValueError, "full_baseline_master_required"):
            recovery.merge(self.baseline, self.subset, self.catalog, self.output, **args)
        args["baseline_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "baseline_hash_mismatch"):
            recovery.merge(self.baseline, self.subset, self.catalog, self.root / "other", **args)

    def test_mid_merge_failure_is_resumable_without_partial_records(self):
        original = recovery.atomic_json
        def interrupt(path, data):
            original(path, data)
            if isinstance(data, dict) and data["phase"] == "preflight_complete":
                raise KeyboardInterrupt("interrupted before insert")
        with mock.patch.object(recovery, "atomic_json", side_effect=interrupt), self.assertRaises(KeyboardInterrupt):
            self.run_merge()
        result = self.run_merge(resume=True)
        self.assertEqual(result["insertedRows"], 1)
        self.assertEqual(self.run_merge(resume=True), result)

    def test_crash_after_rename_completes_with_hash_check_on_resume(self):
        original = recovery.atomic_json
        def interrupt(path, data):
            if isinstance(data, dict) and data["phase"] == "validated_local_master":
                raise KeyboardInterrupt("interrupted after rename")
            original(path, data)
        with mock.patch.object(recovery, "atomic_json", side_effect=interrupt), self.assertRaises(KeyboardInterrupt):
            self.run_merge()
        self.assertTrue((self.output / "master.db").exists())
        self.assertEqual(self.run_merge(resume=True)["phase"], "validated_local_master")

    def test_changed_input_or_output_blocks_resume(self):
        self.run_merge()
        with connection(self.subset) as db:
            db.execute("UPDATE cases SET date='20250102'")
        with self.assertRaisesRegex(ValueError, "resume_input_changed"):
            self.run_merge(resume=True)

    def test_reviewed_overlay_serves_corrected_number_and_preserves_original(self):
        original = case(1, "2024다1판결")
        with connection(self.baseline) as db:
            db.execute("UPDATE cases SET case_number=?,case_number_clean=? WHERE serial='1'",
                       (original["case_number"], original["case_number"]))
        path = self.root / "overlay.json"
        path.write_text(json.dumps({"baselineSha256": recovery.file_hash(self.baseline),
                                   "entries": {"1": {"expectedRaw": original, "record": case(1),
                                                      "evidence": {"rule": "fixture_reviewed_original"}}}}), encoding="utf-8")
        self.run_merge(overlays_path=path, overlays_sha256=recovery.file_hash(path))
        db = MasterDB(str(self.output / "master.db"))
        try:
            self.assertEqual(db.conn.execute("SELECT case_number FROM cases WHERE serial='1'").fetchone()[0], "2024다1판결")
            self.assertEqual(set(db.export_core()[0]), {"24Da1", "24Da2", "24Da3"})
            before = db.conn.execute("SELECT * FROM cases ORDER BY serial").fetchall()
            provenance = db.conn.execute("SELECT * FROM reviewed_recovery_provenance ORDER BY serial").fetchall()
            self.assertEqual(db.upsert_raw([original]), (0, 0, 1))
            self.assertEqual(db.upsert_raw([dict(case(1), _source_raw=original)]), (0, 0, 1))
            self.assertEqual(db.conn.execute("SELECT * FROM cases ORDER BY serial").fetchall(), before)
            self.assertEqual(db.conn.execute("SELECT * FROM reviewed_recovery_provenance ORDER BY serial").fetchall(), provenance)
            with self.assertRaisesRegex(ValueError, "review_required"):
                db.upsert_raw([dict(case(1), _source_raw=dict(original, case_name="changed"))])
            db.conn.execute("UPDATE cases SET case_number='2024다999' WHERE serial='1'")
            with self.assertRaisesRegex(ValueError, "receipt_mismatch"):
                db.export_all()
        finally:
            db.close()

    def test_staging_lock_prevents_two_writers(self):
        with recovery.run_lock(self.output.with_name(self.output.name + ".recovery.lock")):
            with self.assertRaisesRegex(ValueError, "another_merge_process_is_running"):
                self.run_merge()

    def test_failure_during_insertion_rolls_back_all_new_rows_and_provenance(self):
        with connection(self.baseline) as db:
            db.execute("CREATE TRIGGER reject_new BEFORE INSERT ON cases WHEN NEW.serial='2' "
                       "BEGIN SELECT RAISE(ABORT, 'injected'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.run_merge()
        with connection(self.output / "merge-staging.db") as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM cases").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM reviewed_recovery_provenance").fetchone()[0], 0)

    def test_unrelated_invalid_raw_is_preserved_and_full_export_not_claimed(self):
        self.write_master(self.baseline, [case(99, "unregistered original")])
        result = self.run_merge()
        self.assertFalse(result["fullMasterExportVerified"])
        self.assertEqual(result["baselineUnexportableRows"], 1)
        with connection(self.output / "master.db") as db:
            self.assertEqual(db.execute("SELECT case_number FROM cases WHERE serial='99'").fetchone()[0], "unregistered original")

    def test_readonly_master_export_cannot_write_or_migrate_the_input(self):
        before = recovery.file_hash(self.baseline)
        db = MasterDB(str(self.baseline), read_only=True)
        try:
            self.assertEqual(set(db.export_core()[0]), {"24Da1"})
            with self.assertRaises(sqlite3.OperationalError):
                db.upsert_raw([case(99)])
        finally:
            db.close()
        self.assertEqual(recovery.file_hash(self.baseline), before)


if __name__ == "__main__":
    unittest.main()
