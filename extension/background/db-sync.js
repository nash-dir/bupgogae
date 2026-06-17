/**
 * 법고개(Bupgogae) — Service Worker DB 동기화 모듈
 * ===================================================
 * Chrome Extension Manifest V3 Service Worker에서 동작하는
 * IndexedDB 기반 판례 DB 동기화 엔진.
 *
 * [아키텍처]
 *   백엔드(Crawler Runner)가 매일 master.db를 갱신하고
 *   db.json.gz로 구워 Cloudflare R2에 업로드한다.
 *
 * [동기화 전략]
 *   1. 브라우저 시작 / chrome.alarms 주기 트리거
 *   2. R2에서 db.json.gz 풀 DB fetch (ETag로 변경 확인)
 *   3. 변경 시 IndexedDB 전체 교체
 *   4. 동기화 실패 시 빈 DB로 시작, 다음 알람에서 재시도
 */

// 순수 검증·정제 유틸 로드 (테스트 가능한 무부수효과 로직).
// isValidCssSelector / sanitizeAdaptersConfig / validateDbIntegrity를 전역에 제공.
importScripts('sync-utils.js');

// ============================================================
// 상수
// ============================================================
const DB_URL = 'https://api.bup.live/bupgogae/db.json.gz';

const ADAPTERS_URL = 'https://api.bup.live/bupgogae/adapters.json'; // 원격 어댑터 셀렉터 설정
const MANIFEST_URL = 'https://api.bup.live/bupgogae/manifest.json'; // Drift 안전망 정답지
const BUNDLED_DB_URL = 'data/db.json'; // 로컬 디버깅용 폴백
const DB_NAME = 'bupgogae';
const DB_VERSION = 1;
const STORE_CASES = 'cases';
const STORE_META = 'metadata';
const ALARM_NAME = 'bupgogae-sync';
const SYNC_INTERVAL_MINUTES = 60 * 6; // 6시간마다 동기화 시도

// [보안 상수]
const MAX_DB_SIZE_BYTES = 50 * 1024 * 1024; // 50MB 제한
const MAX_SELECTORS_PER_SITE = 10;   // 사이트당 최대 선택자 개수
const MAX_SELECTOR_LENGTH = 150;     // 선택자 하나당 최대 길이 (문자 수)

// [무결성 검증 상수]
const MIN_KEYS_CORE = 100_000;       // Core DB 최소 키 수 (미달 시 파이프라인 장애 판정)
const VERSION_REGEX = /^\d{8}$/;     // version 형식: YYYYMMDD

// [동기화 견고성 상수] — 0.8.0 "DB 2달 정체" 사고 재발 방지
const WATCHDOG_MS = 48 * 3600 * 1000;   // 마지막 성공 후 48h 초과 시 ETag 불신
const FETCH_TIMEOUT_MS = 60_000;        // DB fetch 행(hang) 방지 타임아웃
const SYNC_LEDGER_KEY = 'bupgogae_sync_ledger'; // 동기화 시도 원장 (storage.local)
const SYNC_LEDGER_MAX = 20;             // 원장 보존 개수 (최신순)

// [Drift 안전망 상수] — manifest 정답지 대조 → 캐시버스터 치유
const DRIFT = {
  GRACE_MS: 2 * 3600 * 1000,            // 갓 게시된 manifest는 CDN 전파 대기
  CHECK_MIN_INTERVAL_MS: 4 * 3600 * 1000, // force 아닐 때 검사 최소 간격
  MAX_STRIKES: 3,                       // 연속 치유 실패 한도 (폭주 방지)
  MANIFEST_TIMEOUT_MS: 10_000,          // manifest fetch 타임아웃
};
const DRIFT_STATE_KEY = 'bupgogae_drift_state'; // {lastCheckAt, strikes, lastResult}

// isValidCssSelector / sanitizeAdaptersConfig / validateDbIntegrity는
// sync-utils.js(importScripts)에서 전역으로 제공됨.

// ============================================================
// 1. IndexedDB Promise 래퍼
// ============================================================

/**
 * IndexedDB를 열고 스토어가 없으면 생성한다.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      // cases 스토어: 압축 사건번호(예: "15Da6302")를 키로 사용
      if (!db.objectStoreNames.contains(STORE_CASES)) {
        db.createObjectStore(STORE_CASES);
      }

      // metadata 스토어: 'local_ver', 'last_synced' 등
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(`IndexedDB open failed: ${req.error}`));
  });
}

/**
 * 단일 키-값 읽기.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {string} key
 * @returns {Promise<any>}
 */
function dbGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(`dbGet failed: ${req.error}`));
  });
}

/**
 * 단일 키-값 쓰기.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {string} key
 * @param {any} value
 * @returns {Promise<void>}
 */
function dbPut(db, storeName, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error(`dbPut failed: ${tx.error}`));
  });
}

/**
 * 스토어 전체 비우기.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @returns {Promise<void>}
 */
function dbClear(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error(`dbClear failed: ${tx.error}`));
  });
}



/**
 * 대량 데이터 삽입 (Bulk Insert).
 * chunkSize 단위로 분할하여 각 chunk를 별도 트랜잭션으로 삽입.
 * GC 기회를 확보하여 DB가 20만건 이상으로 성장해도 안정적으로 동기화.
 *
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {Object} data - { "15Da6302": [[...], ...], ... }
 * @param {number} [chunkSize=10000] - 한 트랜잭션당 최대 레코드 수
 * @returns {Promise<number>} 삽입된 레코드 수
 */
