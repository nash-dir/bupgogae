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
 *
 * 동기화 정책 함수 (0.8.0 "DB 2달 정체" 사고 재발 방지 — 명세는
 * __tests__/sync-policy.test.js 헤더가 SSOT):
 *   buildFetchPlan(local, nowMs, opts)       → { conditional, reasons }
 *   shouldLoadBundled(bundledVersion, local) → { load, reason }
 *   validateManifest(m)                      → { ok, error? }
 *   evaluateDrift(manifest, local, nowMs, opts) → { action, reasons }
 *   appendLedger(ledger, entry, max)         → 새 배열 (최신순, 불변)
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

    if (!config || config.adapters == null || typeof config.adapters !== 'object') return config;

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

    // 레코드 구조 샘플 검증 — 중복 없는 선택으로 탐지율 100% 보장
    // 키 수가 sampleSize 이하면 전수 검사; 아니면 중복 없는 랜덤 샘플
    const sampleSize = Math.min(5, keyCount);
    let sampleKeys;
    if (keyCount <= sampleSize) {
      sampleKeys = keys;
    } else {
      // Fisher-Yates 부분 셔플로 중복 없는 sampleSize개 선택
      const indices = keys.slice();
      for (let i = 0; i < sampleSize; i++) {
        const j = i + Math.floor(Math.random() * (keyCount - i));
        const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp;
      }
      sampleKeys = indices.slice(0, sampleSize);
    }
    for (const key of sampleKeys) {
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

  // ============================================================
  // 동기화 정책 함수 (순수 판정 — db-sync.js는 결과만 따른다)
  // ============================================================

  const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;
  const MAX_MANIFEST_TOTAL = 10_000_000; // 원격 manifest total 상한 (비정상 값 차단)

  /**
   * 조건부 요청(If-None-Match) 허용 여부 판정 — 304 가드 + 워치독.
   * "로컬이 건강하고 최근 성공 이력이 있을 때"만 ETag를 신뢰한다.
   * (etag↔IndexedDB 상태 불일치 시 304에 갇혀 빈 DB가 방치되는 트랩 방지)
   *
   * @param {{etag, lastSuccessAt, localVer, coreCount}} local
   * @param {number} nowMs
   * @param {{watchdogMs: number, minCoreKeys: number}} opts
   * @returns {{conditional: boolean, reasons: string[]}}
   */
  function buildFetchPlan(local, nowMs, opts) {
    const reasons = [];

    if (!local || !local.etag) reasons.push('no_etag');
    if (!local || !local.localVer) reasons.push('no_local_version');
    if (!local || typeof local.coreCount !== 'number' || local.coreCount < opts.minCoreKeys) {
      reasons.push('local_db_unhealthy');
    }
    if (!local || local.lastSuccessAt == null) {
      reasons.push('no_success_record');
    } else if (nowMs - local.lastSuccessAt >= opts.watchdogMs) {
      reasons.push('watchdog_expired');
    }

    return { conditional: reasons.length === 0, reasons };
  }

  /**
   * 번들 DB 폴백 허용 여부 판정 — 다운그레이드 절대 금지.
   * "빈 DB를 채우거나 더 최신일 때"만 로드한다.
   *
   * @param {string} bundledVersion - 번들 DB의 version (YYYYMMDD 기대)
   * @param {{localVer, coreCount}} local
   * @returns {{load: boolean, reason: string}}
   */
  function shouldLoadBundled(bundledVersion, local) {
    const coreCount = (local && typeof local.coreCount === 'number') ? local.coreCount : 0;
    const localVer = local ? local.localVer : null;

    if (coreCount <= 0) return { load: true, reason: 'local_empty' };
    if (!localVer) return { load: true, reason: 'no_local_version' };

    // YYYYMMDD 형식끼리만 비교 가능 — 형식 불량이면 "더 최신" 입증 불가 → 금지
    if (!DEFAULT_VERSION_REGEX.test(String(bundledVersion)) ||
        !DEFAULT_VERSION_REGEX.test(String(localVer))) {
      return { load: false, reason: 'bundled_not_newer' };
    }

    return String(bundledVersion) > String(localVer)
      ? { load: true, reason: 'bundled_newer' }
      : { load: false, reason: 'bundled_not_newer' };
  }

  /**
   * manifest 엔트리(core/tax 공용) 검증.
   * @returns {string|null} 오류 메시지 (정상이면 null)
   */
  function validateManifestEntry(entry, label) {
    if (!entry || typeof entry !== 'object') return `${label} 누락`;
    if (typeof entry.version !== 'string' || !DEFAULT_VERSION_REGEX.test(entry.version)) {
      return `${label}.version 형식 오류`;
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_HEX_REGEX.test(entry.sha256)) {
      return `${label}.sha256 형식 오류`;
    }
    if (!Number.isInteger(entry.total) || entry.total <= 0 || entry.total > MAX_MANIFEST_TOTAL) {
      return `${label}.total 범위 오류`;
    }
    return null;
  }

  /**
   * 원격 manifest 엄격 스키마 검증.
   * 검증 실패한 manifest는 어떤 행동도 유발하면 안 된다 (fail-open).
   *
   * @param {Object} m
   * @returns {{ok: boolean, error?: string}}
   */
  function validateManifest(m) {
    if (!m || typeof m !== 'object') return { ok: false, error: 'manifest 없음' };
    if (m.schema !== 1) return { ok: false, error: `지원하지 않는 schema: ${m.schema}` };
    if (typeof m.built_at !== 'string' || !Number.isFinite(Date.parse(m.built_at))) {
      return { ok: false, error: 'built_at 파싱 불가' };
    }

    const coreError = validateManifestEntry(m.core, 'core');
    if (coreError) return { ok: false, error: coreError };

    if (m.tax !== undefined) {
      const taxError = validateManifestEntry(m.tax, 'tax');
      if (taxError) return { ok: false, error: taxError };
    }

    return { ok: true };
  }

  /**
   * 로컬 DB와 manifest 정답지의 드리프트 판정 + 자가치유 폭주 방지.
   * 우선순위: backoff(strike 초과) > defer(grace window/미래 built_at)
   *           > force_sync > none (local_ahead 포함 — 다운그레이드 동기화 금지).
   *
   * @param {Object} manifest - validateManifest를 통과한 manifest
   * @param {{localVer, contentHash, coreCount, strikes}} local
   * @param {number} nowMs
   * @param {{graceMs: number, maxStrikes: number}} opts
   * @returns {{action: 'none'|'defer'|'backoff'|'force_sync', reasons: string[]}}
   */
  function evaluateDrift(manifest, local, nowMs, opts) {
    const remote = manifest.core;
    const reasons = [];

    const localVer = local && local.localVer ? String(local.localVer) : null;
    if (!localVer) {
      reasons.push('no_local_version');
    } else if (localVer < remote.version) {
      reasons.push('version_behind');
    } else if (localVer > remote.version) {
      // 게시 레이스: 클라이언트가 더 최신이면 절대 강제 동기화 금지
      return { action: 'none', reasons: ['local_ahead'] };
    } else {
      // 같은 버전 — 내용물 대조 (해시 미기록이면 해시 검사 스킵)
      if (local.contentHash && local.contentHash !== remote.sha256) {
        reasons.push('hash_mismatch');
      }
      if (typeof local.coreCount === 'number' && local.coreCount !== remote.total) {
        reasons.push('count_mismatch');
      }
    }

    if (reasons.length === 0) return { action: 'none', reasons: [] };

    // 드리프트가 있어도 strike 한도에 도달하면 자가치유 중단 (폭주 방지)
    if (((local && local.strikes) || 0) >= opts.maxStrikes) {
      return { action: 'backoff', reasons };
    }

    // 갓 게시된 manifest는 CDN 전파 대기, 미래 built_at은 시계 스큐 의심
    const builtAtMs = Date.parse(manifest.built_at);
    if (Number.isFinite(builtAtMs)) {
      if (builtAtMs > nowMs) return { action: 'defer', reasons: [...reasons, 'built_at_future'] };
      if (nowMs - builtAtMs < opts.graceMs) return { action: 'defer', reasons: [...reasons, 'grace_window'] };
    }

    return { action: 'force_sync', reasons };
  }

  /**
   * 동기화 시도 원장에 엔트리 추가 (최신순, max 초과분 절삭, 입력 불변).
   *
   * @param {Array|undefined} ledger - 기존 원장 (비배열이면 빈 원장 취급)
   * @param {Object} entry
   * @param {number} max
   * @returns {Array} 새 배열
   */
  function appendLedger(ledger, entry, max) {
    const base = Array.isArray(ledger) ? ledger : [];
    return [entry, ...base].slice(0, max);
  }

  const api = {
    isValidCssSelector,
    sanitizeAdaptersConfig,
    validateDbIntegrity,
    buildFetchPlan,
    shouldLoadBundled,
    validateManifest,
    evaluateDrift,
    appendLedger,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;          // 단위 테스트 (Node)
  } else {
    Object.assign(root, api);      // Service Worker 전역 (importScripts)
  }
})(typeof self !== 'undefined' ? self : this);
