/**
 * 법고개(Bupgogae) — 사건번호 정규식 + Red 필터 + 키 압축 모듈
 * ==============================================================
 * LLM 응답 텍스트에서 한국 판례/심판 사건번호를 추출, 검증, 압축한다.
 *
 * [파이프라인]
 *   1. extractCaseNumbers(text) → 화이트리스트 정규식으로 사건번호 추출
 *      - 법원/헌재: case_code_map 기반 동적 정규식 (등록된 사건부호만 매칭)
 *   2. validateCaseNumber(num)  → Red 필터: 미래 연도, 제품 지원 연도 하한, 비정상 일련번호
 *   3. compressCaseKey(num)     → "2015다6302" → "15Da6302"
 *
 * [의존성]
 *   - bupgogae_meta.json 의 case_code_map (Service Worker에서 GET_META로 전달)
 */

// ============================================================
// 1. 초기화 — Service Worker에서 case_code_map 로드
// ============================================================

/**
 * case_code_map: { "다": "Da", "가합": "Gah", ... }
 * Service Worker에서 GET_META 메시지로 전달받아 초기화.
 */
let _caseCodeMap = null;      // 한글부호 → 로마자
let _validCodes = null;       // Set<한글부호> — 유효 부호 집합
let _courtCodeMap = null;     // 법원코드 매핑 { "대법원": 1, ... }
let _shortCaseKeys = new Set(); // 활성 DB에 실제 존재하는 4글자 사건번호 압축 키
let _shortRawCases = new Set(); // 정규식 전 fast-path용 원문 사건번호
let _metaInitPromise = null;  // 초기화 Promise (중복 요청 방지)
let _courtCaseRegex = null;   // 동적 빌드된 법원 사건번호 정규식

function applyMetadata(caseCodeMap, courtCodeMap, shortCaseKeys) {
  _caseCodeMap = caseCodeMap || {};
  _validCodes = new Set(Object.keys(_caseCodeMap));
  _courtCodeMap = courtCodeMap || {};
  _shortCaseKeys = new Set(Array.isArray(shortCaseKeys)
    ? shortCaseKeys.filter((key) => typeof key === 'string')
    : []);
  _shortRawCases = new Set();

  const romanToSingleHangul = new Map();
  for (const [hangulCode, romanCode] of Object.entries(_caseCodeMap)) {
    if (hangulCode.length === 1 && typeof romanCode === 'string') {
      romanToSingleHangul.set(romanCode, hangulCode);
    }
  }
  for (const key of _shortCaseKeys) {
    if (!/^\d{2}.+\d$/.test(key)) continue;
    const hangulCode = romanToSingleHangul.get(key.slice(2, -1));
    if (hangulCode) _shortRawCases.add(`${key.slice(0, 2)}${hangulCode}${key.slice(-1)}`);
  }

  const codes = Object.keys(_caseCodeMap)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  if (codes.length > 0) {
    const codesPattern = codes.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    _courtCaseRegex = new RegExp(
      `(?<![0-9])((?:19|20)\\d{2}|\\d{2})(${codesPattern})(\\d{1,7})(?![0-9])`, 'g'
    );
  } else {
    _courtCaseRegex = null;
  }
}

/**
 * 메타데이터 초기화.
 * Content Script 로드 시 한 번 호출.
 * case_code_map 키를 기반으로 사건부호 화이트리스트 정규식을 동적 빌드.
 * @returns {Promise<void>}
 */
function initMeta() {
  if (_metaInitPromise) return _metaInitPromise;

  _metaInitPromise = new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_META' }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[bupgogae] 메타데이터 로드 실패:', chrome.runtime.lastError.message);
        applyMetadata({}, {}, []);
        resolve();
        return;
      }

      if (response && response.case_code_map) {
        applyMetadata(
          response.case_code_map,
          response.court_code_map,
          response.short_case_keys,
        );

        console.log(`[bupgogae] 메타데이터 로드 완료: ${_validCodes.size}개 사건부호, ${Object.keys(_courtCodeMap).length}개 법원, ${_shortCaseKeys.size}개 4글자 사건번호`);
      } else {
        applyMetadata({}, {}, []);
        console.warn('[bupgogae] 메타데이터 응답 이상:', response);
      }
      resolve();
    });
  });

  return _metaInitPromise;
}