async function dbBulkInsert(db, storeName, data, chunkSize = 10000) {
  const entries = Object.entries(data);
  let totalCount = 0;

  for (let i = 0; i < entries.length; i += chunkSize) {
    const chunk = entries.slice(i, i + chunkSize);

    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);

      for (const [key, value] of chunk) {
        store.put(value, key);
      }

      tx.oncomplete = () => {
        totalCount += chunk.length;
        resolve();
      };
      tx.onerror = () => reject(new Error(`dbBulkInsert failed: ${tx.error}`));
    });
  }

  return totalCount;
}

// ============================================================
// 2. 네트워크 요청 (ETag 지원)
// ============================================================

/**
 * db.json.gz를 fetch. ETag 비교로 변경 확인.
 *
 * [메모리 주의] 50MB 기준 최대 ~150MB 피크 메모리 가능
 * (chunks + chunksAll + text + data 동시 존재).
 * DB가 20MB 이상 성장 시 Response.json() 또는
 * 스트림 파이프라인 전환을 검토할 것.
 *
 * @param {string} url
 * @param {string|null} cachedETag - 이전 ETag (null이면 무조건 다운로드)
 * @returns {Promise<{data: Object|null, etag: string|null, notModified: boolean, contentHash: string|null}>}
 *   contentHash: 수신 바이트(비압축)의 SHA-256 hex — drift 대조의 기준값
 */
async function fetchDB(url, cachedETag = null) {
  const headers = { 'Accept': 'application/json' };
  if (cachedETag) {
    headers['If-None-Match'] = cachedETag;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // 행(hang) 방지: 0.8.0 사고에서 응답 없는 fetch가 동기화를 무기한 정지시킴
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

      if (res.status === 304) {
        return { data: null, etag: cachedETag, notModified: true, contentHash: null };
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      // 1차 방어: Content-Length 헤더 확인
      const contentLength = res.headers.get('Content-Length');
      if (contentLength && parseInt(contentLength, 10) > MAX_DB_SIZE_BYTES) {
        throw new Error(`DB 파일 크기 초과 (헤더 기준): ${contentLength} bytes`);
      }

      // 2차 방어: 스트림 단위 파일 크기 제한 (50MB 하드 리미트)
      const reader = res.body.getReader();
      let receivedLength = 0;
      const chunks = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        receivedLength += value.length;
        if (receivedLength > MAX_DB_SIZE_BYTES) {
          reader.cancel();
          throw new Error(`DB 파일 크기 하드 리미트 초과. 연결 강제 종료됨.`);
        }
        chunks.push(value);
      }

      // 청크 조합 후 JSON 파싱
      const chunksAll = new Uint8Array(receivedLength);
      let position = 0;
      for (const chunk of chunks) {
        chunksAll.set(chunk, position);
        position += chunk.length;
      }
      const text = new TextDecoder('utf-8').decode(chunksAll);
      const data = JSON.parse(text);

      // 수신 바이트 SHA-256 — manifest(비압축 바이트 해시)와 직접 대조 가능
      const hashBuffer = await crypto.subtle.digest('SHA-256', chunksAll);
      const contentHash = Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0')).join('');

      const etag = res.headers.get('ETag') || null;
      return { data, etag, notModified: false, contentHash };
    } catch (err) {
      console.warn(`[bupgogae] fetch 실패 (${attempt}/3):`, err.message);
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
}

// ============================================================
// 3. 핵심 동기화 로직 — 풀 DB fetch-and-replace
// ============================================================

/**
 * Core 키 수 조회 — 전체 count에서 DLC 키(TX*, KP*)를 제외.
 * buildFetchPlan/shouldLoadBundled/evaluateDrift의 건강 판정 기준값.
 * @param {IDBDatabase} db
 * @returns {Promise<number>}
 */
function countCoreKeys(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CASES, 'readonly');
    const store = tx.objectStore(STORE_CASES);
    let total = 0, taxCount = 0, patentCount = 0;
    const RANGE_END = String.fromCharCode(0xFFFF); // 'TX'~'TX￿' 키 범위 상한

    const reqTotal = store.count();
    reqTotal.onsuccess = () => { total = reqTotal.result; };
    const reqTax = store.count(IDBKeyRange.bound('TX', 'TX' + RANGE_END));
    reqTax.onsuccess = () => { taxCount = reqTax.result; };
    const reqPatent = store.count(IDBKeyRange.bound('KP', 'KP' + RANGE_END));
    reqPatent.onsuccess = () => { patentCount = reqPatent.result; };

    tx.oncomplete = () => resolve(total - taxCount - patentCount);
    tx.onerror = () => reject(new Error(`countCoreKeys failed: ${tx.error}`));
  });
}

/**
 * 동기화/드리프트 판정에 필요한 로컬 상태 스냅샷.
 * @returns {Promise<{localVer, contentHash, lastSuccessAt, coreCount}>}
 */
async function readLocalSyncState() {
  const db = await getCachedDB();
  const [localVer, contentHash, lastSuccessAt, coreCount] = await Promise.all([
    dbGet(db, STORE_META, 'local_ver').catch(() => null),
    dbGet(db, STORE_META, 'content_hash').catch(() => null),
    dbGet(db, STORE_META, 'last_success_at').catch(() => null),
    countCoreKeys(db).catch(() => 0),
  ]);
  return {
    localVer: localVer ?? null,
    contentHash: contentHash ?? null,
    lastSuccessAt: lastSuccessAt ?? null,
    coreCount,
  };
}

// 원장 쓰기 직렬화 큐 — 동시 동기화(설치+수동 등)의 read-modify-write 유실 방지
let _ledgerWriteQueue = Promise.resolve();

