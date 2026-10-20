"""State handoffs remain confidential, authenticated and safe on failure."""
import base64
from io import BytesIO
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock
import zipfile

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

import state_artifact as transport


class StateArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = mock.patch.dict(os.environ, {
            "STATE_ARTIFACT_KEY": base64.b64encode(os.urandom(32)).decode(),
            "GITHUB_REPOSITORY": "test/repo", "GITHUB_RUN_ID": "12345",
            "GITHUB_SHA": "a" * 40,
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.data = self.root / "source"
        self.data.mkdir()
        self.master = sqlite3.connect(self.data / "master.db")
        self.addCleanup(self.master.close)
        self.master.execute("PRAGMA journal_mode=WAL")
        self.master.execute("CREATE TABLE cases (serial TEXT)")
        self.master.execute("INSERT INTO cases VALUES ('private-synthetic-row')")
        self.master.commit()
        (self.data / "failed_dates.json").write_bytes(b'{"pending":[]}')
        self.encrypted = self.root / "cipher" / "input.aead"
        self.restored = self.root / "restored"

    def test_roundtrip_captures_wal_without_exposing_plaintext(self):
        transport.seal(self.data, self.encrypted, "input")
        cipher = self.encrypted.read_bytes()
        self.assertNotIn(b"SQLite format", cipher)
        self.assertNotIn(b"private-synthetic-row", cipher)
        transport.unseal(self.encrypted, self.restored, "input")
        self.assertEqual(sorted(p.name for p in self.restored.iterdir()),
                         ["failed_dates.json", "master.db"])
        conn = sqlite3.connect(self.restored / "master.db")
        try:
            self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            self.assertEqual(conn.execute("SELECT serial FROM cases").fetchone(),
                             ("private-synthetic-row",))
        finally:
            conn.close()

    def test_fresh_nonce_and_context_bound_to_phase_run_revision_repo(self):
        transport.seal(self.data, self.encrypted, "input")
        first = self.encrypted.read_bytes()
        transport.seal(self.data, self.encrypted, "input")
        self.assertNotEqual(first, self.encrypted.read_bytes())
        with self.assertRaises(InvalidTag):
            transport.unseal(self.encrypted, self.restored, "resume")
        for field, value in [("GITHUB_RUN_ID", "999"), ("GITHUB_SHA", "b"*40),
                             ("GITHUB_REPOSITORY", "other/repo")]:
            with self.subTest(field=field), mock.patch.dict(os.environ, {field: value}):
                with self.assertRaises(InvalidTag):
                    transport.unseal(self.encrypted, self.restored, "input")
        self.assertFalse(self.restored.exists())

    def test_tamper_wrong_key_and_truncation_never_extract(self):
        transport.seal(self.data, self.encrypted, "input")
        original = self.encrypted.read_bytes()
        with mock.patch.dict(os.environ, {"STATE_ARTIFACT_KEY": base64.b64encode(os.urandom(32)).decode()}):
            with self.assertRaises(InvalidTag):
                transport.unseal(self.encrypted, self.restored, "input")
        for cipher in [original[:-1], original[:15], original[:-1]+bytes([original[-1]^1])]:
            self.encrypted.write_bytes(cipher)
            with self.assertRaises((ValueError, InvalidTag)):
                transport.unseal(self.encrypted, self.restored, "input")
            self.assertFalse(self.restored.exists())

    def test_missing_key_empty_sources_and_existing_destination_fail_closed(self):
        with mock.patch.dict(os.environ, {"STATE_ARTIFACT_KEY": ""}):
            with self.assertRaises(ValueError):
                transport.seal(self.data, self.encrypted, "input")
        self.assertFalse(self.encrypted.exists())
        empty = self.root / "empty"
        empty.mkdir()
        with self.assertRaises(ValueError):
            transport.seal(empty, self.encrypted, "input")
        transport.seal(self.data, self.encrypted, "input")
        self.restored.mkdir()
        sentinel = self.restored / "master.db"
        sentinel.write_bytes(b"last-known-good")
        with self.assertRaises(ValueError):
            transport.unseal(self.encrypted, self.restored, "input")
        self.assertEqual(sentinel.read_bytes(), b"last-known-good")

    def test_empty_bootstrap_marker_supported(self):
        bootstrap = self.root / "bootstrap"
        bootstrap.mkdir()
        (bootstrap / "state-mode.json").write_bytes(b'{"mode":"full_bootstrap"}')
        transport.seal(bootstrap, self.encrypted, "input")
        transport.unseal(self.encrypted, self.restored, "input")
        self.assertEqual((self.restored / "state-mode.json").read_bytes(),
                         b'{"mode":"full_bootstrap"}')

    def test_closed_master_retains_exact_bytes_for_expected_sha_readback(self):
        closed = self.root / "closed"
        closed.mkdir()
        conn = sqlite3.connect(closed / "master.db")
        conn.execute("CREATE TABLE cases(serial TEXT)")
        conn.execute("INSERT INTO cases VALUES('synthetic')")
        conn.commit()
        conn.close()
        original = (closed / "master.db").read_bytes()
        transport.seal(closed, self.encrypted, "input")
        transport.unseal(self.encrypted, self.restored, "input")
        self.assertEqual(original, (self.restored / "master.db").read_bytes())

    def test_authenticated_but_unsafe_archive_is_rejected(self):
        # Even a producer holding the key cannot extract paths or arbitrary files
        # into a trusted finalize runner.
        for names in [["../escape", "master.db"], ["master.db", "master.db"],
                      [".env"], ["pipeline-report.json"]]:
            stream = BytesIO()
            with zipfile.ZipFile(stream, "w") as archive:
                for name in names:
                    archive.writestr(name, b"synthetic")
            nonce = os.urandom(12)
            cipher = AESGCM(transport.transport_key()).encrypt(
                nonce, stream.getvalue(), transport.context("input"))
            self.encrypted.parent.mkdir(exist_ok=True)
            self.encrypted.write_bytes(transport.MAGIC + nonce + cipher)
            with self.subTest(names=names), self.assertRaises(ValueError):
                transport.unseal(self.encrypted, self.restored, "input")
            self.assertFalse(self.restored.exists())
            self.assertFalse((self.root / "escape").exists())

    def test_archive_size_limit_and_unknown_local_files(self):
        (self.data / ".env").write_text("synthetic-never-upload", encoding="utf-8")
        with mock.patch.dict(transport.LIMITS, {"master.db": 1}):
            with self.assertRaises(ValueError):
                transport.seal(self.data, self.encrypted, "input")
        transport.seal(self.data, self.encrypted, "input")
        transport.unseal(self.encrypted, self.restored, "input")
        self.assertFalse((self.restored / ".env").exists())


if __name__ == "__main__":
    unittest.main()
