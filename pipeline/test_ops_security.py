"""운영 보안/상태 원자성 회귀 테스트."""

from io import BytesIO
from datetime import date
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import unittest
from unittest import mock

from botocore.exceptions import ClientError
import requests

import api
import publish_outputs
import sync_state


def _missing(operation="GetObject"):
    return ClientError(
        {"Error": {"Code": "NoSuchKey", "Message": "missing"}},
        operation,
    )


class MemoryR2:
    def __init__(self):
        self.objects = {}
        self.operations = []
        self.fail_pointer = False

    def upload_file(self, path, bucket, key, ExtraArgs=None):
        del bucket, ExtraArgs
        with open(path, "rb") as stream:
            self.objects[key] = stream.read()
        self.operations.append(("upload", key))

    def put_object(self, Bucket, Key, Body, **kwargs):
        del Bucket, kwargs
        if self.fail_pointer and Key == sync_state.STATE_POINTER_KEY:
            raise RuntimeError("pointer write failed")
        self.objects[Key] = bytes(Body)
        self.operations.append(("put", Key))

    def get_object(self, Bucket, Key):
        del Bucket
        if Key not in self.objects:
            raise _missing()
        return {"Body": BytesIO(self.objects[Key])}

    def head_object(self, Bucket, Key):
        del Bucket
        if Key not in self.objects:
            raise _missing("HeadObject")
        return {"ContentLength": len(self.objects[Key])}

    def download_file(self, bucket, key, path):
        del bucket
        if key not in self.objects:
            raise _missing("DownloadFile")
        with open(path, "wb") as stream:
            stream.write(self.objects[key])


def _create_master(path, row_value="committed-in-wal"):
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """CREATE TABLE cases (
            serial TEXT PRIMARY KEY,
            case_name TEXT,
            case_number TEXT,
            case_number_clean TEXT,
            date TEXT,
            court TEXT,
            inserted_at TEXT
        )"""
    )
    conn.commit()
    conn.execute(
        """INSERT INTO cases(
            serial, case_name, case_number, case_number_clean, date, court
        ) VALUES (?, ?, ?, ?, ?, ?)""",
        ("1", row_value, "2026다1", "2026다1", "20260720", "대법원"),
    )
    conn.commit()
    return conn


def _replace_master_rows(conn, precedent_count, *, include_detc=True):
    """운영 health 경계를 실제 SQLite 집계로 검증할 테스트 fixture."""
    conn.execute("DELETE FROM cases")
    recent_date = f"{date.today().year}0101"

    def rows():
        for index in range(1, precedent_count + 1):
            case_date = "19500101" if index == 1 else recent_date
            yield (
                str(index),
                "테스트",
                f"{date.today().year}다{index}",
                f"{date.today().year}다{index}",
                case_date,
                "대법원",
            )

    conn.executemany(
        """INSERT INTO cases(
            serial, case_name, case_number, case_number_clean, date, court
        ) VALUES (?, ?, ?, ?, ?, ?)""",
        rows(),
    )
    if include_detc:
        conn.execute(
            """INSERT INTO cases(
                serial, case_name, case_number, case_number_clean, date, court
            ) VALUES (?, ?, ?, ?, ?, ?)""",
            (
                "D1",
                "헌재 테스트",
                "2026헌마1",
                "2026헌마1",
                recent_date,
                "헌법재판소",
            ),
        )
    conn.commit()


def _pointer_payload(*, master_size=1, backlog=None):
    generation = "20260720T123456123456Z-" + ("a" * 32)
    prefix = f"{sync_state.STATE_GENERATION_PREFIX}/{generation}"
    return {
        "schema": sync_state.STATE_SCHEMA,
        "generation": generation,
        "master": {
            "key": f"{prefix}/master.db",
            "size": master_size,
            "sha256": "0" * 64,
        },
        "backlog": backlog,
    }


def _response(status, body=b""):
    response = mock.Mock(status_code=status, headers={})
    response.iter_content.return_value = [body] if body else []
    return response


