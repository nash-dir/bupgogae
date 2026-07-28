"""부분 수집/backlog/publication 차단 회귀 테스트."""

import json
import os
import tempfile
import unittest
from datetime import date
from unittest import mock

import crawler_runner


class FakeDB:
    def __init__(self):
        self.upserted = []

    def upsert_raw(self, rows):
        self.upserted.extend(rows)
        return len(rows), 0, 0


def one_case(serial):
    return [{
        "serial": serial,
        "case_name": "테스트",
        "case_number": f"2026다{serial}",
        "date": "20260101",
        "court": "대법원",
    }]


def precedent_xml(total, page, *, item_count=None):
    if item_count is None:
        item_count = max(0, min(100, total - ((page - 1) * 100)))
    first_serial = ((page - 1) * 100) + 1
    items = "".join(
        "<prec>"
        f"<판례일련번호>{serial}</판례일련번호>"
        f"<사건명>x</사건명><사건번호>2026다{serial}</사건번호>"
        "<선고일자>20260101</선고일자><법원명>대법원</법원명>"
        "</prec>"
        for serial in range(first_serial, first_serial + item_count)
    )
    return f"<PrecSearch><totalCnt>{total}</totalCnt>{items}</PrecSearch>".encode()


class RangeFetchTests(unittest.TestCase):
    def test_later_page_failure_discards_the_whole_date(self):
        with (
            mock.patch.object(
                crawler_runner,
                "fetch_xml_safe",
                side_effect=[precedent_xml(150, 1), None],
            ),
            mock.patch.object(crawler_runner.time, "sleep"),
        ):
            with self.assertRaises(crawler_runner.RangeFetchError) as caught:
                crawler_runner.fetch_cases_for_range("20260101")

        self.assertEqual(caught.exception.page, 2)
        self.assertEqual(caught.exception.reason, "request_failed")

    def test_error_xml_is_never_a_normal_zero_for_either_endpoint(self):
        for fetch_call in (
            lambda: crawler_runner.fetch_cases_for_range("20260101"),
            lambda: crawler_runner._fetch_detc_page(1),
        ):
            with self.subTest(fetch_call=fetch_call):
                with mock.patch.object(
                    crawler_runner, "fetch_xml_safe", return_value=b"<error/>"
                ):
                    with self.assertRaises(crawler_runner.RangeFetchError) as caught:
                        fetch_call()
                self.assertEqual(caught.exception.reason, "unexpected_xml_root")

        with mock.patch.object(
            crawler_runner,
            "fetch_xml_safe",
            return_value=(
                b"<PrecSearch><totalCnt>0</totalCnt><error/></PrecSearch>"
            ),
        ):
            with self.assertRaises(crawler_runner.RangeFetchError) as caught:
                crawler_runner.fetch_cases_for_range("20260101")
        self.assertEqual(caught.exception.reason, "api_error_envelope")

    def test_expected_roots_still_require_explicit_total_count(self):
        responses = (
            (b"<PrecSearch/>", lambda: crawler_runner.fetch_cases_for_range("20260101")),
            (b"<DetcSearch/>", lambda: crawler_runner._fetch_detc_page(1)),
        )
        for response, fetch_call in responses:
            with self.subTest(response=response):
                with mock.patch.object(
                    crawler_runner, "fetch_xml_safe", return_value=response
                ):
                    with self.assertRaises(crawler_runner.RangeFetchError) as caught:
                        fetch_call()
                self.assertEqual(caught.exception.reason, "missing_total_count")

    def test_explicit_zero_is_valid_for_both_endpoints(self):
        with mock.patch.object(
            crawler_runner,
            "fetch_xml_safe",
            return_value=b"<PrecSearch><totalCnt>0</totalCnt></PrecSearch>",
        ):
            self.assertEqual(crawler_runner.fetch_cases_for_range("20260101"), [])
        with mock.patch.object(
            crawler_runner,
            "fetch_xml_safe",
            return_value=b"<DetcSearch><totalCnt>0</totalCnt></DetcSearch>",
        ):
            self.assertEqual(crawler_runner._fetch_detc_page(1), [])

    def test_implausible_precedent_total_is_bounded_before_page_two(self):
        total = (crawler_runner.PRECEDENT_MAX_PAGES_PER_RANGE + 1) * 100
        first_page = precedent_xml(total, 1)
        with mock.patch.object(
            crawler_runner, "fetch_xml_safe", return_value=first_page
        ) as fetch:
            with self.assertRaises(crawler_runner.RangeFetchError) as caught:
                crawler_runner.fetch_cases_for_range("20260101~20261231")

        self.assertEqual(caught.exception.reason, "configured_page_limit_exceeded")
        fetch.assert_called_once()

    def test_partial_schema_item_fails_the_whole_range_before_upsert(self):
        partial = (
            "<PrecSearch><totalCnt>1</totalCnt><prec>"
            "<판례일련번호>1</판례일련번호><사건명>x</사건명>"
            "<선고일자>20260101</선고일자><법원명>대법원</법원명>"
            "</prec></PrecSearch>"
        ).encode()
        db = FakeDB()
        with mock.patch.object(
            crawler_runner, "fetch_xml_safe", return_value=partial
        ):
            result = crawler_runner.crawl_scan_ranges(
                db,
                [("20260101", "20260101")],
                sleep_fn=lambda: None,
            )

        self.assertEqual(db.upserted, [])
        self.assertEqual(result["errors"], 1)
        self.assertEqual(result["failed"][0]["last_error"], "missing_case_number")

    def test_precedent_date_must_be_real_and_inside_requested_range(self):
        invalid = precedent_xml(1, 1).replace(b"20260101", b"20260230")
        with mock.patch.object(
            crawler_runner, "fetch_xml_safe", return_value=invalid
        ):
            with self.assertRaises(crawler_runner.RangeFetchError) as caught:
                crawler_runner.fetch_cases_for_range("20260201~20260228")
        self.assertEqual(caught.exception.reason, "invalid_case_date")

    def test_detc_partial_schema_is_rejected(self):
        partial = (
            "<DetcSearch><totalCnt>1</totalCnt><Detc>"
            "<헌재결정례일련번호>1</헌재결정례일련번호>"
            "<종국일자>20260101</종국일자>"
            "</Detc></DetcSearch>"
        ).encode()
        with mock.patch.object(
            crawler_runner, "fetch_xml_safe", return_value=partial
        ):
            with self.assertRaises(crawler_runner.RangeFetchError) as caught:
                crawler_runner._fetch_detc_page(1)
        self.assertEqual(caught.exception.reason, "missing_case_number")


