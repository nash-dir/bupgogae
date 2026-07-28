"""
R2 풀 DB 상태(State) 동기화 스크립트.

업로드는 generation 단위의 immutable 객체를 먼저 기록하고, 검증된 기존
current.json을 previous.json으로 보존한 뒤 current.json pointer를 마지막에
교체한다. 따라서 중간 업로드나 최신 generation 검증이 실패해도 직전의
완전한 generation으로 자동 복구할 수 있다.

Usage:
  python pipeline/sync_state.py download --dir ./pipeline/data
  python pipeline/sync_state.py upload --dir ./pipeline/data

환경변수:
  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2_BUCKET / CF_ACCOUNT_ID
"""

import argparse
from datetime import date, datetime, timezone
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
import uuid

import boto3
from botocore.exceptions import ClientError

from log_setup import get_logger
from manifest import MIN_CORE_KEYS

log = get_logger(__name__)

LEGACY_STATE_FILES = {
    "master.db": "bupgogae/state/master.db",
    "failed_dates.json": "bupgogae/state/failed_dates.json",
}
STATE_POINTER_KEY = "bupgogae/state/current.json"
PREVIOUS_STATE_POINTER_KEY = "bupgogae/state/previous.json"
STATE_GENERATION_PREFIX = "bupgogae/state/generations"
STATE_SCHEMA = 1
POINTER_MAX_BYTES = 64 * 1024
STATE_MODE_FILE = "state-mode.json"
MAX_MASTER_STATE_BYTES = 4 * 1024 * 1024 * 1024
MAX_BACKLOG_BYTES = 16 * 1024 * 1024
MAX_BACKLOG_ITEMS = 250_000
MAX_BACKLOG_PAGE = 1_000_000
MAX_BACKLOG_ATTEMPTS = 1_000_000
BACKLOG_MODES = {"incremental", "full_bootstrap"}
MIN_HEALTHY_PRECEDENTS = MIN_CORE_KEYS
EARLIEST_PRECEDENT_CUTOFF = "19600101"
REQUIRED_CASE_COLUMNS = {
    "serial",
    "case_name",
    "case_number",
    "case_number_clean",
    "date",
    "court",
}
_GENERATION_RE = re.compile(r"^[0-9]{8}T[0-9]{12}Z-[0-9a-f]{32}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def get_r2_client():
    """Cloudflare R2 S3 호환 클라이언트 반환."""
    account_id = os.environ.get("CF_ACCOUNT_ID")
    if not account_id:
        log.error("❌ CF_ACCOUNT_ID 환경변수가 설정되지 않았습니다.")
        sys.exit(1)

    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


def _client_error_code(error: ClientError) -> str:
    return str(error.response.get("Error", {}).get("Code", ""))


def _is_not_found(error: ClientError) -> bool:
    return _client_error_code(error) in {"404", "NoSuchKey", "NotFound"}


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_file(path: str, descriptor: dict):
    expected_size = descriptor["size"]
    if os.path.getsize(path) != expected_size:
        raise ValueError("state object size mismatch")
    if _sha256(path) != descriptor["sha256"]:
        raise ValueError("state object checksum mismatch")


def _verify_sqlite(path: str):
    """DB가 손상되지 않았고 crawler가 기대하는 cases schema를 갖는지 확인."""
    conn = sqlite3.connect(path)
    try:
        result = conn.execute("PRAGMA quick_check").fetchone()
        if result != ("ok",):
            raise sqlite3.DatabaseError("quick_check failed")
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(cases)").fetchall()
        }
        if not REQUIRED_CASE_COLUMNS.issubset(columns):
            raise sqlite3.DatabaseError("cases schema mismatch")
    finally:
        conn.close()


