"""Resume never trusts a changed input or completed local candidate."""
import json
from pathlib import Path
import tempfile
import unittest
import sqlite3

from prepare_court_master import prepare, OUTPUT_NAMES
from recover_missing import file_hash


class PrepareResumeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.master, self.reference, self.output = [self.root / name for name in ("source.db", "source.json", "candidate")]
        self.master.write_bytes(b"pinned source fixture")
        self.reference.write_bytes(b"pinned reference fixture")
        self.output.mkdir()
        self.result = self.output / "master.db"
        self.result.write_bytes(b"completed output fixture")
        self.options = dict(master_sha256=file_hash(self.master), reference_sha256=file_hash(self.reference))
        self.receipt = dict(inputs=dict(masterSha256=self.options["master_sha256"],
                                       referenceSha256=self.options["reference_sha256"]),
                            stage="verified_local_candidate", published=False,
                            outputs={name: file_hash(self.result) for name in OUTPUT_NAMES})
        for name in OUTPUT_NAMES:
            (self.output / name).write_bytes(self.result.read_bytes())
        self.checkpoint = self.output / "continuation.json"
        self.checkpoint.write_text(json.dumps(self.receipt), encoding="utf-8")

    def tearDown(self):
        self.directory.cleanup()

    def run_prepare(self):
        return prepare(self.master, self.reference, self.output, **self.options)

    def test_unchanged_completed_candidate_is_reused_without_rewriting(self):
        before = self.result.stat().st_mtime_ns
        self.assertEqual(self.run_prepare(), self.receipt)
        self.assertEqual(self.result.stat().st_mtime_ns, before)

    def test_changed_or_missing_completed_file_is_rejected(self):
        self.result.write_bytes(b"changed output")
        with self.assertRaisesRegex(ValueError, "completed_candidate_changed"):
            self.run_prepare()
        self.result.unlink()
        with self.assertRaisesRegex(ValueError, "completed_candidate_changed"):
            self.run_prepare()

    def test_changed_input_or_checkpoint_is_rejected(self):
        original = self.master.read_bytes()
        self.master.write_bytes(b"changed source")
        with self.assertRaisesRegex(ValueError, "pinned_input_hash_mismatch"):
            self.run_prepare()

        self.master.write_bytes(original)
        self.receipt["inputs"]["masterSha256"] = "0" * 64
        self.checkpoint.write_text(json.dumps(self.receipt), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "resume_input_mismatch"):
            self.run_prepare()

    def test_empty_partial_or_unsafe_output_inventory_is_rejected(self):
        for outputs in ({}, {"master.db": file_hash(self.result)},
                        dict(self.receipt["outputs"], **{"../elsewhere": "0" * 64}),
                        {name: None for name in OUTPUT_NAMES}):
            self.receipt["outputs"] = outputs
            self.checkpoint.write_text(json.dumps(self.receipt), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "invalid_completed_receipt"):
                self.run_prepare()

    def test_live_wal_is_rejected_even_when_main_hash_is_unchanged(self):
        self.master.unlink()
        conn = sqlite3.connect(self.master)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("CREATE TABLE evidence(value TEXT)")
            conn.commit()
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self.options["master_sha256"] = file_hash(self.master)
            conn.execute("INSERT INTO evidence VALUES('unbound change')")
            conn.commit()
            self.assertEqual(file_hash(self.master), self.options["master_sha256"])
            with self.assertRaisesRegex(ValueError, "checkpoint_inputs_before_hashing"):
                self.run_prepare()
        finally:
            conn.close()
