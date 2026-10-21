"""Source-bound serving overlays; immutable original rows are never repaired in place."""

import hashlib
import json
import re
from html.parser import HTMLParser
from functools import lru_cache
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import requests

from known_errors import CorrectionError, LIST_FIELDS, validate_record, _unique_object
from law_normalization import normalize_decision_date, normalize_precedent_identity

REGISTRY = Path(__file__).with_name("source-corrections.json")
PROFILE = "nts_judgment_html_sha256_v1"


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


@lru_cache(maxsize=1)
def entries():
    data = json.loads(REGISTRY.read_bytes(), object_pairs_hook=_unique_object)
    if data.get("schema") != 1 or not isinstance(data.get("entries"), dict):
        raise CorrectionError("known_error_invalid_registry")
    for key, entry in data["entries"].items():
        fields = entry["expectedList"]
        evidence = entry.get("courtEvidence")
        validate_record(entry["record"], allow_missing_court=evidence == "unknown")
        if (entry["profile"] != PROFILE or fields["데이터출처명"] != "국세법령정보시스템"
                or set(fields) != set(LIST_FIELDS)
                or key != fields["데이터출처명"] + ":" + fields["판례일련번호"]
                or entry["record"]["serial"] != fields["판례일련번호"]
                or not re.fullmatch(r"[0-9a-f]{64}", entry["judgmentSha256"])):
            raise CorrectionError("known_error_invalid_registry")
        number, court = normalize_precedent_identity(fields["사건번호"], fields["법원명"], fields["데이터출처명"])
        court_matches = entry["record"]["court"] == court
        if evidence is not None:
            if court or evidence not in {"unknown", "judgment_header"}:
                raise CorrectionError("known_error_invalid_registry")
            court_matches = (not entry["record"]["court"] if evidence == "unknown"
                             else bool(entry["record"]["court"]))
        if (entry["record"]["case_number"] != number or not court_matches
                or entry["record"]["case_name"] != fields["사건명"]):
            raise CorrectionError("known_error_invalid_registry")
        url = urlsplit(entry["originalUrl"])
        if (url.scheme != "https" or url.netloc != "taxlaw.nts.go.kr"
                or url.path != "/qt/USEQTA002P.do" or url.fragment
                or set(parse_qs(url.query)) != {"ntstDcmId"}
                or len(parse_qs(url.query)["ntstDcmId"]) != 1):
            raise CorrectionError("known_error_invalid_registry")
    return data["entries"]


def fetch_judgment(entry):
    """Follow only the exact reviewed government referral, never generic redirects."""
    from api import _get_session, _read_bounded_body, ResponseBodyTooLarge
    fields = entry["expectedList"]
    session = _get_session()
    try:
        with session.get("https://www.law.go.kr/LSW/precInfoP.do",
                         params={"precSeq": fields["판례일련번호"], "mode": "0"},
                         stream=True, allow_redirects=False, timeout=(10, 30)) as response:
            if response.status_code != 302 or response.headers.get("Location") != entry["originalUrl"]:
                raise CorrectionError("known_error_source_changed")
        params = {k: values[0] for k, values in parse_qs(urlsplit(entry["originalUrl"]).query).items()}
        with session.post("https://taxlaw.nts.go.kr/action.do",
                          data={"actionId": "ASIQTB002PR01", "paramData": json.dumps({"dcmDVO": params})},
                          headers={"Referer": entry["originalUrl"]},
                          stream=True, allow_redirects=False, timeout=(10, 30)) as response:
            if response.status_code != 200:
                raise CorrectionError("known_error_source_unavailable")
            body = _read_bounded_body(response)
        data = json.loads(body)
        result = data["data"]["ASIQTB002PR01"]
        metadata = result["dcmDVO"]
        expected = entry.get("expectedOriginalMetadata", {
            "ntstDcmId": params["ntstDcmId"], "ntstDcmDscmCntn": fields["사건번호"],
            "ntstDcmTtl": fields["사건명"], "ntstDcmRgtDt": normalize_decision_date(fields["선고일자"])})
        if (data["status"] != "SUCCESS" or set(expected) != {
                "ntstDcmId", "ntstDcmDscmCntn", "ntstDcmTtl", "ntstDcmRgtDt"}
                or {k: metadata[k] for k in expected} != expected
                or expected["ntstDcmId"] != params["ntstDcmId"]
                or expected["ntstDcmDscmCntn"] != fields["사건번호"]
                or expected["ntstDcmTtl"].strip() != fields["사건명"]
                or expected["ntstDcmRgtDt"] != normalize_decision_date(fields["선고일자"])):
            raise CorrectionError("known_error_source_changed")
        html_rows = [row for row in result["dcmHwpEditorDVOList"] if row["dcmFleTy"] == "html"]
        if len(html_rows) != 1 or not isinstance(html_rows[0]["dcmFleByte"], str):
            raise CorrectionError("known_error_source_changed")
        return html_rows[0]["dcmFleByte"].encode()
    except (requests.RequestException, ResponseBodyTooLarge) as error:
        raise CorrectionError("known_error_source_unavailable") from error
    except (KeyError, TypeError, ValueError) as error:
        if isinstance(error, CorrectionError):
            raise
        raise CorrectionError("known_error_source_changed") from error


