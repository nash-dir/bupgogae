"""완전 성공한 crawl artifact를 검증해 public R2 객체로 게시한다.

이 스크립트는 WARP/crawl job과 분리된 trusted finalize job에서만 실행한다.
R2 및 Telegram credential은 이 프로세스의 해당 호출에만 주입한다.
"""

import argparse
import gzip
import hashlib
import json
import os
import re
import sys

import requests

from log_setup import get_logger
from manifest import MAX_RAW_BYTES, build_manifest, validate_payload, write_manifest
from upload_r2 import R2_KEY, upload_db_to_r2

log = get_logger(__name__)

REPORT_REASON_RE = re.compile(r"^[a-z0-9_]{1,80}$")
MANIFEST_R2_KEY = "bupgogae/manifest.json"
IMMUTABLE_R2_PREFIX = "bupgogae/objects"
IMMUTABLE_MANIFEST_PREFIX = "objects"


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_gzip_matches(raw_path: str, gzip_path: str) -> str:
    raw_size = os.path.getsize(raw_path)
    if raw_size > MAX_RAW_BYTES:
        raise ValueError("db.json exceeds raw size limit")
    if os.path.getsize(gzip_path) > MAX_RAW_BYTES:
        raise ValueError("db.json.gz exceeds compressed size limit")
    raw_digest = _sha256(raw_path)
    decoded_digest = hashlib.sha256()
    decoded_size = 0
    with gzip.open(gzip_path, "rb") as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            decoded_size += len(chunk)
            if decoded_size > MAX_RAW_BYTES:
                raise ValueError("db.json.gz decoded size limit exceeded")
            decoded_digest.update(chunk)
    if decoded_size != raw_size or decoded_digest.hexdigest() != raw_digest:
        raise ValueError("db.json.gz does not match db.json")
    return raw_digest


def _validate_public_payload(raw_bytes: bytes) -> dict:
    payload = validate_payload(raw_bytes, "core")
    case_count = len(payload["cases"])
    keys = payload.get("keys")
    if isinstance(keys, bool) or not isinstance(keys, int) or keys != case_count:
        raise ValueError("public keys does not match cases")
    court_map = payload.get("court_code_map")
    if not isinstance(court_map, dict) or not court_map:
        raise ValueError("court_code_map missing")
    known_court_codes = set()
    for name, code in court_map.items():
        if (
            not isinstance(name, str)
            or not 1 <= len(name) <= 128
            or isinstance(code, bool)
            or not isinstance(code, int)
            or code < 1
            or code in known_court_codes
        ):
            raise ValueError("invalid court_code_map")
        known_court_codes.add(code)
    for records in payload["cases"].values():
        for record in records:
            court_code = record[1]
            if court_code != 0 and court_code not in known_court_codes:
                raise ValueError("record references unknown court code")
    return payload


def _load_pipeline_report(data_dir: str | None):
    if not data_dir:
        return None
    path = os.path.join(data_dir, "pipeline-report.json")
    if not os.path.isfile(path) or os.path.getsize(path) > 16 * 1024:
        return None
    try:
        with open(path, encoding="utf-8") as stream:
            report = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(report, dict)
        or report.get("schema") != 1
        or report.get("status") not in {"success", "blocked"}
        or not isinstance(report.get("reason"), str)
        or REPORT_REASON_RE.fullmatch(report["reason"]) is None
    ):
        return None
    for field in ("db_total", "precedent_failed", "detc_failed"):
        value = report.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            return None
    if not isinstance(report.get("circuit_broken"), bool):
        return None
    return report


