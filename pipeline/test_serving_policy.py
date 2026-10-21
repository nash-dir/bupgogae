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
from api import clean_case_number
import crawler_runner as runner
import xml.etree.ElementTree as ET


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

    def install(self, original=None):
        if original is None:
            self.db.conn.execute("INSERT INTO cases(serial,case_number,case_number_clean,date) VALUES('99','bad, unknown','bad','')")
            sid = "99"
        else:
            sid = original["serial"]
            self.db.conn.execute(
                "INSERT INTO cases(serial,case_name,case_number,case_number_clean,date,court) VALUES(?,?,?,?,?,?)",
                (sid, original["case_name"], original["case_number"], clean_case_number(original["case_number"]),
                 original["date"], original["court"]),
            )
        self.db.conn.row_factory = __import__("sqlite3").Row
        raw = self.db.conn.execute("SELECT * FROM cases WHERE serial=?", (sid,)).fetchone()
        self.db.conn.row_factory = None
        rows = [(sid, row_hash(raw), "legacy_not_in_reviewed_snapshot", "a" * 64)]
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

    def test_exact_source_replay_keeps_held_raw_hash_and_reference_unchanged(self):
        original = dict(serial="624775", case_name="이익처분에 의한 상여금", case_number="대법원-2026-두-31267",
                        date="2026.10.08", court="")
        self.install(original)
        before = self.db.conn.execute("SELECT * FROM cases ORDER BY serial").fetchall()
        replay = dict(original, case_number="2026두31267", date="20261008", court="대법원",
                      _source_raw=original, _source_name="국세법령정보시스템")
        self.assertEqual(self.db.upsert_raw([replay]), (0, 0, 1))
        self.assertEqual(self.db.conn.execute("SELECT * FROM cases ORDER BY serial").fetchall(), before)
        self.assertEqual(self.db.export_core()[0], json.loads(self.payload)["cases"])
        checker = self.db.raw_replay_checker()
        for date_text in ("20261008", "2026.10.08", "2026-10-08", "2026/10/08"):
            held = checker(dict(original, date=date_text))
            self.assertEqual(self.db.upsert_raw([held]), (0, 0, 1))
        with self.assertRaisesRegex(ValueError, "raw_changed_requires_review"):
            checker(dict(original, date="20261009"))
        for field in ("case_name", "case_number", "date", "court"):
            changed = dict(replay, _source_raw=dict(original, **{field: original[field] + "1"}))
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "raw_changed_requires_review"):
                self.db.upsert_raw([changed])
        with self.assertRaisesRegex(ValueError, "raw_changed_requires_review"):
            self.db.upsert_raw([dict(replay, court="서울고등법원")])
        self.db.conn.execute("UPDATE cases SET case_name='tampered' WHERE serial='624775'")
        with self.assertRaisesRegex(ValueError, "raw_changed_requires_review"):
            self.db.upsert_raw([replay])

    def test_pinned_unparseable_replay_is_not_a_rule_for_new_or_changed_rows(self):
        self.install()
        replay = self.db.raw_replay_checker()
        item = ET.fromstring("<prec><판례일련번호>99</판례일련번호><사건번호>bad, unknown</사건번호></prec>")
        before = self.db.conn.execute("SELECT * FROM cases ORDER BY serial").fetchall()
        row = runner._precedent_case(item, "20260101", 1, replay)
        self.assertEqual(self.db.upsert_raw([row]), (0, 0, 1))
        self.assertEqual(self.db.conn.execute("SELECT * FROM cases ORDER BY serial").fetchall(), before)
        item.find("판례일련번호").text = "100"
        with self.assertRaises(runner.RangeFetchError):
            runner._precedent_case(item, "20260101", 1, replay)
        item.find("판례일련번호").text = "99"
        item.find("사건번호").text = "changed"
        with self.assertRaisesRegex(ValueError, "raw_changed_requires_review"):
            runner._precedent_case(item, "20260101", 1, replay)
        self.assertEqual(self.db.export_core()[0], json.loads(self.payload)["cases"])

    def test_changed_quarantine_replay_rolls_back_entire_batch(self):
        original = dict(serial="99", case_name="사건", case_number="2026다99", date="20260101", court="대법원")
        self.install(original)
        with self.assertRaisesRegex(ValueError, "raw_changed_requires_review"):
            self.db.upsert_raw([dict(original, serial="100"), dict(original, case_name="changed")])
        self.assertEqual(self.db.conn.execute("SELECT count(*) FROM cases WHERE serial='100'").fetchone()[0], 0)
        self.assertEqual(self.db.export_core()[0], json.loads(self.payload)["cases"])

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