// ============================================================
// 2. extractCaseNumbers(text) — 정규식으로 사건번호 후보 추출
// ============================================================

/**
 * 법원 사건번호 폴백 정규식 (메타 미로드 시에만 사용).
 * 메타 로드 후에는 _courtCaseRegex (화이트리스트)를 우선 사용.
 */
const CASE_NUMBER_REGEX_FALLBACK = /(?<![0-9])(?:(?:19|20)\d{2}|\d{2})[가-힣]{1,4}\d{1,7}(?![0-9])/g;
const CASE_PARTS_REGEX = /^((?:19|20)\d{2}|\d{2})([가-힣]{1,4})(\d{1,7})$/;

/**
 * 2자리 연도 → 4자리 변환 (현재연도 기준 슬라이딩 윈도우, M3).
 *
 * 하드코딩 피벗(예: 30)은 시간이 지나면 깨진다 — 피벗이 30이면 2030년의
 * "30다1"이 영구히 1930으로 오인된다. 대신 "현재연도를 넘지 않는 가장 가까운
 * 과거"로 해석한다: 현 세기 후보가 미래면 직전 세기로 내린다.
 *   (예: 2026년 → "26"→2026, "27"→1927, "99"→1999, "00"→2000)
 *
 * @param {number} twoDigit 0~99
 * @returns {number} 4자리 연도
 */
function expandTwoDigitYear(twoDigit) {
  const now = new Date().getFullYear();
  const candidate = Math.floor(now / 100) * 100 + twoDigit; // 현 세기 후보
  return candidate > now ? candidate - 100 : candidate;     // 미래면 직전 세기
}


/**
 * 텍스트에서 모든 사건번호 후보를 추출.
 * 법원 판례 + 헌법재판소.
 *
 * [주의] g 플래그 정규식의 lastIndex를 수동 리셋함.
 * Content Script는 단일 스레드이므로 안전하나,
 * 이 함수를 모듈 외부에서 공유·병렬 호출 시 주의 필요.
 *
 * @param {string} text - 스캔할 텍스트
 * @returns {Array<{raw: string, year: string, code: string, serial: string, startIdx: number, type: string}>}
 *          매칭 결과 배열 (중복 제거됨). type: 'court' | 'constitutional'
 */
function extractCaseNumbers(text) {
  if (!text || typeof text !== 'string') return [];

  const results = [];
  const seen = new Set();

  // --- 법원 판례 (화이트리스트 우선, 메타 미로드 시 폴백) ---
  let match;

  if (_courtCaseRegex) {
    // 동적 화이트리스트 정규식: case_code_map 부호만 매칭
    _courtCaseRegex.lastIndex = 0;
    while ((match = _courtCaseRegex.exec(text)) !== null) {
      const raw = match[0];
      const parsed = {
        raw, year: match[1], code: match[2], serial: match[3],
        startIdx: match.index,
        type: match[2].startsWith('헌') ? 'constitutional' : 'court',
      };
      // 정확히 4글자인 후보는 활성 DB snapshot에서 파생한 canonical 집합만 허용한다.
      if (raw.length === 4 && !_shortCaseKeys.has(compressCaseKey(parsed))) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      results.push(parsed);
    }
  } else {
    // 폴백: 메타 미로드 시 범용 정규식
    CASE_NUMBER_REGEX_FALLBACK.lastIndex = 0;
    while ((match = CASE_NUMBER_REGEX_FALLBACK.exec(text)) !== null) {
      const raw = match[0];
      if (seen.has(raw)) continue;
      seen.add(raw);
      const parts = raw.match(CASE_PARTS_REGEX);
      if (!parts) continue;
      // 메타 로드 실패 시 canonical 집합도 없으므로 4글자 후보는 fail-closed한다.
      if (raw.length === 4) continue;
      results.push({
        raw, year: parts[1], code: parts[2], serial: parts[3],
        startIdx: match.index, type: 'court',
      });
    }
  }

  return results;
}