class BacklogLifecycleTests(unittest.TestCase):
    def test_full_bootstrap_resume_uses_only_authoritative_pending_work(self):
        prior = [
            {
                "start": "20200101",
                "end": "20201231",
                "attempts": 1,
                "failed_pages": [2],
                "last_error": "request_failed",
            },
            {
                "kind": "detc",
                "page": 7,
                "attempts": 1,
                "last_error": "request_failed",
            },
        ]
        ranges, pages, journal = crawler_runner.prepare_full_bootstrap_work(
            date(2026, 7, 20),
            prior,
            crawler_runner.BACKLOG_MODE_FULL_BOOTSTRAP,
        )

        self.assertEqual(ranges, [("20200101", "20201231")])
        self.assertEqual(pages, [7])
        self.assertEqual(journal, prior)

    def test_new_full_bootstrap_prejournals_every_source(self):
        with (
            mock.patch.object(
                crawler_runner,
                "get_full_bootstrap_ranges",
                return_value=[("19480815", "19481231"), ("19490101", "19491231")],
            ),
            mock.patch.object(crawler_runner, "DETC_MAX_PAGES", 2),
        ):
            ranges, pages, journal = crawler_runner.prepare_full_bootstrap_work(
                date(2026, 7, 20), [], None
            )

        self.assertEqual(len(journal), 4)
        self.assertEqual(ranges, [
            ("19480815", "19481231"),
            ("19490101", "19491231"),
        ])
        self.assertEqual(pages, [1, 2])

    def test_empty_full_bootstrap_marker_survives_until_final_validation(self):
        with tempfile.TemporaryDirectory() as data_dir:
            crawler_runner.save_failed_dates(
                data_dir,
                [],
                mode=crawler_runner.BACKLOG_MODE_FULL_BOOTSTRAP,
                retain_empty=True,
            )
            backlog, mode = crawler_runner.load_failed_dates_state(data_dir)
            self.assertEqual(backlog, [])
            self.assertEqual(mode, crawler_runner.BACKLOG_MODE_FULL_BOOTSTRAP)

            crawler_runner.save_failed_dates(
                data_dir,
                [],
                mode=mode,
                retain_empty=False,
            )
            self.assertFalse(
                os.path.exists(os.path.join(data_dir, "failed_dates.json"))
            )

    def test_empty_bootstrap_marker_reseeds_when_completed_baseline_is_invalid(self):
        with tempfile.TemporaryDirectory() as data_dir:
            db_path = os.path.join(data_dir, "master.db")
            db = crawler_runner.MasterDB(db_path)
            db.conn.executemany(
                "INSERT INTO cases "
                "(serial, case_name, case_number, case_number_clean, date, court) "
                "VALUES (?, 'x', ?, ?, ?, '대법원')",
                [
                    ("1", "1950다1", "1950다1", "19500101"),
                    ("2", "2025다2", "2025다2", "20250101"),
                ],
            )
            db.conn.commit()
            db.close()
            crawler_runner.save_failed_dates(
                data_dir,
                [],
                mode=crawler_runner.BACKLOG_MODE_FULL_BOOTSTRAP,
                retain_empty=True,
            )
            backlog, mode = crawler_runner.load_failed_dates_state(data_dir)

            with mock.patch.object(
                crawler_runner, "BASELINE_MIN_PRECEDENTS", 2
            ):
                resolved_mode = crawler_runner.resolve_full_bootstrap_resume_mode(
                    db_path, date(2026, 7, 20), backlog, mode
                )
            self.assertIsNone(resolved_mode)

            with (
                mock.patch.object(
                    crawler_runner,
                    "get_full_bootstrap_ranges",
                    return_value=[("19480815", "20260720")],
                ),
                mock.patch.object(crawler_runner, "DETC_MAX_PAGES", 2),
            ):
                ranges, pages, journal = crawler_runner.prepare_full_bootstrap_work(
                    date(2026, 7, 20), backlog, resolved_mode
                )

        self.assertEqual(ranges, [("19480815", "20260720")])
        self.assertEqual(pages, [1, 2])
        self.assertEqual(len(journal), 3)

    def test_first_request_hard_stop_has_already_journaled_all_ranges(self):
        dates = [
            ("20260101", "20260101"),
            ("20260102", "20260102"),
        ]
        snapshots = []

        def persist(items):
            snapshots.append([dict(item) for item in items])

        def terminate(_date_range):
            raise SystemExit(143)

        with self.assertRaises(SystemExit):
            crawler_runner.crawl_scan_ranges(
                FakeDB(),
                dates,
                fetcher=terminate,
                sleep_fn=lambda: None,
                persist_backlog=persist,
            )

        self.assertEqual(
            [(item["start"], item["end"]) for item in snapshots[0]], dates
        )
        self.assertTrue(
            all(item["attempts"] == 0 for item in snapshots[0])
        )

    def test_new_failure_is_atomic_before_an_abrupt_interruption(self):
        with tempfile.TemporaryDirectory() as data_dir:
            def persist(items):
                crawler_runner.save_failed_dates(data_dir, items)
                if any(
                    item.get("last_error") == "request_failed" for item in items
                ):
                    raise SystemExit(143)

            def fail(date_range):
                raise crawler_runner.RangeFetchError(
                    date_range, 2, "request_failed"
                )

            with self.assertRaises(SystemExit):
                crawler_runner.crawl_scan_ranges(
                    FakeDB(),
                    [("20260101", "20260101")],
                    fetcher=fail,
                    sleep_fn=lambda: None,
                    persist_backlog=persist,
                )

            reloaded = crawler_runner.load_failed_dates(data_dir)

        self.assertEqual(reloaded[0]["failed_pages"], [2])
        self.assertEqual(reloaded[0]["attempts"], 1)

    def test_one_of_three_failed_dates_is_retried_then_removed(self):
        dates = [
            ("20260101", "20260101"),
            ("20260102", "20260102"),
            ("20260103", "20260103"),
        ]

        def first_fetch(date_range):
            if date_range == "20260102":
                raise crawler_runner.RangeFetchError(
                    date_range, 2, "request_failed"
                )
            return one_case(date_range[-2:])

        first_db = FakeDB()
        result = crawler_runner.crawl_scan_ranges(
            first_db, dates, fetcher=first_fetch, sleep_fn=lambda: None
        )
        self.assertEqual(
            [(item["start"], item["end"]) for item in result["failed"]],
            [("20260102", "20260102")],
        )
        self.assertFalse(crawler_runner.publication_allowed(result["failed"]))
        self.assertEqual(len(first_db.upserted), 2)

        with tempfile.TemporaryDirectory() as data_dir:
            crawler_runner.save_failed_dates(data_dir, result["failed"])
            reloaded = crawler_runner.load_failed_dates(data_dir)
            merged = crawler_runner.merge_scan_ranges(
                [("20260103", "20260103")], reloaded
            )
            self.assertEqual(merged, [
                ("20260102", "20260102"),
                ("20260103", "20260103"),
            ])

            retry = crawler_runner.crawl_scan_ranges(
                FakeDB(),
                merged,
                prior_backlog=reloaded,
                fetcher=lambda date_range: one_case(date_range[-2:]),
                sleep_fn=lambda: None,
            )
            self.assertEqual(retry["failed"], [])
            crawler_runner.save_failed_dates(data_dir, retry["failed"])
            self.assertFalse(
                os.path.exists(os.path.join(data_dir, "failed_dates.json"))
            )

    def test_legacy_list_state_migrates_without_loss(self):
        with tempfile.TemporaryDirectory() as data_dir:
            path = os.path.join(data_dir, "failed_dates.json")
            with open(path, "w", encoding="utf-8") as stream:
                json.dump([{"start": "20250101", "end": "20250101"}], stream)

            backlog = crawler_runner.load_failed_dates(data_dir)

        self.assertEqual(backlog, [{
            "start": "20250101",
            "end": "20250101",
            "attempts": 0,
            "failed_pages": [],
            "last_error": "legacy_state",
        }])

    def test_corrupt_state_fails_closed_and_is_not_deleted(self):
        with tempfile.TemporaryDirectory() as data_dir:
            path = os.path.join(data_dir, "failed_dates.json")
            original = b'{"schema":2,"backlog":['
            with open(path, "wb") as stream:
                stream.write(original)

            with self.assertRaises(crawler_runner.BacklogStateError):
                crawler_runner.load_failed_dates(data_dir)

            with open(path, "rb") as stream:
                self.assertEqual(stream.read(), original)


