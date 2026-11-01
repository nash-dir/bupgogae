"""Source-bound replays of existing reviewed identities, without changing raw."""
import hashlib
import json
import re
from functools import lru_cache
from pathlib import Path
import xml.etree.ElementTree as ET

import requests

from known_errors import CorrectionError, LIST_FIELDS, _unique_object, validate_record
from law_normalization import expand_merged_case_numbers, is_merged_case_number, normalize_decision_date
from log_setup import get_logger

log = get_logger(__name__)


@lru_cache(maxsize=1)
def entries():
    data = json.loads(Path(__file__).with_name("reviewed-replays.json").read_bytes(),
                      object_pairs_hook=_unique_object)
    if data.get("schema") != 1 or not isinstance(data.get("entries"), dict):
        raise CorrectionError("known_error_invalid_registry")
    for sid, entry in data["entries"].items():
        validate_record(entry["record"])
        if (set(entry["expectedList"]) != set(LIST_FIELDS)
                or entry["expectedList"]["데이터출처명"] != "대법원"
                or entry["expectedList"]["판례일련번호"] != sid
                or entry["record"]["serial"] != sid or entry["expectedArchived"]["serial"] != sid):
            raise CorrectionError("known_error_invalid_registry")
    return data["entries"]


def fetch_detail(sid):
    from api import _get_session, _read_bounded_body, API_KEY, ResponseBodyTooLarge
    try:
        with _get_session().get("https://www.law.go.kr/DRF/lawService.do",
                                params={"OC": API_KEY, "target": "prec", "type": "XML", "ID": sid},
                                stream=True, allow_redirects=False, timeout=(10, 30)) as response:
            if response.status_code != 200:
                raise CorrectionError("known_error_source_unavailable")
            body = _read_bounded_body(response)
        if b"<!DOCTYPE" in body.upper() or b"<!ENTITY" in body.upper():
            raise CorrectionError("known_error_source_changed")
        root = ET.fromstring(body)
        return {"metadata": {k: root.findtext(".//" + k, "")
                             for k in ("사건명", "사건번호", "선고일자", "법원명")},
                "body": root.findtext(".//판례내용", "")}
    except (requests.RequestException, ResponseBodyTooLarge) as error:
        raise CorrectionError("known_error_source_unavailable") from error
    except (ValueError, ET.ParseError) as error:
        if isinstance(error, CorrectionError):
            raise
        raise CorrectionError("known_error_source_changed") from error


def verify(fields, archived, corrected, *, fetch=fetch_detail):
    sid = fields.get("판례일련번호", "")
    entry = entries().get(sid)
    if entry is None:
        return verify_existing_identity(fields, archived, corrected, fetch=fetch)
    if (fields != entry["expectedList"] or archived != entry["expectedArchived"]
            or corrected != entry["record"]):
        raise CorrectionError("known_error_input_changed")
    detail = fetch(sid)
    if (detail["metadata"] != entry["expectedDetail"]
            or hashlib.sha256(detail["body"].encode()).hexdigest() != entry["bodySha256"]):
        raise CorrectionError("known_error_source_changed")
    return True


def verify_existing_identity(fields, archived, corrected, *, fetch=fetch_detail):
    """Confirm a lossy list against an ALREADY reviewed identity, without writes.

    This is not a resolver for new rows or permission to change canonical data.
    The caller must validate persisted provenance before calling. Pinned entries
    above retain their stronger exact-input/body checks and never fall back here.
    """
    sid = fields.get("판례일련번호", "")
    if (fields.get("데이터출처명") != "대법원" or not re.fullmatch(r"[0-9]{1,32}", sid)
            or archived.get("serial") != sid or corrected.get("serial") != sid):
        return False
    validate_record(corrected)
    number, court = corrected["case_number"], corrected["court"]
    numbers = {number}
    if is_merged_case_number(number):
        # Only the leading complete member is a supported list projection.
        numbers.add(expand_merged_case_numbers(number)[0])
    courts = {court}
    branch = re.fullmatch(r"(.+법원)\(([가-힣]+)\)", court)
    if branch:
        courts.update({branch[1], branch[1] + branch[2] + "재판부"})
    if (fields.get("사건명") != corrected["case_name"]
            or normalize_decision_date(fields.get("선고일자", "")) != corrected["date"]
            or fields.get("사건번호") not in numbers or fields.get("법원명") not in courts):
        return False
    detail = fetch(sid)
    expected = {"사건명": corrected["case_name"], "사건번호": number,
                "선고일자": corrected["date"], "법원명": court}
    # The detail may encode a branch explicitly in the case-number prefix.
    # Bind both parts to the existing court; never guess a branch from a list.
    alternatives = [expected]
    if branch:
        alternatives.append(dict(expected, 사건번호=f"({branch[2]}){number}", 법원명=branch[1]))
    if (detail.get("metadata") not in alternatives
            or not isinstance(detail.get("body"), str) or not detail["body"].strip()):
        raise CorrectionError("known_error_source_changed")
    log.info("  reviewed detail replay serial=%s body_sha256=%s", sid,
             hashlib.sha256(detail["body"].encode()).hexdigest())
    return True


def resolve(fields, *, fetch=None):
    """Reconstruct only a fully reviewed identity, including on a fresh DB.

    List summaries are not evidence that merged members were removed. Every
    field and the complete official detail/body must match the pinned review.
    """
    entry = entries().get(fields.get("판례일련번호", ""))
    if entry is None:
        return None
    verify(fields, entry["expectedArchived"], entry["record"], fetch=fetch or fetch_detail)
    return dict(entry["record"])