/**
 * 동기화 시도를 storage 원장에 기록 (최신순 SYNC_LEDGER_MAX개).
 * 실패해도 동기화 결과에 영향을 주지 않는다.
 * @param {{ts, trigger, outcome, reason?, version?, durationMs}} entry
 */
function recordSyncAttempt(entry) {
  _ledgerWriteQueue = _ledgerWriteQueue.then(async () => {
    const { [SYNC_LEDGER_KEY]: ledger } = await chrome.storage.local.get(SYNC_LEDGER_KEY);
    await chrome.storage.local.set({
      [SYNC_LEDGER_KEY]: appendLedger(ledger, entry, SYNC_LEDGER_MAX),
    });
  }).catch(err => {
    console.warn('[bupgogae] 원장 기록 실패:', err?.message);
  });
  return _ledgerWriteQueue;
}

/**
 * 메인 동기화 함수 — 절대 reject하지 않는다.
 * R2에서 db.json.gz를 fetch → 변경 시 IndexedDB 교체, 모든 시도를 원장에 기록.
 *
 * @param {{trigger?: string, force?: boolean, cacheBuster?: string}} [opts]
 *   trigger: install|startup|alarm|force|drift (원장 라벨)
 *   force: If-None-Match 생략 (드리프트 치유용)
 *   cacheBuster: force일 때 URL에 ?cb=<값> 부착 — 낡은 CDN 캐시 우회
 * @returns {Promise<{success: boolean, outcome: string, reason?: string, version?: string}>}
 *   outcome: replaced|not_modified|fetch_failed|invalid_payload|integrity_failed|db_error
 */
async function syncDatabase(opts = {}) {
  const trigger = opts.trigger || 'manual';
  const force = opts.force === true;
  const cacheBuster = opts.cacheBuster ?? null;
  const startedAt = Date.now();

  console.log(`[bupgogae] 동기화 시작 (trigger=${trigger}${force ? ', force' : ''})...`);

  let result;
  try {
    result = await doSyncDatabase({ force, cacheBuster });
  } catch (err) {
    // doSyncDatabase가 모든 오류를 분류하지만, 만에 하나를 대비한 최후 방어선
    console.error('[bupgogae] ❌ 동기화 중 미분류 오류:', err);
    result = { success: false, outcome: 'db_error', reason: err?.message || String(err) };
  }

  // ── 원장 기록 (정직한 관측성 — 실패도 시도로 남긴다) ──
  await recordSyncAttempt({
    ts: startedAt,
    trigger,
    outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.version ? { version: result.version } : {}),
    durationMs: Date.now() - startedAt,
  });

  // ── 실패 시 번들 폴백 (shouldLoadBundled 게이트 — 다운그레이드 금지) ──
  if (!result.success) {
    try { await maybeLoadBundledDB(); } catch {}
  }

  // ── 어댑터 원격 설정 동기화 (DB 동기화와 독립적으로 실행) ──
  try { await fetchAdaptersConfig(); } catch {}

  // ── post-sync 드리프트 자동 검증 (drift 트리거 자신은 제외 — 재귀 방지) ──
  if (trigger !== 'drift' &&
      (result.outcome === 'replaced' || result.outcome === 'not_modified')) {
    verifyDbFreshness('post_sync', { force: false }).catch(() => {});
  }

  return result;
}

/**
 * 동기화 핵심 로직 — fetch 계획 수립 → fetch → 검증 → 교체.
 * 결과를 outcome으로 분류해 반환한다 (번들 폴백/원장은 syncDatabase 담당).
 */
async function doSyncDatabase({ force, cacheBuster }) {
  // ── Step 1: 로컬 상태 + ETag → fetch 계획 (304 가드 + 워치독) ──
  let local;
  try {
    local = await readLocalSyncState();
  } catch (err) {
    // 로컬 상태를 알 수 없으면 가장 보수적인 가정 → 무조건 전체 fetch
    local = { localVer: null, contentHash: null, lastSuccessAt: null, coreCount: 0 };
  }

  let cachedETag = null;
  try {
    ({ bupgogae_etag: cachedETag = null } =
      await chrome.storage.local.get('bupgogae_etag'));
  } catch {}

  let conditional = false;
  if (!force) {
    const plan = buildFetchPlan(
      {
        etag: cachedETag,
        lastSuccessAt: local.lastSuccessAt,
        localVer: local.localVer,
        coreCount: local.coreCount,
      },
      Date.now(),
      { watchdogMs: WATCHDOG_MS, minCoreKeys: MIN_KEYS_CORE },
    );
    conditional = plan.conditional;
    if (!conditional && plan.reasons.length > 0) {
      console.log(`[bupgogae] 조건부 요청 생략 → 전체 fetch (${plan.reasons.join(', ')})`);
    }
  }

  const url = (force && cacheBuster != null)
    ? `${DB_URL}?cb=${encodeURIComponent(cacheBuster)}`
    : DB_URL;

  // ── Step 2: R2에서 fetch ──
  let fetched;
  try {
    fetched = await fetchDB(url, conditional ? cachedETag : null);
  } catch (err) {
    console.error('[bupgogae] ❌ R2 동기화 실패:', err);
    return { success: false, outcome: 'fetch_failed', reason: err?.message || String(err) };
  }

  const { data, etag, notModified, contentHash } = fetched;

  if (notModified) {
    console.log('[bupgogae] DB 변경 없음 (304). 동기화 스킵.');
    return {
      success: true,
      outcome: 'not_modified',
      ...(local.localVer ? { version: local.localVer } : {}),
    };
  }

  if (!data || !data.cases) {
    console.warn('[bupgogae] 유효하지 않은 응답. 동기화 중단.');
    return { success: false, outcome: 'invalid_payload', reason: 'cases 없음' };
  }

  // ── 무결성 게이트 (sync-utils.validateDbIntegrity) ──
  const integrity = validateDbIntegrity(data, {
    minKeys: MIN_KEYS_CORE,
    versionRegex: VERSION_REGEX,
  });
  if (!integrity.ok) {
    console.error(`[bupgogae] DB 무결성 검증 실패: ${integrity.error}`);
    return { success: false, outcome: 'integrity_failed', reason: integrity.error };
  }
  const keyCount = integrity.keyCount;
  console.log(`[bupgogae] 무결성 검증 통과: ${keyCount.toLocaleString()}건, ver=${data.version}`);

  // ── Step 3~5: IndexedDB 교체 + 메타/ETag 저장 ──
  try {
    const db = await getCachedDB();
    await dbClear(db, STORE_CASES);
    const count = await dbBulkInsert(db, STORE_CASES, data.cases);
    console.log(`[bupgogae] Core DB 교체: ${count}건 삽입`);

    const version = data.version || new Date().toISOString().slice(0, 10);
    await updateMetadata(db, version, data.total || count, {
      contentHash,
      lastSuccessAt: Date.now(),
    });
    await chrome.storage.local.set({ bupgogae_etag: etag });

    if (data.court_code_map) {
      await chrome.storage.local.set({ bupgogae_court_map: data.court_code_map });
      console.log(`[bupgogae] court_code_map 저장: ${Object.keys(data.court_code_map).length}개 법원`);
    }

    console.log(`[bupgogae] ✅ 동기화 완료: ${count}건 교체, ver=${version}`);
    return { success: true, outcome: 'replaced', version };
  } catch (err) {
    console.error('[bupgogae] ❌ IndexedDB 교체 실패:', err);
    _cachedDB = null; // 커넥션 오류 가능성 — 캐시 무효화
    return { success: false, outcome: 'db_error', reason: err?.message || String(err) };
  }
}

