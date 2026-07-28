"""
manifest.py 명세 (SDD) — Drift 안전망용 manifest 빌더
========================================================
클라이언트(확장프로그램)가 로컬 DB와 대조할 "정답지" manifest.json을 생성한다.

[명세 계약]
  build_manifest(core_bytes, tax_bytes=None, built_at=None) -> dict
    - core_bytes / tax_bytes: 업로드되는 비압축 db.json / db_tax.json의 바이트.
      (클라이언트 fetch는 Content-Encoding: gzip을 자동 해제하므로,
       클라이언트가 해시하는 대상 = 비압축 바이트. 반드시 같은 것을 해시할 것)
    - 반환 스키마:
        {
          "schema": 1,
          "built_at": "<ISO-8601 UTC, 'Z' suffix>",
          "core": {"version": "YYYYMMDD", "sha256": "<64 hex>",
                    "total": <cases 키 수>, "bytes_raw": <len(core_bytes)>},
          "tax":  {...}   # tax_bytes가 주어진 경우에만
        }
    - payload의 total과 len(cases)가 정확히 같아야 하며 manifest에도 그 키 수를 기록.
    - payload의 version이 YYYYMMDD 형식이 아니면 ValueError
      (잘못된 manifest 게시는 전 사용자 강제 동기화 폭주를 유발할 수 있으므로
       빌드 단계에서 차단한다)
    - built_at 미지정 시 현재 UTC. 테스트를 위해 주입 가능.

  write_manifest(manifest, path) -> None
    - compact JSON으로 저장 (ensure_ascii=False)

실행: python -m unittest discover -s pipeline -p "test_*.py"
"""

import hashlib
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone

from manifest import MIN_CORE_KEYS, build_manifest, validate_payload, write_manifest


def make_payload(version="20260607", n_keys=3, total=None):
    cases = {f"00Da{i}": [[i, 1, 200101, "테스트"]] for i in range(1, n_keys + 1)}
    payload = {"version": version, "total": total if total is not None else n_keys,
               "keys": n_keys, "cases": cases,
               "court_code_map": {"대법원": 1}}
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def build_test_manifest(core, **kwargs):
    return build_manifest(core, min_core_keys=1, **kwargs)


class TestBuildManifest(unittest.TestCase):

    def test_sha256은_입력_바이트의_해시와_일치(self):
        core = make_payload()
        m = build_test_manifest(core)
        self.assertEqual(m["core"]["sha256"], hashlib.sha256(core).hexdigest())

    def test_스키마_필수_필드(self):
        core = make_payload(version="20260607", n_keys=5)
        m = build_test_manifest(core)
        self.assertEqual(m["schema"], 1)
        self.assertEqual(m["core"]["version"], "20260607")
        self.assertEqual(m["core"]["bytes_raw"], len(core))

    def test_total은_cases_키_수와_같이_manifest에_기록(self):
        core = make_payload(n_keys=4)
        m = build_test_manifest(core)
        self.assertEqual(m["core"]["total"], 4)

    def test_built_at_주입_및_Z_suffix(self):
        fixed = datetime(2026, 6, 7, 3, 0, 0, tzinfo=timezone.utc)
        m = build_test_manifest(make_payload(), built_at=fixed)
        self.assertEqual(m["built_at"], "2026-06-07T03:00:00Z")

    def test_built_at_기본값은_현재_UTC_파싱가능(self):
        m = build_test_manifest(make_payload())
        self.assertTrue(m["built_at"].endswith("Z"))
        datetime.fromisoformat(m["built_at"].replace("Z", "+00:00"))  # 파싱 가능해야 함

    def test_tax_생략시_키_없음(self):
        m = build_test_manifest(make_payload())
        self.assertNotIn("tax", m)

    def test_tax_제공시_같은_스키마로_포함(self):
        tax = make_payload(version="20260606", n_keys=2)
        m = build_test_manifest(make_payload(), tax_bytes=tax)
        self.assertEqual(m["tax"]["version"], "20260606")
        self.assertEqual(m["tax"]["total"], 2)
        self.assertEqual(m["tax"]["sha256"], hashlib.sha256(tax).hexdigest())

    def test_version_형식_불량은_ValueError(self):
        bad = make_payload(version="2026.06.07")
        with self.assertRaises(ValueError):
            build_test_manifest(bad)

    def test_version_누락도_ValueError(self):
        payload = json.dumps({"cases": {"00Da1": [[1, 1, 0, "x"]]}}).encode()
        with self.assertRaises(ValueError):
            build_test_manifest(payload)

    def test_total_불일치는_manifest_생성_전에_차단(self):
        with self.assertRaisesRegex(ValueError, "total"):
            build_test_manifest(make_payload(n_keys=3, total=999))

    def test_keys_불일치는_manifest_생성_전에_차단(self):
        payload = json.loads(make_payload().decode("utf-8"))
        payload["keys"] = 999
        with self.assertRaisesRegex(ValueError, "keys"):
            build_test_manifest(json.dumps(payload).encode("utf-8"))

    def test_알_수_없는_법원_코드_참조를_차단(self):
        payload = json.loads(make_payload().decode("utf-8"))
        payload["cases"]["00Da1"][0][1] = 99
        with self.assertRaisesRegex(ValueError, "court code"):
            build_test_manifest(
                json.dumps(payload, ensure_ascii=False).encode("utf-8")
            )

    def test_실재하지_않는_version_날짜를_차단(self):
        with self.assertRaisesRegex(ValueError, "달력"):
            build_test_manifest(make_payload(version="20260230"))

    def test_레코드_후반부_손상도_전수_검사(self):
        payload = json.loads(make_payload(n_keys=7).decode("utf-8"))
        payload["cases"]["00Da7"][0][3] = None
        with self.assertRaisesRegex(ValueError, "case name"):
            build_test_manifest(
                json.dumps(payload, ensure_ascii=False).encode("utf-8")
            )

    def test_production_최소_키_하한을_강제(self):
        with self.assertRaisesRegex(ValueError, "키 수"):
            validate_payload(make_payload(n_keys=3))
        self.assertEqual(MIN_CORE_KEYS, 100_000)


class TestWriteManifest(unittest.TestCase):

    def test_파일로_저장하고_다시_읽으면_동일(self):
        m = build_test_manifest(make_payload())
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "manifest.json")
            write_manifest(m, path)
            with open(path, encoding="utf-8") as f:
                self.assertEqual(json.load(f), m)


if __name__ == "__main__":
    unittest.main()