// ============================================================
// 3. validateCaseNumber(parsed) — Red 필터
// ============================================================

/**
 * 사건번호 유효성 검증.
 *
 * Red 판정 기준:
 *   1. 미래 연도: year > currentYear
 *   2. 제품 지원 연도 하한: 법원 < 1945, 헌재 < 1988
 *   3. 비정상 일련번호: 0
 *
 * 사건부호 유효성은 추출 단계에서 화이트리스트 정규식(_courtCaseRegex)으로
 * 이미 필터링되므로, 이 함수에서는 검증하지 않는다.
 *
 * @param {{year: string, code: string, serial: string, type: string}} parsed
 * @returns {{valid: boolean, reason: string|null}}
 */
function validateCaseNumber(parsed) {
  const currentYear = new Date().getFullYear();

  // ── 연도 정규화 (2자리 → 4자리, 현재연도 기준 슬라이딩 윈도우) ──
  let fullYear;
  // 2자리 연도가 "현 세기 후보가 미래라 직전 세기로 내려간" 경우를 표시.
  // (예: 2026년의 "27" → 2027은 미래 → 1927로 해석). 이 경우 floor 미만 사유를
  // "비현실적 연도(1927년)"로만 적으면 1927이 의도였던 것처럼 오도되므로 분기한다.
  let twoDigitDroppedToPastCentury = false;
  if (parsed.year.length === 2) {
    const twoDigit = parseInt(parsed.year, 10);
    fullYear = expandTwoDigitYear(twoDigit);
    const sameCenturyCandidate = Math.floor(currentYear / 100) * 100 + twoDigit;
    twoDigitDroppedToPastCentury = sameCenturyCandidate > currentYear;
  } else {
    fullYear = parseInt(parsed.year, 10);
  }

  // ── Red 1: 미래 연도 ──
  if (fullYear > currentYear) {
    return {
      valid: false,
      reason: `미래 연도(${fullYear}년)입니다. 현재 ${currentYear}년까지의 사건만 존재할 수 있습니다.`,
    };
  }

  // ── Red 2: 제품 지원 연도 하한 ──
  // 이 하한은 현재 공개 DB와 조회 정책의 범위이며, 법적 부존재 판정이 아니다.
  const minYears = { court: 1945, constitutional: 1988 };
  const minYear = minYears[parsed.type] || 1945;
  if (fullYear < minYear) {
    const floorLabel = parsed.type === 'constitutional'
      ? '헌법재판소 사건 조회 지원 하한(1988)'
      : '법원 사건 조회 지원 하한(1945)';
    // 2자리 연도가 직전 세기로 해석돼 floor 미만이 된 경우엔, 해석 과정을 밝혀
    // "왜 과거로 읽혔는지"를 사용자가 알 수 있게 한다 (라벨은 Red로 동일).
    const reason = twoDigitDroppedToPastCentury
      ? `2자리 연도 '${parsed.year}'은 가장 가까운 과거인 ${fullYear}년으로 해석되며, 이는 ${floorLabel} 이전입니다.`
      : `${fullYear}년은 법고개의 ${floorLabel}보다 이전이어서 조회 지원 범위 밖입니다.`;
    return { valid: false, reason };
  }

  // (Red 3 삭제: 사건부호 유효성 검증은 타기관 부호(부해, 형제 등) 오탐 문제로 제거)

  // ── Red 4: 비정상 일련번호 ──
  const serialNum = parseInt(parsed.serial, 10);
  if (serialNum === 0) {
    return {
      valid: false,
      reason: '일련번호가 0입니다.',
    };
  }

  return { valid: true, reason: null };
}