// ============================================================
// 3-1. 어댑터 원격 설정 Fetch (Remote Config)
// ============================================================

/**
 * 원격 서버에서 어댑터 셀렉터 JSON을 fetch하여 chrome.storage.local에 저장.
 * 순수 JSON만 파싱 — eval/innerHTML/new Function 일체 금지 (MV3 CSP 준수).
 *
 * 스키마 예시:
 *   {
 *     "version": "2026-03-22",
 *     "adapters": {
 *       "chatgpt": {
 *         "responseSelectors": ["div[data-message-author-role=\"assistant\"] .markdown"],
 *         "streamingIndicator": ".result-streaming"
 *       }
 *     }
 *   }
 *
 * 실패 시 기존 저장값을 유지 (silent fail) — 오프라인 생존력 보장.
 */
async function fetchAdaptersConfig() {
  console.log('[bupgogae] 어댑터 원격 설정 fetch 시도...');

  try {
    const res = await fetch(ADAPTERS_URL, {
      headers: { 'Accept': 'application/json' },
      // 행 방지: 응답 없는 원격 설정이 동기화 응답 전체를 막지 않도록
      signal: AbortSignal.timeout(DRIFT.MANIFEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn(`[bupgogae] 어댑터 설정 fetch 실패: HTTP ${res.status}`);
      return;
    }

    const config = await res.json();

    // 기본 무결성 검증: adapters 객체 존재 여부
    if (!config || typeof config.adapters !== 'object') {
      console.warn('[bupgogae] 어댑터 설정 형식 오류 — adapters 객체 없음');
      return;
    }

    // 🚨 보안 검증 (Sanitization) — 화이트리스트 기반 (sync-utils)
    sanitizeAdaptersConfig(config, {
      maxPerSite: MAX_SELECTORS_PER_SITE,
      maxLen: MAX_SELECTOR_LENGTH,
    });

    await chrome.storage.local.set({ bupgogae_remote_adapters: config });
    console.log(`[bupgogae] ✅ 어댑터 원격 설정 저장 완료 (ver=${config.version || '?'})`);

  } catch (err) {
    // 네트워크 오류, 파싱 오류 등 — 기존 저장값 유지 (silent fail)
    console.warn('[bupgogae] 어댑터 원격 설정 fetch 실패 (기존값 유지):', err.message);
  }
}

/**
 * 번들 DB 폴백 — R2 동기화 실패 시 shouldLoadBundled 게이트 통과 시에만 로드.
 * 게이트가 다운그레이드를 차단한다: 0.8.0 사고에서 동기화 실패가 최신 로컬 DB를
 * 구버전 번들(version=20260321)로 무조건 덮어쓰던 결함의 수정.
 * 로드 시 bupgogae_etag를 삭제해 번들 내용이 R2 ETag와 어긋난 채
 * 304에 갇히는 2차 트랩을 막는다.
 */
// 번들 로드 중복 제거 — 동시 동기화 실패(설치+수동 등)가 같은 번들을
// 두 번 삽입하며 응답을 수십 초 지연시키는 것을 방지
let _bundledLoadInFlight = null;

function maybeLoadBundledDB() {
  if (_bundledLoadInFlight) return _bundledLoadInFlight;
  _bundledLoadInFlight = doMaybeLoadBundledDB()
    .finally(() => { _bundledLoadInFlight = null; });
  return _bundledLoadInFlight;
}

async function doMaybeLoadBundledDB() {
  try {
    const url = chrome.runtime.getURL(BUNDLED_DB_URL);
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('[bupgogae] 번들 DB 없음 — 다음 알람에서 R2 재시도');
      return;
    }
    const data = await res.json();
    if (!data || !data.cases) {
      console.warn('[bupgogae] 번들 DB 형식 오류');
      return;
    }

    // ── 다운그레이드 금지 게이트 ──
    let local;
    try {
      local = await readLocalSyncState();
    } catch {
      local = { localVer: null, coreCount: 0 };
    }
    const gate = shouldLoadBundled(String(data.version || 'bundled'), {
      localVer: local.localVer,
      coreCount: local.coreCount,
    });
    if (!gate.load) {
      console.log(`[bupgogae] 번들 폴백 게이트 차단 (${gate.reason}) — 로컬 DB 보존`);
      return;
    }
    console.log(`[bupgogae] 📦 번들 DB 폴백 시도 (${gate.reason})...`);

    const db = await getCachedDB();
    await dbClear(db, STORE_CASES);
    const count = await dbBulkInsert(db, STORE_CASES, data.cases);
    const version = data.version || 'bundled';
    // 번들은 R2 동기화 성공이 아니므로 content_hash/last_success_at은 제거
    await updateMetadata(db, version, data.total || count, {
      contentHash: null,
      lastSuccessAt: null,
    });
    // 번들 내용은 저장된 ETag와 무관 — 이후 동기화가 304에 갇히지 않도록 정리
    await chrome.storage.local.remove('bupgogae_etag');

    console.log(`[bupgogae] ✅ 번들 DB 로드 완료: ${count}건, ver=${version}`);
  } catch (bundledErr) {
    console.warn('[bupgogae] 번들 DB 로드 실패:', bundledErr.message);
  }
}

/**
 * 메타데이터 갱신.
 * @param {IDBDatabase} db
 * @param {string} version - DB 버전 (YYYYMMDD)
 * @param {number} [totalCount] - 전체 판례 수
 * @param {{contentHash?: string|null, lastSuccessAt?: number|null}} [extras]
 *   contentHash: 수신 바이트 SHA-256 (null이면 삭제 — 번들 폴백 등 비동기화 경로)
 *   lastSuccessAt: 성공 시각 epoch ms (null이면 삭제)
 */
async function updateMetadata(db, version, totalCount, extras = {}) {
  const tx = db.transaction(STORE_META, 'readwrite');
  const store = tx.objectStore(STORE_META);

  store.put(version, 'local_ver');
  store.put(new Date().toISOString(), 'last_synced');
  if (totalCount != null) {
    store.put(totalCount, 'total_count');
  }
  if ('contentHash' in extras) {
    if (extras.contentHash == null) store.delete('content_hash');
    else store.put(extras.contentHash, 'content_hash');
  }
  if ('lastSuccessAt' in extras) {
    if (extras.lastSuccessAt == null) store.delete('last_success_at');
    else store.put(extras.lastSuccessAt, 'last_success_at');
  }

  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(new Error('metadata update failed'));
  });

  console.log(`[bupgogae] 메타데이터 갱신: ver=${version}, total=${totalCount ?? '?'}`);
}

