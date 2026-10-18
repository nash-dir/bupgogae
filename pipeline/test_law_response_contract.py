"""Captured public API responses must survive the real request/parser boundary."""
import copy
import gzip
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

import api
import crawler_runner as runner
from master_db import MasterDB

FIXTURES = Path(__file__).parent / "fixtures" / "law-201811"


def fixture(name):
    return gzip.decompress((FIXTURES / name).read_bytes())


def response(body):
    result = mock.Mock(status_code=200, headers={})
    result.iter_content.return_value = [body]
    return result


class LawResponseContractTests(unittest.TestCase):
    def tearDown(self):
        api.reset_network_stats()

    def test_range_uses_prncYd_on_every_page_and_preserves_all_sources(self):
        session = mock.Mock()

        def get(url, **kwargs):
            params = kwargs["params"]
            if params.get("prncYd") != "20181101~20181130":
                return response(b"<PrecSearch><totalCnt>0</totalCnt></PrecSearch>")
            self.assertNotIn("date", params)
            self.assertNotIn("datSrcNm", params)  # no silent source narrowing
            return response(fixture(f"month-{params['page']}.xml.gz"))

        session.get.side_effect = get
        with mock.patch.object(api, "_get_session", return_value=session), mock.patch.object(runner.time, "sleep"):
            rows = runner.fetch_cases_for_range("20181101~20181130")
        self.assertEqual(len(rows), 426)
        self.assertEqual(len({r["serial"] for r in rows}), 426)
        self.assertEqual(session.get.call_count, 5)
        self.assertTrue(all("20181101" <= r["date"] <= "20181130" for r in rows))
        known = next(r for r in rows if r["serial"] == "206264")
        self.assertEqual(known["case_number"], "2016도10912")
        self.assertEqual(known["date"], "20181101")
        with tempfile.TemporaryDirectory() as folder:
            db = MasterDB(str(Path(folder) / "master.db"))
            try:
                # Existing explicit blacklist policy is preserved, not bypassed
                # to make raw API totals equal the exported snapshot count.
                self.assertEqual(db.upsert_raw(rows), (424, 0, 2))
                payload, skipped = db.export_core()
                self.assertEqual(skipped, 0)
                self.assertEqual({str(row[0]) for records in payload.values() for row in records},
                                 {row["serial"] for row in rows} - {"333242", "302470"})
                self.assertTrue(all(record[1] in db.court_resolver.code_map.values()
                                    for records in payload.values() for record in records))
            finally:
                db.close()

    def test_single_date_keeps_date_parameter_and_normalizes_full_real_page(self):
        session = mock.Mock()
        session.get.return_value = response(fixture("day.xml.gz"))
        with mock.patch.object(api, "_get_session", return_value=session):
            rows = runner.fetch_cases_for_range("20181101")
        params = session.get.call_args.kwargs["params"]
        self.assertEqual(params["date"], "20181101")
        self.assertNotIn("prncYd", params)
        self.assertEqual(len(rows), 26)
        self.assertTrue(all(r["date"] == "20181101" for r in rows))

    def test_invalid_request_dates_never_reach_transport(self):
        for value in ("20180230", "20181130~20181101", "20181101~", "2018.11.01", "20181101~20181130~20181201"):
            with self.subTest(value=value), mock.patch.object(api, "_get_session") as session:
                with self.assertRaises(ValueError):
                    api.fetch_xml_safe(value)
                session.assert_not_called()

    def test_real_exact_record_roundtrips_master_and_export(self):
        item = ET.fromstring(fixture("exact.xml.gz")).find("prec")
        row = runner._precedent_case(item, "20181101", 1)
        with tempfile.TemporaryDirectory() as folder:
            db = MasterDB(str(Path(folder) / "master.db"))
            try:
                self.assertEqual(db.upsert_raw([row]), (1, 0, 0))
                payload, skipped = db.export_core()
                self.assertEqual(skipped, 0)
                self.assertEqual(payload["16Do10912"], [[206264, 1, 181101, "병역법위반"]])
            finally:
                db.close()

    def test_dates_normalize_before_calendar_and_range_checks(self):
        original = ET.fromstring(fixture("exact.xml.gz")).find("prec")
        for raw in ("20181101", "2018.11.01", "2018-11-01", "2018/11/01"):
            item = copy.deepcopy(original)
            item.find("선고일자").text = raw
            self.assertEqual(runner._precedent_case(item, "20181101", 1)["date"], "20181101")
        for raw, reason in (("2018.02.30", "invalid_case_date"), ("2018.11.02", "out_of_range_case_date"), ("2018x11x01", "invalid_case_date"), ("", "missing_case_date")):
            item = copy.deepcopy(original)
            item.find("선고일자").text = raw
            with self.subTest(raw=raw), self.assertRaises(runner.RangeFetchError) as caught:
                runner._precedent_case(item, "20181101", 1)
            self.assertEqual(caught.exception.reason, reason)

    def test_prefixed_tax_record_requires_known_source_and_consistent_court(self):
        item = ET.fromstring(fixture("day.xml.gz")).find("prec")
        row = runner._precedent_case(item, "20181101", 1)
        self.assertEqual(row["court"], "대전지방법원")
        self.assertEqual(row["case_number"], "2017구합104391")
        for tag, value in (("데이터출처명", "unrecognized"), ("법원명", "서울지방법원"), ("사건번호", "아무문자-2017-구합-104391")):
            changed = copy.deepcopy(item)
            changed.find(tag).text = value
            with self.subTest(tag=tag), self.assertRaises(runner.RangeFetchError):
                runner._precedent_case(changed, "20181101", 1)

    def test_later_page_failure_keeps_backlog_and_writes_no_partial_rows(self):
        db = mock.Mock()
        with mock.patch.object(runner, "fetch_xml_safe", side_effect=[fixture("month-1.xml.gz"), None]), mock.patch.object(runner.time, "sleep"):
            result = runner.crawl_scan_ranges(db, [("20181101", "20181130")], sleep_fn=lambda: None)
        db.upsert_raw.assert_not_called()
        self.assertEqual(result["errors"], 1)
        self.assertEqual(result["failed"][0]["failed_pages"], [2])
        self.assertFalse(runner.publication_allowed(result["failed"]))

    def test_latest_date_discovery_normalizes_official_dates(self):
        with mock.patch.object(runner, "RECENT_SCAN_PAGES", 1), mock.patch.object(runner, "fetch_xml_safe", return_value=fixture("day.xml.gz")), mock.patch.object(runner.time, "sleep"):
            self.assertEqual(runner.fetch_recent_ruling_dates(), {"20181101"})

    def test_detc_uses_same_date_normalization_without_changing_empty_policy(self):
        for raw, expected in (("2018.11.01", "20181101"), ("20181101", "20181101"), ("", "")):
            body = f"<DetcSearch><totalCnt>1</totalCnt><Detc><헌재결정례일련번호>1</헌재결정례일련번호><사건번호>2018헌마1</사건번호><종국일자>{raw}</종국일자></Detc></DetcSearch>".encode()
            with mock.patch.object(runner, "fetch_xml_safe", return_value=body):
                self.assertEqual(runner._fetch_detc_page(1)[0]["date"], expected)