// ============================================================
// 4. compressCaseKey(parsed) — 압축 키 변환
// ============================================================

/**
 * 파싱된 사건번호를 IndexedDB 조회용 키 형식으로 압축.
 *
 * 변환 규칙:
 *   - 연도: 뒤 2자리만 (2015 → "15")
 *   - 사건부호: case_code_map 로마자 (다 → "Da")
 *   - 일련번호: 그대로
 *
 * 예시: { year: "2015", code: "다", serial: "6302" } → "15Da6302"
 *
 * @param {{year: string, code: string, serial: string}} parsed
 * @returns {string|null} 압축 키. case_code_map에 없으면 null.
 */
function compressCaseKey(parsed) {
  if (!_caseCodeMap) return null;

  // 연도 뒤 2자리
  const yearSuffix = parsed.year.length === 4
    ? parsed.year.slice(2)
    : parsed.year;

  // 법원/헌재 판례: case_code_map 로마자 압축
  const romanCode = _caseCodeMap[parsed.code];
  if (!romanCode) return null;
  return `${yearSuffix}${romanCode}${parsed.serial}`;
}


// ============================================================
// 5. 유틸리티
// ============================================================

/**
 * 메타데이터 초기화 완료 확인.
 * @returns {boolean}
 */
function isMetaReady() {
  return _validCodes !== null && _validCodes.size > 0;
}

/**
 * court_code_map 반환 (precedent-badge.js에서 full citation 빌드에 사용).
 * @returns {Object}
 */
function getCourtCodeMap() {
  return _courtCodeMap || {};
}

/** 활성 DB snapshot 교체 후 메타를 다시 읽는다. 진행 중 초기화와는 직렬화한다. */
async function refreshMeta() {
  if (_metaInitPromise) await _metaInitPromise;
  _metaInitPromise = null;
  return initMeta();
}

/** 고립된 4글자 텍스트 노드를 정규식 전에 O(1)로 거르는 fast-path. */
function isCanonicalShortCaseText(text) {
  return typeof text === 'string' && text.length === 4 && _shortRawCases.has(text);
}

/** 조회 snapshot과 함께 온 court map으로 원자적으로 교체한다. */
function updateCourtCodeMap(courtCodeMap) {
  if (!courtCodeMap || typeof courtCodeMap !== 'object' || Array.isArray(courtCodeMap)) return false;
  _courtCodeMap = { ...courtCodeMap };
  return true;
}


// ============================================================
// 6. 외부 인터페이스
// ============================================================

if (typeof window !== 'undefined') {
  window.bupgogaeCaseRegex = {
    initMeta,
    refreshMeta,
    extractCaseNumbers,
    validateCaseNumber,
    compressCaseKey,
    isMetaReady,
    getCourtCodeMap,
    updateCourtCodeMap,
    isCanonicalShortCaseText,
  };
}

// CommonJS 노출 (단위 테스트용 — 런타임 동작에는 영향 없음)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initMeta,
    refreshMeta,
    extractCaseNumbers,
    validateCaseNumber,
    compressCaseKey,
    isMetaReady,
    getCourtCodeMap,
    updateCourtCodeMap,
    isCanonicalShortCaseText,
    /**
     * 테스트 전용: 메타데이터(case_code_map / court_code_map)를 직접 주입.
     * Service Worker 메시지 없이 화이트리스트 정규식·압축 로직을 검증하기 위함.
     */
    __setMetaForTest(caseCodeMap, courtCodeMap, shortCaseKeys = []) {
      applyMetadata(caseCodeMap, courtCodeMap, shortCaseKeys);
    },
    /** 테스트 전용: 주입된 메타 초기화. */
    __resetMetaForTest() {
      _caseCodeMap = null;
      _validCodes = null;
      _courtCodeMap = null;
      _shortCaseKeys = new Set();
      _shortRawCases = new Set();
      _metaInitPromise = null;
      _courtCaseRegex = null;
    },
  };
}