def _verify_incremental_health(path: str, today: date | None = None) -> dict:
    """증분 state가 충분한 역사/최근/헌재 범위를 보존하는지 확인."""
    today = today or date.today()
    conn = sqlite3.connect(path)
    try:
        precedent_count, oldest, newest = conn.execute(
            "SELECT COUNT(*), MIN(date), MAX(date) FROM cases "
            "WHERE serial NOT LIKE 'D%'"
        ).fetchone()
        detc_count = conn.execute(
            "SELECT COUNT(*) FROM cases WHERE serial LIKE 'D%'"
        ).fetchone()[0]
    finally:
        conn.close()

    if precedent_count < MIN_HEALTHY_PRECEDENTS:
        raise ValueError("insufficient_precedent_count")
    if not oldest or oldest > EARLIEST_PRECEDENT_CUTOFF:
        raise ValueError("historical_coverage_missing")
    recent_cutoff = f"{today.year - 2}0101"
    if not newest or newest < recent_cutoff:
        raise ValueError("recent_coverage_missing")
    if detc_count < 1:
        raise ValueError("detc_coverage_missing")
    return {
        "precedent_count": precedent_count,
        "detc_count": detc_count,
        "oldest": oldest,
        "newest": newest,
    }


def _valid_backlog_item(item) -> bool:
    if not isinstance(item, dict):
        return False
    attempts = item.get("attempts")
    last_error = item.get("last_error")
    if (
        isinstance(attempts, bool)
        or not isinstance(attempts, int)
        or not 0 <= attempts <= MAX_BACKLOG_ATTEMPTS
    ):
        return False
    if not isinstance(last_error, str) or len(last_error) > 200:
        return False

    if item.get("kind") == "detc":
        page = item.get("page")
        return (
            isinstance(page, int)
            and not isinstance(page, bool)
            and 1 <= page <= MAX_BACKLOG_PAGE
        )

    if item.get("kind") not in (None, "precedent"):
        return False
    start = item.get("start")
    end = item.get("end")
    if not isinstance(start, str) or not isinstance(end, str):
        return False
    if len(start) != 8 or len(end) != 8 or not start.isdigit() or not end.isdigit():
        return False
    try:
        start_date = datetime.strptime(start, "%Y%m%d")
        end_date = datetime.strptime(end, "%Y%m%d")
    except ValueError:
        return False
    if start_date > end_date:
        return False
    failed_pages = item.get("failed_pages")
    if not isinstance(failed_pages, list):
        return False
    return all(
        isinstance(page, int)
        and not isinstance(page, bool)
        and 1 <= page <= MAX_BACKLOG_PAGE
        for page in failed_pages
    )


def _valid_legacy_backlog_item(item) -> bool:
    """crawler가 migration할 수 있는 v1 top-level list 항목인지 확인."""
    if isinstance(item, (list, tuple)) and len(item) == 2:
        item = {"start": item[0], "end": item[1]}
    if not isinstance(item, dict):
        return False
    normalized = dict(item)
    normalized.setdefault("attempts", 0)
    normalized.setdefault("last_error", "legacy_state")
    try:
        normalized["attempts"] = int(normalized["attempts"])
    except (TypeError, ValueError):
        return False
    normalized["last_error"] = str(normalized["last_error"])[:200]
    if normalized.get("kind") == "detc":
        page = normalized.get("page")
        if isinstance(page, bool) or not str(page).isdigit():
            return False
        normalized["page"] = int(page)
    else:
        normalized.setdefault("failed_pages", [])
        pages = normalized["failed_pages"]
        if not isinstance(pages, list):
            return False
        if any(isinstance(page, bool) or not str(page).isdigit() for page in pages):
            return False
        normalized["failed_pages"] = [int(page) for page in pages]
    return _valid_backlog_item(normalized)


def _verify_backlog(path: str, *, allow_legacy_list: bool = False):
    size = os.path.getsize(path)
    if not 1 <= size <= MAX_BACKLOG_BYTES:
        raise ValueError("backlog size exceeds safety limit")
    with open(path, encoding="utf-8") as stream:
        payload = json.load(stream)
    if isinstance(payload, list) and allow_legacy_list:
        items = payload
        validator = _valid_legacy_backlog_item
    elif isinstance(payload, dict) and payload.get("schema") == 2:
        mode = payload.get("mode", "incremental")
        if not isinstance(mode, str) or mode not in BACKLOG_MODES:
            raise ValueError("unsupported backlog mode")
        items = payload.get("backlog")
        validator = _valid_backlog_item
    else:
        raise ValueError("unsupported backlog schema")
    if (
        not isinstance(items, list)
        or len(items) > MAX_BACKLOG_ITEMS
        or not all(
            validator(item) for item in items
        )
    ):
        raise ValueError("invalid backlog item")


