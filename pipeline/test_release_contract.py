"""One contract corpus for Python/JS and the actual release packager."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from manifest import validate_payload
from public_contract import derive_short_case_keys

ROOT = Path(__file__).resolve().parents[1]
CORPUS = json.loads((ROOT / "pipeline/fixtures/public-payload-contract.json").read_bytes())
spec = importlib.util.spec_from_file_location("release_packager", ROOT / "scripts/package.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


def sample_payload(sample):
    payload = copy.deepcopy(CORPUS["base"])
    for key in ("version", "keys", "cases"):
        if key in sample:
            payload[key] = sample[key]
    for key, index in (("serial", 0), ("courtCode", 1), ("title", 3)):
        if key in sample:
            next(iter(payload["cases"].values()))[0][index] = sample[key]
    if sample.get("omitKeys"):
        payload.pop("keys")
    return payload


class ReleaseContractTests(unittest.TestCase):
    def test_shared_canonical_contract(self):
        fixture = CORPUS["canonical"]
        self.assertEqual(derive_short_case_keys(fixture["keys"], fixture["caseCodeMap"]), fixture["expected"])

    def test_shared_contract_corpus(self):
        for sample in CORPUS["samples"]:
            with self.subTest(sample=sample["name"]):
                body = json.dumps(sample_payload(sample), ensure_ascii=False).encode()
                if sample["valid"]:
                    validate_payload(body, min_keys=1)
                else:
                    with self.assertRaises(ValueError):
                        validate_payload(body, min_keys=1)

    def test_packager_rejects_bad_records_versions_and_keys(self):
        for sample in CORPUS["samples"]:
            if sample.get("omitKeys"):
                continue  # Release bundles require keys, older network payloads may omit it.
            payload = sample_payload(sample)
            body = json.dumps(payload, ensure_ascii=False).encode()
            version = payload["version"]
            meta = dict(version=f"{version[:4]}.{version[4:6]}.{version[6:]}",
                        case_code_map={"다": "Da", "헌바": "HB"}, court_code_map=payload["court_code_map"],
                        short_case_keys=derive_short_case_keys(payload["cases"], {"다": "Da"}),
                        stats=dict(unique_keys=payload["total"], file_size_bytes=len(body)))
            with self.subTest(sample=sample["name"]), tempfile.TemporaryDirectory() as directory:
                data = Path(directory) / "data"
                data.mkdir()
                (data / "db.json").write_bytes(body)
                (data / "bupgogae_meta.json").write_text(json.dumps(meta), encoding="utf-8")
                with mock.patch.object(packager, "SRC", directory), mock.patch.object(packager, "MIN_BUNDLE_CASES", 1):
                    errors, _ = packager.validate_release_sources("0.9.0")
                self.assertEqual(not errors, sample["valid"], errors)