// ============================================================
// 3-2. Drift 안전망 — manifest 정답지 대조 → 캐시버스터 치유
// ============================================================

/**
 * 로컬 DB 신선도 검증 + 자가치유.
 * R2의 manifest.json(정답지)과 로컬 상태(버전/해시/건수)를 대조해
 * 뒤처짐이 확정되면 캐시 버스터로 강제 재동기화한다.
 *
 * fail-open 원칙: manifest 미게시(404)/파싱 실패/스키마 불량 시 아무 행동도
 * 하지 않는다 — 안전망 자신이 사고를 만들면 안 된다.
 *
 * @param {string} trigger - content|post_sync|message 등 (관측 라벨)
 * @param {{force?: boolean}} [opts] - force=true면 4h 스로틀 무시
 * @returns {Promise<{checked: boolean, skipped?: string, drift: boolean,
 *                    action: string, reasons: string[], healed?: boolean}>}
 */
async function verifyDbFreshness(trigger, opts = {}) {
  const force = opts.force === true;
  const now = Date.now();

  try {
    // ── 스로틀 (force 아닐 때 4h 최소 간격) ──
    let state = {};
    try {
      ({ [DRIFT_STATE_KEY]: state = {} } =
        await chrome.storage.local.get(DRIFT_STATE_KEY));
    } catch {}
    if (!force && state.lastCheckAt &&
        now - state.lastCheckAt < DRIFT.CHECK_MIN_INTERVAL_MS) {
      return { checked: false, skipped: 'throttled', drift: false, action: 'none', reasons: [] };
    }

    // ── manifest fetch (no-store + 타임아웃, 실패 시 fail-open) ──
    let manifest;
    try {
      const res = await fetch(MANIFEST_URL, {
        cache: 'no-store',
        signal: AbortSignal.timeout(DRIFT.MANIFEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    } catch (err) {
      console.log(`[bupgogae] drift 검사 스킵 — manifest 사용 불가 (${err?.message})`);
      return { checked: false, skipped: 'manifest_unavailable', drift: false, action: 'none', reasons: [] };
    }

    const validation = validateManifest(manifest);
    if (!validation.ok) {
      console.warn(`[bupgogae] drift 검사 스킵 — manifest 스키마 불량: ${validation.error}`);
      return { checked: false, skipped: 'manifest_invalid', drift: false, action: 'none', reasons: [] };
    }

    // ── 드리프트 판정 ──
    const strikes = state.strikes || 0;
    const local = await readLocalSyncState();
    const verdict = evaluateDrift(
      manifest,
      { ...local, strikes },
      now,
      { graceMs: DRIFT.GRACE_MS, maxStrikes: DRIFT.MAX_STRIKES },
    );

    const result = {
      checked: true,
      drift: verdict.action !== 'none',
      action: verdict.action,
      reasons: verdict.reasons,
    };
    let nextStrikes = strikes;

    if (verdict.action === 'none') {
      nextStrikes = 0; // 정합 확인 — strike 청산
    } else if (verdict.action === 'force_sync') {
      // ── 치유: 캐시 버스터 강제 재동기화 → 동일 manifest로 재평가 ──
      console.warn(`[bupgogae] 🚑 drift 감지 (${verdict.reasons.join(', ')}) → 강제 재동기화`);
      await syncDatabase({
        trigger: 'drift',
        force: true,
        cacheBuster: manifest.core.version,
      });
      const localAfter = await readLocalSyncState();
      const reVerdict = evaluateDrift(
        manifest,
        { ...localAfter, strikes: 0 },
        Date.now(),
        { graceMs: DRIFT.GRACE_MS, maxStrikes: DRIFT.MAX_STRIKES },
      );
      result.healed = reVerdict.action === 'none';
      nextStrikes = result.healed ? 0 : strikes + 1;
      console.log(`[bupgogae] drift 치유 ${result.healed ? '성공' : `실패 (strikes=${nextStrikes})`}`);
    }
    // defer/backoff: 행동 없음 — strikes 유지

    try {
      await chrome.storage.local.set({
        [DRIFT_STATE_KEY]: {
          lastCheckAt: now,
          strikes: nextStrikes,
          lastResult: { ts: now, trigger, ...result },
        },
      });
    } catch {}

    return result;
  } catch (err) {
    // 안전망은 절대 reject하지 않는다
    console.warn('[bupgogae] drift 검사 오류 (fail-open):', err?.message);
    return { checked: false, skipped: 'error', drift: false, action: 'none', reasons: [] };
  }
}

// ============================================================
// 4. DB 커넥션 캐시 — 매 조회마다 열고 닫지 않음
// ============================================================

let _cachedDB = null;
let _dbIdleTimer = null;
const DB_IDLE_TIMEOUT_MS = 30_000; // 30초 미사용 시 자동 닫기

/**
 * 캐시된 DB 커넥션을 반환. 없으면 새로 열고 캐시.
 * 매 호출 시 idle 타이머가 리셋되므로, 연속 조회 시 커넥션을 재사용.
 * Service Worker 비활성화 시 타이머에 의해 자동 해제.
 * @returns {Promise<IDBDatabase>}
 */
async function getCachedDB() {
  // idle 타이머 리셋
  if (_dbIdleTimer) clearTimeout(_dbIdleTimer);
  _dbIdleTimer = setTimeout(() => {
    if (_cachedDB) {
      _cachedDB.close();
      _cachedDB = null;
      console.log('[bupgogae] DB 커넥션 idle 해제');
    }
  }, DB_IDLE_TIMEOUT_MS);

  if (_cachedDB) return _cachedDB;

  _cachedDB = await openDB();
  return _cachedDB;
}


// ============================================================
// 5. 판례 조회 API (Content Script에서 호출)
// ============================================================

/**
 * 단건 조회 (하위 호환).
 * @param {string} compressedKey - 예: "15Da6302"
 * @returns {Promise<{found: boolean, data: Array|null}>}
 */
async function lookupCase(compressedKey) {
  try {
    const db = await getCachedDB();
    const result = await dbGet(db, STORE_CASES, compressedKey);

    if (result && result.length > 0) {
      return { found: true, data: result };
    }
    return { found: false, data: null };
  } catch (err) {
    console.error('[bupgogae] 조회 실패:', err);
    // 커넥션 오류 시 캐시 무효화
    _cachedDB = null;
    return { found: false, data: null, error: err.message };
  }
}

/**
 * 배치 조회 — 여러 사건번호를 단일 트랜잭션으로 한 번에 조회.
 * Content Script에서 텍스트 내 판례번호를 모아서 한 번에 보내는 용도.
 *
 * @param {string[]} compressedKeys - 압축 사건번호 배열 (예: ["15Da6302", "22Da266874"])
 * @returns {Promise<Object>} { "15Da6302": { found: true, data: [...] }, "22Da266874": { found: false, data: null } }
 *
 * 성능 비교 (20건 기준):
 *   단건 반복: 20 × (sendMessage + openDB + get + close) ≈ 100ms
 *   배치 조회: 1 × (sendMessage + getCachedDB + 20×get)  ≈ 24ms  (~4배 빠름)
 */
async function lookupBatch(compressedKeys) {
  if (!compressedKeys || compressedKeys.length === 0) {
    return {};
  }

  try {
    const db = await getCachedDB();
    const results = {};

    // 단일 readonly 트랜잭션으로 모든 키 조회
    // tx.oncomplete 기준으로 resolve하여 트랜잭션 완료를 보장
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CASES, 'readonly');
      const store = tx.objectStore(STORE_CASES);

      for (const key of compressedKeys) {
        const req = store.get(key);

        req.onsuccess = () => {
          const val = req.result;
          results[key] = (val && val.length > 0)
            ? { found: true, data: val }
            : { found: false, data: null };
        };

        req.onerror = () => {
          results[key] = { found: false, data: null, error: req.error?.message };
        };
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error(`batch tx failed: ${tx.error}`));
    });

    return results;
  } catch (err) {
    console.error('[bupgogae] 배치 조회 실패:', err);
    _cachedDB = null;
    // 전체 실패 시 모든 키를 not found로 반환
    const fallback = {};
    for (const key of compressedKeys) {
      fallback[key] = { found: false, data: null, error: err.message };
    }
    return fallback;
  }
}


