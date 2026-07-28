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
from datetime import datetime, timedelta, timezone

SCHEMA_VERSION = 1
VERSION_RE = re.compile(r"^\d{8}$")  # YYYYMMDD
CORE_CASE_KEY_RE = re.compile(
    r"^(?:\d{2}(?:[A-Za-z][A-Za-z0-9]*|[가-힣]{1,4})\d+|"
    r"(?:TX|KP)\d{2}[가-힣]{1,4}\d+)$"
)
CONSTITUTIONAL_SERIAL_RE = re.compile(r"^D\d+$")
MIN_CORE_KEYS = 100_000
MAX_CORE_KEYS = 10_000_000
MAX_RAW_BYTES = 50 * 1024 * 1024


def _is_integer(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _validate_version(version: object, label: str) -> str:
    if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
        raise ValueError(f"{label}: version 형식 오류 {version!r} (YYYYMMDD 필요)")
    try:
        parsed = datetime.strptime(version, "%Y%m%d").date()
    except ValueError as error:
        raise ValueError(f"{label}: version이 실제 달력 날짜가 아님") from error

    kst_today = datetime.now(timezone(timedelta(hours=9))).date()
    if parsed > kst_today + timedelta(days=1):
        raise ValueError(f"{label}: version이 허용 미래 범위를 초과함")
    return version


def _validate_court_code_map(data: dict, label: str) -> set[int]:
    """공개 record가 참조하는 법원 코드 사전을 엄격하게 검증한다."""
    court_map = data.get("court_code_map")
    if not isinstance(court_map, dict) or not court_map:
        raise ValueError(f"{label}: court_code_map 누락 또는 빈 객체")

    known_codes = set()
    for name, code in court_map.items():
        if not isinstance(name, str) or not 1 <= len(name) <= 128:
            raise ValueError(f"{label}: court_code_map 법원명 형식 오류")
        if not _is_integer(code) or code < 1 or code in known_codes:
            raise ValueError(f"{label}: court_code_map 코드 형식/중복 오류")
        known_codes.add(code)
    return known_codes


def _validate_record(
    record: object,
    label: str,
    key: str,
    known_court_codes: set[int],
) -> None:
    if not isinstance(record, list) or len(record) != 4:
        raise ValueError(f"{label}: cases[{key!r}] record 형식 오류")
    serial, court_code, decision_date, case_name = record
    valid_serial = (
        (_is_integer(serial) and serial > 0)
        or (
            isinstance(serial, str)
            and CONSTITUTIONAL_SERIAL_RE.fullmatch(serial) is not None
        )
    )
    if not valid_serial:
        raise ValueError(f"{label}: cases[{key!r}] serial 형식 오류")
    if not _is_integer(court_code) or court_code < 0:
        raise ValueError(f"{label}: cases[{key!r}] court code 형식 오류")
    if court_code != 0 and court_code not in known_court_codes:
        raise ValueError(f"{label}: cases[{key!r}] 알 수 없는 court code")
    if (
        not _is_integer(decision_date)
        or decision_date < 0
        or decision_date > 999_999
    ):
        raise ValueError(f"{label}: cases[{key!r}] date 형식 오류")
    if not isinstance(case_name, str):
        raise ValueError(f"{label}: cases[{key!r}] case name 형식 오류")


def validate_payload(
    payload_bytes: bytes,
    label: str = "core",
    *,
    min_keys: int = MIN_CORE_KEYS,
) -> dict:
    """클라이언트 설치 계약과 동일한 public DB payload를 전수 검증한다."""
    if not isinstance(payload_bytes, bytes) or not payload_bytes:
        raise ValueError(f"{label}: payload bytes 없음")
    if len(payload_bytes) > MAX_RAW_BYTES:
        raise ValueError(f"{label}: payload 크기 상한 초과")
    try:
        data = json.loads(payload_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{label}: JSON parse 실패") from error
    if not isinstance(data, dict):
        raise ValueError(f"{label}: payload 객체 아님")

    _validate_version(data.get("version"), label)
    cases = data.get("cases")
    if not isinstance(cases, dict):
        raise ValueError(f"{label}: cases 객체 없음")
    key_count = len(cases)
    if key_count < min_keys or key_count > MAX_CORE_KEYS:
        raise ValueError(
            f"{label}: cases 키 수 범위 오류 ({key_count}, min={min_keys})"
        )
    total = data.get("total")
    if not _is_integer(total) or total != key_count:
        raise ValueError(
            f"{label}: total({total!r})과 cases 키 수({key_count}) 불일치"
        )
    # keys는 과거 payload에는 없을 수 있어 하위 호환상 선택 필드로 두되,
    # 존재한다면 total/cases와 정확히 같아야 한다.
    keys_field = data.get("keys")
    if keys_field is not None and (
        not _is_integer(keys_field) or keys_field != key_count
    ):
        raise ValueError(
            f"{label}: keys({keys_field!r})와 cases 키 수({key_count}) 불일치"
        )

    known_court_codes = _validate_court_code_map(data, label)

    for key, records in cases.items():
        if (
            not isinstance(key, str)
            or len(key) > 64
            or CORE_CASE_KEY_RE.fullmatch(key) is None
        ):
            raise ValueError(f"{label}: 압축 사건번호 키 형식 오류 {key!r}")
        if not isinstance(records, list) or not records:
            raise ValueError(f"{label}: cases[{key!r}]가 빈 배열이거나 배열 아님")
        for record in records:
            _validate_record(record, label, key, known_court_codes)
    return data


def _build_entry(payload_bytes: bytes, label: str, min_keys: int) -> dict:
    """비압축 DB payload 바이트 → manifest 엔트리 (core/tax 공용)."""
    data = validate_payload(payload_bytes, label, min_keys=min_keys)
    version = data["version"]
    cases = data["cases"]

    return {
        "version": version,
        "sha256": hashlib.sha256(payload_bytes).hexdigest(),
        # payload의 'total' 필드가 아니라 키 수 — 클라이언트가 IndexedDB
        # count()와 직접 비교하는 값이므로 키 수가 정답.
        "total": len(cases),
        "bytes_raw": len(payload_bytes),
    }


def build_manifest(
    core_bytes: bytes,
    tax_bytes: bytes = None,
    built_at: datetime = None,
    *,
    min_core_keys: int = MIN_CORE_KEYS,
    min_tax_keys: int = 1,
) -> dict:
    """비압축 DB 바이트들로부터 manifest dict 생성.

    built_at 미지정 시 현재 UTC (테스트를 위해 주입 가능).
    """
    if built_at is None:
        built_at = datetime.now(timezone.utc)

    manifest = {
        "schema": SCHEMA_VERSION,
        "built_at": built_at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "core": _build_entry(core_bytes, "core", min_core_keys),
    }
    if tax_bytes is not None:
        manifest["tax"] = _build_entry(tax_bytes, "tax", min_tax_keys)
    return manifest


def write_manifest(manifest: dict, path: str) -> None:
    """manifest를 compact JSON으로 저장."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))