class DetcBacklogTests(unittest.TestCase):
    def test_failed_page_is_durable_and_retried_before_schedule(self):
        prior = [{
            "kind": "detc",
            "page": 42,
            "attempts": 1,
            "last_error": "request_failed",
        }]
        pages = crawler_runner.merge_detc_pages([1], prior)
        self.assertEqual(pages, [42, 1])

        def first_fetch(page):
            if page == 42:
                raise crawler_runner.RangeFetchError("detc", page, "request_failed")
            return one_case(f"D{page}")

        first = crawler_runner.crawl_detc_scan(
            FakeDB(),
            pages,
            prior_backlog=prior,
            fetcher=first_fetch,
            sleep_fn=lambda: None,
        )
        self.assertEqual(
            [item["page"] for item in first["failed"] if item.get("kind") == "detc"],
            [42],
        )
        self.assertFalse(crawler_runner.publication_allowed(first["failed"]))

        retry = crawler_runner.crawl_detc_scan(
            FakeDB(),
            crawler_runner.merge_detc_pages([], first["failed"]),
            prior_backlog=first["failed"],
            fetcher=lambda page: one_case(f"D{page}"),
            sleep_fn=lambda: None,
        )
        self.assertEqual(retry["failed"], [])

    def test_first_request_hard_stop_journals_all_detc_pages(self):
        snapshots = []

        def terminate(_page):
            raise SystemExit(143)

        with self.assertRaises(SystemExit):
            crawler_runner.crawl_detc_scan(
                FakeDB(),
                [7, 8],
                fetcher=terminate,
                sleep_fn=lambda: None,
                persist_backlog=lambda items: snapshots.append(items),
            )

        self.assertEqual([item["page"] for item in snapshots[0]], [7, 8])
        self.assertTrue(all(item["attempts"] == 0 for item in snapshots[0]))


