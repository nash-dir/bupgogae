"""
Drift 안전망용 manifest 빌더.

클라이언트(확장프로그램)가 로컬 IndexedDB와 대조할 "정답지" manifest.json을
생성한다. 명세는 test_manifest.py가 SSOT.

[해시 대상 주의]
  클라이언트 fetch는 Content-Encoding: gzip을 자동 해제하므로,
  클라이언트가 해시하는 대상 = 비압축 바이트. 따라서 여기서도 반드시
  업로드되는 비압축 db.json / db_tax.json 바이트를 그대로 해시한다.
"""

import hashlib
import json
import re
from datetime import datetime, timezone

SCHEMA_VERSION = 1
VERSION_RE = re.compile(r"^\d{8}$")  # YYYYMMDD


def _build_entry(payload_bytes: bytes, label: str) -> dict:
    """비압축 DB payload 바이트 → manifest 엔트리 (core/tax 공용)."""
    data = json.loads(payload_bytes.decode("utf-8"))

    version = data.get("version")
    if not isinstance(version, str) or not VERSION_RE.match(version):
        # 잘못된 manifest 게시는 전 사용자 강제 동기화 폭주를 유발할 수
        # 있으므로 빌드 단계에서 차단한다.
        raise ValueError(f"{label}: version 형식 오류 {version!r} (YYYYMMDD 필요)")

    cases = data.get("cases")
    if not isinstance(cases, dict):
        raise ValueError(f"{label}: cases 객체 없음")

    return {
        "version": version,
        "sha256": hashlib.sha256(payload_bytes).hexdigest(),
        # payload의 'total' 필드가 아니라 키 수 — 클라이언트가 IndexedDB
        # count()와 직접 비교하는 값이므로 키 수가 정답.
        "total": len(cases),
        "bytes_raw": len(payload_bytes),
    }


def build_manifest(core_bytes: bytes, tax_bytes: bytes = None,
                   built_at: datetime = None) -> dict:
    """비압축 DB 바이트들로부터 manifest dict 생성.

    built_at 미지정 시 현재 UTC (테스트를 위해 주입 가능).
    """
    if built_at is None:
        built_at = datetime.now(timezone.utc)

    manifest = {
        "schema": SCHEMA_VERSION,
        "built_at": built_at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "core": _build_entry(core_bytes, "core"),
    }
    if tax_bytes is not None:
        manifest["tax"] = _build_entry(tax_bytes, "tax")
    return manifest


def write_manifest(manifest: dict, path: str) -> None:
    """manifest를 compact JSON으로 저장."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))
