"""Bounded, allowlisted network error metadata; never serialize a request or URL."""

import errno
import re
import socket
import ssl

import requests
import socks
from urllib3 import exceptions as ue


def network_error_detail(error):
    """Walk wrapped transport errors without rendering their secret-bearing text."""
    pending = [error]
    seen = set()
    kinds = set()
    codes = set()
    known = (
        (requests.exceptions.SSLError, "tls"),
        (ssl.SSLCertVerificationError, "tls_certificate"),
        (ssl.SSLError, "tls"),
        (requests.exceptions.ConnectTimeout, "connect_timeout"),
        (requests.exceptions.ReadTimeout, "read_timeout"),
        (requests.exceptions.ProxyError, "proxy"),
        (socks.ProxyConnectionError, "proxy_connect"),
        (socks.SOCKS5Error, "socks5_reply"),
        (socks.GeneralProxyError, "socks_transport"),
        (socket.gaierror, "dns"),
        (TimeoutError, "socket_timeout"),
        (ConnectionRefusedError, "refused"),
        (ConnectionResetError, "reset"),
        (ue.NameResolutionError, "dns"),
        (ue.NewConnectionError, "new_connection"),
        (ue.ProtocolError, "protocol"),
    )
    while pending and len(seen) < 24:
        item = pending.pop()
        if not isinstance(item, BaseException) or id(item) in seen:
            continue
        seen.add(id(item))
        for error_type, label in known:
            if isinstance(item, error_type):
                kinds.add(label)
        if isinstance(item, OSError):
            for name in ("ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"):
                if item.errno == getattr(errno, name):
                    codes.add(name)
        # PySocks exposes the SOCKS reply only in msg. Emit solely its
        # protocol byte, never the rest of that string (or str(exception)).
        if isinstance(item, socks.SOCKS5Error) and isinstance(item.msg, str):
            match = re.match(r"^0x(0[1-8]):", item.msg)
            if match:
                codes.add("socks_" + match[1])
        pending.extend(x for x in item.args if isinstance(x, BaseException))
        pending.extend(getattr(item, attr, None) for attr in
                       ("__cause__", "__context__", "reason", "original_error", "socket_err"))
    return {"layers": sorted(kinds) or ["unclassified"], "codes": sorted(codes)}
