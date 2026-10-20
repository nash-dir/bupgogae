"""Keyless, bounded law endpoint probes on the actual crawler runner.

No environment credential, response body, redirect target or exception text is
printed. HTTP is a keyless control only; the collector always uses HTTPS.
"""

import json
import time

import requests

from api import HEADERS, WARP_LAW_PROXY
from network_errors import network_error_detail


def probe(route, endpoint):
    urls = {
        "https_root": "https://www.law.go.kr/",
        "https_api": "https://www.law.go.kr/DRF/lawSearch.do?target=prec&type=XML&display=1",
        "http_root": "http://www.law.go.kr/",
    }
    proxies = {"direct": None, "warp_remote_dns": WARP_LAW_PROXY,
               "warp_local_dns": WARP_LAW_PROXY.replace("socks5h:", "socks5:")}
    result = {"route": route, "endpoint": endpoint}
    started = time.monotonic()
    with requests.Session() as session:
        session.trust_env = False
        session.headers.update(HEADERS)
        if proxies[route]:
            session.proxies = {"http": proxies[route], "https": proxies[route]}
        try:
            with session.get(urls[endpoint], timeout=(8, 12), stream=True,
                             allow_redirects=False) as response:
                result["status"] = response.status_code
                # No body or Location header is read or logged.
        except requests.exceptions.RequestException as error:
            result["error"] = network_error_detail(error)
    result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    return result


def main():
    for route in ("direct", "warp_remote_dns", "warp_local_dns"):
        for endpoint in ("https_root", "https_api", "http_root"):
            print(json.dumps(probe(route, endpoint), sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
