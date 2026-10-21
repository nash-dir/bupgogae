"""Reviewed, source-bound corrections. Never guesses values or publishes data."""
from datetime import datetime, timezone
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import parse_qs, urlsplit

from compress import CASE_CODE_MAP, compress_case_number
from law_normalization import expand_merged_case_numbers, is_merged_case_number, normalize_decision_date
from validate import sanitize_raw_case

REGISTRY_PATH = Path(__file__).with_name("known-errors.json")
LIST_FIELDS = ("판례일련번호", "데이터출처명", "사건명", "사건번호", "선고일자", "법원명", "사건종류코드")
MAX_BODY_BYTES = 10 * 1024 * 1024
RECORD_FIELDS = ("serial", "case_name", "case_number", "date", "court")
LAW_COMPARISON_PROFILE = "law_head_resource_cache_time_v1"
_RESOURCE_PATHS = (
    "/LSW/js/jquery/jquery.min.js", "/LSW/js/common/common.js", "/LSW/js/common/drag_search.js",
    "/LSW/js/jquery/jquery.loadmask.min.js", "/LSW/js/common/jquery-custom.js",
    "/LSW/js/jquery/jquery-ui.js", "/LSW/js/jquery/jquery-ui_2017.min.js",
    "/LSW/js/jquery/jquery.layout-latest.min.js", "/LSW/js/common/layout.js",
    "/LSW/css/lsw/common.css", "/LSW/js/jquery/jquery.loadmask.css",
    "/LSW/js/jquery/layout-default-latest.css", "/LSW/css/lsw/layout.css",
    "/LSW/css/lsw/board.css", "/LSW/css/ui_2017.css", "/LSW/css/fonts.css",
)
_RESOURCE_TIME = re.compile(
    rb'(?P<prefix><(?:script type="text/javascript" src|link rel="stylesheet" type="text/css" href)="'
    rb'(?P<path>' + b"|".join(re.escape(p.encode()) for p in _RESOURCE_PATHS)
    + rb')\?Time=)[0-9]{10}(?P<suffix>")'
)


class CorrectionError(ValueError):
    """Safe reason for durable backlog, without response text or credentials."""


def digest(body):
    return hashlib.sha256(body).hexdigest()


def law_comparison_hash(body):
    """Bind ALL HTML bytes except 16 observed <head> asset cache timestamps.

    Never strips tags, text, whitespace, URLs, query strings in a decision, or
    numbers outside the exact observed head attributes. Layout drift fails closed.
    Raw body hashes remain in the review archive and each application receipt.
    """
    if body.count(b"<head>") != 1 or body.count(b"</head>") != 1:
        raise CorrectionError("known_error_source_changed")
    before, head_and_after = body.split(b"<head>")
    head, after = head_and_after.split(b"</head>")
    matches = list(_RESOURCE_TIME.finditer(head))
    if (len(matches) != len(_RESOURCE_PATHS)
            or {m["path"].decode() for m in matches} != set(_RESOURCE_PATHS)):
        raise CorrectionError("known_error_source_changed")
    normalized = _RESOURCE_TIME.sub(lambda m: m["prefix"] + b"0000000000" + m["suffix"], head)
    return digest(before + b"<head>" + normalized + b"</head>" + after)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise CorrectionError("known_error_invalid_registry")
        result[key] = value
    return result


def validate_record(record, *, allow_missing_court=False):
    if (not isinstance(record, dict) or set(record) != set(RECORD_FIELDS)
            or any(not isinstance(v, str) or (not v and not (k == "court" and allow_missing_court))
                   for k, v in record.items())
            or not re.fullmatch(r"[0-9]{1,32}", record["serial"])
            or sanitize_raw_case(record) != record
            or normalize_decision_date(record["date"]) != record["date"]):
        raise CorrectionError("known_error_invalid_record")
    members = (expand_merged_case_numbers(record["case_number"])
               if is_merged_case_number(record["case_number"]) else (record["case_number"],))
    for number in members:
        match = re.fullmatch(r"([0-9]{2}|[0-9]{4})([가-힣]{1,4})([0-9]+)", number)
        if (not match or match[2] not in CASE_CODE_MAP or not compress_case_number(number)
                or (len(match[1]) == 4 and match[1] > record["date"][:4])):
            raise CorrectionError("known_error_invalid_record")
    if record["date"] > datetime.now(timezone.utc).strftime("%Y%m%d"):
        raise CorrectionError("known_error_invalid_record")


def _validate_urls(serial, urls):
    if not isinstance(urls, list) or len(urls) != 2:
        raise CorrectionError("known_error_invalid_registry")
    for index, url in enumerate(urls):
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or parsed.username or parsed.password
                or parsed.port or parsed.fragment):
            raise CorrectionError("known_error_invalid_registry")
        if index == 0:
            valid = (parsed.netloc == "www.law.go.kr" and parsed.path == "/LSW/precInfoP.do"
                     and parse_qs(parsed.query) == {"precSeq": [serial]})
        else:
            valid = (parsed.netloc == "sanjaecase.comwel.or.kr"
                     and parsed.path == "/service/dataView"
                     and set(parse_qs(parsed.query)) == {"id"})
        if not valid:
            raise CorrectionError("known_error_invalid_registry")


