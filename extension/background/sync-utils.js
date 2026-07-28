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
 *   validateVersionDate(version, opts)        → { ok, error? }
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
  const DEFAULT_MAX_ADAPTER_SITES = 50;
  const DEFAULT_VERSION_REGEX = /^\d{8}$/; // YYYYMMDD
  const DAY_MS = 24 * 60 * 60 * 1000;
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

  /**
   * YYYYMMDD 버전이 실제 달력 날짜이고 KST 오늘 기준 허용 미래 범위 안인지 검증.
   * nowMs를 주입할 수 있어 테스트와 정책 판정이 시간에 독립적이다.
   *
   * @param {*} version
   * @param {{nowMs?: number, futureSkewDays?: number}} [opts]
   * @returns {{ok: boolean, error?: string}}
   */
  function validateVersionDate(version, opts = {}) {
    if (typeof version !== 'string' || !DEFAULT_VERSION_REGEX.test(version)) {
      return { ok: false, error: 'YYYYMMDD 문자열 아님' };
    }

    const year = Number(version.slice(0, 4));
    const month = Number(version.slice(4, 6));
    const day = Number(version.slice(6, 8));
    const versionMs = Date.UTC(year, month - 1, day);
    const parsed = new Date(versionMs);
    if (year < 2000 || parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
      return { ok: false, error: '실제 달력 날짜 아님' };
    }

    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const futureSkewDays = Number.isSafeInteger(opts.futureSkewDays) &&
      opts.futureSkewDays >= 0 ? opts.futureSkewDays : 1;
    const kstNow = new Date(nowMs + KST_OFFSET_MS);
    const kstTodayMs = Date.UTC(
      kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate(),
    );
    if (versionMs > kstTodayMs + futureSkewDays * DAY_MS) {
      return { ok: false, error: `허용 미래 범위(+${futureSkewDays}일) 초과` };
    }
    return { ok: true };
  }

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
   * @param {{maxPerSite?: number, maxLen?: number, maxSites?: number}} [opts]
   * @returns {Object} 정제된 config (입력과 동일 객체)
   */
  function sanitizeAdaptersConfig(config, opts = {}) {
    const maxPerSite = opts.maxPerSite || DEFAULT_MAX_SELECTORS_PER_SITE;
    const maxLen = opts.maxLen || DEFAULT_MAX_SELECTOR_LENGTH;
    const maxSites = opts.maxSites || DEFAULT_MAX_ADAPTER_SITES;

    if (!config || config.adapters == null || typeof config.adapters !== 'object' ||
        Array.isArray(config.adapters)) return config;

    const adapterEntries = Object.entries(config.adapters);
    for (const [siteId] of adapterEntries.slice(maxSites)) delete config.adapters[siteId];
    for (const [siteId, siteConfig] of adapterEntries.slice(0, maxSites)) {
      if (!siteConfig || typeof siteConfig !== 'object' || Array.isArray(siteConfig)) {
        delete config.adapters[siteId];
        continue;
      }
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

    if (config.scraping_adapters && typeof config.scraping_adapters === 'object' &&
        !Array.isArray(config.scraping_adapters)) {
      const scrapingEntries = Object.entries(config.scraping_adapters);
      for (const [siteId] of scrapingEntries.slice(maxSites)) delete config.scraping_adapters[siteId];
      for (const [siteId, selObj] of scrapingEntries.slice(0, maxSites)) {
        if (!selObj || typeof selObj !== 'object' || Array.isArray(selObj)) {
          delete config.scraping_adapters[siteId];
          continue;
        }
        for (const [key, val] of Object.entries(selObj)) {
          if (!isValidCssSelector(val, maxLen)) delete selObj[key];
        }
      }
    }

    return config;
  }

  const CORE_CASE_KEY_REGEX = /^\d{2}(?:[A-Za-z][A-Za-z0-9]*|[가-힣]{1,4})\d+$/;
  const DLC_CASE_KEY_REGEX = /^(?:TX|KP)\d{2}[가-힣]{1,4}\d+$/;
  const CONSTITUTIONAL_SERIAL_REGEX = /^D\d+$/;

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function isValidCompressedCaseKey(key) {
    return typeof key === 'string' && key.length <= 64 &&
      (CORE_CASE_KEY_REGEX.test(key) || DLC_CASE_KEY_REGEX.test(key));
  }

  function isValidCaseRecord(entry) {
    if (!Array.isArray(entry) || entry.length !== 4) return false;
    const [serial, courtCode, decisionDate, caseName] = entry;
    const validSerial = (Number.isSafeInteger(serial) && serial > 0) ||
      (typeof serial === 'string' && CONSTITUTIONAL_SERIAL_REGEX.test(serial));
    return validSerial &&
      Number.isSafeInteger(courtCode) && courtCode >= 0 &&
      Number.isSafeInteger(decisionDate) && decisionDate >= 0 && decisionDate <= 999999 &&
      typeof caseName === 'string';
  }

  /**
   * 다운로드한 DB 페이로드의 무결성 검증.
   * version/total을 필수로 확인하고, 압축 키와 모든 레코드를 전수 검사한다.
   *
   * @param {Object} data - { cases, version, total }
   * @param {{minKeys?: number, versionRegex?: RegExp}} [opts]
   * @returns {{ok: boolean, error?: string, keyCount?: number}}
   */
  function validateDbIntegrity(data, opts = {}) {
    const versionRegex = opts.versionRegex || DEFAULT_VERSION_REGEX;

    if (!data || typeof data !== 'object' || !isPlainObject(data.cases)) {
      return { ok: false, error: '유효하지 않은 응답 (cases 없음)' };
    }

    const versionValidation = validateVersionDate(data.version, {
      nowMs: opts.nowMs,
      futureSkewDays: opts.futureSkewDays,
    });
    if (!versionValidation.ok || !versionRegex.test(data.version)) {
      return {
        ok: false,
        error: `version 형식 오류 '${data.version}' (${versionValidation.error || '정책 불일치'})`,
      };
    }

    const keys = Object.keys(data.cases);
    const keyCount = keys.length;

    if (typeof opts.minKeys === 'number' && keyCount < opts.minKeys) {
      return { ok: false, error: `키 수 ${keyCount} < 하한 ${opts.minKeys}` };
    }
    if (!Number.isSafeInteger(data.total) || data.total < 0) {
      return { ok: false, error: `total 형식 오류 '${data.total}'` };
    }
    if (data.total !== keyCount) {
      return { ok: false, error: `total(${data.total}) ≠ keys(${keyCount})` };
    }

    if (!isPlainObject(data.court_code_map) || Object.keys(data.court_code_map).length === 0) {
      return { ok: false, error: 'court_code_map 누락 또는 형식 오류' };
    }
    const knownCourtCodes = new Set();
    for (const [name, code] of Object.entries(data.court_code_map)) {
      if (name.length < 1 || name.length > 128 ||
          !Number.isSafeInteger(code) || code < 1 || knownCourtCodes.has(code)) {
        return { ok: false, error: `court_code_map 엔트리 형식 오류 '${name}'` };
      }
      knownCourtCodes.add(code);
    }

    for (const key of keys) {
      if (!isValidCompressedCaseKey(key)) {
        return { ok: false, error: `압축 사건번호 키 형식 오류 '${key}'` };
      }
      const val = data.cases[key];
      if (!Array.isArray(val) || val.length === 0) {
        return { ok: false, error: `cases["${key}"]가 비어있거나 배열이 아님` };
      }
      for (const entry of val) {
        if (!isValidCaseRecord(entry)) {
          return { ok: false, error: `cases["${key}"] 엔트리 형식 불량` };
        }
        if (entry[1] !== 0 && !knownCourtCodes.has(entry[1])) {
          return { ok: false, error: `cases["${key}"]가 알 수 없는 법원 코드 ${entry[1]} 참조` };
        }
      }
    }

    return { ok: true, keyCount };
  }

  // ============================================================
  // 동기화 정책 함수 (순수 판정 — db-sync.js는 결과만 따른다)
  // ============================================================

  const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;
  const IMMUTABLE_CORE_OBJECT_REGEX = /^objects\/([0-9a-f]{64})\.json\.gz$/;
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
   * @param {{minCoreKeys?: number}} [opts]
   * @returns {{load: boolean, reason: string}}
   */
  function shouldLoadBundled(bundledVersion, local, opts = {}) {
    const coreCount = (local && typeof local.coreCount === 'number') ? local.coreCount : 0;
    const localVer = local ? local.localVer : null;
    const minCoreKeys = Number.isSafeInteger(opts.minCoreKeys) && opts.minCoreKeys > 0
      ? opts.minCoreKeys
      : 1;

    if (coreCount <= 0) return { load: true, reason: 'local_empty' };
    if (coreCount < minCoreKeys) return { load: true, reason: 'local_unhealthy' };
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
  function validateManifestEntry(entry, label, opts) {
    if (!entry || typeof entry !== 'object') return `${label} 누락`;
    const versionValidation = validateVersionDate(entry.version, opts);
    if (!versionValidation.ok) {
      return `${label}.version 형식 오류 (${versionValidation.error})`;
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_HEX_REGEX.test(entry.sha256)) {
      return `${label}.sha256 형식 오류`;
    }
    if (!Number.isInteger(entry.total) || entry.total <= 0 || entry.total > MAX_MANIFEST_TOTAL) {
      return `${label}.total 범위 오류`;
    }
    if (entry.object_path !== undefined) {
      if (label !== 'core' || typeof entry.object_path !== 'string') {
        return `${label}.object_path 형식 오류`;
      }
      const match = IMMUTABLE_CORE_OBJECT_REGEX.exec(entry.object_path);
      if (!match) return `${label}.object_path 형식 오류`;
      if (match[1] !== entry.sha256) return `${label}.object_path hash 불일치`;
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
  function validateManifest(m, opts = {}) {
    if (!m || typeof m !== 'object') return { ok: false, error: 'manifest 없음' };
    if (m.schema !== 1) return { ok: false, error: `지원하지 않는 schema: ${m.schema}` };
    if (typeof m.built_at !== 'string' || !Number.isFinite(Date.parse(m.built_at))) {
      return { ok: false, error: 'built_at 파싱 불가' };
    }

    const coreError = validateManifestEntry(m.core, 'core', opts);
    if (coreError) return { ok: false, error: coreError };

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
    validateVersionDate,
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