def _write_state_mode(data_dir: str, mode: str, generation: str | None = None):
    path = os.path.join(data_dir, STATE_MODE_FILE)
    temp_path = path + ".tmp"
    payload = {"schema": 1, "mode": mode}
    if generation is not None:
        payload["generation"] = generation
    with open(temp_path, "w", encoding="utf-8") as stream:
        json.dump(payload, stream, separators=(",", ":"))
    os.replace(temp_path, path)


def _create_verified_snapshot(db_path: str) -> str:
    """live DB와 WAL을 포함하는 일관된 단일 SQLite backup을 생성."""
    data_dir = os.path.dirname(os.path.abspath(db_path))
    handle = tempfile.NamedTemporaryFile(
        prefix=".master-state-",
        suffix=".db",
        dir=data_dir,
        delete=False,
    )
    snapshot_path = handle.name
    handle.close()

    source = None
    destination = None
    try:
        source = sqlite3.connect(db_path, timeout=30)
        destination = sqlite3.connect(snapshot_path)
        source.backup(destination)
        destination.commit()
        destination.close()
        destination = None
        source.close()
        source = None
        _verify_sqlite(snapshot_path)
        return snapshot_path
    except Exception:
        if os.path.exists(snapshot_path):
            os.remove(snapshot_path)
        raise
    finally:
        if destination is not None:
            destination.close()
        if source is not None:
            source.close()


def _descriptor(key: str, path: str, max_size: int) -> dict:
    size = os.path.getsize(path)
    if not 1 <= size <= max_size:
        raise ValueError("state object size exceeds upload limit")
    return {
        "key": key,
        "size": size,
        "sha256": _sha256(path),
    }


def _validate_descriptor(value, expected_key: str, max_size: int) -> dict:
    if not isinstance(value, dict):
        raise ValueError("state descriptor missing")
    if value.get("key") != expected_key:
        raise ValueError("unexpected state key")
    size = value.get("size")
    digest = value.get("sha256")
    if (
        isinstance(size, bool)
        or not isinstance(size, int)
        or not 1 <= size <= max_size
    ):
        raise ValueError("invalid state size")
    if not isinstance(digest, str) or not _SHA256_RE.fullmatch(digest):
        raise ValueError("invalid state checksum")
    return {"key": expected_key, "size": size, "sha256": digest}


def _validate_pointer(payload) -> dict:
    if not isinstance(payload, dict) or payload.get("schema") != STATE_SCHEMA:
        raise ValueError("unsupported state pointer")
    generation = payload.get("generation")
    if not isinstance(generation, str) or not _GENERATION_RE.fullmatch(generation):
        raise ValueError("invalid state generation")

    generation_prefix = f"{STATE_GENERATION_PREFIX}/{generation}"
    master = _validate_descriptor(
        payload.get("master"),
        f"{generation_prefix}/master.db",
        MAX_MASTER_STATE_BYTES,
    )
    backlog_value = payload.get("backlog")
    backlog = None
    if backlog_value is not None:
        backlog = _validate_descriptor(
            backlog_value,
            f"{generation_prefix}/failed_dates.json",
            MAX_BACKLOG_BYTES,
        )
    return {
        "schema": STATE_SCHEMA,
        "generation": generation,
        "master": master,
        "backlog": backlog,
    }


def _read_pointer_key(client, bucket: str, key: str):
    """bounded pointer 객체를 읽고 schema/key/checksum descriptor를 검증."""
    try:
        response = client.get_object(Bucket=bucket, Key=key)
    except ClientError as error:
        if _is_not_found(error):
            return None
        raise

    stream = response["Body"]
    try:
        body = stream.read(POINTER_MAX_BYTES + 1)
    finally:
        stream.close()
    if len(body) > POINTER_MAX_BYTES:
        raise ValueError("state pointer too large")
    return _validate_pointer(json.loads(body.decode("utf-8")))


