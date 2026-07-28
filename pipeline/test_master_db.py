"""MasterDB transaction 경계 회귀 테스트."""

import os
import sqlite3
import tempfile
import unittest

from master_db import MasterDB


def _case(serial: str) -> dict:
    return {
        "serial": serial,
        "case_name": "테스트",
        "case_number": f"2026다{serial}",
        "date": "20260720",
        "court": "대법원",
    }


class MasterDbTransactionTests(unittest.TestCase):
    def test_upsert_mid_batch_failure_rolls_back_every_row(self):
        with tempfile.TemporaryDirectory() as data_dir:
            db = MasterDB(os.path.join(data_dir, "master.db"))
            try:
                db.conn.execute("""
                    CREATE TRIGGER fail_second_case
                    BEFORE INSERT ON cases
                    WHEN NEW.serial = '2'
                    BEGIN
                        SELECT RAISE(ABORT, 'injected failure');
                    END;
                """)
                db.conn.commit()

                with self.assertRaises(sqlite3.IntegrityError):
                    db.upsert_raw([_case("1"), _case("2")])

                self.assertEqual(db.count(), 0)

                db.conn.execute("DROP TRIGGER fail_second_case")
                db.conn.commit()
                self.assertEqual(db.upsert_raw([_case("3")]), (1, 0, 0))
                self.assertEqual(db.count(), 1)
            finally:
                db.close()

    def test_blank_update_cannot_erase_existing_case_fields(self):
        with tempfile.TemporaryDirectory() as data_dir:
            db = MasterDB(os.path.join(data_dir, "master.db"))
            try:
                self.assertEqual(db.upsert_raw([_case("1")]), (1, 0, 0))
                self.assertEqual(
                    db.upsert_raw([{
                        "serial": "1",
                        "case_name": "",
                        "case_number": "",
                        "date": "",
                        "court": "",
                    }]),
                    (0, 1, 0),
                )
                row = db.conn.execute(
                    "SELECT case_name, case_number, case_number_clean, date, court "
                    "FROM cases WHERE serial = '1'"
                ).fetchone()
                self.assertEqual(
                    row,
                    ("테스트", "2026다1", "2026다1", "20260720", "대법원"),
                )
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()