def send_notification(status: str, data_dir: str | None = None):
    """credential/URL을 로그에 남기지 않는 최소 운영 알림."""
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
    if not bot_token or not chat_id:
        log.info("Telegram credential 없음 — 알림 스킵")
        return

    run_url = ""
    server = os.environ.get("GITHUB_SERVER_URL", "")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    if server and repository and run_id:
        run_url = f"\n{server}/{repository}/actions/runs/{run_id}"
    text = (
        "✅ 법고개 공개 DB/state 게시 완료"
        if status == "success"
        else (
            "❌ 법고개 pipeline 실패 — 게시 단계 확인 필요; "
            "클라이언트는 검증된 generation/LKG만 사용"
        )
    )
    report = _load_pipeline_report(data_dir)
    if report is not None:
        text += (
            f"\nreason={report['reason']} db={report['db_total']:,}"
            f" precedent_backlog={report['precedent_failed']:,}"
            f" detc_backlog={report['detc_failed']:,}"
        )

    try:
        response = requests.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={"chat_id": chat_id, "text": f"{text}{run_url}"},
            timeout=10,
        )
        if response.status_code != 200:
            log.warning(
                f"Telegram 알림 실패 (status={response.status_code})"
            )
    except requests.exceptions.RequestException as error:
        # token이 URL에 포함되므로 exception 문자열은 절대 기록하지 않는다.
        log.warning(f"Telegram 알림 실패 (kind={type(error).__name__})")


def publish_outputs(data_dir: str):
    raw_path = os.path.join(data_dir, "db.json")
    gzip_path = os.path.join(data_dir, "db.json.gz")
    manifest_path = os.path.join(data_dir, "manifest.json")
    for path in (raw_path, gzip_path):
        if not os.path.isfile(path):
            raise FileNotFoundError(os.path.basename(path))

    raw_sha256 = _verify_gzip_matches(raw_path, gzip_path)
    with open(raw_path, "rb") as stream:
        raw_bytes = stream.read()
    _validate_public_payload(raw_bytes)
    manifest = build_manifest(raw_bytes)
    if manifest.get("core", {}).get("sha256") != raw_sha256:
        raise ValueError("manifest core hash does not match db.json")

    object_name = f"{raw_sha256}.json.gz"
    immutable_r2_key = f"{IMMUTABLE_R2_PREFIX}/{object_name}"
    # object_path는 API base(`.../bupgogae/`) 기준 상대 경로다. 클라이언트는
    # 이 값에 대해 별도의 strict path 검증을 거친 뒤에만 URL을 조립한다.
    manifest["core"]["object_path"] = (
        f"{IMMUTABLE_MANIFEST_PREFIX}/{object_name}"
    )
    write_manifest(manifest, manifest_path)

    # 게시 순서 자체가 원자성 계약이다.
    # 1) content-addressed 객체, 2) 새 클라이언트용 commit marker,
    # 3) 구버전 클라이언트용 고정 키 mirror.
    # manifest PUT 실패 전에는 고정 키를 건드리지 않으며, mirror PUT 실패 시에도
    # 새 클라이언트는 이미 커밋된 immutable 객체를 계속 사용할 수 있다.
    upload_db_to_r2(
        gzip_path,
        r2_key=immutable_r2_key,
        cache_control="public, max-age=31536000, immutable",
    )
    upload_db_to_r2(
        manifest_path,
        r2_key=MANIFEST_R2_KEY,
        cache_control="no-cache, max-age=0",
        content_encoding=None,
    )
    upload_db_to_r2(gzip_path, r2_key=R2_KEY)
    log.info("✅ public DB와 manifest 게시 완료")


def main():
    parser = argparse.ArgumentParser(description="Publish verified crawl outputs")
    parser.add_argument("--dir", help="db.json/db.json.gz artifact 디렉토리")
    notify_group = parser.add_mutually_exclusive_group()
    notify_group.add_argument(
        "--notify-success",
        action="store_true",
        help="게시 없이 pipeline success 알림만 전송",
    )
    notify_group.add_argument(
        "--notify-failure",
        action="store_true",
        help="게시 없이 pipeline failure 알림만 전송",
    )
    args = parser.parse_args()

    if args.notify_success or args.notify_failure:
        send_notification(
            "success" if args.notify_success else "failure", args.dir
        )
        return
    if not args.dir:
        parser.error("--dir is required unless a notification flag is used")

    try:
        publish_outputs(args.dir)
    except Exception as error:
        log.error(f"❌ public 게시 실패: {type(error).__name__}")
        sys.exit(1)


if __name__ == "__main__":
    main()