def _read_pointer(client, bucket: str):
    return _read_pointer_key(client, bucket, STATE_POINTER_KEY)


def _read_previous_pointer(client, bucket: str):
    return _read_pointer_key(client, bucket, PREVIOUS_STATE_POINTER_KEY)


def _put_pointer(client, bucket: str, key: str, pointer: dict):
    """검증되고 bounded된 pointer만 commit object로 기록."""
    _validate_pointer(pointer)
    body = json.dumps(
        pointer, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    if len(body) > POINTER_MAX_BYTES:
        raise ValueError("state pointer too large")
    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ContentType="application/json",
        CacheControl="no-store",
    )


def _download_to_temp(client, bucket: str, descriptor: dict,
                      data_dir: str, suffix: str) -> str:
    handle = tempfile.NamedTemporaryFile(
        prefix=".state-download-",
        suffix=suffix,
        dir=data_dir,
        delete=False,
    )
    temp_path = handle.name
    handle.close()
    try:
        head = client.head_object(Bucket=bucket, Key=descriptor["key"])
        if head.get("ContentLength") != descriptor["size"]:
            raise ValueError("state object remote size mismatch")
        client.download_file(bucket, descriptor["key"], temp_path)
        _verify_file(temp_path, descriptor)
        return temp_path
    except Exception:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise


def _activate_local_state(data_dir: str, master_temp: str,
                          backlog_temp: str | None):
    """consumer 실행 전에 backlog를 먼저, master를 마지막에 교체."""
    master_path = os.path.join(data_dir, "master.db")
    backlog_path = os.path.join(data_dir, "failed_dates.json")
    if backlog_temp is None:
        if os.path.exists(backlog_path):
            os.remove(backlog_path)
    else:
        os.replace(backlog_temp, backlog_path)
    os.replace(master_temp, master_path)


def _download_generation(client, bucket: str, data_dir: str, pointer: dict):
    master_temp = None
    backlog_temp = None
    try:
        master_temp = _download_to_temp(
            client, bucket, pointer["master"], data_dir, ".db"
        )
        _verify_sqlite(master_temp)
        if pointer["backlog"] is not None:
            backlog_temp = _download_to_temp(
                client, bucket, pointer["backlog"], data_dir, ".json"
            )
            _verify_backlog(backlog_temp)
        _activate_local_state(data_dir, master_temp, backlog_temp)
        master_temp = None
        backlog_temp = None
    finally:
        for temp_path in (master_temp, backlog_temp):
            if temp_path and os.path.exists(temp_path):
                os.remove(temp_path)


def _download_legacy_state(client, bucket: str, data_dir: str,
                           allow_empty_bootstrap: bool):
    master_handle = tempfile.NamedTemporaryFile(
        prefix=".legacy-state-", suffix=".db", dir=data_dir, delete=False
    )
    master_temp = master_handle.name
    master_handle.close()
    backlog_temp = None
    try:
        try:
            master_head = client.head_object(
                Bucket=bucket, Key=LEGACY_STATE_FILES["master.db"]
            )
            master_size = master_head.get("ContentLength")
            if (
                isinstance(master_size, bool)
                or not isinstance(master_size, int)
                or not 1 <= master_size <= MAX_MASTER_STATE_BYTES
            ):
                raise ValueError("legacy master size exceeds safety limit")
            client.download_file(
                bucket, LEGACY_STATE_FILES["master.db"], master_temp
            )
            if os.path.getsize(master_temp) != master_size:
                raise ValueError("legacy master size changed during download")
        except ClientError as error:
            if not _is_not_found(error):
                raise
            if not allow_empty_bootstrap:
                raise RuntimeError(
                    "master state is missing; explicit bootstrap required"
                ) from error
            os.remove(master_temp)
            for filename in ("master.db", "failed_dates.json"):
                local_path = os.path.join(data_dir, filename)
                if os.path.exists(local_path):
                    os.remove(local_path)
            log.warning("⚠️ 명시적 empty bootstrap 모드 — 기준 DB 없이 시작")
            return

        # Legacy에는 원격 checksum이 없지만 SQLite 구조/무결성은 반드시 확인한다.
        _verify_sqlite(master_temp)

        backlog_handle = tempfile.NamedTemporaryFile(
            prefix=".legacy-state-", suffix=".json", dir=data_dir, delete=False
        )
        backlog_temp = backlog_handle.name
        backlog_handle.close()
        try:
            backlog_head = client.head_object(
                Bucket=bucket,
                Key=LEGACY_STATE_FILES["failed_dates.json"],
            )
            backlog_size = backlog_head.get("ContentLength")
            if (
                isinstance(backlog_size, bool)
                or not isinstance(backlog_size, int)
                or not 1 <= backlog_size <= MAX_BACKLOG_BYTES
            ):
                raise ValueError("legacy backlog size exceeds safety limit")
            client.download_file(
                bucket,
                LEGACY_STATE_FILES["failed_dates.json"],
                backlog_temp,
            )
            if os.path.getsize(backlog_temp) != backlog_size:
                raise ValueError("legacy backlog size changed during download")
            _verify_backlog(backlog_temp, allow_legacy_list=True)
        except ClientError as error:
            if not _is_not_found(error):
                raise
            os.remove(backlog_temp)
            backlog_temp = None

        _activate_local_state(data_dir, master_temp, backlog_temp)
        master_temp = None
        backlog_temp = None
    finally:
        for temp_path in (master_temp, backlog_temp):
            if temp_path and os.path.exists(temp_path):
                os.remove(temp_path)