// ============================================================
// 6. Chrome Extension 이벤트 바인딩
// ============================================================

/**
 * 확장프로그램 설치 시 — R2에서 풀 DB 동기화 + 알람 등록.
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[bupgogae] 설치/업데이트: ${details.reason}`);

  // 주기적 동기화 알람 등록
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,                   // 설치 후 1분 뒤 첫 실행
    periodInMinutes: SYNC_INTERVAL_MINUTES,
  });

  // 설치/업데이트 시 Circuit Breaker 카운터 초기화 (이전 버전 누적 스트라이크 제거)
  await chrome.storage.local.remove([
    'bupgogae_circuit_strikes',
    'bupgogae_circuit_fast_streak',
    'bupgogae_disabled_global',
  ]);

  // 설치/업데이트 시 R2에서 동기화 시도
  await syncDatabase({ trigger: 'install' });

  // 동기화 실패 시 빈 DB로 시작 — 다음 알람(1분 후)에서 재시도
  try {
    const db = await getCachedDB();
    const ver = await dbGet(db, STORE_META, 'local_ver');
    if (!ver) {
      console.warn('[bupgogae] 동기화 후 DB 비어있음 — 다음 알람에서 재시도');
    }
  } catch (err) {
    console.warn('[bupgogae] DB 상태 확인 실패:', err.message);
  }
});

/**
 * Service Worker 시작 시 — 알람이 없으면 재등록 (MV3 Service Worker 재시작 대비).
 */
