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


def upload_db_to_r2(gz_path: str, dry: bool = False, r2_key: str = None):
    """db.json.gz를 R2에 업로드."""
    if not os.path.exists(gz_path):
        print(f"❌ 파일 없음: {gz_path}")
        sys.exit(1)

    key = r2_key or R2_KEY
    size_mb = os.path.getsize(gz_path) / (1024 * 1024)
    bucket = os.environ["R2_BUCKET"]

    print(f"\n{'─'*50}")
    print(f"  📤 R2 Upload")
    print(f"     파일: {gz_path} ({size_mb:.2f} MB)")
    print(f"     버킷: {bucket}/{key}")
    print(f"{'─'*50}")

    if dry:
        print("  [DRY-RUN] 업로드 스킵")
        return

    client = get_r2_client()

    client.upload_file(
        gz_path, bucket, key,
        ExtraArgs={
            "ContentType": "application/json",
            "ContentEncoding": "gzip",
            "CacheControl": "public, max-age=3600",
        },
    )

    print(f"  ✅ 업로드 완료: {key}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="R2 DB Uploader")
    parser.add_argument("file", help="db.json.gz 경로")
    parser.add_argument("--dry", action="store_true", help="Dry-run")
    args = parser.parse_args()

    upload_db_to_r2(args.file, dry=args.dry)