class PublicationGateTests(unittest.TestCase):
    def test_empty_baseline_requires_explicit_full_bootstrap(self):
        with tempfile.TemporaryDirectory() as data_dir:
            empty_path = os.path.join(data_dir, "master.db")
            open(empty_path, "wb").close()
            with self.assertRaises(crawler_runner.BaselineStateError):
                crawler_runner.require_healthy_baseline(
                    empty_path, date(2026, 7, 20)
                )

        ranges = crawler_runner.get_full_bootstrap_ranges(date(2026, 7, 20))
        self.assertEqual(ranges[0][0], "19480815")
        self.assertEqual(ranges[-1][1], "20260720")

    def test_structurally_valid_but_truncated_baseline_is_rejected(self):
        with tempfile.TemporaryDirectory() as data_dir:
            path = os.path.join(data_dir, "master.db")
            db = crawler_runner.MasterDB(path)
            db.conn.executemany(
                "INSERT INTO cases "
                "(serial, case_name, case_number, case_number_clean, date, court) "
                "VALUES (?, 'x', ?, ?, ?, '대법원')",
                [
                    ("1", "1950다1", "1950다1", "19500101"),
                    ("2", "2025다2", "2025다2", "20250101"),
                    ("D1", "2025헌1", "2025헌1", "20250101"),
                ],
            )
            db.conn.commit()
            db.close()

            with self.assertRaises(crawler_runner.BaselineStateError) as caught:
                crawler_runner.require_healthy_baseline(
                    path, date(2026, 7, 20), require_detc=True
                )
            self.assertEqual(
                str(caught.exception), "insufficient_precedent_count"
            )

            with mock.patch.object(
                crawler_runner, "BASELINE_MIN_PRECEDENTS", 2
            ):
                stats = crawler_runner.require_healthy_baseline(
                    path, date(2026, 7, 20), require_detc=True
                )
            self.assertEqual(stats["precedent_count"], 2)
            self.assertEqual(stats["detc_count"], 1)

    def test_export_rejects_core_below_client_minimum(self):
        db = mock.Mock()
        db.export_core.return_value = ({"2026다1": [[1, 1, 1, "x"]]}, 0)
        db.court_resolver.code_map = {"대법원": 1}
        with tempfile.TemporaryDirectory() as data_dir:
            with mock.patch.object(crawler_runner, "MIN_PUBLIC_CORE_KEYS", 2):
                with self.assertRaises(crawler_runner.PublicationStateError):
                    crawler_runner.export_split_db(db, data_dir)
            self.assertFalse(os.path.exists(os.path.join(data_dir, "db.json")))

    def test_pipeline_report_contains_only_classified_fields(self):
        with tempfile.TemporaryDirectory() as data_dir:
            path = crawler_runner.write_pipeline_report(
                data_dir,
                status="blocked",
                reason="partial_crawl",
                db_total=123,
                precedent_failed=2,
                detc_failed=1,
                circuit_broken=True,
            )
            with open(path, encoding="utf-8") as stream:
                payload = json.load(stream)

        self.assertEqual(payload["schema"], 1)
        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(set(payload), {
            "schema",
            "generated_at",
            "status",
            "reason",
            "db_total",
            "precedent_failed",
            "detc_failed",
            "circuit_broken",
        })

    def test_pipeline_report_does_not_serialize_unknown_error_text(self):
        with tempfile.TemporaryDirectory() as data_dir:
            path = crawler_runner.write_pipeline_report(
                data_dir,
                status="blocked",
                reason="OC=super-secret-key",
            )
            with open(path, encoding="utf-8") as stream:
                raw = stream.read()
                payload = json.loads(raw)
        self.assertNotIn("super-secret-key", raw)
        self.assertEqual(payload["reason"], "internal_failure")

    def test_local_manifest_is_built_without_r2_credentials(self):
        with tempfile.TemporaryDirectory() as data_dir:
            db_path = os.path.join(data_dir, "db.json")
            with open(db_path, "w", encoding="utf-8") as stream:
                json.dump({
                    "version": "20260720",
                    "total": 1,
                    "keys": 1,
                    "cases": {"26다1": [[1, 1, 1, "x"]]},
                    "court_code_map": {"대법원": 1},
                }, stream, ensure_ascii=False)

            with mock.patch.dict(os.environ, {}, clear=True):
                manifest_path = crawler_runner.write_local_manifest(
                    data_dir, min_core_keys=1
                )

            with open(manifest_path, encoding="utf-8") as stream:
                manifest = json.load(stream)
        self.assertEqual(manifest["core"]["total"], 1)

    def test_gzip_output_is_deterministic_for_content_addressing(self):
        payload = {"version": "20260720", "cases": {"26Da1": [[1, 1, 1, "x"]]}}
        with tempfile.TemporaryDirectory() as data_dir:
            first = os.path.join(data_dir, "first.json")
            second = os.path.join(data_dir, "second.json")
            crawler_runner._write_gzipped_json(payload, first)
            crawler_runner._write_gzipped_json(payload, second)
            with open(first + ".gz", "rb") as stream:
                first_bytes = stream.read()
            with open(second + ".gz", "rb") as stream:
                second_bytes = stream.read()

        self.assertEqual(first_bytes, second_bytes)
        self.assertEqual(first_bytes[4:8], b"\x00\x00\x00\x00")

    def test_master_db_closes_on_unexpected_crawl_exception(self):
        fake_db = mock.Mock()
        fake_db.count.return_value = crawler_runner.BASELINE_MIN_PRECEDENTS
        fake_db.conn.execute.return_value.fetchone.return_value = (1,)
        with (
            tempfile.TemporaryDirectory() as data_dir,
            mock.patch.object(crawler_runner, "MasterDB", return_value=fake_db),
            mock.patch.object(crawler_runner, "save_failed_dates"),
            mock.patch.object(
                crawler_runner,
                "crawl_scan_ranges",
                side_effect=RuntimeError("classified test failure"),
            ),
        ):
            with self.assertRaises(RuntimeError):
                crawler_runner.execute_local_crawl(
                    master_db_path=os.path.join(data_dir, "master.db"),
                    data_dir=data_dir,
                    today=date(2026, 7, 20),
                    scan_ranges=[("20260101", "20260101")],
                    detc_pages=[1],
                    prior_backlog=[],
                    full_bootstrap=False,
                )
        fake_db.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
