"""Source-bound replays of existing reviewed identities, without changing raw."""
import hashlib
import json
from functools import lru_cache
from pathlib import Path
import xml.etree.ElementTree as ET

import requests

from known_errors import CorrectionError, LIST_FIELDS, _unique_object, validate_record


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
        return False
    if (fields != entry["expectedList"] or archived != entry["expectedArchived"]
            or corrected != entry["record"]):
        raise CorrectionError("known_error_input_changed")
    detail = fetch(sid)
    if (detail["metadata"] != entry["expectedDetail"]
            or hashlib.sha256(detail["body"].encode()).hexdigest() != entry["bodySha256"]):
        raise CorrectionError("known_error_source_changed")
    return True
