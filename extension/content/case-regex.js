/**
 * 법고개(Bupgogae) — 사건번호 정규식 + Red 필터 + 키 압축 모듈
 * ==============================================================
 * LLM 응답 텍스트에서 한국 판례 사건번호를 추출, 검증, 압축한다.
 *
 * [파이프라인]
 *   1. extractCaseNumbers(text) → 정규식으로 사건번호 후보 전부 추출
 *   2. validateCaseNumber(num)  → Red 필터: 미래 연도, 무효 부호, 비정상 일련번호
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
let _metaInitPromise = null;  // 초기화 Promise (중복 요청 방지)

/**
 * 메타데이터 초기화.
 * Content Script 로드 시 한 번 호출.
 * @returns {Promise<void>}
 */
function initMeta() {
  if (_metaInitPromise) return _metaInitPromise;

  _metaInitPromise = new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_META' }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[bupgogae] 메타데이터 로드 실패:', chrome.runtime.lastError.message);
        _caseCodeMap = {};
        _validCodes = new Set();
        resolve();
        return;
      }

      if (response && response.case_code_map) {
        _caseCodeMap = response.case_code_map;
        _validCodes = new Set(Object.keys(_caseCodeMap));
        _courtCodeMap = response.court_code_map || {};
        console.log(`[bupgogae] 메타데이터 로드 완료: ${_validCodes.size}개 사건부호, ${Object.keys(_courtCodeMap).length}개 법원`);
      } else {
        _caseCodeMap = {};
        _validCodes = new Set();
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
 * 한국 판례 사건번호 정규식.
 *
 * 구조: [연도][사건부호][일련번호]
 *   - 연도: 4자리 (19xx 또는 20xx)
 *   - 사건부호: 한글 1~4자 (예: 다, 가합, 재다카, 준재가단)
 *   - 일련번호: 1~7자리 숫자
 *
 * 예시 매칭:
 *   "2015다6302"     → { year: "2015", code: "다", serial: "6302" }
 *   "2023가합12345"  → { year: "2023", code: "가합", serial: "12345" }
 *   "99다카34567"    → { year: "99", code: "다카", serial: "34567" }
 *
 * 연도가 2자리인 케이스(99다카12345)도 지원하되,
 * 4자리 우선 매칭 → 2자리 폴백.
 */
const CASE_NUMBER_REGEX = /(?:(?:19|20)\d{2}|\d{2})[가-힣]{1,4}\d{1,7}/g;

/**
 * 세부 분해용 정규식 (그룹 캡처).
 * g1: 연도 (2~4자리)
 * g2: 사건부호 (한글 1~4자)
 * g3: 일련번호 (1~7자리)
 */
const CASE_PARTS_REGEX = /^((?:19|20)\d{2}|\d{2})([가-힣]{1,4})(\d{1,7})$/;

/**
 * 텍스트에서 모든 사건번호 후보를 추출.
 *
 * @param {string} text - 스캔할 텍스트
 * @returns {Array<{raw: string, year: string, code: string, serial: string, startIdx: number}>}
 *          매칭 결과 배열 (중복 제거됨)
 */
function extractCaseNumbers(text) {
  if (!text || typeof text !== 'string') return [];

  const results = [];
  const seen = new Set();

  let match;
  // 매번 lastIndex 리셋
  CASE_NUMBER_REGEX.lastIndex = 0;

  while ((match = CASE_NUMBER_REGEX.exec(text)) !== null) {
    const raw = match[0];
    if (seen.has(raw)) continue;
    seen.add(raw);

    const parts = raw.match(CASE_PARTS_REGEX);
    if (!parts) continue;

    results.push({
      raw,
      year: parts[1],
      code: parts[2],
      serial: parts[3],
      startIdx: match.index,
    });
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
 *   2. 무효 사건부호: case_code_map에 없는 부호
 *   3. 비정상 일련번호: 0 또는 지나치게 큰 번호 (> 9999999)
 *
 * @param {{year: string, code: string, serial: string}} parsed
 * @returns {{valid: boolean, reason: string|null}}
 */
function validateCaseNumber(parsed) {
  const currentYear = new Date().getFullYear();

  // ── 연도 정규화 (2자리 → 4자리) ──
  let fullYear;
  if (parsed.year.length === 2) {
    const twoDigit = parseInt(parsed.year, 10);
    // 00~29 → 2000~2029, 30~99 → 1930~1999
    fullYear = twoDigit <= 29 ? 2000 + twoDigit : 1900 + twoDigit;
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

  // ── Red 2: 비현실적 과거 연도 (1945년 이전) ──
  if (fullYear < 1945) {
    return {
      valid: false,
      reason: `비현실적 연도(${fullYear}년)입니다. 대한민국 사법부는 1945년 이후 설립되었습니다.`,
    };
  }

  // ── Red 3: 무효 사건부호 ──
  if (_validCodes && _validCodes.size > 0 && !_validCodes.has(parsed.code)) {
    return {
      valid: false,
      reason: `"${parsed.code}"는 유효하지 않은 사건부호입니다.`,
    };
  }

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

  const romanCode = _caseCodeMap[parsed.code];
  if (!romanCode) return null;

  // 연도 뒤 2자리
  const yearSuffix = parsed.year.length === 4
    ? parsed.year.slice(2)
    : parsed.year;

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


// ============================================================
// 6. 외부 인터페이스
// ============================================================

if (typeof window !== 'undefined') {
  window.bupgogaeCaseRegex = {
    initMeta,
    extractCaseNumbers,
    validateCaseNumber,
    compressCaseKey,
    isMetaReady,
    getCourtCodeMap,
  };
}
