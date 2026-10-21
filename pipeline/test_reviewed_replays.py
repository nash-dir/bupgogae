import copy
import gzip
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

from known_errors import CorrectionError
from master_db import MasterDB
import crawler_runner as runner
import reviewed_replays as replay


class ReviewedReplayTests(unittest.TestCase):
    def test_exact_detail_keeps_both_members_and_explicit_branch(self):
        for sid, entry in replay.entries().items():
            detail = json.loads(gzip.decompress((Path(__file__).parent / "fixtures" /
                                                 "reviewed-replays" / (sid + ".json.gz")).read_bytes()))
            with self.subTest(serial=sid), tempfile.TemporaryDirectory() as folder:
                db = MasterDB(str(Path(folder) / "master.db"))
                try:
                    db.upsert_raw([entry["expectedArchived"]])
                    db.conn.execute("INSERT INTO reviewed_recovery_provenance VALUES(?,?,?,?,?)",
                                    (sid, "a" * 64, "b" * 64, json.dumps(entry["record"]),
                                     json.dumps(entry["expectedArchived"])))
                    db.conn.commit()
                    before = list(db.conn.iterdump())
                    item = ET.Element("prec")
                    for k, v in entry["expectedList"].items():
                        ET.SubElement(item, k).text = v
                    original = replay.verify
                    with mock.patch.object(replay, "verify", side_effect=lambda f, a, c:
                                           original(f, a, c, fetch=lambda serial: detail)):
                        row = runner._precedent_case(item, entry["record"]["date"], 1,
                                                     replay=db.raw_replay_checker())
                    self.assertEqual(db.upsert_raw([row]), (0, 0, 1))
                    self.assertEqual(list(db.conn.iterdump()), before)
                    self.assertTrue(replay.verify(entry["expectedList"], entry["expectedArchived"],
                                                  entry["record"], fetch=lambda serial: detail))
                    changed = copy.deepcopy(detail)
                    changed["body"] += " "
                    with self.assertRaisesRegex(CorrectionError, "source_changed"):
                        replay.verify(entry["expectedList"], entry["expectedArchived"], entry["record"],
                                      fetch=lambda serial: changed)
                    for field in entry["expectedList"]:
                        if field == "판례일련번호":
                            continue
                        with self.assertRaisesRegex(CorrectionError, "input_changed"):
                            replay.verify(dict(entry["expectedList"], **{field: "changed"}),
                                          entry["expectedArchived"], entry["record"], fetch=lambda serial: detail)
                finally:
                    db.close()
