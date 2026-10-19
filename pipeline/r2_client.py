"""One R2 client configuration for state and public-object operations."""
import os

import boto3


def get_r2_client():
    account_id = os.environ.get("CF_ACCOUNT_ID")
    if not account_id:
        raise SystemExit("CF_ACCOUNT_ID is required")
    return boto3.client("s3", endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
                        region_name="auto", aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
                        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"))
