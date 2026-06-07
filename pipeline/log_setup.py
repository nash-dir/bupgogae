"""파이프라인 공용 로깅 설정.

print() 대신 표준 logging을 사용해 레벨/타임스탬프/스트림 분리를 제공한다.
- 레벨: 환경변수 LOG_LEVEL (기본 INFO)
- INFO 이하 → stdout, WARNING 이상 → stderr (CI 로그에서 에러 식별 용이)
- 포맷: "HH:MM:SS LEVEL message"

사용:
    from log_setup import get_logger
    log = get_logger(__name__)
    log.info("...")    # 진행 상황
    log.warning("...") # 재시도/경고
    log.error("...")   # 실패
"""

import logging
import os
import sys

_configured = False


def configure_logging(level: str | None = None) -> None:
    """루트 로거를 1회 구성 (중복 핸들러 방지)."""
    global _configured
    if _configured:
        return

    level_name = (level or os.getenv("LOG_LEVEL", "INFO")).upper()
    log_level = getattr(logging, level_name, logging.INFO)

    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%H:%M:%S")

    # INFO 이하 → stdout
    out = logging.StreamHandler(sys.stdout)
    out.setLevel(logging.DEBUG)
    out.addFilter(lambda record: record.levelno < logging.WARNING)
    out.setFormatter(fmt)

    # WARNING 이상 → stderr
    err = logging.StreamHandler(sys.stderr)
    err.setLevel(logging.WARNING)
    err.setFormatter(fmt)

    root = logging.getLogger()
    root.setLevel(log_level)
    root.handlers.clear()
    root.addHandler(out)
    root.addHandler(err)
    _configured = True


def get_logger(name: str) -> logging.Logger:
    """구성된 모듈 로거 반환 (필요 시 루트 구성 트리거)."""
    configure_logging()
    return logging.getLogger(name)
