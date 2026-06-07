"""
R2 풀 DB 업로더 — db.json.gz를 Cloudflare R2에 PUT.

Usage:
  python upload_r2.py /app/data/db.json.gz
  python upload_r2.py --dry /app/data/db.json.gz

환경변수:
  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2_BUCKET / CF_ACCOUNT_ID

[보안 참고]
  유일한 외부 통신: Cloudflare R2 S3 호환 API (PUT 업로드만).
  인증 정보는 환경변수로 주입되며 코드에 하드코딩되지 않음.
  사용자 데이터를 포함하지 않음 — 공공 판례 DB 파일만 업로드.
"""

import argparse
import os
import sys

import boto3

from log_setup import get_logger

log = get_logger(__name__)

R2_KEY = "bupgogae/db.json.gz"


def get_r2_client():
    """Cloudflare R2 S3 클라이언트."""
    account_id = os.environ["CF_ACCOUNT_ID"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    )


def upload_db_to_r2(gz_path: str, dry: bool = False, r2_key: str = None,
                    cache_control: str = "public, max-age=3600",
                    content_encoding: str = "gzip"):
    """파일을 R2에 업로드 (기본값은 gzip DB 업로드 동작 그대로).

    cache_control / content_encoding을 덮어써 manifest.json처럼
    비압축·no-cache로 게시해야 하는 파일도 같은 경로로 업로드한다.
    content_encoding=None이면 ContentEncoding 헤더를 생략한다.
    """
    if not os.path.exists(gz_path):
        log.error(f"❌ 파일 없음: {gz_path}")
        sys.exit(1)

    key = r2_key or R2_KEY
    size_mb = os.path.getsize(gz_path) / (1024 * 1024)
    bucket = os.environ["R2_BUCKET"]

    log.info(f"\n{'─'*50}")
    log.info(f"  📤 R2 Upload")
    log.info(f"     파일: {gz_path} ({size_mb:.2f} MB)")
    log.info(f"     버킷: {bucket}/{key}")
    log.info(f"{'─'*50}")

    if dry:
        log.info("  [DRY-RUN] 업로드 스킵")
        return

    client = get_r2_client()

    extra_args = {
        "ContentType": "application/json",
        "CacheControl": cache_control,
    }
    if content_encoding:
        extra_args["ContentEncoding"] = content_encoding

    client.upload_file(gz_path, bucket, key, ExtraArgs=extra_args)

    log.info(f"  ✅ 업로드 완료: {key}")


def ensure_cors():
    """R2 버킷 CORS 규칙 설정 (멱등)."""
    client = get_r2_client()
    bucket = os.environ["R2_BUCKET"]
    try:
        client.put_bucket_cors(
            Bucket=bucket,
            CORSConfiguration={
                "CORSRules": [{
                    "AllowedOrigins": ["*"],
                    "AllowedMethods": ["GET", "HEAD"],
                    "AllowedHeaders": ["*"],
                    "MaxAgeSeconds": 3600,
                }]
            },
        )
        log.info("  ✅ CORS 설정 완료")
    except Exception as e:
        log.warning(f"  ⚠️ CORS 설정 실패 (무시): {e}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="R2 DB Uploader")
    parser.add_argument("file", help="db.json.gz 경로")
    parser.add_argument("--dry", action="store_true", help="Dry-run")
    args = parser.parse_args()

    upload_db_to_r2(args.file, dry=args.dry)