class CorrectionRegistry:
    def __init__(self, body):
        try:
            self.data = json.loads(body, object_pairs_hook=_unique_object)
            self.sha256 = digest(body)
            if (self.data["schema"] != 3 or not re.fullmatch(r"[0-9]{8}", self.data["version"])
                    or self.data["lawComparisonProfile"] != LAW_COMPARISON_PROFILE):
                raise CorrectionError("known_error_invalid_registry")
            self.entries = self.data["entries"]
            if not isinstance(self.entries, dict):
                raise CorrectionError("known_error_invalid_registry")
            for key, entry in self.entries.items():
                source, serial = entry["source"], entry["serial"]
                if (source != "근로복지공단산재판례" or not re.fullmatch(r"[0-9]{1,32}", serial)
                        or key != source + ":" + serial
                        or set(entry["expectedList"]) != set(LIST_FIELDS)
                        or entry["expectedList"]["데이터출처명"] != source
                        or entry["expectedList"]["판례일련번호"] != serial):
                    raise CorrectionError("known_error_invalid_registry")
                if entry["status"] == "verified":
                    validate_record(entry["record"])
                    if entry["record"]["serial"] != serial:
                        raise CorrectionError("known_error_invalid_registry")
                    if any(not re.fullmatch(r"[0-9a-f]{64}", h) for h in entry["bodyHashes"]):
                        raise CorrectionError("known_error_invalid_registry")
                    if len(entry["bodyHashes"]) != 2:
                        raise CorrectionError("known_error_invalid_registry")
                    if not re.fullmatch(r"[0-9a-f]{64}", entry["lawComparisonSha256"]):
                        raise CorrectionError("known_error_invalid_registry")
                    _validate_urls(serial, entry["urls"])
                elif entry["status"] != "held" or entry["record"] is not None:
                    raise CorrectionError("known_error_invalid_registry")
        except (KeyError, TypeError, AttributeError, json.JSONDecodeError) as exc:
            raise CorrectionError("known_error_invalid_registry") from exc

    def resolve(self, fields, fetch_body):
        key = fields["데이터출처명"] + ":" + fields["판례일련번호"]
        entry = self.entries.get(key)
        if entry is None:
            return None
        # A reviewed duplicate is not permission to add another source ID.
        if entry["status"] != "verified" or entry["disposition"] != "added":
            raise CorrectionError("known_error_review_required")
        if fields != entry["expectedList"]:
            raise CorrectionError("known_error_input_changed")
        observed_hashes = []
        for index, (url, expected) in enumerate(zip(entry["urls"], entry["bodyHashes"])):
            body = fetch_body(url)
            if not isinstance(body, bytes) or not body or len(body) > MAX_BODY_BYTES:
                raise CorrectionError("known_error_source_changed")
            actual = digest(body)
            if index == 0:
                if law_comparison_hash(body) != entry["lawComparisonSha256"]:
                    raise CorrectionError("known_error_source_changed")
            elif actual != expected:
                raise CorrectionError("known_error_source_changed")
            observed_hashes.append(actual)
        record = dict(entry["record"])
        record["_known_error"] = {
            "key": key, "registrySha256": self.sha256, "version": self.data["version"],
            "expectedList": dict(fields), "bodyHashes": list(entry["bodyHashes"]),
            "observedBodyHashes": observed_hashes, "lawComparisonProfile": LAW_COMPARISON_PROFILE,
            "lawComparisonSha256": entry["lawComparisonSha256"],
            "verifiedAt": datetime.now(timezone.utc).isoformat(),
        }
        return record

    def verify_receipt(self, record, receipt):
        entry = self.entries.get(receipt.get("key"))
        if (not entry or entry["status"] != "verified" or entry["disposition"] != "added"
                or receipt.get("registrySha256") != self.sha256
                or receipt.get("version") != self.data["version"]
                or receipt.get("expectedList") != entry["expectedList"]
                or receipt.get("bodyHashes") != entry["bodyHashes"]
                or receipt.get("lawComparisonProfile") != LAW_COMPARISON_PROFILE
                or receipt.get("lawComparisonSha256") != entry["lawComparisonSha256"]
                or not isinstance(receipt.get("observedBodyHashes"), list)
                or len(receipt["observedBodyHashes"]) != 2
                or any(not isinstance(h, str) or not re.fullmatch(r"[0-9a-f]{64}", h)
                       for h in receipt["observedBodyHashes"])
                or receipt["observedBodyHashes"][1] != entry["bodyHashes"][1]
                or {k: record.get(k) for k in RECORD_FIELDS} != entry["record"]):
            raise CorrectionError("known_error_receipt_mismatch")


@lru_cache(maxsize=1)
def registry():
    return CorrectionRegistry(REGISTRY_PATH.read_bytes())


def fetch_source_body(url):
    # Same approved per-host WARP routing as the law API. No redirects, fallback
    # route, unbounded reads, retries or response content in failure messages.
    from api import _get_session
    import requests
    try:
        with _get_session().get(url, stream=True, allow_redirects=False, timeout=(10, 30)) as response:
            if response.status_code != 200:
                raise CorrectionError("known_error_source_unavailable")
            chunks, size = [], 0
            for chunk in response.iter_content(chunk_size=65536):
                size += len(chunk)
                if size > MAX_BODY_BYTES:
                    raise CorrectionError("known_error_source_unavailable")
                chunks.append(chunk)
            return b"".join(chunks)
    except requests.RequestException as exc:
        raise CorrectionError("known_error_source_unavailable") from exc