def resolve(fields, fetch=fetch_judgment):
    entry = entries().get(fields["데이터출처명"] + ":" + fields["판례일련번호"])
    if entry is None:
        return None
    if fields != entry["expectedList"]:
        raise CorrectionError("known_error_input_changed")
    body = fetch(entry)
    if not isinstance(body, bytes) or hashlib.sha256(body).hexdigest() != entry["judgmentSha256"]:
        raise CorrectionError("known_error_source_changed")
    if entry.get("courtEvidence") == "judgment_header":
        class Text(HTMLParser):
            def __init__(self):
                super().__init__()
                self.parts = []
            def handle_data(self, data):
                self.parts.append(data)
        parser = Text()
        parser.feed(body.decode("utf-8"))
        header = re.sub(r"\s+", "", "".join(parser.parts)).split("사건", 1)[0]
        court = re.sub(r"\s+", "", entry["record"]["court"])
        if not re.fullmatch(re.escape(court) + r"(?:제[0-9]+민사부판결)?", header):
            raise CorrectionError("known_error_source_changed")
    return {"profile": PROFILE, "entrySha256": digest(entry), "expectedList": dict(fields),
            "record": dict(entry["record"]), "judgmentSha256": entry["judgmentSha256"]}


def verify_receipt(raw, receipt):
    fields = receipt.get("expectedList", {})
    key = fields.get("데이터출처명", "") + ":" + fields.get("판례일련번호", "")
    entry = entries().get(key)
    if (not entry or receipt != {"profile": PROFILE, "entrySha256": digest(entry),
                                "expectedList": entry["expectedList"], "record": entry["record"],
                                "judgmentSha256": entry["judgmentSha256"]}):
        raise CorrectionError("known_error_receipt_mismatch")
    number, court = normalize_precedent_identity(fields["사건번호"], fields["법원명"], fields["데이터출처명"])
    original = dict(serial=fields["판례일련번호"], case_name=fields["사건명"], case_number=number,
                    date=normalize_decision_date(fields["선고일자"]), court=court)
    if {k: raw.get(k) for k in original} != original:
        raise CorrectionError("known_error_receipt_mismatch")
    source_raw = dict(original, case_number=fields["사건번호"], date=fields["선고일자"], court=fields["법원명"])
    if (("_source_raw" in raw and raw["_source_raw"] != source_raw)
            or ("_source_name" in raw and raw["_source_name"] != fields["데이터출처명"])):
        raise CorrectionError("known_error_receipt_mismatch")
