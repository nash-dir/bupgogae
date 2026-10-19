"""Pure shared rules for public payloads and deterministic bundle metadata."""
import re

MAX_SAFE_INTEGER = 9_007_199_254_740_991


def derive_short_case_keys(cases, case_code_map):
    one_char_codes = {roman for hangul, roman in case_code_map.items()
                      if isinstance(hangul, str) and len(hangul) == 1
                      and isinstance(roman, str) and roman}
    return sorted(key for key in cases if isinstance(key, str)
                  and re.fullmatch(r"[0-9]{2}.+[0-9]", key) and key[2:-1] in one_char_codes)
