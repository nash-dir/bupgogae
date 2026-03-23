/**
 * 법고개(Bupgogae) — 사건번호 정규식 + Red 필터 + 키 압축 모듈
 * ==============================================================
 * LLM 응답 텍스트에서 한국 판례/심판 사건번호를 추출, 검증, 압축한다.
 *
 * [파이프라인]
 *   1. extractCaseNumbers(text) → 화이트리스트 정규식으로 사건번호 추출
 *      - 법원/헌재: case_code_map 기반 동적 정규식 (등록된 사건부호만 매칭)
 *      - 조세심판: "조심" prefix 전용 정규식
 *      - 특허심판: 당/원/취/정/무 전용 정규식
 *   2. validateCaseNumber(num)  → Red 필터: 미래 연도, 비현실적 과거, 비정상 일련번호
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
let _courtCaseRegex = null;   // 동적 빌드된 법원 사건번호 정규식

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
        _caseCodeMap = {};
        _validCodes = new Set();
        resolve();
        return;
      }

      if (response && response.case_code_map) {
        _caseCodeMap = response.case_code_map;
        _validCodes = new Set(Object.keys(_caseCodeMap));
        _courtCodeMap = response.court_code_map || {};

        // 화이트리스트 정규식 빌드: 긴 부호 우선 (가합 > 가)
        const codes = Object.keys(_caseCodeMap)
          .sort((a, b) => b.length - a.length || a.localeCompare(b));
        if (codes.length > 0) {
          const codesPattern = codes.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
          // 캡처 그룹: (연도)(사건부호)(일련번호)
          _courtCaseRegex = new RegExp(
            `((?:19|20)\\d{2}|\\d{2})(${codesPattern})(\\d{1,7})`, 'g'
          );
        }

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
 * 법원 사건번호 폴백 정규식 (메타 미로드 시에만 사용).
 * 메타 로드 후에는 _courtCaseRegex (화이트리스트)를 우선 사용.
 */
const CASE_NUMBER_REGEX_FALLBACK = /(?:(?:19|20)\d{2}|\d{2})[가-힣]{1,4}\d{1,7}/g;
const CASE_PARTS_REGEX = /^((?:19|20)\d{2}|\d{2})([가-힣]{1,4})(\d{1,7})$/;

/**
 * 조세심판원 사건번호 정규식.
 *
 * 구조: [조심] [연도][지역코드][일련번호]
 *   - "조심" 접두사 (필수)
 *   - 연도: 4자리 또는 2자리
 *   - 지역코드: 한글 1자 (중/서/지/전/부/구/광/대/국 등)
 *   - 일련번호: 1~5자리 숫자
 *
 * 예시: "조심 2025중2548", "조심2024지1234"
 */
const TAX_CASE_REGEX = /조심\s*(\d{2,4})([가-힣])(\d{1,5})/g;

/**
 * 특허심판원 사건번호 정규식.
 *
 * 구조: [연도][심판종류코드][일련번호]
 *   - 연도: 4자리
 *   - 심판종류코드: 당(거절결정/무효), 원(권리범위확인/정정무효),
 *                   취(권리범위확인), 정(정정심판)
 *   - 일련번호: 1~6자리 숫자
 *
 * 주의: 법원 '무'(형사재심)와 충돌 방지 위해 '무' 제외.
 *       KIPRIS 무효사건은 '당' 코드를 사용.
 *
 * 예시: "2023당1234", "2022원5678", "2021취100"
 */
const PATENT_TRIAL_REGEX = /(\d{4})(당|원|취|정)\s*(\d{1,6})/g;


/**
 * 텍스트에서 모든 사건번호 후보를 추출.
 * 법원 판례 + 조세심판원 통합.
 *
 * @param {string} text - 스캔할 텍스트
 * @returns {Array<{raw: string, year: string, code: string, serial: string, startIdx: number, type: string}>}
 *          매칭 결과 배열 (중복 제거됨). type: 'court' | 'tax'
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
      if (seen.has(raw)) continue;
      seen.add(raw);
      // 헌재 부호(헌가~헌아)는 'constitutional', 나머지는 'court'
      const caseType = match[2].startsWith('헌') ? 'constitutional' : 'court';
      results.push({
        raw, year: match[1], code: match[2], serial: match[3],
        startIdx: match.index, type: caseType,
      });
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
      results.push({
        raw, year: parts[1], code: parts[2], serial: parts[3],
        startIdx: match.index, type: 'court',
      });
    }
  }

  // --- 조세심판원 ---
  TAX_CASE_REGEX.lastIndex = 0;
  while ((match = TAX_CASE_REGEX.exec(text)) !== null) {
    const raw = match[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    results.push({
      raw, year: match[1], code: match[2], serial: match[3],
      startIdx: match.index, type: 'tax',
    });
  }

  // --- 특허심판원 ---
  PATENT_TRIAL_REGEX.lastIndex = 0;
  while ((match = PATENT_TRIAL_REGEX.exec(text)) !== null) {
    const raw = match[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    results.push({
      raw, year: match[1], code: match[2], serial: match[3].trim(),
      startIdx: match.index, type: 'patent',
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
 *   2. 비현실적 과거 연도: 법원 < 1945, 특허 < 1956, 조세 < 1966
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

  // ── Red 2: 비현실적 과거 연도 ──
  const minYears = { tax: 1966, patent: 1956, court: 1945 };
  const minYear = minYears[parsed.type] || 1945;
  if (fullYear < minYear) {
    return {
      valid: false,
      reason: `비현실적 연도(${fullYear}년)입니다.`,
    };
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

  // 조세심판원: "TX" prefix + 지역코드 그대로
  if (parsed.type === 'tax') {
    return `TX${yearSuffix}${parsed.code}${parsed.serial}`;
  }

  // 특허심판원: "KP" prefix + 심판종류 + 일련번호
  if (parsed.type === 'patent') {
    return `KP${yearSuffix}${parsed.code}${parsed.serial}`;
  }

  // 법원 판례: 기존 로직
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