def download_state(data_dir: str, allow_empty_bootstrap: bool = False):
    """current, previous 순서로 완전한 state pair를 검증해 활성화."""
    os.makedirs(data_dir, exist_ok=True)
    bucket = os.environ.get("R2_BUCKET")
    if not bucket:
        log.error("❌ R2_BUCKET 환경변수가 설정되지 않았습니다.")
        sys.exit(1)

    client = get_r2_client()
    try:
        current_missing = False
        current_error = None
        try:
            pointer = _read_pointer(client, bucket)
            current_missing = pointer is None
            if pointer is not None:
                _download_generation(client, bucket, data_dir, pointer)
        except Exception as error:
            current_error = error
        else:
            if pointer is not None:
                _write_state_mode(data_dir, "resume", pointer["generation"])
                log.info(
                    "✅ 상태 generation 다운로드 완료: "
                    f"{pointer['generation']}"
                )
                return

        # current pointer 자체나 generation pair가 깨진 경우에도, 별도로
        # 보존한 직전 pointer를 같은 bounded/schema/checksum 절차로 검증한다.
        previous = None
        try:
            previous = _read_previous_pointer(client, bucket)
            if previous is not None:
                _download_generation(client, bucket, data_dir, previous)
        except Exception:
            # 이전 pointer/generation도 검증되지 않으면 legacy나 로컬 일부를
            # 섞지 않고 전체 다운로드를 fail closed 한다.
            raise
        if previous is not None:
            _write_state_mode(data_dir, "resume", previous["generation"])
            log.warning(
                "⚠️ current state 검증 실패 — 직전 generation 복구 완료: "
                f"{previous['generation']}"
            )
            return

        if current_missing and previous is None:
            log.warning("⚠️ state pointer 없음 — legacy fixed-key 상태 확인")
            _download_legacy_state(
                client, bucket, data_dir, allow_empty_bootstrap
            )
            mode = (
                "legacy" if os.path.exists(os.path.join(data_dir, "master.db"))
                else "full-bootstrap"
            )
            _write_state_mode(data_dir, mode)
            return

        if current_error is not None:
            raise current_error
        raise RuntimeError("no valid state generation")
    except Exception as error:
        # ClientError/JSONDecodeError에도 URL이나 credential이 섞인 원문은 남기지 않는다.
        log.error(f"❌ R2 상태 다운로드 실패: {type(error).__name__}")
        sys.exit(1)


def _generation_id() -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return f"{timestamp}-{uuid.uuid4().hex}"