class ApiRetrySecurityTests(unittest.TestCase):
    def setUp(self):
        api.reset_network_stats()

    def test_encoded_api_key_and_exception_url_are_never_logged(self):
        secret = "foo+bar@example.com"
        encoded = "foo%2Bbar%40example.com"
        error = requests.exceptions.ConnectionError(
            "GET https://www.law.go.kr/?OC=" + encoded
        )
        session = mock.Mock()
        session.get.side_effect = [error] * api.MAX_ATTEMPTS

        with (
            mock.patch.object(api, "API_KEY", secret),
            mock.patch.object(api, "_get_session", return_value=session),
            mock.patch.object(api.time, "sleep") as sleep,
            self.assertLogs(api.log.name, level="WARNING") as captured,
        ):
            self.assertIsNone(api.fetch_xml_safe(date_str="20260101"))

        logs = "\n".join(captured.output)
        self.assertNotIn(secret, logs)
        self.assertNotIn(encoded, logs)
        self.assertNotIn("law.go.kr", logs)
        self.assertNotIn("OC=", logs)
        self.assertEqual(sleep.call_count, api.MAX_ATTEMPTS - 1)
        self.assertEqual(session.get.call_count, api.MAX_ATTEMPTS)
        self.assertEqual(
            api.get_network_stats(),
            {
                "requests": 1,
                "attempts": api.MAX_ATTEMPTS,
                "success": 0,
                "retries": api.MAX_ATTEMPTS - 1,
                "failures": 1,
            },
        )

    def test_telemetry_counts_logical_and_physical_requests(self):
        session = mock.Mock()
        session.get.side_effect = [
            _response(503),
            _response(429),
            _response(200, b"<ok/>")
        ]
        with (
            mock.patch.object(api, "_get_session", return_value=session),
            mock.patch.object(api.time, "sleep") as sleep,
        ):
            self.assertEqual(api.fetch_xml_safe(), b"<ok/>")

        self.assertEqual(sleep.call_args_list, [mock.call(5), mock.call(10)])
        self.assertEqual(
            api.get_network_stats(),
            {
                "requests": 1,
                "attempts": 3,
                "success": 1,
                "retries": 2,
                "failures": 0,
            },
        )

    def test_session_disables_transport_level_retries(self):
        with mock.patch.object(api, "_session", None):
            session = api._get_session()
        self.assertEqual(session.get_adapter("https://").max_retries.total, 0)
        session.close()

    def test_non_retryable_4xx_fails_after_one_physical_request(self):
        session = mock.Mock()
        session.get.return_value = _response(401)
        with (
            mock.patch.object(api, "_get_session", return_value=session),
            mock.patch.object(api.time, "sleep") as sleep,
        ):
            self.assertIsNone(api.fetch_xml_safe())

        session.get.assert_called_once()
        sleep.assert_not_called()
        self.assertEqual(
            api.get_network_stats(),
            {
                "requests": 1,
                "attempts": 1,
                "success": 0,
                "retries": 0,
                "failures": 1,
            },
        )

    def test_oversized_response_is_non_retryable_and_closed(self):
        response = _response(200)
        response.headers = {"Content-Length": str(api.MAX_XML_BYTES + 1)}
        session = mock.Mock()
        session.get.return_value = response
        with (
            mock.patch.object(api, "_get_session", return_value=session),
            mock.patch.object(api.time, "sleep") as sleep,
        ):
            self.assertIsNone(api.fetch_xml_safe())

        session.get.assert_called_once()
        response.iter_content.assert_not_called()
        response.close.assert_called_once()
        sleep.assert_not_called()
        self.assertEqual(api.get_network_stats()["failures"], 1)

    def test_streamed_response_enforces_decoded_size_limit(self):
        response = _response(200)
        response.iter_content.return_value = [b"1234", b"5"]
        session = mock.Mock()
        session.get.return_value = response
        with (
            mock.patch.object(api, "MAX_XML_BYTES", 4),
            mock.patch.object(api, "_get_session", return_value=session),
            mock.patch.object(api.time, "sleep") as sleep,
        ):
            self.assertIsNone(api.fetch_xml_safe())

        response.close.assert_called_once()
        sleep.assert_not_called()


