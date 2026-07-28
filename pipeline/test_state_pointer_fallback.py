"""current/previous R2 state pointer 복구 회귀 테스트."""

from io import BytesIO
import json
import os
import sqlite3
import tempfile
import unittest
from unittest import mock

from botocore.exceptions import ClientError

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

    def upload_file(self, path, bucket, key, ExtraArgs=None):
        del bucket, ExtraArgs
        with open(path, "rb") as stream:
            self.objects[key] = stream.read()
        self.operations.append(("upload", key))

    def put_object(self, Bucket, Key, Body, **kwargs):
        del Bucket, kwargs
        self.objects[Key] = bytes(Body)
        self.operations.append(("put", Key))

    def get_object(self, Bucket, Key):
        del Bucket
        self.operations.append(("get", Key))
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


def _create_master(path, case_name):
    connection = sqlite3.connect(path)
    try:
        connection.execute(
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
        connection.execute(
            """INSERT INTO cases(
                serial, case_name, case_number, case_number_clean, date, court
            ) VALUES (?, ?, ?, ?, ?, ?)""",
            ("1", case_name, "2026다1", "2026다1", "20260720", "대법원"),
        )
        connection.commit()
    finally:
        connection.close()


def _read_case_name(path):
    connection = sqlite3.connect(path)
    try:
        return connection.execute(
            "SELECT case_name FROM cases WHERE serial = '1'"
        ).fetchone()[0]
    finally:
        connection.close()


def _corrupt_same_size(value):
    if not value:
        raise AssertionError("fixture must not be empty")
    replacement = b"X" if value[:1] != b"X" else b"Y"
    return replacement + value[1:]


class StatePointerFallbackTests(unittest.TestCase):
    def _upload(self, client, data_dir):
        with (
            mock.patch.object(sync_state, "get_r2_client", return_value=client),
            mock.patch.object(sync_state, "_verify_incremental_health"),
            mock.patch.dict(os.environ, {"R2_BUCKET": "bucket"}),
        ):
            sync_state.upload_state(data_dir)

    def _upload_two_generations(self, client, data_dir):
        master_path = os.path.join(data_dir, "master.db")
        _create_master(master_path, "previous-good")
        self._upload(client, data_dir)
        first_pointer = json.loads(
            client.objects[sync_state.STATE_POINTER_KEY]
        )

        connection = sqlite3.connect(master_path)
        try:
            connection.execute(
                "UPDATE cases SET case_name = 'current-good' WHERE serial = '1'"
            )
            connection.commit()
        finally:
            connection.close()
        self._upload(client, data_dir)
        current_pointer = json.loads(
            client.objects[sync_state.STATE_POINTER_KEY]
        )
        return first_pointer, current_pointer

    def _download(self, client, data_dir):
        with (
            mock.patch.object(sync_state, "get_r2_client", return_value=client),
            mock.patch.dict(os.environ, {"R2_BUCKET": "bucket"}),
        ):
            sync_state.download_state(data_dir)

    def test_upload_saves_validated_current_before_new_commit(self):
        client = MemoryR2()
        with tempfile.TemporaryDirectory() as data_dir:
            first, current = self._upload_two_generations(client, data_dir)

        previous = json.loads(
            client.objects[sync_state.PREVIOUS_STATE_POINTER_KEY]
        )
        self.assertEqual(previous["generation"], first["generation"])
        self.assertNotEqual(previous["generation"], current["generation"])
        self.assertEqual(
            client.operations[-2:],
            [
                ("put", sync_state.PREVIOUS_STATE_POINTER_KEY),
                ("put", sync_state.STATE_POINTER_KEY),
            ],
        )

    def test_invalid_current_pointer_recovers_previous_generation(self):
        client = MemoryR2()
        with tempfile.TemporaryDirectory() as source_dir:
            self._upload_two_generations(client, source_dir)
        client.objects[sync_state.STATE_POINTER_KEY] = b"{invalid-json"

        with tempfile.TemporaryDirectory() as download_dir:
            self._download(client, download_dir)
            self.assertEqual(
                _read_case_name(os.path.join(download_dir, "master.db")),
                "previous-good",
            )
        self.assertIn(
            ("get", sync_state.PREVIOUS_STATE_POINTER_KEY),
            client.operations,
        )

    def test_missing_current_pointer_recovers_previous_generation(self):
        client = MemoryR2()
        with tempfile.TemporaryDirectory() as source_dir:
            self._upload_two_generations(client, source_dir)
        del client.objects[sync_state.STATE_POINTER_KEY]

        with tempfile.TemporaryDirectory() as download_dir:
            self._download(client, download_dir)
            self.assertEqual(
                _read_case_name(os.path.join(download_dir, "master.db")),
                "previous-good",
            )

    def test_corrupt_current_generation_recovers_previous_generation(self):
        client = MemoryR2()
        with tempfile.TemporaryDirectory() as source_dir:
            _, current = self._upload_two_generations(client, source_dir)
        current_key = current["master"]["key"]
        client.objects[current_key] = _corrupt_same_size(
            client.objects[current_key]
        )

        with tempfile.TemporaryDirectory() as download_dir:
            self._download(client, download_dir)
            self.assertEqual(
                _read_case_name(os.path.join(download_dir, "master.db")),
                "previous-good",
            )

    def test_two_invalid_generations_do_not_partially_replace_local_pair(self):
        client = MemoryR2()
        with tempfile.TemporaryDirectory() as source_dir:
            previous, current = self._upload_two_generations(client, source_dir)
        for pointer in (current, previous):
            key = pointer["master"]["key"]
            client.objects[key] = _corrupt_same_size(client.objects[key])

        with tempfile.TemporaryDirectory() as download_dir:
            local_master = os.path.join(download_dir, "master.db")
            local_backlog = os.path.join(download_dir, "failed_dates.json")
            _create_master(local_master, "local-untouched")
            original_backlog = b'{"local":"untouched"}'
            with open(local_backlog, "wb") as stream:
                stream.write(original_backlog)

            with self.assertRaises(SystemExit):
                self._download(client, download_dir)

            self.assertEqual(_read_case_name(local_master), "local-untouched")
            with open(local_backlog, "rb") as stream:
                self.assertEqual(stream.read(), original_backlog)
            self.assertFalse(
                any(
                    name.startswith(".state-download-")
                    for name in os.listdir(download_dir)
                )
            )


if __name__ == "__main__":
    unittest.main()
