import copy
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

import api
import apply_historical_recovery as command
import crawler_runner as runner
import historical_recovery as recovery
from known_errors import CorrectionError
from master_db import MasterDB
from serving_policy import quarantine_digest


FIXTURES = Path(__file__).parent / "fixtures" / "historical-recovery"


class HistoricalRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "master.db"
        self.db = MasterDB(str(self.path))
        self.db.upsert_raw([dict(serial="1", case_name="기준", case_number="2020다1",
                                 date="20200101", court="대법원")])
        self.reference, _ = self.db.export_core()
        payload = json.dumps(dict(version="20200101", total=1, cases=self.reference,
                                  court_code_map=self.db.court_resolver.code_map)).encode()
        entries = recovery.entries()
        inventory = []
        for sid, entry in entries.items():
            raw = entry["expectedArchivedRaw"]
            self.db.conn.execute("INSERT INTO cases VALUES(?,?,?,?,?,?,?)", tuple(raw[k] for k in
                                 ("serial", "case_name", "case_number", "case_number_clean", "date", "court", "inserted_at")))
            inventory.append((sid, entry["archivedRawSha256"], "legacy_not_in_reviewed_snapshot", "a" * 64))
        inventory.sort()
        self.db.conn.executemany("INSERT INTO export_quarantine VALUES(?,?,?,?)", inventory)
        digest = hashlib.sha256(payload).hexdigest()
        review = dict(schema=1, referenceSha256=digest, quarantinedRows=2,
                      quarantineSha256=quarantine_digest(inventory))
        self.db.conn.execute("INSERT INTO serving_policy VALUES(1,?,?,?)", (payload, digest, json.dumps(review)))
        self.db.conn.commit()

    def tearDown(self):
        self.db.close()
        self.directory.cleanup()

    def body(self, entry):
        data = json.loads(gzip.decompress((FIXTURES / (entry["record"]["serial"] + ".json.gz")).read_bytes()))
        return data["data"]["ASIQTB002PR01"]["dcmHwpEditorDVOList"][0]["dcmFleByte"].encode()

    def incoming(self, entry):
        receipt = recovery.resolve(entry["expectedList"], entry["expectedArchivedRaw"], fetch=self.body)
        return dict({k: entry["expectedArchivedRaw"][k] for k in
                     ("serial", "case_name", "case_number", "date", "court")}, _historical_recovery=receipt)

    def test_both_original_headers_and_five_immutable_fields_are_preserved(self):
        before = self.db.conn.execute("SELECT * FROM cases ORDER BY serial").fetchall()
        inventory = self.db.conn.execute("SELECT * FROM export_quarantine ORDER BY serial").fetchall()
        rows = [self.incoming(e) for e in recovery.entries().values()]
        self.assertEqual(self.db.upsert_raw(rows), (0, 2, 0))
        cases, skipped = self.db.export_core()
        self.assertEqual(cases["22Guh1013"][0][:3], [349026, 45, 231116])
        self.assertEqual(cases["22Guh72770"][0][:3], [242327, 45, 231207])
        self.assertNotIn("23Guh72770", cases)
        self.assertEqual(cases["20Da1"], self.reference["20Da1"])
        self.assertEqual(skipped, 0)
        self.assertEqual(self.db.last_export_report["reviewedQuarantineRows"], 2)
        self.assertEqual(before, self.db.conn.execute("SELECT * FROM cases ORDER BY serial").fetchall())
        self.assertEqual(inventory, self.db.conn.execute("SELECT * FROM export_quarantine ORDER BY serial").fetchall())
        sql = list(self.db.conn.iterdump())
        self.assertEqual(self.db.upsert_raw(rows), (0, 0, 2))
        self.assertEqual(sql, list(self.db.conn.iterdump()))

    def test_changed_list_body_or_header_fails_closed(self):
        entry = recovery.entries()["349026"]
        for fields, body in [(dict(entry["expectedList"], 사건번호="2022구합9999"), self.body(entry)),
                             (entry["expectedList"], self.body(entry) + b" ")]:
            with self.assertRaises(CorrectionError):
                recovery.resolve(fields, entry["expectedArchivedRaw"], fetch=lambda _: body)
        altered = copy.deepcopy(entry)
        altered["record"]["date"] = "20230921"  # Hearing closure cannot be used as judgment date.
        with mock.patch.object(recovery, "entries", return_value={"349026": altered}), \
                self.assertRaisesRegex(CorrectionError, "source_changed"):
            recovery.resolve(altered["expectedList"], altered["expectedArchivedRaw"], fetch=self.body)

    def test_all_seven_raw_columns_are_bound(self):
        row = self.incoming(recovery.entries()["242327"])
        for column in ("inserted_at", "court", "case_number_clean"):
            self.db.conn.execute("SAVEPOINT poison")
            self.db.conn.execute(f"UPDATE cases SET {column}={column} || 'x' WHERE serial='242327'")
            with self.assertRaisesRegex(ValueError, "quarantined_raw_changed"):
                self.db.export_core()
            self.db.conn.execute("ROLLBACK TO poison")
            self.db.conn.execute("RELEASE poison")
        changed = copy.deepcopy(row)
        changed["_historical_recovery"]["record"]["court"] = "서울지방법원"
        with self.assertRaisesRegex(CorrectionError, "receipt_mismatch"):
            self.db.upsert_raw([changed])

    def test_batch_failure_rolls_back_every_overlay(self):
        rows = [self.incoming(e) for e in recovery.entries().values()]
        rows[1]["_historical_recovery"]["judgmentSha256"] = "0" * 64
        before = list(self.db.conn.iterdump())
        with self.assertRaises(CorrectionError):
            self.db.upsert_raw(rows)
        self.assertEqual(before, list(self.db.conn.iterdump()))

    def test_deleted_or_changed_provenance_blocks_export(self):
        self.db.upsert_raw([self.incoming(e) for e in recovery.entries().values()])
        for sql in ["DELETE FROM historical_recovery_provenance",
                    "DELETE FROM reviewed_recovery_provenance WHERE serial='242327'",
                    "UPDATE reviewed_recovery_provenance SET recovery_sha256='tampered' WHERE serial='242327'"]:
            self.db.conn.execute("SAVEPOINT poison")
            self.db.conn.execute(sql)
            with self.assertRaisesRegex(ValueError, "receipt_mismatch"):
                self.db.export_core()
            self.db.conn.execute("ROLLBACK TO poison")
            self.db.conn.execute("RELEASE poison")

    def test_real_parser_rechecks_live_proof_on_quarantined_replay(self):
        entry = recovery.entries()["349026"]
        item = ET.Element("prec")
        for k, v in entry["expectedList"].items():
            ET.SubElement(item, k).text = v
        with mock.patch.object(recovery, "fetch_judgment"):
            # Explicit wrapper avoids replacing the resolver's fixed default.
            resolve = recovery.resolve
            with mock.patch.object(recovery, "resolve", side_effect=lambda f, r: resolve(f, r, fetch=self.body)):
                row = runner._precedent_case(item, "20230921", 1, self.db.raw_replay_checker())
        self.assertEqual(row["date"], "20230921")
        self.assertEqual(row["_historical_recovery"]["record"]["date"], "20231116")
        self.db.upsert_raw([row])

    def test_full_source_metadata_and_original_body_are_verified(self):
        import source_corrections
        for entry in recovery.entries().values():
            referral = mock.MagicMock(status_code=302, headers={"Location": entry["originalUrl"]})
            referral.__enter__.return_value = referral
            response = mock.MagicMock(status_code=200)
            response.__enter__.return_value = response
            data = gzip.decompress((FIXTURES / (entry["record"]["serial"] + ".json.gz")).read_bytes())
            response.iter_content.return_value = [data]
            session = mock.Mock()
            session.get.return_value, session.post.return_value = referral, response
            with mock.patch.object(api, "_get_session", return_value=session):
                self.assertEqual(source_corrections.fetch_judgment(entry), self.body(entry))
                modified = json.loads(data)
                modified["data"]["ASIQTB002PR01"]["dcmDVO"]["ntstDcmDscmCntn"] += "x"
                response.iter_content.return_value = [json.dumps(modified).encode()]
                with self.assertRaisesRegex(CorrectionError, "source_changed"):
                    source_corrections.fetch_judgment(entry)

    def test_missing_current_id_cannot_be_recovered(self):
        body = b'<PrecSearch><totalCnt>0</totalCnt></PrecSearch>'
        with self.assertRaises(ValueError):
            command.current_item(recovery.entries()["242327"]["expectedList"], fetch=lambda *a, **k: body)

    def test_owner_excluded_outlier_never_reaches_parser_or_changes_codec(self):
        from compress import CASE_CODE_MAP
        self.assertNotIn("재보군형공", CASE_CODE_MAP)
        item = ET.Element("prec")
        for k, v in {"판례일련번호": "623129", "사건번호": "95재보군형공15"}.items():
            ET.SubElement(item, k).text = v
        before = list(self.db.conn.iterdump())
        row = runner._precedent_case(item, "19970703", 1, self.db.raw_replay_checker())
        self.assertTrue(row["_excluded_serial"])
        self.assertEqual(self.db.upsert_raw([row]), (0, 0, 1))
        self.assertEqual(before, list(self.db.conn.iterdump()))

    def test_last_source_failure_prevents_every_recovery_write(self):
        before = list(self.db.conn.iterdump())
        with mock.patch.object(runner, "_precedent_case", side_effect=[
                {"serial": "349026"}, {"serial": "242327"}, CorrectionError("known_error_source_changed")]), \
                self.assertRaisesRegex(CorrectionError, "source_changed"):
            command.recover(self.path, apply=True, fetch=lambda _: ET.Element("prec"))
        self.assertEqual(before, list(self.db.conn.iterdump()))


if __name__ == "__main__":
    unittest.main()
