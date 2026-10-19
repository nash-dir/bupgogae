"""Merged cases preserve every explicitly identified member, or fail atomically."""
import gzip
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

import crawler_runner as runner
from master_db import MasterDB
from manifest import validate_payload

FIXTURE = Path(__file__).parent / "fixtures" / "law-merged-420836.xml.gz"
EXPECTED = {f"19Guh{n}" for n in (77422, 77439, 77484, 77514, 77521)}


class MergedCaseTests(unittest.TestCase):
    def test_real_main_and_counterclaim_pairs_preserve_both_full_members(self):
        from compress import compress_case_number
        rows = json.loads((FIXTURE.parent / "law-main-counterclaim-pairs.json").read_text(encoding="utf-8"))["records"]
        self.assertEqual(len(rows), 9)
        for row in rows:
            number = row["case_number"]
            expected = {compress_case_number(token.split("(")[0].strip()) for token in number.split(",")}
            with self.subTest(serial=row["serial"]), tempfile.TemporaryDirectory() as folder:
                db = MasterDB(str(Path(folder) / "master.db"))
                try:
                    self.assertEqual(db.upsert_raw([row]), (1, 0, 0))
                    self.assertEqual(db.conn.execute("SELECT case_number FROM cases").fetchone()[0], number)
                    exported, skipped = db.export_core()
                    self.assertEqual(set(exported), expected)
                    self.assertEqual(skipped, 0)
                    self.assertEqual(sum(map(len, exported.values())), 2)
                    with self.assertRaises(ValueError):
                        db.upsert_raw([{**row, "case_number": number.split("(")[0]}])
                    self.assertEqual(set(db.export_core()[0]), expected)
                finally:
                    db.close()

    def test_incomplete_or_conflicting_main_counterclaim_labels_fail_atomically(self):
        from law_normalization import expand_merged_case_numbers
        bad = [
            "2021가단1(본소), 2(반소)",
            "2021가단1(본소), 2022가단2",
            "2021가단1(본소), 2022가단2(본소)",
            "2021가단1(본소), 2021가단1(반소)",
            "2021가단1(본소), 2022가단2(반소), 2023가단3",
            "2021가단1(본소), 2022가단2(반소) 외 1건",
        ]
        for number in bad:
            with self.subTest(number=number), self.assertRaises(ValueError):
                expand_merged_case_numbers(number)

    def item(self):
        return ET.fromstring(gzip.decompress(FIXTURE.read_bytes())).find("prec")

    def test_real_merged_record_survives_fetch_storage_reopen_export_and_validation(self):
        with mock.patch.object(runner, "fetch_xml_safe", return_value=gzip.decompress(FIXTURE.read_bytes())):
            rows = runner.fetch_cases_for_range("20200611")
        self.assertEqual(len(rows), 1)  # source totalCnt is not alias count
        raw_number = self.item().findtext("사건번호")
        self.assertEqual(rows[0]["case_number"], raw_number)
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / "master.db")
            db = MasterDB(path)
            try:
                self.assertEqual(db.upsert_raw(rows), (1, 0, 0))
                self.assertEqual(db.count(), 1)
            finally:
                db.close()
            db = MasterDB(path)
            try:
                self.assertEqual(db.conn.execute("SELECT case_number FROM cases").fetchone()[0], raw_number)
                payload, skipped = db.export_core()
                self.assertEqual(set(payload), EXPECTED)
                exported_fixture = json.loads((FIXTURE.parent / "merged-420836-export.json").read_text(encoding="utf-8"))
                self.assertEqual(payload, exported_fixture)
                self.assertEqual(skipped, 0)
                self.assertEqual({r[0] for records in payload.values() for r in records}, {420836})
                blob = json.dumps({"version": "20261017", "total": 5, "keys": 5, "cases": payload, "court_code_map": db.court_resolver.code_map}).encode()
                self.assertEqual(len(validate_payload(blob, min_keys=1)["cases"]), 5)
            finally:
                db.close()

    def test_ambiguous_or_partial_members_fail_entire_range_without_upsert(self):
        bad = [
            "2019구합77422, 77439",  # no explicit merger marker
            "77422(병합), 2019구합77439",  # no leading anchor
            "2019구합77422, 2020구합1, 2(병합)",  # competing prefixes
            "2019구합77422, 77439(병합) 외 2건",  # discarded tail forbidden
            "2019구합77422,", "2019구합77422,,77439(병합)",
            "2019구합77422, 77422(병합)",  # duplicate alias
            "2019구합77422, 774-39(병합)",
            "2019구합77 422, 77439(병합)",
            "2019구합77422, 서울고법94구23625(병합)",
            "1919구합1,2019구합1",  # two distinct years collide in 2-digit codec
        ]
        for number in bad:
            item = self.item()
            item.find("사건번호").text = number
            root = ET.Element("PrecSearch")
            ET.SubElement(root, "totalCnt").text = "1"
            root.append(item)
            db = mock.Mock()
            with self.subTest(number=number), mock.patch.object(runner, "fetch_xml_safe", return_value=ET.tostring(root, encoding="utf-8")):
                result = runner.crawl_scan_ranges(db, [("20200611", "20200611")], sleep_fn=lambda: None)
            db.upsert_raw.assert_not_called()
            self.assertEqual(result["errors"], 1)
            self.assertFalse(runner.publication_allowed(result["failed"]))

    def test_fully_written_members_need_no_prefix_inference(self):
        item = self.item()
        item.find("사건번호").text = "2019구합77422,2020누1(병합)"
        row = runner._precedent_case(item, "20200611", 1)
        with tempfile.TemporaryDirectory() as folder:
            db = MasterDB(str(Path(folder) / "master.db"))
            try:
                db.upsert_raw([row])
                self.assertEqual(set(db.export_core()[0]), {"19Guh77422", "20Nu1"})
            finally:
                db.close()

    def test_oversized_merged_update_cannot_truncate_or_destroy_existing_data(self):
        raw = {"serial": "420836", "case_number": "2019구합77422", "court": "서울행정법원", "date": "20200611"}
        invalid = {**raw, "case_number": "2019구합77422," + ",".join(f"{i}(병합)" for i in range(100, 125))}
        with tempfile.TemporaryDirectory() as folder:
            db = MasterDB(str(Path(folder) / "master.db"))
            try:
                db.upsert_raw([raw])
                with self.assertRaises(ValueError):
                    db.upsert_raw([{**raw, "serial": "1"}, invalid])
                self.assertEqual(db.count(), 1)
                self.assertEqual(set(db.export_core()[0]), {"19Guh77422"})
            finally:
                db.close()

    def test_malformed_legacy_merged_row_blocks_export_instead_of_skipping(self):
        with tempfile.TemporaryDirectory() as folder:
            db = MasterDB(str(Path(folder) / "master.db"))
            try:
                db.conn.execute("INSERT INTO cases (serial,case_number,case_number_clean) VALUES (?,?,?)", ("420836", "2019구합77422,unknown", "2019구합77422,unknown"))
                db.conn.commit()
                with self.assertRaises(runner.PublicationStateError):
                    runner.export_split_db(db, folder)
                self.assertFalse((Path(folder) / "db.json").exists())
            finally:
                db.close()

    def test_single_and_merged_records_colliding_on_a_key_are_both_preserved(self):
        item = self.item()
        row = runner._precedent_case(item, "20200611", 1)
        with tempfile.TemporaryDirectory() as folder:
            db = MasterDB(str(Path(folder) / "master.db"))
            try:
                db.upsert_raw([row, {**row, "serial": "2", "case_number": "2019구합77439"}])
                records, _ = db.export_core()
                self.assertEqual({r[0] for r in records["19Guh77439"]}, {420836, 2})
                self.assertEqual(set(records), EXPECTED)
                db.upsert_raw([row])
                self.assertEqual(len(db.export_core()[0]["19Guh77439"]), 2)
            finally:
                db.close()

    def test_short_aliases_are_derived_from_the_same_exported_snapshot(self):
        from scripts.refresh_bundle_meta import derive_short_case_keys
        item = self.item()
        item.find("사건번호").text = "89두1,2(병합)"
        row = runner._precedent_case(item, "20200611", 1)
        with tempfile.TemporaryDirectory() as folder:
            db = MasterDB(str(Path(folder) / "master.db"))
            try:
                db.upsert_raw([row])
                cases, _ = db.export_core()
                self.assertEqual(derive_short_case_keys(cases, {"두": "Du"}), ["89Du1", "89Du2"])
            finally:
                db.close()

    def test_partial_update_cannot_silently_remove_known_merged_members(self):
        row = runner._precedent_case(self.item(), "20200611", 1)
        with tempfile.TemporaryDirectory() as folder:
            db = MasterDB(str(Path(folder) / "master.db"))
            try:
                db.upsert_raw([row])
                with self.assertRaises(ValueError):
                    db.upsert_raw([{**row, "case_number": "2019구합77422"}])
                self.assertEqual(set(db.export_core()[0]), EXPECTED)
                db.upsert_raw([{**row, "case_number": ""}])
                self.assertEqual(set(db.export_core()[0]), EXPECTED)
            finally:
                db.close()

    def test_inconsistent_raw_and_clean_legacy_fields_block_export(self):
        row = runner._precedent_case(self.item(), "20200611", 1)
        with tempfile.TemporaryDirectory() as folder:
            db = MasterDB(str(Path(folder) / "master.db"))
            try:
                db.upsert_raw([row])
                db.conn.execute("UPDATE cases SET case_number_clean='2019구합77422'")
                db.conn.commit()
                with self.assertRaises(ValueError):
                    db.export_core()
            finally:
                db.close()
