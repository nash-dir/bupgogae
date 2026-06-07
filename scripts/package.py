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
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "extension")
DIST = os.path.join(ROOT, "dist")

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


def main() -> int:
    with open(os.path.join(SRC, "manifest.json"), encoding="utf-8") as f:
        version = json.load(f)["version"]

    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, f"bupgogae-{version}.zip")
    if os.path.exists(out):
        os.remove(out)

    included, excluded = [], []
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for dirpath, _, files in os.walk(SRC):
            for name in sorted(files):
                full = os.path.join(dirpath, name)
                arc = os.path.relpath(full, SRC).replace(os.sep, "/")
                if is_excluded(arc):
                    excluded.append(arc)
                    continue
                z.write(full, arc)
                included.append(arc)

    # ── 자가 검증 ──
    errors = []
    if "manifest.json" not in included:
        errors.append("manifest.json이 zip 루트에 없음")
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
    print("✅ 자가 검증 통과")
    return 0


if __name__ == "__main__":
    sys.exit(main())
