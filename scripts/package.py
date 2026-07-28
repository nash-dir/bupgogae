"""
Chrome 웹스토어 제출용 zip 패키저.

  python scripts/package.py            # dist/bupgogae-<manifest version>.zip 생성

[규칙]
- 엔트리 경로는 항상 forward slash (PS 5.1 Compress-Archive는 백슬래시를 써서
  웹스토어 업로드가 거부될 수 있음 — 반드시 이 스크립트를 사용할 것)
- 개발 전용 파일(__tests__, *.test.js, 소스맵, 문서, 숨김파일)은 제외
- 생성 후 금지 엔트리·manifest 위치를 자가 검증하고 위반 시 비정상 종료
"""

import fnmatch
import hashlib
import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "extension")
DIST = os.path.join(ROOT, "dist")
MIN_BUNDLE_CASES = 100_000
REQUIRED_ENTRIES = {
    "manifest.json",
    "background/db-sync.js",
    "content/bupgogae-content.js",
    "data/adapters.json",
    "data/bupgogae_meta.json",
    "data/db.json",
}
REPRODUCIBLE_ZIP_TIME = (1980, 1, 1, 0, 0, 0)

# 패키지에 포함되면 안 되는 것들 (arc 경로 기준 glob)
EXCLUDE_PATTERNS = [
    "__tests__/*",      # Jest 테스트
    "*.test.js",
    "*.spec.js",
    "*.map",            # 소스맵
    "*.md",             # 문서
    ".*",               # 숨김파일 (.DS_Store 등)
    "*/.*",
    "Thumbs.db",
    "*/Thumbs.db",
]


def is_excluded(arc: str) -> bool:
    return any(fnmatch.fnmatch(arc, p) for p in EXCLUDE_PATTERNS)


def validate_release_sources(manifest_version: str) -> tuple[list[str], dict]:
    """Store 패키지의 버전·필수 bundle을 clean checkout 기준으로 검증."""
    errors: list[str] = []
    details: dict = {}

    package_path = os.path.join(ROOT, "package.json")
    try:
        with open(package_path, encoding="utf-8") as f:
            package_version = json.load(f)["version"]
        if package_version != manifest_version:
            errors.append(
                f"manifest/package version 불일치: "
                f"{manifest_version} != {package_version}"
            )
    except (OSError, KeyError, json.JSONDecodeError) as exc:
        errors.append(f"package.json 검증 실패: {exc}")

    db_path = os.path.join(SRC, "data", "db.json")
    try:
        with open(db_path, "rb") as f:
            db_bytes = f.read()
        db = json.loads(db_bytes)
        cases = db.get("cases")
        court_map = db.get("court_code_map")
        total = db.get("total")
        if not re.fullmatch(r"\d{8}", str(db.get("version", ""))):
            errors.append("bundle DB version은 YYYYMMDD여야 함")
        if not isinstance(cases, dict) or len(cases) < MIN_BUNDLE_CASES:
            errors.append(
                f"bundle DB cases가 {MIN_BUNDLE_CASES:,}건 미만이거나 객체가 아님"
            )
        elif total != len(cases):
            errors.append(f"bundle DB total 불일치: {total} != {len(cases)}")
        if db.get("keys") != total:
            errors.append(f"bundle DB keys 불일치: {db.get('keys')} != {total}")
        if not isinstance(court_map, dict) or not court_map:
            errors.append("bundle DB court_code_map이 비어 있음")
        details.update(
            bundle_version=db.get("version"),
            bundle_total=total,
            bundle_sha256=hashlib.sha256(db_bytes).hexdigest(),
            bundle_bytes=len(db_bytes),
            bundle_court_map=court_map,
        )
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"필수 bundle DB 검증 실패: {exc}")

    meta_path = os.path.join(SRC, "data", "bupgogae_meta.json")
    try:
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        expected_meta_version = (
            f"{details['bundle_version'][:4]}."
            f"{details['bundle_version'][4:6]}."
            f"{details['bundle_version'][6:8]}"
        )
        if meta.get("version") != expected_meta_version:
            errors.append(
                f"bundle meta version 불일치: "
                f"{meta.get('version')} != {expected_meta_version}"
            )
        if meta.get("stats", {}).get("unique_keys") != details.get("bundle_total"):
            errors.append("bundle meta unique_keys가 DB total과 다름")
        if meta.get("stats", {}).get("file_size_bytes") != details.get(
            "bundle_bytes"
        ):
            errors.append("bundle meta file_size_bytes가 실제 DB와 다름")
        if meta.get("court_code_map") != details.get("bundle_court_map"):
            errors.append("bundle meta court_code_map이 DB snapshot과 다름")
        if not isinstance(meta.get("case_code_map"), dict) or not meta["case_code_map"]:
            errors.append("bundle meta case_code_map이 비어 있음")
    except (OSError, KeyError, json.JSONDecodeError) as exc:
        errors.append(f"bundle meta 검증 실패: {exc}")

    return errors, details


def main() -> int:
    with open(os.path.join(SRC, "manifest.json"), encoding="utf-8") as f:
        version = json.load(f)["version"]

    errors, details = validate_release_sources(version)
    if errors:
        for error in errors:
            print(f"❌ {error}")
        return 1

    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, f"bupgogae-{version}.zip")
    included, excluded = [], []
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        release_files: list[tuple[str, str]] = []
        for dirpath, dirs, files in os.walk(SRC):
            dirs.sort()
            for name in sorted(files):
                full = os.path.join(dirpath, name)
                arc = os.path.relpath(full, SRC).replace(os.sep, "/")
                if is_excluded(arc):
                    excluded.append(arc)
                    continue
                release_files.append((arc, full))

        for arc, full in sorted(release_files):
            info = zipfile.ZipInfo(arc, date_time=REPRODUCIBLE_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            with open(full, "rb") as source:
                z.writestr(info, source.read(), compresslevel=9)
            included.append(arc)

    # ── 자가 검증 ──
    missing = sorted(REQUIRED_ENTRIES.difference(included))
    if missing:
        errors.append(f"필수 엔트리 누락: {missing}")
    leaked = [a for a in included if is_excluded(a) or "__tests__" in a]
    if leaked:
        errors.append(f"금지 엔트리 유출: {leaked}")
    if any("\\" in a for a in included):
        errors.append("백슬래시 경로 엔트리 존재")

    size_mb = os.path.getsize(out) / 1048576
    print(f"📦 {os.path.relpath(out, ROOT)}  ({size_mb:.2f} MB, {len(included)} entries)")
    if excluded:
        print(f"   제외 {len(excluded)}건: {', '.join(excluded)}")
    if errors:
        for e in errors:
            print(f"❌ {e}")
        return 1
    print(
        "   bundle "
        f"ver={details['bundle_version']} "
        f"cases={details['bundle_total']:,} "
        f"sha256={details['bundle_sha256']}"
    )
    print("✅ 자가 검증 통과")
    return 0


if __name__ == "__main__":
    sys.exit(main())
