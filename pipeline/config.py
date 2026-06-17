"""파이프라인 운영 설정 — 환경변수로 조정 가능한 튜너블 중앙화.

각 모듈에 흩어져 있던 매직 넘버(요청 딜레이, HTTP 타임아웃, 에러 임계값,
스케줄러 모듈러)를 한곳에 모으고, 코드 수정 없이 환경변수로 조정할 수 있게
한다. 모든 기본값은 기존 동작과 동일하다.

예) LAW_TIMEOUT=30 python crawler_runner.py
"""

import os


def _f(name: str, default: float) -> float:
    """환경변수에서 float 로드 (미설정/오류 시 기본값)."""
    try:
        return float(os.getenv(name, default))
    except (TypeError, ValueError):
        return float(default)


def _i(name: str, default: int) -> int:
    """환경변수에서 int 로드 (미설정/오류 시 기본값)."""
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return int(default)


# ── 법제처 API (api.py) ──
LAW_DELAY_MIN = _f("LAW_DELAY_MIN", 0.8)
LAW_DELAY_MAX = _f("LAW_DELAY_MAX", 1.0)
LAW_TIMEOUT = _i("LAW_TIMEOUT", 20)

# ── 크롤러 러너 (crawler_runner.py) ──
CRAWLER_DELAY_MIN = _f("CRAWLER_DELAY_MIN", 0.8)
CRAWLER_DELAY_MAX = _f("CRAWLER_DELAY_MAX", 1.0)
# 스케줄러 모듈러 — Tier별 날짜 윈도우 분산 주기 (커버리지 산식에 영향)
TIER1_MOD = _i("TIER1_MOD", 56)
TIER2_MOD = _i("TIER2_MOD", 15)
RECENT_SCAN_PAGES = _i("RECENT_SCAN_PAGES", 3)
CIRCUIT_BREAKER_THRESHOLD = _i("CIRCUIT_BREAKER_THRESHOLD", 20)


if __name__ == "__main__":
    # 현재 적용 설정값 출력 (디버깅용)
    for k, v in sorted(globals().items()):
        if k.isupper():
            print(f"{k} = {v}")
