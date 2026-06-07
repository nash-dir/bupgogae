"""입력 검증·정제 레이어 — 외부 API 응답을 DB에 넣기 전 경계값을 강제.

법제처/KIPRIS API 응답은 신뢰 경계 밖의 데이터이므로, DB 삽입 전에
필드 길이 상한과 기본 정규화를 적용해 손상/비정상 데이터가
유입되는 것을 막는다. (방어적 심층 방어 — XXE 차단과 별개 레이어)

공개 API:
  sanitize_raw_case(case)     → dict | None   (판례/헌재)
  sanitize_kipris_item(item)  → dict | None   (특허심판)

serial이 비어 있으면 None을 반환하여 호출부가 스킵하도록 한다.
"""

# 필드 길이 상한 — 실제 데이터보다 넉넉하되 폭주를 막는 방어적 한도
MAX_SERIAL_LEN = 32
MAX_CASE_NAME_LEN = 500
MAX_CASE_NUMBER_LEN = 64
MAX_COURT_LEN = 64
MAX_DATE_LEN = 16
MAX_TRIAL_TYPE_LEN = 64


def _clip(value, max_len: int) -> str:
    """None-안전 문자열 변환 + strip + 길이 상한."""
    if value is None:
        return ""
    return str(value).strip()[:max_len]


def sanitize_raw_case(case: dict) -> dict | None:
    """판례/헌재 raw 레코드 정제.

    Returns:
        정제된 dict (serial/case_name/case_number/date/court),
        또는 serial이 없으면 None.
    """
    if not isinstance(case, dict):
        return None
    serial = _clip(case.get("serial"), MAX_SERIAL_LEN)
    if not serial:
        return None
    return {
        "serial": serial,
        "case_name": _clip(case.get("case_name"), MAX_CASE_NAME_LEN),
        "case_number": _clip(case.get("case_number"), MAX_CASE_NUMBER_LEN),
        "date": _clip(case.get("date"), MAX_DATE_LEN),
        "court": _clip(case.get("court"), MAX_COURT_LEN),
    }


def sanitize_kipris_item(item: dict) -> dict | None:
    """KIPRIS 심판 아이템 정제.

    Returns:
        정제된 dict (serial/case_name/case_number/decision_date/trial_type),
        또는 serial이 없으면 None.
    """
    if not isinstance(item, dict):
        return None
    serial = _clip(item.get("serial"), MAX_SERIAL_LEN)
    if not serial:
        return None
    return {
        "serial": serial,
        "case_name": _clip(item.get("case_name"), MAX_CASE_NAME_LEN),
        "case_number": _clip(item.get("case_number"), MAX_CASE_NUMBER_LEN),
        "decision_date": _clip(item.get("decision_date"), MAX_DATE_LEN),
        "trial_type": _clip(item.get("trial_type"), MAX_TRIAL_TYPE_LEN),
    }


# 자체 테스트 (직접 실행 시)
if __name__ == "__main__":
    # serial 없음 → None
    assert sanitize_raw_case({"case_name": "x"}) is None
    assert sanitize_raw_case({"serial": ""}) is None
    assert sanitize_raw_case("not a dict") is None
    assert sanitize_kipris_item({}) is None

    # 정상 정제 + strip
    r = sanitize_raw_case({
        "serial": " 100 ", "case_name": " 손해배상 ",
        "case_number": "2024다1", "date": "20240101", "court": "대법원",
    })
    assert r["serial"] == "100", r
    assert r["case_name"] == "손해배상", r

    # 길이 상한
    long_name = "가" * 1000
    r2 = sanitize_raw_case({"serial": "1", "case_name": long_name})
    assert len(r2["case_name"]) == MAX_CASE_NAME_LEN, len(r2["case_name"])

    # None 필드 → 빈 문자열
    r3 = sanitize_raw_case({"serial": "1", "case_name": None, "court": None})
    assert r3["case_name"] == "" and r3["court"] == ""

    # KIPRIS 정상
    k = sanitize_kipris_item({
        "serial": "2023당1", "case_name": "거절", "case_number": "2023당1",
        "decision_date": "20230101", "trial_type": "거절결정",
    })
    assert k["serial"] == "2023당1", k

    print("✅ validate.py self-test passed")
