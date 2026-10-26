import copy
import gzip
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

import crawler_runner as runner
from known_errors import CorrectionError
from master_db import MasterDB
import reviewed_replays as replay


class ExistingIdentityReplayTests(unittest.TestCase):
    def fixtures(self):
        for path in sorted((Path(__file__).parent / 'fixtures' / 'reviewed-replays').glob('*-existing.json.gz')):
            yield json.loads(gzip.decompress(path.read_bytes()))

    def test_unregistered_existing_identities_preserve_raw_receipts_and_export(self):
        for fixture in self.fixtures():
            fields, record, detail = (fixture[k] for k in ('fields', 'record', 'detail'))
            sid = record['serial']
            self.assertNotIn(sid, replay.entries())
            with self.subTest(serial=sid), tempfile.TemporaryDirectory() as folder:
                db = MasterDB(str(Path(folder) / 'master.db'))
                try:
                    db.upsert_raw([record])
                    db.conn.execute('INSERT INTO reviewed_recovery_provenance VALUES(?,?,?,?,?)',
                                    (sid, 'a' * 64, 'b' * 64, json.dumps(record), json.dumps(record)))
                    db.conn.commit()
                    expected = db.export_core()
                    before = list(db.conn.iterdump())
                    item = ET.Element('prec')
                    for key, value in fields.items():
                        ET.SubElement(item, key).text = value
                    verify = replay.verify
                    with mock.patch.object(replay, 'verify', side_effect=lambda f, a, c:
                                           verify(f, a, c, fetch=lambda _: detail)):
                        for _ in range(2):
                            row = runner._precedent_case(item, record['date'], 1, db.raw_replay_checker())
                            self.assertEqual(db.upsert_raw([row]), (0, 0, 1))
                    self.assertEqual(db.export_core(), expected)
                    self.assertEqual(list(db.conn.iterdump()), before)
                finally:
                    db.close()

    def test_detail_drift_and_missing_evidence_are_rejected(self):
        for fixture in self.fixtures():
            fields, record, detail = (fixture[k] for k in ('fields', 'record', 'detail'))
            for key in detail['metadata']:
                changed = copy.deepcopy(detail)
                changed['metadata'][key] += 'changed'
                with self.subTest(serial=record['serial'], field=key), self.assertRaisesRegex(
                        CorrectionError, 'known_error_source_changed'):
                    replay.verify(fields, record, record, fetch=lambda _: changed)
            for body in ('', ' ', None):
                with self.assertRaisesRegex(CorrectionError, 'known_error_source_changed'):
                    replay.verify(fields, record, record, fetch=lambda _: dict(detail, body=body))
            with self.assertRaisesRegex(CorrectionError, 'known_error_source_unavailable'):
                replay.verify(fields, record, record,
                              fetch=mock.Mock(side_effect=CorrectionError('known_error_source_unavailable')))

    def test_unrelated_list_changes_and_new_rows_cannot_use_existing_identity_proof(self):
        for fixture in self.fixtures():
            fields, record = fixture['fields'], fixture['record']
            for key in ('데이터출처명', '판례일련번호', '사건명', '사건번호', '선고일자', '법원명'):
                fetch = mock.Mock()
                self.assertFalse(replay.verify(dict(fields, **{key: 'changed'}), record, record, fetch=fetch))
                fetch.assert_not_called()
            fetch = mock.Mock()
            self.assertIsNone(replay.resolve(fields, fetch=fetch))
            fetch.assert_not_called()

    def test_pending_journal_does_not_emit_failure_warnings(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(runner, 'log') as log:
            runner.save_failed_dates(folder, [
                {'start': '20230901', 'end': '20230930', 'last_error': 'scheduled_not_attempted'},
                {'start': '20241201', 'end': '20241231', 'last_error': 'known_error_review_required'},
            ])
            log.warning.assert_not_called()
            self.assertIn('미처리 1건', log.debug.call_args.args[0])
            self.assertIn('실패·기존 보류 1건', log.debug.call_args.args[0])
            self.assertFalse(runner.publication_allowed(runner.load_failed_dates(folder)))

    def test_same_proof_works_for_an_unlisted_id_but_not_another_branch_or_member(self):
        fixture = next(self.fixtures())
        fields = dict(fixture['fields'], 판례일련번호='999999991')
        record = dict(fixture['record'], serial='999999991')
        self.assertTrue(replay.verify(fields, record, record, fetch=lambda _: fixture['detail']))
        for court in ('서울고등법원(울산)', '부산고등법원'):
            self.assertFalse(replay.verify(dict(fields, 법원명=court), record, record,
                                          fetch=mock.Mock(side_effect=AssertionError('unexpected fetch'))))

    def test_error_retains_public_serial_and_failed_page_without_exception_text(self):
        fixture = next(self.fixtures())
        item = ET.Element('prec')
        for key, value in fixture['fields'].items():
            ET.SubElement(item, key).text = value
        with mock.patch.object(runner, 'log') as log:
            with self.assertRaises(runner.RangeFetchError) as result:
                runner._precedent_case(item, '20241201~20241231', 2,
                                       replay=mock.Mock(side_effect=CorrectionError('known_error_review_required')))
            self.assertEqual(result.exception.page, 2)
            self.assertEqual(result.exception.reason, 'known_error_review_required')
            self.assertEqual(log.error.call_args.args[1], fixture['record']['serial'])
