"""Court-only boundaries, historical quarantine and real serving coverage."""
from datetime import date
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from baseline_health import core_coverage, require_coverage
from master_db import MasterDB
from compress import CourtCodeResolver
from serving_policy import quarantine_digest, row_hash


class ServingPolicyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "master.db"
        self.db = MasterDB(str(self.path))
        self.db.upsert_raw([
            dict(serial="1", case_name="세금", case_number="1950두1", date="1950.01.01", court="대법원"),
            dict(serial="2", case_name="특허", case_number="2026허2", date="2026-01-01", court="특허법원"),
            dict(serial="D1", case_name="헌법", case_number="2026헌바1", date="20260102", court="헌법재판소"),
        ])
        cases, _ = self.db.export_core()
        self.payload = json.dumps(dict(version="20260102", total=len(cases), cases=cases,
                                       court_code_map=self.db.court_resolver.code_map)).encode()

    def tearDown(self):
        self.db.close()
        self.directory.cleanup()

    def install(self):
        self.db.conn.execute("INSERT INTO cases(serial,case_number,case_number_clean,date) VALUES('99','bad, unknown','bad','')")
        self.db.conn.row_factory = __import__("sqlite3").Row
        raw = self.db.conn.execute("SELECT * FROM cases WHERE serial='99'").fetchone()
        self.db.conn.row_factory = None
        rows = [("99", row_hash(raw), "legacy_not_in_reviewed_snapshot", "a" * 64)]
        review = dict(schema=1, referenceSha256=hashlib.sha256(self.payload).hexdigest(),
                      quarantinedRows=1, quarantineSha256=quarantine_digest(rows))
        self.db.conn.executemany("INSERT INTO export_quarantine VALUES(?,?,?,?)", rows)
        self.db.conn.execute("INSERT INTO serving_policy VALUES(1,?,?,?)",
                             (self.payload, review["referenceSha256"], json.dumps(review)))
        self.db.conn.execute("PRAGMA user_version=1")
        self.db.conn.commit()
        self.db.close()
        self.db = MasterDB(str(self.path))

    def test_bound_legacy_raw_is_held_and_all_court_subjects_survive(self):
        self.install()
        cases, skipped = self.db.export_core()
        self.assertEqual(cases, json.loads(self.payload)["cases"])
        self.assertEqual(skipped, 1)
        self.assertEqual(self.db.conn.execute("SELECT case_number FROM cases WHERE serial='99'").fetchone()[0],
                         "bad, unknown")

    def test_changed_or_missing_raw_and_inventory_fail_closed(self):
        self.install()
        for statement, reason in (
            ("UPDATE cases SET date='20260101' WHERE serial='99'", "raw_changed"),
            ("DELETE FROM cases WHERE serial='99'", "raw_missing"),
            ("DELETE FROM export_quarantine", "inventory_changed"),
            ("DELETE FROM serving_policy", "missing_serving_policy"),
        ):
            with self.subTest(statement=statement):
                self.db.conn.execute("SAVEPOINT mutation")
                self.db.conn.execute(statement)
                with self.assertRaisesRegex(ValueError, reason):
                    self.db.export_core()
                self.db.conn.execute("ROLLBACK TO mutation")
                self.db.conn.execute("RELEASE mutation")

    def test_new_invalid_row_cannot_inherit_historical_quarantine(self):
        self.install()
        self.db.conn.execute("INSERT INTO cases(serial,case_number,case_number_clean) VALUES('100','unknown','unknown')")
        with self.assertRaisesRegex(ValueError, "unreviewed_unexportable"):
            self.db.export_core()

    def test_fresh_database_cannot_silently_skip_unknown_rows(self):
        self.db.conn.execute("INSERT INTO cases(serial,case_number,case_number_clean) VALUES('100','unknown','unknown')")
        with self.assertRaisesRegex(ValueError, "unreviewed_unexportable_case"):
            self.db.export_core()

    def test_reference_member_and_metadata_removal_are_rejected(self):
        self.install()
        for statement in ("DELETE FROM cases WHERE serial='1'", "UPDATE cases SET case_name='changed' WHERE serial='1'"):
            self.db.conn.execute("SAVEPOINT mutation")
            self.db.conn.execute(statement)
            with self.assertRaisesRegex(ValueError, "reference_record_removed_or_changed"):
                self.db.export_core()
            self.db.conn.execute("ROLLBACK TO mutation")
            self.db.conn.execute("RELEASE mutation")

    def test_administrative_serials_are_rejected_without_partial_upsert(self):
        for serial in ("T1", "KP1"):
            with self.assertRaisesRegex(ValueError, "unsupported_publication_serial"):
                self.db.upsert_raw([dict(serial=serial, case_number="2026다1")])
        self.assertEqual(self.db.count(), 3)

    def test_seed_allocator_does_not_reuse_existing_code(self):
        resolver = CourtCodeResolver({"대법원": 1, "기존지원": 197})
        self.assertEqual(resolver.resolve("새지원"), 198)

    def test_one_export_loads_policy_once_and_hashes_each_held_row_once(self):
        self.install()
        import master_db
        import serving_policy
        with mock.patch.object(master_db, "load_policy", wraps=master_db.load_policy) as load, \
                mock.patch.object(serving_policy, "row_hash", wraps=serving_policy.row_hash) as hashed:
            self.db.export_core()
            self.assertEqual(load.call_count, 1)
            self.assertEqual(hashed.call_count, 1)
        self.db.conn.execute("UPDATE cases SET date='20260101' WHERE serial='99'")
        with self.assertRaisesRegex(ValueError, "raw_changed"):
            self.db.export_core()

    def test_coverage_normalizes_calendar_and_ignores_unknown_sentinel_future(self):
        for sid, value in enumerate(("", "0", "00010101", "20260230", "20990101"), 10):
            self.db.upsert_raw([dict(serial=str(sid), case_number=f"2026다{sid}", date=value, court="대법원")])
        stats = core_coverage(str(self.path), date(2026, 10, 18))
        self.assertEqual(stats["precedent_count"], 2)
        self.assertEqual(stats["detc_count"], 1)
        self.assertEqual(stats["unknown_core_dates"], 5)
        self.assertEqual(stats["oldest"], "19500101")
        self.assertEqual(stats["newest"], "20260101")
        require_coverage(stats, minimum_precedents=2, earliest_cutoff="19600101", today=date(2026, 10, 18))
        for changed, reason in ((dict(precedent_count=1), "insufficient_precedent_count"),
                                (dict(oldest="20200101"), "historical_coverage_missing"),
                                (dict(newest="20200101"), "recent_coverage_missing"),
                                (dict(detc_count=0), "detc_coverage_missing")):
            with self.assertRaisesRegex(ValueError, reason):
                require_coverage(dict(stats, **changed), minimum_precedents=2, earliest_cutoff="19600101",
                                 today=date(2026, 10, 18))


if __name__ == "__main__":
    unittest.main()
