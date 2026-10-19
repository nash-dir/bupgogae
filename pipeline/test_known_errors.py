"""Real source fixtures plus fail-closed correction and transaction tests."""
import copy
import gzip
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

import api
import crawler_runner as runner
import known_errors as ke
from master_db import MasterDB

FIXTURES = Path(__file__).parent / "fixtures" / "known-errors"
SOURCE = "근로복지공단산재판례"


def entry(serial="362082"):
    return ke.registry().entries[SOURCE + ":" + serial]


def body_fetcher(serial="362082"):
    item = entry(serial)
    bodies = [gzip.decompress((FIXTURES / f"{serial}-{name}.html.gz").read_bytes())
              for name in ("law", "original")]
    return mock.Mock(side_effect=dict(zip(item["urls"], bodies)).__getitem__)


def corrected(serial="362082"):
    return ke.registry().resolve(entry(serial)["expectedList"], body_fetcher(serial))


def xml_page(fields):
    root = ET.Element("PrecSearch")
    ET.SubElement(root, "totalCnt").text = "1"
    item = ET.SubElement(root, "prec")
    for key, value in fields.items():
        ET.SubElement(item, key).text = value
    return ET.tostring(root, encoding="utf-8")


class KnownErrorTests(unittest.TestCase):
    def test_real_merged_date_and_character_fixtures(self):
        for serial in ("362082", "409398", "363788"):
            with self.subTest(serial=serial):
                result = corrected(serial)
                self.assertEqual({k: result[k] for k in ke.RECORD_FIELDS}, entry(serial)["record"])
                ke.registry().verify_receipt(result, result["_known_error"])
        self.assertEqual(ke.expand_merged_case_numbers(corrected()["case_number"]),
                         ("2007구단15523", "2008구단320"))
        self.assertEqual(corrected("363788")["case_name"], "요양･보험급여불승인처분취소")

    def test_live_head_cache_time_variants_match_without_ignoring_judgment_bytes(self):
        for serial in ("362082", "409398", "363788"):
            retained = body_fetcher(serial)
            current = gzip.decompress((FIXTURES / f"{serial}-law-timevariant.html.gz").read_bytes())
            expected = entry(serial)
            self.assertNotEqual(ke.digest(current), expected["bodyHashes"][0])
            self.assertEqual(ke.law_comparison_hash(current), expected["lawComparisonSha256"])
            result = ke.registry().resolve(expected["expectedList"],
                                           lambda url: current if url == expected["urls"][0] else retained(url))
            self.assertEqual(result["_known_error"]["observedBodyHashes"][0], ke.digest(current))
            ke.registry().verify_receipt(result, result["_known_error"])

    def test_cache_normalization_never_ignores_other_page_changes(self):
        body = body_fetcher()(entry()["urls"][0])
        for changed in (body + b"judgment changed", body.replace(b"<head>", b"<head><head>"),
                        body.replace(b"jquery.min.js?Time=", b"other.js?Time="),
                        body.replace(b"/LSW/js/jquery/jquery.min.js?Time=", b"https://attacker.invalid/a.js?Time=")):
            with self.assertRaises(ke.CorrectionError):
                def fetch(url):
                    return changed if url == entry()["urls"][0] else body_fetcher()(url)
                ke.registry().resolve(entry()["expectedList"], fetch)

    def test_changed_list_is_not_repaired_and_does_not_fetch(self):
        for key in ke.LIST_FIELDS:
            fields = dict(entry()["expectedList"])
            fields[key] += "changed"
            fetch = mock.Mock()
            if key in ("판례일련번호", "데이터출처명"):
                self.assertIsNone(ke.registry().resolve(fields, fetch))
            else:
                with self.assertRaisesRegex(ke.CorrectionError, "known_error_input_changed"):
                    ke.registry().resolve(fields, fetch)
            fetch.assert_not_called()

    def test_changed_source_and_wrong_source_identity_fail(self):
        original_fetch = body_fetcher()
        for changed in range(2):
            with self.subTest(changed=changed):
                def fetch(url):
                    body = original_fetch(url)
                    return body + b"changed" if url == entry()["urls"][changed] else body
                with self.assertRaisesRegex(ke.CorrectionError, "known_error_source_changed"):
                    ke.registry().resolve(entry()["expectedList"], fetch)

    def test_held_and_covered_never_become_new_records(self):
        for disposition in ("held", "covered"):
            item = next(e for e in ke.registry().entries.values() if e["disposition"] == disposition)
            fetch = mock.Mock()
            with self.assertRaisesRegex(ke.CorrectionError, "known_error_review_required"):
                ke.registry().resolve(item["expectedList"], fetch)
            fetch.assert_not_called()

    def test_unknown_sources_are_not_changed(self):
        for source in ("unknown", "국세법령정보시스템", "특허법원"):
            fields = dict(entry()["expectedList"], 데이터출처명=source)
            self.assertIsNone(ke.registry().resolve(fields, mock.Mock()))

    def test_duplicate_keys_bad_schema_url_or_record_cannot_load(self):
        with self.assertRaises(ke.CorrectionError):
            ke.CorrectionRegistry(b'{"schema":2,"schema":1}')
        for mutation in ("schema", "date", "tail", "url", "court"):
            data = copy.deepcopy(ke.registry().data)
            record = data["entries"][SOURCE + ":362082"]
            if mutation == "schema":
                data["schema"] = 99
            elif mutation == "date":
                record["record"]["date"] = "20090230"
            elif mutation == "tail":
                record["record"]["case_number"] += ", unknown"
            elif mutation == "court":
                record["record"]["court"] = "가" * 65
            else:
                record["urls"][0] = "https://attacker.invalid/body"
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                ke.CorrectionRegistry(json.dumps(data).encode())

    def test_receipt_registry_and_output_tampering_fail(self):
        result = corrected()
        for field in ("registrySha256", "version", "expectedList", "bodyHashes", "observedBodyHashes",
                      "lawComparisonSha256", "lawComparisonProfile"):
            receipt = copy.deepcopy(result["_known_error"])
            receipt[field] = None
            with self.subTest(field=field), self.assertRaisesRegex(ke.CorrectionError, "receipt_mismatch"):
                ke.registry().verify_receipt(result, receipt)
        result["case_number"] = "2007구단15523"
        with self.assertRaises(ke.CorrectionError):
            ke.registry().verify_receipt(result, result["_known_error"])

    def test_real_crawler_parser_and_master_export_preserve_every_member(self):
        with mock.patch.object(runner, "fetch_source_body", body_fetcher()), \
                mock.patch.object(runner, "fetch_xml_safe", return_value=xml_page(entry()["expectedList"])):
            rows = runner.fetch_cases_for_range("20090902")
        with tempfile.TemporaryDirectory() as folder:
            db = MasterDB(str(Path(folder) / "master.db"))
            try:
                self.assertEqual(db.upsert_raw(rows), (1, 0, 0))
                data, skipped = db.export_core()
                self.assertEqual(set(data), {"07Gud15523", "08Gud320"})
                self.assertEqual(skipped, 0)
                receipt = json.loads(db.conn.execute("SELECT receipt_json FROM known_error_provenance").fetchone()[0])
                self.assertEqual(receipt["expectedList"], entry()["expectedList"])
                self.assertEqual(receipt["expectedList"]["선고일자"], "0001.01.01")
                with self.assertRaises(ke.CorrectionError):
                    db.upsert_raw([entry()["record"]])
                self.assertEqual(db.export_core()[0], data)
                db.conn.execute("UPDATE cases SET date='20090903'")
                with self.assertRaises(ke.CorrectionError):
                    db.export_all()
            finally:
                db.close()

    def test_failed_correction_rolls_back_cases_and_provenance(self):
        with tempfile.TemporaryDirectory() as folder:
            db = MasterDB(str(Path(folder) / "master.db"))
            try:
                bad = corrected("363788")
                bad["date"] = "20090404"
                with self.assertRaises(ke.CorrectionError):
                    db.upsert_raw([corrected(), bad])
                self.assertEqual(db.count(), 0)
                self.assertEqual(db.conn.execute("SELECT COUNT(*) FROM known_error_provenance").fetchone()[0], 0)
            finally:
                db.close()

    def test_clean_key_tampering_cannot_redirect_a_verified_single_case(self):
        with tempfile.TemporaryDirectory() as folder:
            db = MasterDB(str(Path(folder) / "master.db"))
            try:
                db.upsert_raw([corrected("409398")])
                db.conn.execute("UPDATE cases SET case_number_clean='2019두99999'")
                with self.assertRaisesRegex(ke.CorrectionError, "receipt_mismatch"):
                    db.export_core()
            finally:
                db.close()

    def test_source_failure_keeps_durable_backlog_and_blocks_publication(self):
        with tempfile.TemporaryDirectory() as folder:
            db = MasterDB(str(Path(folder) / "master.db"))
            try:
                with mock.patch.object(runner, "fetch_source_body", side_effect=ke.CorrectionError("known_error_source_unavailable")), \
                        mock.patch.object(runner, "fetch_xml_safe", return_value=xml_page(entry()["expectedList"])):
                    result = runner.crawl_scan_ranges(db, [("20090902", "20090902")],
                                                      fetcher=runner.fetch_cases_for_range, sleep_fn=lambda: None,
                                                      persist_backlog=lambda pending: runner.save_failed_dates(folder, pending))
                self.assertEqual(db.count(), 0)
                backlog = runner.load_failed_dates(folder)
                self.assertEqual(backlog[0]["last_error"], "known_error_source_unavailable")
                self.assertFalse(runner.publication_allowed(backlog))
                self.assertEqual(result["errors"], 1)
            finally:
                db.close()

    def test_corrected_date_still_must_be_in_requested_range(self):
        item = ET.fromstring(xml_page(entry()["expectedList"])).find("prec")
        with mock.patch.object(runner, "fetch_source_body", body_fetcher()):
            with self.assertRaisesRegex(runner.RangeFetchError, "out_of_range_case_date"):
                runner._precedent_case(item, "20261018", 1)

    def test_network_redirect_status_oversize_and_timeout_fail_closed(self):
        for status, chunks in ((302, []), (500, []), (200, [b"x" * (ke.MAX_BODY_BYTES + 1)])):
            response = mock.MagicMock(status_code=status)
            response.__enter__.return_value = response
            response.iter_content.return_value = chunks
            session = mock.Mock()
            session.get.return_value = response
            with mock.patch.object(api, "_get_session", return_value=session):
                with self.assertRaises(ke.CorrectionError):
                    ke.fetch_source_body(entry()["urls"][0])
            self.assertFalse(session.get.call_args.kwargs["allow_redirects"])
        with mock.patch.object(api, "_get_session") as session:
            session.return_value.get.side_effect = api.requests.Timeout("private response")
            with self.assertRaisesRegex(ke.CorrectionError, "^known_error_source_unavailable$"):
                ke.fetch_source_body(entry()["urls"][0])


if __name__ == "__main__":
    unittest.main()
