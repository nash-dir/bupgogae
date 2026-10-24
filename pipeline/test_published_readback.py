import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from master_db import MasterDB
import verify_state_readback as readback


class PublishedReadbackTests(unittest.TestCase):
    def setUp(self):
        self.payload = dict(version='20261021', total=1, cases={'20Da1': [[1, 1, 200101, 'case']]},
                            court_code_map={'대법원': 1})
        self.body = json.dumps(self.payload).encode()
        self.sha = hashlib.sha256(self.body).hexdigest()
        self.manifest = dict(schema=1, contract='v0.9.0', core=dict(version='20261021', total=1,
                             bytes_raw=len(self.body), sha256=self.sha, object_path='objects/' + self.sha + '.json.gz'))

    def response(self, body, status=200):
        result = mock.MagicMock(status_code=status)
        result.__enter__.return_value = result
        result.iter_content.return_value = [body]
        return result

    def test_reads_only_the_fixed_manifest_and_its_exact_hash_bound_object(self):
        get = mock.Mock(side_effect=[self.response(json.dumps(self.manifest).encode()), self.response(self.body)])
        result, sha = readback.fetch_published_reference(get=get, min_keys=1)
        self.assertEqual(result, self.payload)
        self.assertEqual(sha, self.sha)
        self.assertEqual([call.args[0] for call in get.call_args_list], [
            readback.PUBLIC_BASE + 'manifest-v0.9.0.json', readback.PUBLIC_BASE + 'objects/' + self.sha + '.json.gz'])
        self.assertTrue(all(call.kwargs['allow_redirects'] is False for call in get.call_args_list))

    def test_path_or_contract_changes_never_trigger_a_second_request(self):
        for field, value in [('object_path', 'https://private.invalid/object'), ('object_path', '../state/master.db')]:
            manifest = copy.deepcopy(self.manifest)
            manifest['core'][field] = value
            get = mock.Mock(return_value=self.response(json.dumps(manifest).encode()))
            with self.assertRaisesRegex(ValueError, 'invalid_manifest'):
                readback.fetch_published_reference(get=get, min_keys=1)
            self.assertEqual(get.call_count, 1)
        get = mock.Mock(return_value=self.response(b'', status=302))
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            readback.fetch_published_reference(get=get, min_keys=1)
        self.assertEqual(get.call_count, 1)

    def test_mutated_object_and_oversized_manifest_are_rejected(self):
        changed = copy.deepcopy(self.payload)
        changed['cases']['20Da1'][0][3] = 'changed'
        get = mock.Mock(side_effect=[self.response(json.dumps(self.manifest).encode()),
                                    self.response(json.dumps(changed).encode())])
        with self.assertRaisesRegex(ValueError, 'integrity_failed'):
            readback.fetch_published_reference(get=get, min_keys=1)
        with self.assertRaisesRegex(ValueError, 'too_large'):
            readback.fetch_published_reference(get=lambda *a, **k: self.response(b' ' * 65537), min_keys=1)

    def test_readback_requires_exact_private_hash_before_public_network_access(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            db = MasterDB(str(directory / 'master.db'))
            db.upsert_raw([dict(serial='1', case_name='case', case_number='2020다1', date='20200101', court='대법원')])
            cases, _ = db.export_core()
            reference = dict(cases=cases, court_code_map=db.court_resolver.code_map)
            db.close()
            before = (directory / 'master.db').read_bytes()
            sha = hashlib.sha256(before).hexdigest()
            with mock.patch.object(readback, 'fetch_published_reference', return_value=(reference, self.sha)) as fetch:
                with self.assertRaisesRegex(ValueError, 'checksum_mismatch'):
                    readback.verify(directory, '0' * 64)
                fetch.assert_not_called()
                report = readback.verify(directory, sha)
                self.assertTrue(report['reviewedCasesAndCourtsMatch'])
                self.assertFalse(report['publication'])
            self.assertEqual((directory / 'master.db').read_bytes(), before)
            reference['cases']['20Da1'][0][2] = 200102
            with mock.patch.object(readback, 'fetch_published_reference', return_value=(reference, self.sha)):
                with self.assertRaisesRegex(ValueError, 'cases_mismatch'):
                    readback.verify(directory, sha)
