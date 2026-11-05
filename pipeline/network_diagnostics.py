"""Keyless, bounded law endpoint probes on the actual crawler runner.

No environment credential, response body, redirect target or exception text is
printed. HTTP is a keyless control only; the collector always uses HTTPS.
"""

import argparse
import json
from pathlib import Path
import time

import requests

from api import HEADERS, WARP_LAW_PROXY, WARP_LAW_REMOTE_DNS_PROXY
from network_errors import network_error_detail

ROUTE_PROXIES = {"direct": "", "warp_local_dns": WARP_LAW_PROXY,
                 "warp_remote_dns": WARP_LAW_REMOTE_DNS_PROXY}


def probe(route, endpoint):
    urls = {
        "https_root": "https://www.law.go.kr/",
        "https_api": "https://www.law.go.kr/DRF/lawSearch.do?target=prec&type=XML&display=1",
        "http_root": "http://www.law.go.kr/",
    }
    proxies = {"direct": None, "warp_remote_dns": WARP_LAW_REMOTE_DNS_PROXY,
               "warp_local_dns": WARP_LAW_PROXY}
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


def main(full=False):
    routes = ("direct", "warp_remote_dns", "warp_local_dns") if full else ("warp_local_dns",)
    endpoints = ("https_root", "https_api", "http_root") if full else ("https_api",)
    for route in routes:
        for endpoint in endpoints:
            print(json.dumps(probe(route, endpoint), sort_keys=True), flush=True)


def select_route(routes):
    """Choose a reachable HTTPS API route before injecting any credential."""
    for route in routes:
        result = probe(route, "https_api")
        print(json.dumps(result, sort_keys=True), flush=True)
        if result.get("status") == 200:
            return route
    return None


def configure_route(group, output_file):
    routes = ("direct",) if group == "direct" else ("warp_local_dns", "warp_remote_dns")
    route = select_route(routes)
    if route is None and group == "warp":
        raise RuntimeError("No reachable law HTTPS route")
    values = {"needs_warp": "true" if route is None else "false"}
    if route is not None:
        values.update(route=route, proxy=ROUTE_PROXIES[route])
    with Path(output_file).open("a", encoding="utf-8") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--full", action="store_true", help="Run all nine keyless route controls")
    parser.add_argument("--select", choices=("direct", "warp"))
    parser.add_argument("--output-file", type=Path)
    args = parser.parse_args()
    if args.select:
        if args.full or args.output_file is None:
            parser.error("--select requires --output-file and cannot use --full")
        try:
            configure_route(args.select, args.output_file)
        except RuntimeError:
            parser.exit(1, "No reachable law HTTPS route\n")
    else:
        main(args.full)