chrome.runtime.onStartup.addListener(async () => {
  console.log('[bupgogae] 브라우저 시작');

  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) {
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 1,
      periodInMinutes: SYNC_INTERVAL_MINUTES,
    });
  }

  // 시작 시 동기화 시도
  await syncDatabase({ trigger: 'startup' });
});

/**
 * 알람 트리거 — 주기적 동기화 실행.
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log('[bupgogae] 알람 트리거 → 동기화 실행');
    await syncDatabase({ trigger: 'alarm' });
  }
});

/**
 * Content Script → Background 메시지 핸들러.
 *
 * 메시지 타입:
 *   LOOKUP_CASE   — 단건 조회 (하위 호환)
 *   LOOKUP_BATCH  — 배치 조회 ★ 권장
 *   FORCE_SYNC    — 수동 동기화
 *   GET_SYNC_STATUS — 상태 조회
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── 단건 조회 (하위 호환) ──
  if (message.type === 'LOOKUP_CASE') {
    lookupCase(message.key)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ found: false, error: err.message }));
    return true;
  }

  // ── 배치 조회 ★ 권장 ──
  // Content Script에서: chrome.runtime.sendMessage({
  //   type: 'LOOKUP_BATCH',
  //   keys: ['15Da6302', '22Da266874', '23Na12345']
  // })
  // 응답: { '15Da6302': { found: true, data: [...] }, '22Da266874': { found: false, data: null }, ... }
  if (message.type === 'LOOKUP_BATCH') {
    lookupBatch(message.keys)
      .then(results => sendResponse(results))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'FORCE_SYNC') {
    // 수동 동기화: DB + 어댑터 설정 모두 동기화 (syncDatabase 내부에서 fetchAdaptersConfig 호출)
    // 정직한 결과 보고: 실패를 success:true로 가장하지 않는다 (0.8.0 사고의 직접 원인)
    syncDatabase({ trigger: 'force' })
      .then(result => sendResponse({
        success: result.success,
        outcome: result.outcome,
        ...(result.reason ? { error: result.reason } : {}),
      }))
      .catch(err => sendResponse({ success: false, outcome: 'db_error', error: err.message }));
    return true;
  }

  // ── DB 신선도 검증 (Drift 안전망) — content script 진입/수동 트리거 ──
  if (message.type === 'VERIFY_DB_FRESHNESS') {
    verifyDbFreshness(message.trigger || 'message', { force: message.force === true })
      .then(result => sendResponse(result))
      .catch(err => sendResponse({
        checked: false, skipped: 'error', drift: false,
        action: 'none', reasons: [], error: err.message,
      }));
    return true;
  }

  // ── 어댑터 원격 설정만 단독 fetch (Content Script Auto-Fetch 트리거) ──
  if (message.type === 'FETCH_ADAPTERS') {
    fetchAdaptersConfig()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_SYNC_STATUS') {
    getSyncStatus()
      .then(status => sendResponse(status))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  // ── 법제처 HTML 원문 Fetch (CORS 우회) ──
  if (message.type === 'FETCH_LAW_HTML') {
    let parsedUrl;
    try {
      parsedUrl = new URL(message.url || '');
    } catch {
      sendResponse({ error: "Invalid URL format." });
      return true;
    }
    if (parsedUrl.hostname !== 'www.law.go.kr' || parsedUrl.protocol !== 'https:') {
      sendResponse({ error: "Invalid URL or Host. Only https://www.law.go.kr is permitted." });
      return true;
    }
    fetch(parsedUrl.href)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then(html => sendResponse({ html }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  // ── 비상 정지 (Circuit Breaker) 수신부 ──
  if (message.type === 'EMERGENCY_DISABLE') {
    console.error('[bupgogae] 🚨 서킷 브레이커: EMERGENCY_DISABLE 수신. 부하 방지를 위해 글로벌 비활성화를 실행합니다.');
    chrome.storage.local.set({ bupgogae_disabled_global: true }, () => {
      // 모든 활성 탭 아이콘 배지를 ERR로 무조건 업데이트
      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          chrome.action.setBadgeText({ text: 'ERR', tabId: tab.id });
          chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId: tab.id });
        }
      });
      sendResponse({ success: true });
    });
    return true;
  }

  // ── 메타데이터 요청 (Content Script → case_code_map 전달) ──
  if (message.type === 'GET_META') {
    getMetadata()
      .then(meta => sendResponse(meta))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  // ── 활성 상태 확인 (Content Script / Popup → 현재 호스트의 활성 여부) ──
  if (message.type === 'CHECK_ENABLED') {
    checkEnabled(message.hostname)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ enabled: true, error: err.message }));
    return true;
  }

});

/**
 * 동기화 상태 조회 (Popup UI용).
 * @returns {Promise<Object>}
 */
