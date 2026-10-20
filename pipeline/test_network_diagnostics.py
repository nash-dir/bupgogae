"""Safe error graph and keyless probe regressions."""

import json
import socket
import unittest
from unittest import mock

import requests
import socks
from urllib3.exceptions import MaxRetryError, NewConnectionError

import network_diagnostics as diagnostic
from network_errors import network_error_detail


class NetworkDiagnosticsTests(unittest.TestCase):
    def test_nested_socks_error_emits_protocol_code_but_no_secret(self):
        secret = "https://www.law.go.kr/?OC=secret%40example.com"
        inner = socks.SOCKS5Error("0x04: " + secret)
        wrapped = NewConnectionError(None, secret)
        wrapped.__cause__ = inner
        error = requests.ConnectionError(MaxRetryError(None, secret, wrapped))
        detail = network_error_detail(error)
        self.assertIn("socks5_reply", detail["layers"])
        self.assertIn("socks_04", detail["codes"])
        self.assertNotIn("secret", json.dumps(detail))
        self.assertNotIn("law.go.kr", json.dumps(detail))

    def test_cycles_and_hostile_exception_text_are_not_rendered(self):
        class HostileError(OSError):
            def __str__(self):
                raise AssertionError("Must not render error")
        error = HostileError()
        error.__cause__ = error
        self.assertEqual(network_error_detail(error),
                         {"layers": ["unclassified"], "codes": []})
        self.assertIn("dns", network_error_detail(socket.gaierror()) ["layers"])
        self.assertIn("tls", network_error_detail(requests.exceptions.SSLError()) ["layers"])

    def test_probe_disables_ambient_credentials_redirects_and_body_reads(self):
        response = mock.MagicMock(status_code=302)
        response.__enter__.return_value = response
        session = mock.MagicMock()
        session.__enter__.return_value = session
        session.get.return_value = response
        with mock.patch.object(diagnostic.requests, "Session", return_value=session):
            result = diagnostic.probe("warp_remote_dns", "https_api")
        self.assertFalse(session.trust_env)
        args, kwargs = session.get.call_args
        self.assertNotIn("OC=", args[0])
        self.assertFalse(kwargs["allow_redirects"])
        self.assertTrue(kwargs["stream"])
        self.assertEqual(kwargs["timeout"], (8, 12))
        self.assertEqual(session.proxies["https"], diagnostic.WARP_LAW_PROXY)
        response.iter_content.assert_not_called()
        self.assertEqual(result["status"], 302)

    def test_probe_failure_contains_no_request_or_exception_text(self):
        session = mock.MagicMock()
        session.__enter__.return_value = session
        session.get.side_effect = requests.ConnectionError("OC=SECRET_TOKEN")
        with mock.patch.object(diagnostic.requests, "Session", return_value=session):
            result = diagnostic.probe("direct", "http_root")
        self.assertNotIn("SECRET_TOKEN", json.dumps(result))
        self.assertEqual(result["error"]["layers"], ["unclassified"])


if __name__ == "__main__":
    unittest.main()
