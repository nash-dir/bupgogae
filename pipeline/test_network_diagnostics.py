"""Safe error graph and keyless probe regressions."""

import io
import json
import runpy
import sys
import socket
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import requests
import socks
from urllib3.exceptions import MaxRetryError, NewConnectionError

import network_diagnostics as diagnostic
from network_errors import network_error_detail


class NetworkDiagnosticsTests(unittest.TestCase):
    def test_daily_preflight_uses_one_keyless_https_probe_and_full_mode_is_explicit(self):
        with mock.patch.object(diagnostic, "probe", return_value={}) as probe, \
                mock.patch("builtins.print"):
            diagnostic.main()
            probe.assert_called_once_with("warp_local_dns", "https_api")
            probe.reset_mock()
            diagnostic.main(full=True)
            self.assertEqual(probe.call_count, 9)

    def test_select_route_uses_only_https_api_and_stops_at_first_200(self):
        with mock.patch.object(diagnostic, "probe", side_effect=[{"status": 200}]) as probe, \
                mock.patch("builtins.print"):
            self.assertEqual(diagnostic.select_route(("warp_local_dns", "warp_remote_dns")), "warp_local_dns")
            probe.assert_called_once_with("warp_local_dns", "https_api")
        with mock.patch.object(diagnostic, "probe", side_effect=[{"error": {}}, {"status": 200}]) as probe, \
                mock.patch("builtins.print"):
            self.assertEqual(diagnostic.select_route(("warp_local_dns", "warp_remote_dns")), "warp_remote_dns")
            self.assertEqual(probe.call_args_list,
                             [mock.call("warp_local_dns", "https_api"), mock.call("warp_remote_dns", "https_api")])

    def test_redirect_http_error_and_transport_error_do_not_select_a_route(self):
        for result in ({"status": 301}, {"status": 302}, {"status": 403}, {"status": 503},
                       {"error": {"layers": ["socks5_reply"], "codes": ["socks_04"]}}):
            with self.subTest(result=result), mock.patch.object(diagnostic, "probe", return_value=result), \
                    mock.patch("builtins.print"):
                self.assertIsNone(diagnostic.select_route(("direct",)))

    def test_direct_success_outputs_empty_proxy_and_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "github-output"
            output.write_text("existing=value\n", encoding="utf-8")
            with mock.patch.object(diagnostic, "probe", return_value={"status": 200}) as probe, \
                    mock.patch("builtins.print"):
                diagnostic.configure_route("direct", output)
            probe.assert_called_once_with("direct", "https_api")
            self.assertEqual(dict(line.split("=", 1) for line in output.read_text().splitlines()),
                             {"existing": "value", "needs_warp": "false", "route": "direct", "proxy": ""})

    def test_direct_failure_requests_warp_without_publishing_a_route(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "github-output"
            with mock.patch.object(diagnostic, "probe", return_value={"status": 403}) as probe, \
                    mock.patch("builtins.print"):
                diagnostic.configure_route("direct", output)
            probe.assert_called_once_with("direct", "https_api")
            self.assertEqual(output.read_text().splitlines(), ["needs_warp=true"])

    def test_warp_outputs_the_first_reachable_dns_mode(self):
        for statuses, route, proxy_url in (
                ([200], "warp_local_dns", "socks5://127.0.0.1:40000"),
                ([503, 200], "warp_remote_dns", "socks5h://127.0.0.1:40000")):
            with self.subTest(route=route), tempfile.TemporaryDirectory() as folder:
                output = Path(folder) / "github-output"
                with mock.patch.object(diagnostic, "probe", side_effect=[{"status": v} for v in statuses]) as probe, \
                        mock.patch("builtins.print"):
                    diagnostic.configure_route("warp", output)
                self.assertEqual(probe.call_args_list,
                                 [mock.call(v, "https_api") for v in ("warp_local_dns", "warp_remote_dns")[:len(statuses)]])
                self.assertEqual(dict(line.split("=", 1) for line in output.read_text().splitlines()),
                                 {"needs_warp": "false", "route": route, "proxy": proxy_url})

    def test_unreachable_warp_fails_without_success_outputs_or_reading_credentials(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "github-output"
            with mock.patch.object(diagnostic, "probe", return_value={"error": {}}) as probe, \
                    mock.patch("os.getenv", side_effect=AssertionError("Must not read credentials")), \
                    mock.patch("builtins.print"), \
                    self.assertRaisesRegex(RuntimeError, "^No reachable law HTTPS route$"):
                diagnostic.configure_route("warp", output)
            self.assertEqual(probe.call_args_list,
                             [mock.call("warp_local_dns", "https_api"), mock.call("warp_remote_dns", "https_api")])
            self.assertTrue(not output.exists() or output.read_text() == "")

    def test_cli_direct_failure_exits_normally_but_unreachable_warp_exits_one(self):
        for group in ("direct", "warp"):
            with self.subTest(group=group), tempfile.TemporaryDirectory() as folder:
                output = Path(folder) / "github-output"
                session = mock.MagicMock()
                session.__enter__.return_value = session
                session.get.side_effect = requests.ConnectionError("OC=SECRET_TOKEN")
                stdout, stderr = io.StringIO(), io.StringIO()
                with mock.patch.object(sys, "argv", ["network_diagnostics.py", "--select", group,
                                                      "--output-file", str(output)]), \
                        mock.patch.object(diagnostic.requests, "Session", return_value=session), \
                        mock.patch.object(sys, "stdout", stdout), mock.patch.object(sys, "stderr", stderr):
                    if group == "warp":
                        with self.assertRaises(SystemExit) as caught:
                            runpy.run_path(str(Path(diagnostic.__file__)), run_name="__main__")
                        self.assertEqual(caught.exception.code, 1)
                    else:
                        runpy.run_path(str(Path(diagnostic.__file__)), run_name="__main__")
                self.assertNotIn("SECRET_TOKEN", stdout.getvalue() + stderr.getvalue())
                if group == "warp":
                    self.assertEqual(stderr.getvalue(), "No reachable law HTTPS route\n")
                    self.assertFalse(output.exists())
                else:
                    self.assertEqual(stderr.getvalue(), "")
                    self.assertEqual(output.read_text().splitlines(), ["needs_warp=true"])

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
        self.assertEqual(session.proxies["https"], "socks5h://127.0.0.1:40000")
        response.iter_content.assert_not_called()
        self.assertEqual(result["status"], 302)

    def test_route_labels_use_distinct_dns_modes(self):
        for route, expected in (("warp_local_dns", "socks5://127.0.0.1:40000"),
                                ("warp_remote_dns", "socks5h://127.0.0.1:40000")):
            with self.subTest(route=route):
                session = mock.MagicMock()
                session.__enter__.return_value = session
                with mock.patch.object(diagnostic.requests, "Session", return_value=session):
                    result = diagnostic.probe(route, "https_api")
                self.assertEqual(result["route"], route)
                self.assertEqual(session.proxies, {"http": expected, "https": expected})

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