async function getSyncStatus() {
  try {
    const db = await getCachedDB();
    const localVer = await dbGet(db, STORE_META, 'local_ver');
    const lastSynced = await dbGet(db, STORE_META, 'last_synced');
    const totalCount = await dbGet(db, STORE_META, 'total_count');

    return {
      localVer: localVer || null,
      lastSynced: lastSynced || null,
      totalCount: totalCount || null,
    };
  } catch (err) {
    _cachedDB = null;
    throw err;
  }
}

/**
 * 메타데이터(case_code_map 등) 반환.
 * Content Script에서 사건부호 유효성 검증에 필요.
 * 서버에서 최초 로드 후 chrome.storage.local에 캐시.
 * @returns {Promise<Object>}
 */
async function getMetadata() {
  // 먼저 로컬 캐시 확인
  const cached = await chrome.storage.local.get(['bupgogae_meta', 'bupgogae_court_map']);

  // 정적 번들 메타 로드
  let meta;
  if (cached.bupgogae_meta) {
    meta = cached.bupgogae_meta;
  } else {
    try {
      const url = chrome.runtime.getURL('data/bupgogae_meta.json');
      const res = await fetch(url);
      meta = await res.json();
      await chrome.storage.local.set({ bupgogae_meta: meta });
      console.log('[bupgogae] ✅ 번들 메타데이터 로드 완료');
    } catch (bundledErr) {
      console.error('[bupgogae] 번들 메타 로드 실패:', bundledErr);
      meta = { case_code_map: {}, court_code_map: {} };
    }
  }

  // 동적 court_code_map 이 있으면 merge (우선)
  if (cached.bupgogae_court_map) {
    meta = {
      ...meta,
      court_code_map: { ...meta.court_code_map, ...cached.bupgogae_court_map },
    };
  }

  return meta;
}



// ============================================================
// 7. 활성/비활성 상태 관리
// ============================================================

/**
 * 특정 호스트에 대해 확장프로그램이 활성인지 확인.
 * @param {string} hostname - 확인할 호스트명
 * @returns {Promise<{enabled: boolean}>}
 */
async function checkEnabled(hostname) {
  try {
    const data = await chrome.storage.local.get([
      'bupgogae_disabled_global',
      'bupgogae_disabled_sites',
    ]);

    const disabledGlobal = data.bupgogae_disabled_global === true;
    const disabledSites = Array.isArray(data.bupgogae_disabled_sites)
      ? data.bupgogae_disabled_sites
      : [];

    if (disabledGlobal) {
      return { enabled: false, reason: 'global' };
    }

    if (hostname && disabledSites.includes(hostname)) {
      return { enabled: false, reason: 'site' };
    }

    return { enabled: true };
  } catch (err) {
    console.warn('[bupgogae] 활성 상태 확인 실패:', err);
    return { enabled: true }; // 실패 시 기본 활성
  }
}

/**
 * 특정 탭에 대해 아이콘 배지 업데이트.
 * 비활성 상태이면 "OFF" 배지 표시, 활성이면 배지 제거.
 * @param {number} tabId
 * @param {string} hostname
 */
async function updateTabBadge(tabId, hostname) {
  try {
    const { enabled } = await checkEnabled(hostname);

    if (!enabled) {
      await chrome.action.setBadgeText({ text: 'OFF', tabId });
      await chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId });
    } else {
      await chrome.action.setBadgeText({ text: '', tabId });
    }
  } catch (err) {
    // 탭이 이미 닫혔거나 할 수 있으므로 무시
  }
}

/**
 * 탭 업데이트 시 배지 자동 갱신.
 * 페이지 로드 완료 시 해당 탭의 URL을 확인하여 배지 표시.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    try {
      const url = new URL(tab.url);
      updateTabBadge(tabId, url.hostname);
    } catch (err) {
      // 잘못된 URL (chrome:// 등) 무시
    }
  }
});

/**
 * 탭 활성화 시 배지 갱신.
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url) {
      const url = new URL(tab.url);
      updateTabBadge(activeInfo.tabId, url.hostname);
    }
  } catch (err) {
    // 무시
  }
});

/**
 * 스토리지 변경 시 모든 탭 배지 갱신.
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!changes.bupgogae_disabled_global && !changes.bupgogae_disabled_sites) return;

  // 모든 탭의 배지 갱신
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.url) {
        try {
          const url = new URL(tab.url);
          updateTabBadge(tab.id, url.hostname);
        } catch (err) {
          // 무시
        }
      }
    }
  });
});



/**
 * 단축키(commands) 핸들러
 */
chrome.commands.onCommand.addListener((command) => {
  if (command === 'copy_orange_cases') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'EXTRACT_ORANGE_CASES' }, (res) => {
          if (chrome.runtime.lastError) {
             console.warn('[bupgogae] 단축키 복사 오류:', chrome.runtime.lastError.message);
          }
        });
      }
    });
  }
});
