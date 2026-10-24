import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from diagnose_state import diagnose, safe_error
from master_db import MasterDB
from serving_policy import quarantine_digest


class DiagnosticTests(unittest.TestCase):
    def test_readonly_report_identifies_exact_changed_record_without_repairing_it(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "master.db"
            db = MasterDB(str(path))
            db.upsert_raw([dict(serial="1", case_name="원본 제목", case_number="2020다1",
                                date="20200101", court="대법원")])
            cases, _ = db.export_core()
            payload = json.dumps(dict(version="20200101", total=1, cases=cases,
                                      court_code_map=db.court_resolver.code_map)).encode()
            digest = hashlib.sha256(payload).hexdigest()
            review = dict(schema=1, referenceSha256=digest, quarantinedRows=0,
                          quarantineSha256=quarantine_digest([]))
            db.conn.execute("INSERT INTO serving_policy VALUES(1,?,?,?)", (payload, digest, json.dumps(review)))
            db.conn.execute("UPDATE cases SET court='서울고등법원' WHERE serial='1'")
            db.conn.commit()
            db.close()
            before = path.read_bytes()
            report = diagnose(path)
            self.assertEqual(report["exportError"], "reference_record_removed_or_changed")
            self.assertEqual(report["differenceCount"], 1)
            self.assertEqual(report["referenceSha256"], digest)
            self.assertEqual(report["reviewedMetadataRaw"], {})
            self.assertEqual(report["differences"][0]["expected"][1], 1)
            self.assertEqual(report["differences"][0]["actual"][0]["record"][1], 10)
            self.assertEqual(path.read_bytes(), before)

    def test_exception_urls_and_credentials_cannot_enter_public_error_field(self):
        self.assertEqual(safe_error(ValueError("https://example.invalid?OC=SECRET")), "ValueError")
        self.assertEqual(safe_error(ValueError("reference_record_removed_or_changed")),
                         "reference_record_removed_or_changed")