def upload_state(data_dir: str, *, allow_partial_bootstrap: bool = False):
    """검증된 snapshot/backlog generation을 올리고 pointer를 마지막에 게시."""
    db_path = os.path.join(data_dir, "master.db")
    backlog_path = os.path.join(data_dir, "failed_dates.json")
    if not os.path.exists(db_path):
        log.error(f"❌ 업로드할 로컬 상태 파일이 없습니다: {db_path}")
        sys.exit(1)

    bucket = os.environ.get("R2_BUCKET")
    if not bucket:
        log.error("❌ R2_BUCKET 환경변수가 설정되지 않았습니다.")
        sys.exit(1)

    snapshot_path = None
    try:
        # SQLite backup API는 source WAL의 committed page를 포함한 일관된
        # 단일 파일을 만든다. checkpoint 실패를 무시하고 live file을 올리지 않는다.
        snapshot_path = _create_verified_snapshot(db_path)
        try:
            _verify_incremental_health(snapshot_path)
        except ValueError as error:
            if not allow_partial_bootstrap:
                raise
            # 이 예외는 신뢰된 수동 full-bootstrap 입력으로만 열어야 한다.
            # backlog/state-mode 같은 비신뢰 artifact 내용으로 추론하지 않는다.
            log.warning(
                "⚠️ 명시적 partial bootstrap state 업로드: "
                f"{str(error)}"
            )
        if os.path.exists(backlog_path):
            _verify_backlog(backlog_path)

        generation = _generation_id()
        generation_prefix = f"{STATE_GENERATION_PREFIX}/{generation}"
        master_key = f"{generation_prefix}/master.db"
        backlog_key = f"{generation_prefix}/failed_dates.json"
        master_descriptor = _descriptor(
            master_key, snapshot_path, MAX_MASTER_STATE_BYTES
        )
        backlog_descriptor = (
            _descriptor(backlog_key, backlog_path, MAX_BACKLOG_BYTES)
            if os.path.exists(backlog_path)
            else None
        )
        pointer = {
            "schema": STATE_SCHEMA,
            "generation": generation,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "master": master_descriptor,
            "backlog": backlog_descriptor,
        }

        client = get_r2_client()
        client.upload_file(snapshot_path, bucket, master_key)
        if backlog_descriptor is not None:
            client.upload_file(backlog_path, bucket, backlog_key)

        # 새 commit 직전의 검증된 current를 독립 pointer로 보존한다. 이
        # 기록이 실패하면 current도 바꾸지 않아 rollback 경로를 잃지 않는다.
        current_pointer = _read_pointer(client, bucket)
        if current_pointer is not None:
            _put_pointer(
                client,
                bucket,
                PREVIOUS_STATE_POINTER_KEY,
                current_pointer,
            )

        # Commit point: generation과 previous 기록이 모두 성공한 뒤에만
        # current generation을 교체한다.
        _put_pointer(client, bucket, STATE_POINTER_KEY, pointer)
        log.info(f"✅ 상태 generation 업로드 완료: {generation}")
    except Exception as error:
        log.error(f"❌ R2 상태 업로드 실패: {type(error).__name__}")
        sys.exit(1)
    finally:
        if snapshot_path and os.path.exists(snapshot_path):
            os.remove(snapshot_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="State sync for master.db")
    parser.add_argument(
        "action", choices=["download", "upload"], help="수행할 작업"
    )
    parser.add_argument(
        "--dir", required=True, help="데이터 디렉토리 (master.db 위치)"
    )
    parser.add_argument(
        "--allow-empty-bootstrap",
        action="store_true",
        help="download에서 원격 master가 없을 때만 명시적으로 빈 초기화 허용",
    )
    parser.add_argument(
        "--allow-partial-bootstrap",
        action="store_true",
        help="upload에서 수동 full bootstrap 재개용 불완전 state만 명시 허용",
    )
    args = parser.parse_args()

    if args.action == "download":
        if args.allow_partial_bootstrap:
            parser.error("--allow-partial-bootstrap is only valid for upload")
        download_state(args.dir, allow_empty_bootstrap=args.allow_empty_bootstrap)
    else:
        upload_state(
            args.dir,
            allow_partial_bootstrap=args.allow_partial_bootstrap,
        )
