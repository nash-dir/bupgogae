/**
 * 법고개(Bupgogae) — 사건번호 정규식 + Red 필터 + 키 압축 모듈
 * ==============================================================
 * LLM 응답 텍스트에서 한국 판례/심판 사건번호를 추출, 검증, 압축한다.
 *
 * [파이프라인]
 *   1. extractCaseNumbers(text) → 화이트리스트 정규식으로 사건번호 추출
 *      - 법원/헌재: case_code_map 기반 동적 정규식 (등록된 사건부호만 매칭)
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
            `(?<![0-9])((?:19|20)\\d{2}|\\d{2})(${codesPattern})(\\d{1,7})`, 'g'
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
const CASE_NUMBER_REGEX_FALLBACK = /(?<![0-9])(?:(?:19|20)\d{2}|\d{2})[가-힣]{1,4}\d{1,7}/g;
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
 *   2. 비현실적 과거 연도: 법원 < 1945, 헌재 < 1988
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
  if (parsed.year.length === 2) {
    fullYear = expandTwoDigitYear(parseInt(parsed.year, 10));
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
  // 헌재(constitutional)는 헌법재판소 설립(1988) 이전 사건이 존재할 수 없다 (L2).
  const minYears = { court: 1945, constitutional: 1988 };
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

// CommonJS 노출 (단위 테스트용 — 런타임 동작에는 영향 없음)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initMeta,
    extractCaseNumbers,
    validateCaseNumber,
    compressCaseKey,
    isMetaReady,
    getCourtCodeMap,
    /**
     * 테스트 전용: 메타데이터(case_code_map / court_code_map)를 직접 주입.
     * Service Worker 메시지 없이 화이트리스트 정규식·압축 로직을 검증하기 위함.
     */
    __setMetaForTest(caseCodeMap, courtCodeMap) {
      _caseCodeMap = caseCodeMap || {};
      _validCodes = new Set(Object.keys(_caseCodeMap));
      _courtCodeMap = courtCodeMap || {};
      const codes = Object.keys(_caseCodeMap)
        .sort((a, b) => b.length - a.length || a.localeCompare(b));
      if (codes.length > 0) {
        const codesPattern = codes.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        _courtCaseRegex = new RegExp(
          `(?<![0-9])((?:19|20)\\d{2}|\\d{2})(${codesPattern})(\\d{1,7})`, 'g'
        );
      } else {
        _courtCaseRegex = null;
      }
    },
    /** 테스트 전용: 주입된 메타 초기화. */
    __resetMetaForTest() {
      _caseCodeMap = null;
      _validCodes = null;
      _courtCodeMap = null;
      _courtCaseRegex = null;
    },
  };
}