class AtomicStateSyncTests(unittest.TestCase):
    def test_empty_schema_valid_state_is_rejected_before_r2_access(self):
        client_factory = mock.Mock(return_value=MemoryR2())
        with tempfile.TemporaryDirectory() as data_dir:
            conn = _create_master(os.path.join(data_dir, "master.db"))
            conn.execute("DELETE FROM cases")
            conn.commit()
            conn.close()

            with (
                mock.patch.object(
                    sync_state, "get_r2_client", client_factory
                ),
                mock.patch.dict(os.environ, {"R2_BUCKET": "bucket"}),
                self.assertRaises(SystemExit),
            ):
                sync_state.upload_state(data_dir)

        client_factory.assert_not_called()

    def test_99999_precedents_are_rejected_at_upload_health_boundary(self):
        client_factory = mock.Mock(return_value=MemoryR2())
        with tempfile.TemporaryDirectory() as data_dir:
            path = os.path.join(data_dir, "master.db")
            conn = _create_master(path)
            _replace_master_rows(conn, 99_999)
            conn.close()

            with (
                mock.patch.object(
                    sync_state, "get_r2_client", client_factory
                ),
                mock.patch.dict(os.environ, {"R2_BUCKET": "bucket"}),
                self.assertRaises(SystemExit),
            ):
                sync_state.upload_state(data_dir)

            conn = sqlite3.connect(path)
            conn.execute(
                """INSERT INTO cases(
                    serial, case_name, case_number, case_number_clean,
                    date, court
                ) VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    "100000",
                    "경계 테스트",
                    "2026다100000",
                    "2026다100000",
                    f"{date.today().year}0101",
                    "대법원",
                ),
            )
            conn.commit()
            conn.close()
            health = sync_state._verify_incremental_health(path)

        client_factory.assert_not_called()
        self.assertEqual(health["precedent_count"], 100_000)
        self.assertEqual(health["detc_count"], 1)

    def test_explicit_partial_bootstrap_upload_accepts_unhealthy_state(self):
        client = MemoryR2()
        with tempfile.TemporaryDirectory() as data_dir:
            conn = _create_master(os.path.join(data_dir, "master.db"))
            conn.close()
            with (
                mock.patch.object(
                    sync_state, "get_r2_client", return_value=client
                ),
                mock.patch.dict(os.environ, {"R2_BUCKET": "bucket"}),
            ):
                sync_state.upload_state(
                    data_dir, allow_partial_bootstrap=True
                )

        self.assertIn(sync_state.STATE_POINTER_KEY, client.objects)

    def test_full_bootstrap_artifact_mode_does_not_bypass_default_gate(self):
        client_factory = mock.Mock(return_value=MemoryR2())
        with tempfile.TemporaryDirectory() as data_dir:
            conn = _create_master(os.path.join(data_dir, "master.db"))
            conn.close()
            with open(
                os.path.join(data_dir, sync_state.STATE_MODE_FILE),
                "w",
                encoding="utf-8",
            ) as stream:
                json.dump({"schema": 1, "mode": "full-bootstrap"}, stream)

            with (
                mock.patch.object(
                    sync_state, "get_r2_client", client_factory
                ),
                mock.patch.dict(os.environ, {"R2_BUCKET": "bucket"}),
                self.assertRaises(SystemExit),
            ):
                sync_state.upload_state(data_dir)

        client_factory.assert_not_called()

    def test_upload_and_download_use_verified_generation_pair(self):
        client = MemoryR2()
        with tempfile.TemporaryDirectory() as source_dir:
            master_path = os.path.join(source_dir, "master.db")
            live_conn = _create_master(master_path)
            backlog_path = os.path.join(source_dir, "failed_dates.json")
            with open(backlog_path, "w", encoding="utf-8") as stream:
                json.dump({"schema": 2, "backlog": []}, stream)

            with (
                mock.patch.object(sync_state, "get_r2_client", return_value=client),
                mock.patch.dict(os.environ, {"R2_BUCKET": "bucket"}),
            ):
                sync_state.upload_state(
                    source_dir, allow_partial_bootstrap=True
                )

            live_conn.close()
            pointer = json.loads(
                client.objects[sync_state.STATE_POINTER_KEY].decode("utf-8")
            )
            self.assertEqual(client.operations[-1], (
                "put", sync_state.STATE_POINTER_KEY
            ))
            self.assertIsNotNone(pointer["backlog"])
            self.assertIn(pointer["master"]["key"], client.objects)
            self.assertIn(pointer["backlog"]["key"], client.objects)
            self.assertFalse(any(
                name.startswith(".master-state-")
                for name in os.listdir(source_dir)
            ))

            with tempfile.TemporaryDirectory() as download_dir:
                with (
                    mock.patch.object(
                        sync_state, "get_r2_client", return_value=client
                    ),
                    mock.patch.dict(os.environ, {"R2_BUCKET": "bucket"}),
                ):
                    sync_state.download_state(download_dir)

                conn = sqlite3.connect(os.path.join(download_dir, "master.db"))
                try:
                    row = conn.execute("SELECT case_name FROM cases").fetchone()
                finally:
                    conn.close()
                self.assertEqual(row, ("committed-in-wal",))
                self.assertTrue(os.path.exists(
                    os.path.join(download_dir, "failed_dates.json")
                ))

    def test_pointer_failure_keeps_previous_generation_and_cleans_snapshot(self):
        client = MemoryR2()
        prior_pointer = json.dumps(_pointer_payload()).encode("utf-8")
        client.objects[sync_state.STATE_POINTER_KEY] = prior_pointer
        client.fail_pointer = True
        with tempfile.TemporaryDirectory() as data_dir:
            conn = _create_master(os.path.join(data_dir, "master.db"))
            conn.close()
            with (
                mock.patch.object(sync_state, "get_r2_client", return_value=client),
                mock.patch.dict(os.environ, {"R2_BUCKET": "bucket"}),
                self.assertRaises(SystemExit),
            ):
                sync_state.upload_state(
                    data_dir, allow_partial_bootstrap=True
                )

            self.assertEqual(
                client.objects[sync_state.STATE_POINTER_KEY], prior_pointer
            )
            self.assertFalse(any(
                name.startswith(".master-state-")
                for name in os.listdir(data_dir)
            ))

    def test_snapshot_failure_fails_closed_before_r2_access(self):
        with tempfile.TemporaryDirectory() as data_dir:
            conn = _create_master(os.path.join(data_dir, "master.db"))
            conn.close()
            get_client = mock.Mock()
            with (
                mock.patch.object(
                    sync_state,
                    "_create_verified_snapshot",
                    side_effect=sqlite3.DatabaseError("checkpoint/backup failed"),
                ),
                mock.patch.object(sync_state, "get_r2_client", get_client),
                mock.patch.dict(os.environ, {"R2_BUCKET": "bucket"}),
                self.assertRaises(SystemExit),
            ):
                sync_state.upload_state(
                    data_dir, allow_partial_bootstrap=True
                )
            get_client.assert_not_called()

    def test_wrong_cases_schema_is_rejected(self):
        with tempfile.TemporaryDirectory() as data_dir:
            path = os.path.join(data_dir, "master.db")
            conn = sqlite3.connect(path)
            conn.execute("CREATE TABLE cases (value TEXT)")
            conn.commit()
            conn.close()
            with self.assertRaises(sqlite3.DatabaseError):
                sync_state._verify_sqlite(path)

    def test_pointer_rejects_oversized_master_before_download(self):
        pointer = _pointer_payload(
            master_size=sync_state.MAX_MASTER_STATE_BYTES + 1
        )
        with self.assertRaisesRegex(ValueError, "invalid state size"):
            sync_state._validate_pointer(pointer)

    def test_pointer_body_is_closed_after_bounded_read(self):
        body = BytesIO(json.dumps(_pointer_payload()).encode("utf-8"))
        client = mock.Mock()
        client.get_object.return_value = {"Body": body}
        sync_state._read_pointer(client, "bucket")
        self.assertTrue(body.closed)

    def test_remote_content_length_mismatch_prevents_download(self):
        client = MemoryR2()
        key = "bupgogae/state/generations/x/master.db"
        client.objects[key] = b"abc"
        descriptor = {"key": key, "size": 2, "sha256": "0" * 64}
        with tempfile.TemporaryDirectory() as data_dir:
            with self.assertRaisesRegex(ValueError, "remote size mismatch"):
                sync_state._download_to_temp(
                    client, "bucket", descriptor, data_dir, ".db"
                )
            self.assertFalse(any(
                name.startswith(".state-download-")
                for name in os.listdir(data_dir)
            ))

    def test_backlog_attempt_and_page_bounds_fail_closed(self):
        with tempfile.TemporaryDirectory() as data_dir:
            path = os.path.join(data_dir, "failed_dates.json")
            with open(path, "w", encoding="utf-8") as stream:
                json.dump({
                    "schema": 2,
                    "backlog": [{
                        "kind": "detc",
                        "page": sync_state.MAX_BACKLOG_PAGE + 1,
                        "attempts": sync_state.MAX_BACKLOG_ATTEMPTS + 1,
                        "last_error": "bounded",
                    }],
                }, stream)
            with self.assertRaisesRegex(ValueError, "invalid backlog item"):
                sync_state._verify_backlog(path)

    def test_malformed_schema2_backlog_blocks_generation_commit(self):
        client = MemoryR2()
        with tempfile.TemporaryDirectory() as data_dir:
            conn = _create_master(os.path.join(data_dir, "master.db"))
            conn.close()
            with open(
                os.path.join(data_dir, "failed_dates.json"),
                "w",
                encoding="utf-8",
            ) as stream:
                json.dump({
                    "schema": 2,
                    "backlog": [{"start": "20260720", "end": "20260720"}],
                }, stream)
            with (
                mock.patch.object(sync_state, "get_r2_client", return_value=client),
                mock.patch.dict(os.environ, {"R2_BUCKET": "bucket"}),
                self.assertRaises(SystemExit),
            ):
                sync_state.upload_state(
                    data_dir, allow_partial_bootstrap=True
                )
            self.assertNotIn(sync_state.STATE_POINTER_KEY, client.objects)

    def test_schema2_backlog_rejects_unknown_resume_mode(self):
        with tempfile.TemporaryDirectory() as data_dir:
            path = os.path.join(data_dir, "failed_dates.json")
            with open(path, "w", encoding="utf-8") as stream:
                json.dump({
                    "schema": 2,
                    "mode": "skip_all_work",
                    "backlog": [],
                }, stream)
            with self.assertRaisesRegex(ValueError, "unsupported backlog mode"):
                sync_state._verify_backlog(path)

    def test_missing_baseline_requires_explicit_bootstrap(self):
        client = MemoryR2()
        with tempfile.TemporaryDirectory() as data_dir:
            with (
                mock.patch.object(sync_state, "get_r2_client", return_value=client),
                mock.patch.dict(os.environ, {"R2_BUCKET": "bucket"}),
                self.assertRaises(SystemExit),
            ):
                sync_state.download_state(data_dir)

            with (
                mock.patch.object(sync_state, "get_r2_client", return_value=client),
                mock.patch.dict(os.environ, {"R2_BUCKET": "bucket"}),
            ):
                sync_state.download_state(
                    data_dir, allow_empty_bootstrap=True
                )
            self.assertFalse(os.path.exists(os.path.join(data_dir, "master.db")))
            with open(
                os.path.join(data_dir, sync_state.STATE_MODE_FILE),
                encoding="utf-8",
            ) as stream:
                mode = json.load(stream)
            self.assertEqual(mode, {"schema": 1, "mode": "full-bootstrap"})

    def test_null_backlog_pointer_removes_stale_local_backlog(self):
        client = MemoryR2()
        with tempfile.TemporaryDirectory() as source_dir:
            conn = _create_master(os.path.join(source_dir, "master.db"))
            conn.close()
            with (
                mock.patch.object(sync_state, "get_r2_client", return_value=client),
                mock.patch.dict(os.environ, {"R2_BUCKET": "bucket"}),
            ):
                sync_state.upload_state(
                    source_dir, allow_partial_bootstrap=True
                )

        with tempfile.TemporaryDirectory() as download_dir:
            stale = os.path.join(download_dir, "failed_dates.json")
            with open(stale, "w", encoding="utf-8") as stream:
                stream.write("{}")
            with (
                mock.patch.object(sync_state, "get_r2_client", return_value=client),
                mock.patch.dict(os.environ, {"R2_BUCKET": "bucket"}),
            ):
                sync_state.download_state(download_dir)
            self.assertFalse(os.path.exists(stale))


class PublishOutputTests(unittest.TestCase):
    _RAW = b'{"version":"20260720","payload":"test"}'

    def _publish_with_store(self, data_dir, *, fail_key=None):
        raw_path = os.path.join(data_dir, "db.json")
        gzip_path = os.path.join(data_dir, "db.json.gz")
        with open(raw_path, "wb") as stream:
            stream.write(self._RAW)
        with gzip.open(gzip_path, "wb") as stream:
            stream.write(self._RAW)

        sha256 = hashlib.sha256(self._RAW).hexdigest()
        object_key = f"bupgogae/objects/{sha256}.json.gz"
        old_fixed = b"old-fixed-last-known-good"
        old_manifest = b"old-manifest-last-known-good"
        store = {
            publish_outputs.R2_KEY: old_fixed,
            publish_outputs.MANIFEST_R2_KEY: old_manifest,
        }
        operations = []

        def fake_upload(path, *, r2_key=None, **kwargs):
            del kwargs
            key = r2_key or publish_outputs.R2_KEY
            operations.append(key)
            if key == fail_key:
                raise RuntimeError("injected upload failure")
            with open(path, "rb") as stream:
                store[key] = stream.read()

        manifest = {
            "schema": 1,
            "core": {
                "version": "20260720",
                "sha256": sha256,
                "total": 1,
                "bytes_raw": len(self._RAW),
            },
        }
        with (
            mock.patch.object(publish_outputs, "_validate_public_payload"),
            mock.patch.object(
                publish_outputs, "build_manifest", return_value=manifest
            ),
            mock.patch.object(
                publish_outputs, "upload_db_to_r2", side_effect=fake_upload
            ),
        ):
            if fail_key is None:
                publish_outputs.publish_outputs(data_dir)
            else:
                with self.assertRaisesRegex(RuntimeError, "injected"):
                    publish_outputs.publish_outputs(data_dir)

        with open(gzip_path, "rb") as stream:
            gzip_bytes = stream.read()
        return {
            "store": store,
            "operations": operations,
            "object_key": object_key,
            "old_fixed": old_fixed,
            "old_manifest": old_manifest,
            "gzip_bytes": gzip_bytes,
        }

    def test_mismatched_gzip_is_rejected_before_upload(self):
        with tempfile.TemporaryDirectory() as data_dir:
            raw_path = os.path.join(data_dir, "db.json")
            gzip_path = os.path.join(data_dir, "db.json.gz")
            with open(raw_path, "wb") as stream:
                stream.write(b'{"version":"20260720","cases":{}}')
            with gzip.open(gzip_path, "wb") as stream:
                stream.write(b"different")
            with mock.patch.object(publish_outputs, "upload_db_to_r2") as upload:
                with self.assertRaises(ValueError):
                    publish_outputs.publish_outputs(data_dir)
            upload.assert_not_called()

    def test_gzip_decoding_stops_at_raw_size_limit(self):
        with tempfile.TemporaryDirectory() as data_dir:
            raw_path = os.path.join(data_dir, "db.json")
            gzip_path = os.path.join(data_dir, "db.json.gz")
            with open(raw_path, "wb") as stream:
                stream.write(b"small")
            with gzip.open(gzip_path, "wb") as stream:
                stream.write(b"x" * 128)
            with (
                mock.patch.object(publish_outputs, "MAX_RAW_BYTES", 32),
                self.assertRaisesRegex(ValueError, "decoded size limit"),
            ):
                publish_outputs._verify_gzip_matches(raw_path, gzip_path)

    def test_public_payload_rejects_unknown_court_code(self):
        payload = {
            "cases": {"26Da1": [[1, 99, 260720, "테스트"]]},
            "total": 1,
            "keys": 1,
            "court_code_map": {"대법원": 1},
        }
        with (
            mock.patch.object(
                publish_outputs, "validate_payload", return_value=payload
            ),
            self.assertRaisesRegex(ValueError, "unknown court code"),
        ):
            publish_outputs._validate_public_payload(b"ignored")

    def test_pipeline_report_accepts_only_classified_reason(self):
        with tempfile.TemporaryDirectory() as data_dir:
            path = os.path.join(data_dir, "pipeline-report.json")
            report = {
                "schema": 1,
                "status": "blocked",
                "reason": "partial_crawl",
                "db_total": 100_000,
                "precedent_failed": 1,
                "detc_failed": 2,
                "circuit_broken": False,
            }
            with open(path, "w", encoding="utf-8") as stream:
                json.dump(report, stream)
            self.assertEqual(
                publish_outputs._load_pipeline_report(data_dir), report
            )

            report["reason"] = "https://example.test/?token=secret"
            with open(path, "w", encoding="utf-8") as stream:
                json.dump(report, stream)
            self.assertIsNone(publish_outputs._load_pipeline_report(data_dir))

    def test_publish_cli_does_not_invoke_telegram_notifier(self):
        with (
            mock.patch.object(
                publish_outputs.sys,
                "argv",
                ["publish_outputs.py", "--dir", "artifact-dir"],
            ),
            mock.patch.object(publish_outputs, "publish_outputs") as publish,
            mock.patch.object(
                publish_outputs, "send_notification"
            ) as notify,
        ):
            publish_outputs.main()

        publish.assert_called_once_with("artifact-dir")
        notify.assert_not_called()

    def test_success_notification_cli_does_not_invoke_r2_publisher(self):
        with (
            mock.patch.object(
                publish_outputs.sys,
                "argv",
                [
                    "publish_outputs.py",
                    "--notify-success",
                    "--dir",
                    "artifact-dir",
                ],
            ),
            mock.patch.object(publish_outputs, "publish_outputs") as publish,
            mock.patch.object(
                publish_outputs, "send_notification"
            ) as notify,
        ):
            publish_outputs.main()

        notify.assert_called_once_with("success", "artifact-dir")
        publish.assert_not_called()

    def test_success_commits_immutable_then_manifest_then_fixed_mirror(self):
        with tempfile.TemporaryDirectory() as data_dir:
            result = self._publish_with_store(data_dir)

        self.assertEqual(result["operations"], [
            result["object_key"],
            publish_outputs.MANIFEST_R2_KEY,
            publish_outputs.R2_KEY,
        ])
        self.assertEqual(
            result["store"][result["object_key"]], result["gzip_bytes"]
        )
        manifest = json.loads(
            result["store"][publish_outputs.MANIFEST_R2_KEY]
        )
        self.assertEqual(
            manifest["core"]["object_path"],
            result["object_key"].removeprefix("bupgogae/"),
        )
        self.assertEqual(
            result["store"][publish_outputs.R2_KEY], result["gzip_bytes"]
        )

    def test_immutable_upload_failure_preserves_manifest_and_fixed_lkg(self):
        with tempfile.TemporaryDirectory() as data_dir:
            sha256 = hashlib.sha256(self._RAW).hexdigest()
            result = self._publish_with_store(
                data_dir,
                fail_key=f"bupgogae/objects/{sha256}.json.gz",
            )

        self.assertEqual(result["operations"], [result["object_key"]])
        self.assertNotIn(result["object_key"], result["store"])
        self.assertEqual(
            result["store"][publish_outputs.MANIFEST_R2_KEY],
            result["old_manifest"],
        )
        self.assertEqual(
            result["store"][publish_outputs.R2_KEY], result["old_fixed"]
        )

    def test_manifest_upload_failure_preserves_fixed_lkg(self):
        with tempfile.TemporaryDirectory() as data_dir:
            result = self._publish_with_store(
                data_dir, fail_key=publish_outputs.MANIFEST_R2_KEY
            )

        self.assertEqual(result["operations"], [
            result["object_key"], publish_outputs.MANIFEST_R2_KEY
        ])
        self.assertIn(result["object_key"], result["store"])
        self.assertEqual(
            result["store"][publish_outputs.MANIFEST_R2_KEY],
            result["old_manifest"],
        )
        self.assertEqual(
            result["store"][publish_outputs.R2_KEY], result["old_fixed"]
        )

    def test_fixed_mirror_failure_keeps_committed_immutable_generation(self):
        with tempfile.TemporaryDirectory() as data_dir:
            result = self._publish_with_store(
                data_dir, fail_key=publish_outputs.R2_KEY
            )

        self.assertEqual(result["operations"], [
            result["object_key"],
            publish_outputs.MANIFEST_R2_KEY,
            publish_outputs.R2_KEY,
        ])
        manifest = json.loads(
            result["store"][publish_outputs.MANIFEST_R2_KEY]
        )
        self.assertEqual(
            manifest["core"]["object_path"],
            result["object_key"].removeprefix("bupgogae/"),
        )
        self.assertEqual(
            result["store"][result["object_key"]], result["gzip_bytes"]
        )
        self.assertEqual(
            result["store"][publish_outputs.R2_KEY], result["old_fixed"]
        )


class DeploymentSecurityTests(unittest.TestCase):
    REPO_ROOT = Path(__file__).resolve().parents[1]

    def test_crawl_job_has_no_marketplace_action_or_publish_secrets(self):
        workflow = (
            self.REPO_ROOT / ".github/workflows/daily-pipeline.yml"
        ).read_text(encoding="utf-8")
        crawl_section = workflow.split("\n  crawl:\n", 1)[1].split(
            "\n  finalize:\n", 1
        )[0]
        action_refs = re.findall(r"^\s*uses:\s*(\S+)", crawl_section, re.M)

        self.assertTrue(action_refs)
        self.assertTrue(all(ref.startswith("actions/") for ref in action_refs))
        self.assertNotIn("warp-on-actions", crawl_section)
        secret_names = set(
            re.findall(r"secrets\.([A-Z0-9_]+)", crawl_section)
        )
        self.assertEqual(secret_names, {"BUPGOGAE_API_KEY"})
        self.assertNotIn("WARP_PRIVATE_KEY", workflow)
        self.assertLess(
            crawl_section.index("bash .github/scripts/connect-warp.sh"),
            crawl_section.index("BUPGOGAE_API_KEY"),
        )
        warp_step = crawl_section.split(
            "- name: 공식 Cloudflare WARP Client 연결", 1
        )[1].split("- name: 크롤러 실행", 1)[0]
        self.assertIn(
            "vars.CLOUDFLARE_WARP_TOS_ACCEPTED",
            warp_step,
        )
        self.assertNotRegex(warp_step, r"\${{\s*secrets\.")
        self.assertNotIn("BUPGOGAE_API_KEY", warp_step)
        self.assertLess(
            crawl_section.index("명시적 full historical bootstrap 실행"),
            crawl_section.index("WARP 연결 및 ephemeral 등록 정리"),
        )
        self.assertLess(
            crawl_section.index("WARP 연결 및 ephemeral 등록 정리"),
            crawl_section.index("재개 state 전달"),
        )

        warp_script = (
            self.REPO_ROOT / ".github/scripts/connect-warp.sh"
        ).read_text(encoding="utf-8")
        self.assertNotIn("${{", warp_script)
        self.assertNotIn("curl | bash", warp_script)
        for forbidden in (
            "WARP_PRIVATE_KEY",
            "wg-quick",
            "wireguard-tools",
            "/etc/wireguard",
            "[Interface]",
            "PrivateKey",
            "engage.cloudflareclient.com",
        ):
            self.assertNotIn(forbidden, warp_script)
        self.assertIn("CLOUDFLARE_WARP_TOS_ACCEPTED", warp_script)
        self.assertIn(
            'WARP_PACKAGE_VERSION="2026.6.880.0"',
            warp_script,
        )
        self.assertIn(
            "pkg.cloudflareclient.com/pool/noble/main/c/cloudflare-warp/",
            warp_script,
        )
        self.assertIn(
            "648a7c7e9085f8e50d32a2adcacb0c2049fb72ebeb02ebe913becadee3ab0d4c",
            warp_script,
        )
        self.assertIn("sha256sum --check --strict", warp_script)
        self.assertIn(
            "registration new",
            warp_script,
        )
        self.assertIn(
            "tunnel protocol set MASQUE",
            warp_script,
        )
        self.assertIn(
            "--ipc-timeout 20 connect",
            warp_script,
        )
        self.assertIn("socks5h://127.0.0.1:40000", warp_script)
        self.assertIn(
            "https://www.cloudflare.com/cdn-cgi/trace",
            warp_script,
        )
        self.assertIn("for _ in {1..30}", warp_script)

        ci_workflow = (
            self.REPO_ROOT / ".github/workflows/ci.yml"
        ).read_text(encoding="utf-8")
        smoke_section = ci_workflow.split("\n  warp-smoke:\n", 1)[1].split(
            "\n  unit:\n", 1
        )[0]
        self.assertIn("Official WARP local-proxy smoke", smoke_section)
        self.assertIn("runs-on: ubuntu-24.04", smoke_section)
        self.assertIn(
            "bash .github/scripts/connect-warp.sh",
            smoke_section,
        )
        self.assertIn("WARP_ROUTE_MODE: proxy", smoke_section)
        self.assertNotRegex(smoke_section, r"\${{\s*secrets\.")
        self.assertNotIn("warp-diag", smoke_section)

    def test_production_install_and_base_are_content_locked(self):
        workflow = (
            self.REPO_ROOT / ".github/workflows/daily-pipeline.yml"
        ).read_text(encoding="utf-8")
        lock = (self.REPO_ROOT / "requirements-crawler.lock").read_text(
            encoding="utf-8"
        )
        requirements = [
            line.strip()
            for line in (
                self.REPO_ROOT / "requirements-crawler.txt"
            ).read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        for requirement in requirements:
            self.assertIn(requirement, lock)
        self.assertGreaterEqual(lock.count("--hash=sha256:"), len(requirements))
        self.assertEqual(workflow.count("--require-hashes"), 3)
        self.assertEqual(workflow.count("--only-binary=:all:"), 3)
        self.assertNotIn("runs-on: ubuntu-latest", workflow)
        self.assertEqual(workflow.count("runs-on: ubuntu-24.04"), 3)

        dockerfile = (self.REPO_ROOT / "Dockerfile.crawler").read_text(
            encoding="utf-8"
        )
        self.assertRegex(
            dockerfile.splitlines()[0],
            r"^FROM python:[^@]+@sha256:[0-9a-f]{64}$",
        )
        self.assertIn("--require-hashes", dockerfile)

    def test_r2_publish_and_telegram_notify_use_disjoint_steps(self):
        workflow = (
            self.REPO_ROOT / ".github/workflows/daily-pipeline.yml"
        ).read_text(encoding="utf-8")
        publish_step = workflow.split(
            "- name: DB 검증 후 immutable 객체→manifest→legacy mirror 게시", 1
        )[1].split("- name: public/state 게시 성공 알림", 1)[0]
        notify_step = workflow.split("- name: public/state 게시 성공 알림", 1)[
            1
        ].split("- name: crawl 실패 알림", 1)[0]

        self.assertIn("AWS_ACCESS_KEY_ID", publish_step)
        self.assertNotIn("TELEGRAM_BOT_TOKEN", publish_step)
        self.assertIn("TELEGRAM_BOT_TOKEN", notify_step)
        self.assertNotIn("AWS_ACCESS_KEY_ID", notify_step)

    def test_partial_state_upload_bypass_is_manual_full_bootstrap_only(self):
        workflow = (
            self.REPO_ROOT / ".github/workflows/daily-pipeline.yml"
        ).read_text(encoding="utf-8")
        self.assertEqual(workflow.count("--allow-partial-bootstrap"), 1)

        incremental_step = workflow.split(
            "- name: 검증된 증분 snapshot generation 및 pointer 게시", 1
        )[1].split(
            "- name: 명시적 full bootstrap 재개 snapshot generation 및 pointer 게시",
            1,
        )[0]
        bootstrap_step = workflow.split(
            "- name: 명시적 full bootstrap 재개 snapshot generation 및 pointer 게시",
            1,
        )[1].split("- name: 완전 성공한 public 출력 다운로드", 1)[0]

        self.assertNotIn("--allow-partial-bootstrap", incremental_step)
        self.assertIn(
            "github.event_name != 'workflow_dispatch' || "
            "inputs.full_bootstrap != true",
            incremental_step,
        )
        self.assertIn("--allow-partial-bootstrap", bootstrap_step)
        self.assertIn(
            "github.event_name == 'workflow_dispatch' && "
            "inputs.full_bootstrap == true",
            bootstrap_step,
        )
        self.assertNotIn("state-mode.json", bootstrap_step)

if __name__ == "__main__":
    unittest.main()
