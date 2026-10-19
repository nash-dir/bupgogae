"""R2 signing must not inherit an unrelated ambient AWS region."""
import unittest
from unittest import mock

import sync_state
import upload_r2
import r2_client


class R2RegionTests(unittest.TestCase):
    def test_explicit_auto_region_for_state_download_and_upload_client(self):
        with mock.patch.dict(sync_state.os.environ, {"CF_ACCOUNT_ID": "test-account",
                                                    "AWS_DEFAULT_REGION": "ap-northeast-2"}), \
                mock.patch.object(r2_client.boto3, "client") as client:
            sync_state.get_r2_client()
            upload_r2.get_r2_client()
        self.assertEqual(client.call_count, 2)
        for call in client.call_args_list:
            self.assertEqual(call.kwargs["region_name"], "auto")
            self.assertEqual(call.kwargs["endpoint_url"],
                             "https://test-account.r2.cloudflarestorage.com")


if __name__ == "__main__":
    unittest.main()
