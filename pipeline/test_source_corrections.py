"""Reviewed original judgment beats erroneous metadata without overwriting raw."""

import copy
import gzip
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

import requests

import api
import crawler_runner as runner
from known_errors import CorrectionError
from master_db import MasterDB
import source_corrections as corrections

FIXTURES = Path(__file__).parent / "fixtures" / "source-corrections"


class SourceCorrectionTests(unittest.TestCase):
    def test_single_member_branch_details_preserve_reference_parent_court(self):
        for sid in ('145396', '182768'):
            entry = corrections.entries()['대법원:' + sid]
            detail = json.loads(gzip.decompress((FIXTURES / (sid + '-law-detail.json.gz')).read_bytes()))
            with self.subTest(serial=sid), tempfile.TemporaryDirectory() as folder:
                with mock.patch('reviewed_replays.fetch_detail', return_value=detail):
                    receipt = corrections.resolve(entry['expectedList'])
                self.assertEqual(receipt['record'], entry['expectedPreviousRaw'])
                with self.assertRaisesRegex(CorrectionError, 'source_changed'):
                    corrections.resolve(entry['expectedList'], fetch=lambda _: detail['body'].encode() + b' ')
                db = MasterDB(str(Path(folder) / 'master.db'))
                try:
                    item = self.item(entry['expectedList'])
                    with mock.patch.object(corrections, 'resolve', return_value=receipt):
                        row = runner._precedent_case(item, entry['record']['date'], 1)
                    db.upsert_raw([row])
                    before = list(db.conn.iterdump())
                    exported = db.export_core()
                    self.assertEqual(db.upsert_raw([row]), (0, 0, 1))
                    self.assertEqual(list(db.conn.iterdump()), before)
                    self.assertEqual(db.export_core(), exported)
                    self.assertEqual(db.court_resolver.code_map[entry['record']['court']],
                                     13 if sid == '145396' else 14)
                finally:
                    db.close()

    def setUp(self):
        self.entry = copy.deepcopy(next(iter(corrections.entries().values())))
        self.fields = dict(self.entry["expectedList"])
        self.html = gzip.decompress((FIXTURES / "613735-judgment.html.gz").read_bytes())

    def resolve(self, fields=None):
        return corrections.resolve(fields or self.fields, fetch=lambda entry: self.html)

    def item(self, fields=None):
        item = ET.Element("prec")
        for k, v in (fields or self.fields).items():
            ET.SubElement(item, k).text = v
        return item

    def test_pinned_source_and_input_changes_fail_closed(self):
        receipt = self.resolve()
        self.assertEqual(receipt["record"]["date"], "20251211")
        with self.assertRaisesRegex(CorrectionError, "source_changed"):
            corrections.resolve(self.fields, fetch=lambda entry: self.html + b" ")
        with self.assertRaisesRegex(CorrectionError, "input_changed"):
            self.resolve(dict(self.fields, 선고일자="2025.12.11"))
        with mock.patch.object(corrections, "fetch_judgment") as fetch:
            self.assertIsNone(corrections.resolve(dict(self.fields, 데이터출처명="other")))
            fetch.assert_not_called()

    def test_exact_referral_and_bounded_readonly_lookup_have_no_oc(self):
        referral = mock.MagicMock(status_code=302, headers={"Location": self.entry["originalUrl"]})
        referral.__enter__.return_value = referral
        body = mock.MagicMock(status_code=200, headers={})
        body.__enter__.return_value = body
        body.iter_content.return_value = [(FIXTURES / "613735-original.json").read_bytes()]
        session = mock.Mock()
        session.get.return_value = referral
        session.post.return_value = body
        with mock.patch.object(api, "_get_session", return_value=session):
            self.assertEqual(corrections.fetch_judgment(self.entry), self.html)
        for method in (session.get, session.post):
            self.assertFalse(method.call_args.kwargs["allow_redirects"])
            self.assertTrue(method.call_args.kwargs["stream"])
            self.assertNotIn("OC=", str(method.call_args))
        referral.headers["Location"] = "https://unapproved.invalid/"
        session.post.reset_mock()
        with mock.patch.object(api, "_get_session", return_value=session), \
                self.assertRaisesRegex(CorrectionError, "source_changed"):
            corrections.fetch_judgment(self.entry)
        session.post.assert_not_called()
        session.get.side_effect = requests.ConnectionError("OC=SECRET")
        with mock.patch.object(api, "_get_session", return_value=session), \
                self.assertRaises(CorrectionError) as caught:
            corrections.fetch_judgment(self.entry)
        self.assertNotIn("SECRET", str(caught.exception))

    def test_serving_overlay_preserves_bad_raw_and_receipt_on_replay(self):
        receipt = self.resolve()
        with mock.patch.object(corrections, "resolve", return_value=receipt):
            row = runner._precedent_case(self.item(), "20261211", 1)
        self.assertEqual(row["date"], "20261211")  # immutable original metadata
        with tempfile.TemporaryDirectory() as folder:
            db = MasterDB(str(Path(folder) / "master.db"))
            try:
                db.upsert_raw([{k: row[k] for k in receipt["record"]}])  # prior failed-run state
                self.assertEqual(db.upsert_raw([row]), (0, 1, 0))
                self.assertEqual(db.conn.execute("SELECT date FROM cases").fetchone()[0], "20261211")
                cases, _ = db.export_core()
                self.assertEqual(cases["25Du34754"][0][2], 251211)
                before = list(db.conn.iterdump())
                self.assertEqual(db.upsert_raw([row]), (0, 0, 1))
                self.assertEqual(list(db.conn.iterdump()), before)
                altered = copy.deepcopy(row)
                altered["_serving_correction"]["record"]["date"] = "20251212"
                with self.assertRaisesRegex(CorrectionError, "receipt_mismatch"):
                    db.upsert_raw([altered])
                for sql in ("DELETE FROM source_correction_provenance",
                            "UPDATE reviewed_recovery_provenance SET recovery_sha256='tampered'"):
                    db.conn.execute("SAVEPOINT poison")
                    db.conn.execute(sql)
                    with self.subTest(sql=sql), self.assertRaisesRegex(ValueError, "receipt_mismatch"):
                        db.export_core()
                    db.conn.execute("ROLLBACK TO poison")
                    db.conn.execute("RELEASE poison")
                db.conn.execute("UPDATE reviewed_recovery_provenance SET record_json=?",
                                (json.dumps(dict(receipt["record"], date="20251212")),))
                with self.assertRaisesRegex(ValueError, "receipt_mismatch"):
                    db.export_core()
            finally:
                db.close()

    def test_unreviewed_future_dates_are_not_published_or_inferred(self):
        fields = dict(self.fields, 판례일련번호="999999999", 선고일자="2099.01.01")
        with self.assertRaises(runner.RangeFetchError) as caught:
            runner._precedent_case(self.item(fields), "20990101", 1)
        self.assertEqual(caught.exception.reason, "invalid_case_date")
        xml = b"<DetcSearch><totalCnt>1</totalCnt><Detc>" + \
            "<헌재결정례일련번호>1</헌재결정례일련번호><사건번호>2026헌마1</사건번호><종국일자>20990101</종국일자>".encode() + b"</Detc></DetcSearch>"
        with mock.patch.object(runner, "fetch_xml_safe", return_value=xml), \
                self.assertRaises(runner.RangeFetchError):
            runner._fetch_detc_page(1)

    def test_missing_courts_require_exact_reviewed_original_not_registration_office(self):
        reviewed = [e for e in corrections.entries().values() if "courtEvidence" in e]
        self.assertEqual(len(reviewed), 9)
        self.assertEqual(sum(e["courtEvidence"] == "unknown" for e in reviewed), 9)
        original_resolve = corrections.resolve
        def resolve(fields):
            return original_resolve(fields, fetch=lambda e: gzip.decompress(
                (FIXTURES / (e["record"]["serial"] + "-judgment.html.gz")).read_bytes()))
        with tempfile.TemporaryDirectory() as folder:
            db = MasterDB(str(Path(folder) / "master.db"))
            try:
                for entry in reviewed:
                    fields = entry["expectedList"]
                    with mock.patch.object(corrections, "resolve", side_effect=resolve):
                        row = runner._precedent_case(self.item(fields), entry["record"]["date"], 1)
                    self.assertEqual(row["court"], "")  # Original API remains untouched.
                    db.upsert_raw([row])
                    before = list(db.conn.iterdump())
                    self.assertIsNone(db.raw_replay_checker()(row["_source_raw"], row["_source_name"]))
                    self.assertEqual(db.upsert_raw([row]), (0, 0, 1))
                    self.assertEqual(list(db.conn.iterdump()), before)
                cases, _ = db.export_core()
                records = [row for rows in cases.values() for row in rows]
                self.assertEqual(len(records), 9)
                self.assertEqual(sum(row[1] == 0 for row in records), 9)
                self.assertEqual({e.get("verifiedCourt") for e in reviewed if e.get("verifiedCourt")},
                                 {"대전지방법원 천안지원", "춘천지방법원 원주지원"})
            finally:
                db.close()
        fields = dict(reviewed[0]["expectedList"], 판례일련번호="999999998")
        with self.assertRaises(runner.RangeFetchError) as caught:
            runner._precedent_case(self.item(fields), reviewed[0]["record"]["date"], 1)
        self.assertEqual(caught.exception.reason, "missing_case_court")

    def test_all_original_metadata_and_body_are_bound_without_global_title_trimming(self):
        for entry in corrections.entries().values():
            if entry["profile"] != corrections.PROFILE:
                continue
            sid = entry["record"]["serial"]
            referral = mock.MagicMock(status_code=302, headers={"Location": entry["originalUrl"]})
            referral.__enter__.return_value = referral
            body = mock.MagicMock(status_code=200, headers={})
            body.__enter__.return_value = body
            data = (FIXTURES / (sid + "-original.json")).read_bytes()
            body.iter_content.return_value = [data]
            session = mock.Mock()
            session.get.return_value, session.post.return_value = referral, body
            with self.subTest(serial=sid), mock.patch.object(api, "_get_session", return_value=session):
                receipt = corrections.resolve(entry["expectedList"], fetch=corrections.fetch_judgment)
                self.assertEqual(receipt["record"], entry["record"])
                changed = json.loads(data)
                changed["data"]["ASIQTB002PR01"]["dcmDVO"]["ntstDcmTtl"] += " "
                body.iter_content.return_value = [json.dumps(changed).encode()]
                with self.assertRaisesRegex(CorrectionError, "source_changed"):
                    corrections.fetch_judgment(entry)

    def test_official_merged_detail_preserves_published_parent_and_every_member(self):
        entry = corrections.entries()["대법원:202029"]
        detail = json.loads(gzip.decompress((FIXTURES / "202029-original.json.gz").read_bytes()))
        import reviewed_replays
        with mock.patch.object(reviewed_replays, "fetch_detail", return_value=detail):
            receipt = corrections.resolve(entry["expectedList"], fetch=corrections.fetch_judgment)
        with mock.patch.object(corrections, "resolve", return_value=receipt):
            row = runner._precedent_case(self.item(entry["expectedList"]), "20151105", 1)
        with tempfile.TemporaryDirectory() as folder:
            db = MasterDB(str(Path(folder) / "master.db"))
            try:
                db.upsert_raw([entry["expectedPreviousRaw"]])
                previous, _ = db.export_core()
                import hashlib
                from serving_policy import quarantine_digest
                payload = json.dumps(dict(version="20151105", total=len(previous), cases=previous,
                                          court_code_map=db.court_resolver.code_map)).encode()
                digest = hashlib.sha256(payload).hexdigest()
                review = dict(schema=1, referenceSha256=digest, quarantinedRows=0,
                              quarantineSha256=quarantine_digest([]))
                db.conn.execute("INSERT INTO serving_policy VALUES(1,?,?,?)",
                                (payload, digest, json.dumps(review)))
                db.conn.commit()
                # Reproduce the exact failed production snapshot: the ordinary
                # list update already changed the parent code to branch code.
                db.conn.execute("UPDATE cases SET court='부산고등법원창원재판부'")
                db.conn.commit()
                with self.assertRaisesRegex(ValueError, "reference_record_removed_or_changed"):
                    db.export_core()
                db.upsert_raw([row])
                cases, _ = db.export_core()
                self.assertEqual(set(cases), {"14Na21277", "14Na21284", "14Na21291", "14Na21307", "14Na21314"})
                self.assertEqual(cases["14Na21277"], previous["14Na21277"])
                self.assertTrue(all(records[0][1] == 11 for records in cases.values()))
                self.assertEqual(db.conn.execute("SELECT court FROM cases").fetchone()[0],
                                 "부산고등법원창원재판부")
                before = list(db.conn.iterdump())
                self.assertEqual(db.upsert_raw([row]), (0, 0, 1))
                self.assertEqual(list(db.conn.iterdump()), before)
            finally:
                db.close()
        changed = copy.deepcopy(detail)
        changed["metadata"]["사건번호"] = "2014나21277"
        with mock.patch.object(reviewed_replays, "fetch_detail", return_value=changed), \
                self.assertRaisesRegex(CorrectionError, "source_changed"):
            corrections.fetch_judgment(entry)
