"""Exact source-reviewed overlays for immutable quarantined rows. Never publishes."""
import hashlib
import json
import re
from functools import lru_cache
from html.parser import HTMLParser
from pathlib import Path

from known_errors import CorrectionError, LIST_FIELDS, _unique_object, validate_record
from law_normalization import normalize_decision_date, normalize_precedent_identity
from serving_policy import RAW_COLUMNS, row_hash
from source_corrections import digest, fetch_judgment


@lru_cache(maxsize=1)
def entries():
    data = json.loads(Path(__file__).with_name("historical-recovery.json").read_bytes(),
                      object_pairs_hook=_unique_object)
    if data.get("schema") != 1 or not isinstance(data.get("entries"), dict):
        raise CorrectionError("known_error_invalid_registry")
    for sid, entry in data["entries"].items():
        fields, raw, record = entry["expectedList"], entry["expectedArchivedRaw"], entry["record"]
        validate_record(record)
        number, court = normalize_precedent_identity(fields["사건번호"], fields["법원명"], fields["데이터출처명"])
        if (set(fields) != set(LIST_FIELDS) or set(raw) != set(RAW_COLUMNS)
                or fields["데이터출처명"] != "국세법령정보시스템"
                or fields["판례일련번호"] != sid or raw["serial"] != sid or record["serial"] != sid
                or entry["profile"] != "nts_judgment_html_sha256_v1"
                or row_hash(raw) != entry["archivedRawSha256"]
                or record["case_number"] != number or record["court"] != court
                or record["case_name"] != fields["사건명"]
                or not re.fullmatch(r"[0-9a-f]{64}", entry["judgmentSha256"])):
            raise CorrectionError("known_error_invalid_registry")
    return data["entries"]


def receipt_for(entry):
    return {"entrySha256": digest(entry), "judgmentSha256": entry["judgmentSha256"],
            "record": entry["record"], "expectedList": entry["expectedList"]}


def verify_receipt(raw, receipt):
    entry = entries().get(raw["serial"])
    if (not entry or receipt != receipt_for(entry)
            or {k: raw[k] for k in RAW_COLUMNS} != entry["expectedArchivedRaw"]
            or row_hash(raw) != entry["archivedRawSha256"]):
        raise CorrectionError("known_error_receipt_mismatch")
    return dict(entry["record"])


def resolve(fields, raw, *, fetch=fetch_judgment):
    entry = entries().get(raw["serial"])
    if entry is None:
        return None
    receipt = receipt_for(entry)
    verify_receipt(raw, receipt)
    if fields != entry["expectedList"]:
        raise CorrectionError("known_error_input_changed")
    body = fetch(entry)
    if not isinstance(body, bytes) or hashlib.sha256(body).hexdigest() != entry["judgmentSha256"]:
        raise CorrectionError("known_error_source_changed")

    class Text(HTMLParser):
        def __init__(self):
            super().__init__()
            self.parts = []

        def handle_data(self, value):
            self.parts.append(value)

    parser = Text()
    parser.feed(body.decode("utf-8"))
    # Bind the original judgment's header, never a later quoted judgment.
    header = re.sub(r"\s|\xa0", "", "".join(parser.parts)).split("주문", 1)[0]
    date_match = re.search(r"판결선고([0-9]{4})\.([0-9]{1,2})\.([0-9]{1,2})\.", header)
    judgment_date = (normalize_decision_date("{}{:02d}{:02d}".format(
        date_match[1], int(date_match[2]), int(date_match[3]))) if date_match else None)
    if (not header.startswith("사건" + entry["record"]["case_number"])
            or judgment_date != entry["record"]["date"]):
        raise CorrectionError("known_error_source_changed")
    return receipt
