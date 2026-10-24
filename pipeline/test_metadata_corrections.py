import copy
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

from apply_metadata_corrections import migrate, raw_digest, MIGRATION
from master_db import MasterDB
from serving_policy import quarantine_digest
import source_corrections as sources
import reviewed_replays

FIXTURES = Path(__file__).parent / 'fixtures' / 'source-corrections'


class MetadataCorrectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'master.db'
        self.entries = {key: entry for key, entry in sources.entries().items()
                        if entry['profile'] == sources.METADATA_PROFILE}
        db = MasterDB(str(self.path))
        db.upsert_raw([entry['expectedPreviousRaw'] for entry in self.entries.values()] + [
            dict(serial='123', case_name='unrelated', case_number='2020다123', date='20200101', court='대법원')])
        cases, _ = db.export_core()
        self.before_cases = copy.deepcopy(cases)
        self.payload = json.dumps(dict(version='20261021', total=len(cases), cases=cases,
                                       court_code_map=db.court_resolver.code_map)).encode()
        sha = hashlib.sha256(self.payload).hexdigest()
        review = dict(schema=1, referenceSha256=sha, quarantinedRows=0, quarantineSha256=quarantine_digest([]))
        db.conn.execute('INSERT INTO serving_policy VALUES(1,?,?,?)', (self.payload, sha, json.dumps(review)))
        db.conn.commit()
        self.raw = raw_digest(db.conn)
        db.close()

    def tearDown(self):
        self.tmp.cleanup()

    def item(self, fields):
        item = ET.Element('prec')
        for key, value in fields.items():
            ET.SubElement(item, key).text = value
        return item

    def body(self, entry):
        return gzip.decompress((FIXTURES / (entry['record']['serial'] + '-judgment.html.gz')).read_bytes())

    def run_migration(self, **kwargs):
        return migrate(self.path, fetch=self.item, fetch_judgment=self.body, **kwargs)

    def test_two_approved_changes_preserve_all_raw_and_archive_exact_old_reference(self):
        before_bytes = self.path.read_bytes()
        proposed = self.run_migration()
        self.assertFalse(proposed['applied'])
        self.assertEqual(self.path.read_bytes(), before_bytes)
        result = self.run_migration(apply=True)
        self.assertTrue(result['applied'])
        self.assertEqual(len(result['changes']), 2)
        self.assertEqual(proposed['afterSha256'], result['afterSha256'])
        db = MasterDB(str(self.path))
        try:
            self.assertEqual(raw_digest(db.conn), self.raw)
            cases, _ = db.export_core()
            self.assertEqual(set(cases), set(self.before_cases))
            self.assertEqual(cases['20Da123'], self.before_cases['20Da123'])
            for change in result['changes']:
                self.assertEqual(cases[change['key']], [change['after']])
                self.assertEqual(self.before_cases[change['key']], [change['before']])
            audit = db.conn.execute('SELECT before_payload,before_sha256,after_sha256 FROM reference_metadata_migrations WHERE id=?', (MIGRATION,)).fetchone()
            self.assertEqual(audit[0], self.payload)
            self.assertEqual(audit[1], hashlib.sha256(self.payload).hexdigest())
            self.assertEqual(audit[2], result['afterSha256'])
            before = list(db.conn.iterdump())
        finally:
            db.close()
        again = self.run_migration(apply=True)
        self.assertFalse(again['applied'])
        self.assertTrue(again['alreadyApplied'])
        db = MasterDB(str(self.path))
        self.assertEqual(list(db.conn.iterdump()), before)
        db.close()

    def test_daily_collection_cannot_silently_migrate_an_existing_reference(self):
        db = MasterDB(str(self.path))
        try:
            entry = next(iter(self.entries.values()))
            receipt = sources.resolve(entry['expectedList'], fetch=self.body)
            raw = dict(entry['record'], _serving_correction=receipt)
            with self.assertRaisesRegex(ValueError, 'reference_metadata_migration_required'):
                db.upsert_raw([raw])
            self.assertEqual(raw_digest(db.conn), self.raw)
            self.assertEqual(db.export_core()[0], self.before_cases)
        finally:
            db.close()

    def test_source_or_raw_changes_fail_before_any_migration_write(self):
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'source_changed'):
            migrate(self.path, apply=True, fetch=self.item, fetch_judgment=lambda entry: self.body(entry) + b' ')
        self.assertEqual(self.path.read_bytes(), before)
        db = MasterDB(str(self.path))
        db.conn.execute("UPDATE cases SET inserted_at='changed' WHERE serial='69909'")
        db.conn.execute("UPDATE cases SET case_number='2004가단99999',case_number_clean='2004가단99999' WHERE serial='69909'")
        db.conn.commit()
        db.close()
        before = self.path.read_bytes()
        with self.assertRaises(ValueError):
            self.run_migration(apply=True)
        self.assertEqual(self.path.read_bytes(), before)

    def test_post_migration_failure_rolls_back_reference_receipts_and_audit(self):
        original = MasterDB.export_core
        calls = 0
        def fail_after_write(db):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise ValueError('reference_record_removed_or_changed')
            return original(db)
        db = MasterDB(str(self.path))
        before = list(db.conn.iterdump())
        db.close()
        with mock.patch.object(MasterDB, 'export_core', fail_after_write):
            with self.assertRaisesRegex(ValueError, 'reference_record_removed_or_changed'):
                self.run_migration(apply=True)
        db = MasterDB(str(self.path))
        self.assertEqual(list(db.conn.iterdump()), before)
        db.close()

    def test_corrected_metadata_replays_without_overwriting_archived_raw(self):
        self.run_migration(apply=True)
        import crawler_runner as runner
        db = MasterDB(str(self.path))
        try:
            before = list(db.conn.iterdump())
            for entry in self.entries.values():
                detail = json.loads(gzip.decompress((FIXTURES / (entry['record']['serial'] + '-original.json.gz')).read_bytes()))
                with mock.patch.object(reviewed_replays, 'fetch_detail', return_value=detail):
                    row = runner._precedent_case(self.item(entry['expectedList']), entry['record']['date'], 1,
                                                 replay=db.raw_replay_checker())
                self.assertEqual(db.upsert_raw([row]), (0, 0, 1))
            self.assertEqual(list(db.conn.iterdump()), before)
        finally:
            db.close()


    def test_missing_receipts_and_unrelated_changes_still_block_export(self):
        self.run_migration(apply=True)
        db = MasterDB(str(self.path))
        try:
            db.conn.execute("SAVEPOINT tamper")
            db.conn.execute("DELETE FROM source_correction_provenance WHERE serial='69909'")
            with self.assertRaisesRegex(ValueError, 'receipt_mismatch'):
                db.export_core()
            db.conn.execute("ROLLBACK TO tamper")
            db.conn.execute("RELEASE tamper")
            db.conn.execute("UPDATE cases SET date='20200102' WHERE serial='123'")
            with self.assertRaisesRegex(ValueError, 'reference_record_removed_or_changed'):
                db.export_core()
        finally:
            db.close()


    def test_migration_protects_verified_records_added_after_the_old_reference(self):
        db = MasterDB(str(self.path))
        db.upsert_raw([dict(serial='456', case_name='newly published', case_number='2026다456',
                            date='20260101', court='대법원')])
        db.close()
        result = self.run_migration(apply=True)
        self.assertEqual(result['protectedKeys'], 4)
        db = MasterDB(str(self.path))
        try:
            reference = json.loads(db.conn.execute('SELECT reference_payload FROM serving_policy').fetchone()[0])
            self.assertIn('26Da456', reference['cases'])
            saved, sha = db.conn.execute('SELECT before_export_payload,before_export_sha256 FROM reference_metadata_migrations').fetchone()
            self.assertEqual(hashlib.sha256(saved).hexdigest(), sha)
            self.assertIn('26Da456', json.loads(saved)['cases'])
            db.conn.execute("UPDATE cases SET date='20260102' WHERE serial='456'")
            with self.assertRaisesRegex(ValueError, 'reference_record_removed_or_changed'):
                db.export_core()
        finally:
            db.close()


    def test_repeat_migration_rejects_changed_audit_snapshot(self):
        self.run_migration(apply=True)
        db = MasterDB(str(self.path))
        db.conn.execute("UPDATE reference_metadata_migrations SET before_export_payload=?", (b"changed",))
        db.conn.commit()
        db.close()
        with self.assertRaisesRegex(ValueError, 'metadata_migration_receipt_mismatch'):
            self.run_migration(apply=True)
