"""Law-only WARP routing, remote DNS and fail-closed transport regression."""

import os
import socket
import socketserver
import threading
import unittest
from unittest import mock

import api


class RejectingSocks(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(3)
        stream = self.request.makefile("rb")
        version, count = stream.read(2)
        self.server.greetings.append((version, stream.read(count)))
        self.request.sendall(b"\x05\x00")
        version, command, reserved, address_type = stream.read(4)
        if address_type != 3:
            raise AssertionError("SOCKS must send a hostname, not resolve locally")
        length = stream.read(1)[0]
        host = stream.read(length).decode("ascii")
        port = int.from_bytes(stream.read(2), "big")
        self.server.destinations.append((version, command, reserved, host, port))
        # Controlled remote-unreachable response. Never connects externally.
        self.request.sendall(b"\x05\x04\x00\x01\x7f\x00\x00\x01\x00\x00")
        stream.close()


class LawProxyTests(unittest.TestCase):
    def setUp(self):
        self.previous_session = api._session
        api._session = None
        self.env = mock.patch.dict(os.environ, {}, clear=True)
        self.env.start()
        api.reset_network_stats()

    def tearDown(self):
        if api._session is not None:
            api._session.close()
        api._session = self.previous_session
        self.env.stop()
        api.reset_network_stats()

    def test_default_session_preserves_local_developer_behavior(self):
        session = api._get_session()
        self.assertTrue(session.trust_env)
        self.assertEqual(session.proxies, {})

    def test_proxy_is_law_only_and_ambient_env_cannot_bypass_it(self):
        os.environ.update({
            "BUPGOGAE_LAW_PROXY": api.WARP_LAW_PROXY,
            "HTTPS_PROXY": "http://unapproved.invalid:9999",
            "NO_PROXY": "*",
        })
        session = api._get_session()
        self.assertFalse(session.trust_env)
        self.assertEqual(session.proxies, {"https://www.law.go.kr": api.WARP_LAW_PROXY})
        law = session.merge_environment_settings(
            "https://www.law.go.kr/DRF/lawSearch.do", {}, None, None, None,
        )
        self.assertEqual(law["proxies"], session.proxies)
        from requests.utils import select_proxy
        self.assertIsNone(select_proxy("https://r2.example.invalid", session.proxies))
        self.assertEqual(
            select_proxy("https://www.law.go.kr/DRF/lawSearch.do", law["proxies"]),
            api.WARP_LAW_PROXY,
        )

    def test_unapproved_proxy_rejected_before_session_creation(self):
        for proxy in ("http://127.0.0.1:40000", "socks5h://remote.invalid:40000",
                      "socks5h://secret:password@127.0.0.1:40000"):
            with self.subTest(proxy=proxy):
                os.environ["BUPGOGAE_LAW_PROXY"] = proxy
                with self.assertRaises(ValueError) as caught:
                    api._get_session()
                self.assertNotIn(proxy, str(caught.exception))
                self.assertIsNone(api._session)

    def test_real_socks_remote_dns_failure_never_falls_back_directly(self):
        with socketserver.TCPServer(("127.0.0.1", 0), RejectingSocks) as server:
            server.greetings = []
            server.destinations = []
            proxy = f"socks5h://127.0.0.1:{server.server_address[1]}"
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            original_getaddrinfo = socket.getaddrinfo

            def local_dns_only(host, *args, **kwargs):
                self.assertEqual(host, "127.0.0.1")
                return original_getaddrinfo(host, *args, **kwargs)

            try:
                with mock.patch.object(api, "WARP_LAW_PROXY", proxy), \
                     mock.patch.dict(os.environ, {"BUPGOGAE_LAW_PROXY": proxy,
                                                 "NO_PROXY": "*"}), \
                     mock.patch("socket.getaddrinfo", side_effect=local_dns_only), \
                     mock.patch.object(api.time, "sleep") as sleep:
                    self.assertIsNone(api.fetch_xml_safe(date_str="20261011"))
                    self.assertEqual([call.args[0] for call in sleep.call_args_list],
                                     [5, 10, 20, 40])
                    self.assertEqual(api.get_network_stats(), {
                        "requests": 1, "attempts": 5, "success": 0,
                        "retries": 4, "failures": 1,
                    })
                self.assertEqual(server.destinations,
                                 [(5, 1, 0, "www.law.go.kr", 443)] * 5)
                self.assertEqual(server.greetings, [(5, b"\x00")] * 5)
            finally:
                server.shutdown()
                thread.join(timeout=3)
