"""
R2 풀 DB 상태(State) 동기화 스크립트.

GitHub Actions 환경에서 이전 실행의 master.db(SQLite) 상태를 
내려받거나 최신 상태를 백업(업로드)한다.

Usage:
  python pipeline/sync_state.py download --dir ./pipeline/data
  python pipeline/sync_state.py upload --dir ./pipeline/data

환경변수:
  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2_BUCKET / CF_ACCOUNT_ID
"""

import argparse
import os
import sys

import boto3
from botocore.exceptions import ClientError

from log_setup import get_logger

log = get_logger(__name__)

R2_STATE_KEY = "bupgogae/state/master.db"


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


def download_state(data_dir: str):
    """R2에서 기존 master.db를 다운로드."""
    os.makedirs(data_dir, exist_ok=True)
    db_path = os.path.join(data_dir, "master.db")
    bucket = os.environ.get("R2_BUCKET")

    if not bucket:
        log.error("❌ R2_BUCKET 환경변수가 설정되지 않았습니다.")
        sys.exit(1)

    log.info(f"📥 다운로드 시작: R2({bucket}/{R2_STATE_KEY}) -> Local({db_path})")
    client = get_r2_client()

    try:
        client.download_file(bucket, R2_STATE_KEY, db_path)
        log.info("✅ 상태 파일 다운로드 완료.")
    except ClientError as e:
        if e.response['Error']['Code'] == "404" or e.response['Error']['Code'] == "NoSuchKey":
            log.warning("⚠️ 상태 파일(master.db)이 R2에 존재하지 않습니다. 초기 상태로 새로 생성합니다.")
        else:
            log.error(f"❌ R2 다운로드 오류 발생: {e}")
            sys.exit(1)
    except Exception as e:
        log.error(f"❌ R2 다운로드 알 수 없는 오류: {e}")
        sys.exit(1)


def upload_state(data_dir: str):
    """로컬의 갱신된 master.db를 R2에 업로드."""
    db_path = os.path.join(data_dir, "master.db")

    if not os.path.exists(db_path):
        log.error(f"❌ 업로드할 로컬 상태 파일이 없습니다: {db_path}")
        sys.exit(1)

    bucket = os.environ.get("R2_BUCKET")
    if not bucket:
        log.error("❌ R2_BUCKET 환경변수가 설정되지 않았습니다.")
        sys.exit(1)

    size_mb = os.path.getsize(db_path) / (1024 * 1024)
    log.info(f"📤 업로드 시작: Local({db_path}, {size_mb:.2f}MB) -> R2({bucket}/{R2_STATE_KEY})")
    
    # [Code Audit Fix] WAL 체크포인트 강제 실행 (동기화 누락 방지)
    # MasterDB는 PRAGMA journal_mode=WAL 을 사용하므로, 크래시 등으로 인해 
    # db.close() 가 정상 호출되지 않으면 최신 데이터가 -wal 파일에 남아있을 수 있음.
    # 업로드 직전 SQLite 연결을 맺고 wal_checkpoint 를 호출하여 master.db 단일 파일로 병합을 보장.
    import sqlite3
    try:
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
        conn.close()
        log.info("  ✅ 로컬 SQLite WAL Checkpoint (TRUNCATE) 완료")
    except Exception as e:
        log.warning(f"  ⚠️ SQLite WAL Checkpoint 실패 (무시됨): {e}")

    client = get_r2_client()
    try:
        client.upload_file(db_path, bucket, R2_STATE_KEY)
        log.info("✅ 상태 파일 업로드 완료.")
    except Exception as e:
        log.error(f"❌ R2 업로드 중 오류 발생: {e}")
        sys.exit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="State sync for master.db")
    parser.add_argument("action", choices=["download", "upload"], help="수행할 작업 (download/upload)")
    parser.add_argument("--dir", required=True, help="데이터 디렉토리 (master.db 가 위치한 경로)")

    args = parser.parse_args()

    if args.action == "download":
        download_state(args.dir)
    elif args.action == "upload":
        upload_state(args.dir)
