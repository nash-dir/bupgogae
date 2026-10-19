"""Narrow, lossless normalization of observed law.go.kr response formats.

Normalization precedes existing calendar/range/codec/schema validation; unknown
formats are not repaired heuristically or silently discarded.
"""
from datetime import datetime
import re

from compress import compress_case_number
from validate import MAX_CASE_NUMBER_LEN


def is_merged_case_number(value: str) -> bool:
    return "," in value or "(병합)" in value


def expand_merged_case_numbers(value: str) -> tuple[str, ...]:
    """Preserve every member of an explicitly annotated merged-case list.

    OLTA decision 60090520 / law list ID 420836 uses a full leading number
    followed by serials explicitly marked (병합). Such serials may share only
    the ONE year/code prefix explicitly present in that list. With competing
    prefixes, missing markers, unknown tails or codec collisions we fail closed.
    The original string remains in master.db; this is an export interpretation.
    """
    value = value.strip()
    if len(value) > MAX_CASE_NUMBER_LEN or "," not in value:
        raise ValueError("invalid_merged_case_number")
    tokens = [token.strip() for token in value.split(",")]
    # Captured official decisions also identify a main claim and counterclaim.
    # Both must be fully written and individually labeled; numeric shorthand
    # cannot inherit a prefix from either role, and no extra member is dropped.
    if any("(본소)" in token or "(반소)" in token for token in tokens):
        roles = [re.fullmatch(r"[0-9]{2,4}[가-힣]{1,4}[0-9]+ *\((본소|반소)\)", token)
                 for token in tokens]
        if (len(tokens) != 2 or not all(roles)
                or {match[1] for match in roles} != {"본소", "반소"}):
            raise ValueError("invalid_main_counterclaim_pair")
    full = [re.fullmatch(r"([0-9]{2,4}[가-힣]{1,4})([0-9]+)(?: *\((?:병합|본소|반소)\))?", token)
            for token in tokens]
    if not full[0]:
        raise ValueError("invalid_merged_case_number")
    prefixes = {match[1] for match in full if match}
    numbers = []
    for token, match in zip(tokens, full):
        if match:
            numbers.append(match[1] + match[2])
        else:
            short = re.fullmatch(r"([0-9]+) *\(병합\)", token)
            if short is None or len(prefixes) != 1:
                raise ValueError("ambiguous_merged_case_number")
            numbers.append(full[0][1] + short[1])
    keys = [compress_case_number(number) for number in numbers]
    if None in keys or len(set(keys)) != len(keys):
        raise ValueError("duplicate_or_colliding_merged_case_number")
    return tuple(numbers)


def normalize_decision_date(value: str) -> str | None:
    """Accept canonical dates and fixed-width dotted/dashed/slashed API dates."""
    if re.fullmatch(r"[0-9]{8}", value):
        normalized = value
    elif re.fullmatch(r"[0-9]{4}([./-])[0-9]{2}\1[0-9]{2}", value):
        normalized = value[:4] + value[5:7] + value[8:10]
    else:
        return None
    try:
        datetime.strptime(normalized, "%Y%m%d")
    except ValueError:
        return None
    return normalized


def normalize_precedent_identity(number: str, court: str, source: str) -> tuple[str, str]:
    """Decode the tax source's explicit court-year-code-serial representation.

    The court is copied verbatim from an explicit source field, never guessed.
    Parenthesized branch names remain verbatim, without aliasing court identities.
    Other formats remain unchanged for the existing strict validator to reject.
    """
    if source != "국세법령정보시스템":
        return number, court
    match = re.fullmatch(
        r"(대법원|[가-힣]{2,48}(?:법원|지원)(?:\([가-힣]{1,12}\))?)"
        r"-([0-9]{4})-([가-힣]{1,4})-([0-9]+)",
        number,
    )
    if not match:
        return number, court
    supplied_court, year, code, serial = match.groups()
    if len(supplied_court) > 64 or (court and court != supplied_court):
        raise ValueError("conflicting_case_court")
    return year + code + serial, court or supplied_court
