/**
 * 법고개(Bupgogae) — Sync 순수 유틸리티
 * =====================================
 * Service Worker(db-sync.js)에서 chrome.* / IndexedDB / fetch와 얽혀 있던
 * 순수 검증·정제 로직을 분리한 모듈. 외부 부수효과가 전혀 없어 단위 테스트가
 * 가능하며, db-sync.js는 importScripts('sync-utils.js')로 로드한다.
 *
 * 공개 API (globalThis 또는 module.exports):
 *   isValidCssSelector(s, maxLen)            → boolean
 *   sanitizeAdaptersConfig(config, opts)     → config (in-place 정제)
 *   validateDbIntegrity(data, opts)          → { ok, error?, keyCount? }
 */
(function (root) {
  'use strict';

  const DEFAULT_MAX_SELECTOR_LENGTH = 150;
  const DEFAULT_MAX_SELECTORS_PER_SITE = 10;
  const DEFAULT_VERSION_REGEX = /^\d{8}$/; // YYYYMMDD

  /**
   * CSS 셀렉터 화이트리스트 검증.
   * 원격 어댑터 설정에서 받은 셀렉터가 querySelectorAll()에 안전한지 검증한다.
   * 금지 패턴 차단 + 허용 문자 화이트리스트 조합.
   *
   * @param {string} s
   * @param {number} [maxLen]
   * @returns {boolean}
   */
  function isValidCssSelector(s, maxLen = DEFAULT_MAX_SELECTOR_LENGTH) {
    if (typeof s !== 'string' || s.length === 0 || s.length > maxLen) return false;
    const DANGEROUS = [':has(', 'url(', '@import', 'expression(', 'javascript:'];
    const lower = s.toLowerCase();
    if (DANGEROUS.some(p => lower.includes(p))) return false;
    return /^[a-zA-Z0-9\-_.*#>+~:=\[\]"\\,\s()]+$/.test(s);
  }

  /**
   * 원격 어댑터 설정의 셀렉터를 화이트리스트 기반으로 정제 (in-place).
   * - responseSelectors: 배열 크기 제한 + 유효 셀렉터만 유지, 비배열이면 제거
   * - streamingIndicator: 유효하지 않으면 제거
   * - scraping_adapters: 유효하지 않은 셀렉터 제거
   *
   * @param {Object} config - config.adapters를 가진 설정 객체
   * @param {{maxPerSite?: number, maxLen?: number}} [opts]
   * @returns {Object} 정제된 config (입력과 동일 객체)
   */
  function sanitizeAdaptersConfig(config, opts = {}) {
    const maxPerSite = opts.maxPerSite || DEFAULT_MAX_SELECTORS_PER_SITE;
    const maxLen = opts.maxLen || DEFAULT_MAX_SELECTOR_LENGTH;

    if (!config || typeof config.adapters !== 'object') return config;

    for (const [siteId, siteConfig] of Object.entries(config.adapters)) {
      if (siteConfig.responseSelectors) {
        const selectors = siteConfig.responseSelectors;
        if (Array.isArray(selectors)) {
          config.adapters[siteId].responseSelectors = selectors
            .slice(0, maxPerSite)
            .filter(s => isValidCssSelector(s, maxLen));
        } else {
          delete config.adapters[siteId].responseSelectors;
        }
      }
      if (siteConfig.streamingIndicator &&
          !isValidCssSelector(siteConfig.streamingIndicator, maxLen)) {
        delete config.adapters[siteId].streamingIndicator;
      }
    }

    if (config.scraping_adapters && typeof config.scraping_adapters === 'object') {
      for (const selObj of Object.values(config.scraping_adapters)) {
        for (const [key, val] of Object.entries(selObj)) {
          if (!isValidCssSelector(val, maxLen)) delete selObj[key];
        }
      }
    }

    return config;
  }

  /**
   * 다운로드한 DB 페이로드의 무결성 검증.
   * 키 수 하한, version 형식, total 정합성, 레코드 구조(샘플)를 확인한다.
   *
   * @param {Object} data - { cases, version?, total? }
   * @param {{minKeys?: number, versionRegex?: RegExp}} [opts]
   * @returns {{ok: boolean, error?: string, keyCount?: number}}
   */
  function validateDbIntegrity(data, opts = {}) {
    const versionRegex = opts.versionRegex || DEFAULT_VERSION_REGEX;

    if (!data || !data.cases || typeof data.cases !== 'object') {
      return { ok: false, error: '유효하지 않은 응답 (cases 없음)' };
    }

    const keys = Object.keys(data.cases);
    const keyCount = keys.length;

    if (typeof opts.minKeys === 'number' && keyCount < opts.minKeys) {
      return { ok: false, error: `키 수 ${keyCount} < 하한 ${opts.minKeys}` };
    }
    if (data.version && !versionRegex.test(String(data.version))) {
      return { ok: false, error: `version 형식 오류 '${data.version}'` };
    }
    if (data.total && data.total !== keyCount) {
      return { ok: false, error: `total(${data.total}) ≠ keys(${keyCount})` };
    }

    // 레코드 구조 샘플 검증 — 랜덤 최대 5건이 [[serial, ...], ...] 형태인지
    const sampleSize = Math.min(5, keyCount);
    for (let i = 0; i < sampleSize; i++) {
      const key = keys[Math.floor(Math.random() * keyCount)];
      const val = data.cases[key];
      if (!Array.isArray(val) || val.length === 0) {
        return { ok: false, error: `cases["${key}"]가 비어있거나 배열이 아님` };
      }
      for (const entry of val) {
        if (!Array.isArray(entry) || entry.length < 1) {
          return { ok: false, error: `cases["${key}"] 엔트리 형식 불량` };
        }
      }
    }

    return { ok: true, keyCount };
  }

  const api = { isValidCssSelector, sanitizeAdaptersConfig, validateDbIntegrity };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;          // 단위 테스트 (Node)
  } else {
    Object.assign(root, api);      // Service Worker 전역 (importScripts)
  }
})(typeof self !== 'undefined' ? self : this);
