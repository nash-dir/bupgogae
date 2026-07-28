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
 *   3. 변경 시 비활성 snapshot store에 전부 staging/검증
 *   4. metadata의 active pointer만 원자적으로 전환
 *   5. 동기화 실패 시 기존 snapshot(또는 번들 폴백)을 유지하고 다음 알람에서 재시도
 */

// 순수 검증·정제 유틸 로드 (테스트 가능한 무부수효과 로직).
// isValidCssSelector / sanitizeAdaptersConfig / validateDbIntegrity를 전역에 제공.
importScripts('sync-utils.js');

// ============================================================
// 상수
// ============================================================
const API_BASE_URL = 'https://api.bup.live/bupgogae/';
const DB_URL = `${API_BASE_URL}db.json.gz`;

const ADAPTERS_URL = 'https://api.bup.live/bupgogae/adapters.json'; // 원격 어댑터 셀렉터 설정
const MANIFEST_URL = 'https://api.bup.live/bupgogae/manifest.json'; // Drift 안전망 정답지
const BUNDLED_DB_URL = 'data/db.json'; // 로컬 디버깅용 폴백
const DB_NAME = 'bupgogae';
const DB_VERSION = 2;
// v1 사용자의 기존 store는 복사/삭제하지 않고 첫 안전한 sync까지 그대로 사용한다.
const STORE_CASES_LEGACY = 'cases';
const STORE_CASES_A = 'cases_a';
const STORE_CASES_B = 'cases_b';
const SNAPSHOT_STORES = [STORE_CASES_LEGACY, STORE_CASES_A, STORE_CASES_B];
const STORE_META = 'metadata';
const ACTIVE_STORE_KEY = 'active_cases_store';
const SNAPSHOT_META_PREFIX = 'snapshot_meta:';
const ALARM_NAME = 'bupgogae-sync';
const SYNC_INTERVAL_MINUTES = 60 * 6; // 6시간마다 동기화 시도

// [보안 상수]
const MAX_DB_SIZE_BYTES = 50 * 1024 * 1024; // 50MB 제한
const MAX_ADAPTER_CONFIG_BYTES = 256 * 1024; // remote selector JSON 256KiB 제한
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_LAW_HTML_BYTES = 5 * 1024 * 1024;
const MAX_ADAPTER_SITES = 50;
const REQUIRED_ADAPTER_SITE_IDS = [
  'gemini', 'chatgpt', 'claude', 'copilot', 'perplexity', 'grok',
];
const MAX_SELECTORS_PER_SITE = 10;   // 사이트당 최대 선택자 개수
const MAX_SELECTOR_LENGTH = 150;     // 선택자 하나당 최대 길이 (문자 수)

// [무결성 검증 상수]
const MIN_KEYS_CORE = 100_000;       // Core DB 최소 키 수 (미달 시 파이프라인 장애 판정)
const VERSION_REGEX = /^\d{8}$/;     // version 형식: YYYYMMDD

// [동기화 견고성 상수] — 0.8.0 "DB 2달 정체" 사고 재발 방지
const WATCHDOG_MS = 48 * 3600 * 1000;   // 마지막 성공 후 48h 초과 시 ETag 불신
const FETCH_TIMEOUT_MS = 60_000;        // DB fetch 행(hang) 방지 타임아웃
const LAW_FETCH_TIMEOUT_MS = 20_000;
const SYNC_LEDGER_KEY = 'bupgogae_sync_ledger'; // 동기화 시도 원장 (storage.local)
const SYNC_LEDGER_MAX = 20;             // 원장 보존 개수 (최신순)
const ADAPTER_SYNC_STATE_KEY = 'bupgogae_adapter_sync_state';
const ADAPTER_ATTEMPT_COOLDOWN_MS = 15 * 60 * 1000;

// [Drift 안전망 상수] — manifest 정답지 대조 → 캐시버스터 치유
const DRIFT = {
  GRACE_MS: 2 * 3600 * 1000,            // 갓 게시된 manifest는 CDN 전파 대기
  CHECK_MIN_INTERVAL_MS: 4 * 3600 * 1000, // force 아닐 때 검사 최소 간격
  MAX_STRIKES: 3,                       // 연속 치유 실패 한도 (폭주 방지)
  MANIFEST_TIMEOUT_MS: 10_000,          // manifest fetch 타임아웃
};
const DRIFT_STATE_KEY = 'bupgogae_drift_state'; // {lastCheckAt, strikes, lastResult}

// staging 중 idle DB 커넥션 닫기 방지 플래그
let _syncActive = false;
// 설치/시작/알람/수동/drift trigger를 하나의 fetch+install로 합치는 single-flight.
let _syncInFlight = null;
// 여러 탭의 진입 신호를 하나의 manifest 대조로 합쳐 outage herd를 막는다.
let _driftCheckInFlight = null;
// 여러 탭 initAdapters의 같은 remote-config 요청을 한 번으로 합친다.
let _adapterFetchInFlight = null;
// sync와 drift가 동시에 요구하는 commit manifest 요청도 합친다.
let _manifestFetchInFlight = null;

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

      // v1 legacy store와 v2 이중 snapshot store. 기존 cases는 절대 삭제하지 않는다.
      if (!db.objectStoreNames.contains(STORE_CASES_LEGACY)) {
        db.createObjectStore(STORE_CASES_LEGACY);
      }
      if (!db.objectStoreNames.contains(STORE_CASES_A)) {
        db.createObjectStore(STORE_CASES_A);
      }
      if (!db.objectStoreNames.contains(STORE_CASES_B)) {
        db.createObjectStore(STORE_CASES_B);
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

/**
 * 현재 active snapshot 이름. v1 DB에는 pointer가 없으므로 legacy cases를 사용한다.
 *
 * @param {IDBDatabase} db
 * @returns {Promise<string>}
 */
async function getActiveStoreName(db) {
  const candidate = await dbGet(db, STORE_META, ACTIVE_STORE_KEY).catch(() => null);
  if (SNAPSHOT_STORES.includes(candidate) && db.objectStoreNames.contains(candidate)) {
    return candidate;
  }
  return STORE_CASES_LEGACY;
}

/**
 * active store에 결합된 메타데이터를 읽는다. v1 legacy store만 기존 전역 키를
 * 사용하고, A/B는 snapshot 전용 객체가 없으면 손상 상태(null)로 취급한다.
 */
async function readActiveSnapshotMetadata(db, activeStore = null) {
  const storeName = activeStore || await getActiveStoreName(db);
  if (storeName === STORE_CASES_LEGACY) {
    const [version, totalCount, contentHash, lastSuccessAt, lastSynced, courtCodeMap] =
      await Promise.all([
        dbGet(db, STORE_META, 'local_ver').catch(() => null),
        dbGet(db, STORE_META, 'total_count').catch(() => null),
        dbGet(db, STORE_META, 'content_hash').catch(() => null),
        dbGet(db, STORE_META, 'last_success_at').catch(() => null),
        dbGet(db, STORE_META, 'last_synced').catch(() => null),
        dbGet(db, STORE_META, 'court_code_map').catch(() => null),
      ]);
    let etag = null;
    try {
      ({ bupgogae_etag: etag = null } =
        await chrome.storage.local.get('bupgogae_etag'));
    } catch {}
    return {
      version: version ?? null,
      totalCount: totalCount ?? null,
      contentHash: contentHash ?? null,
      lastSuccessAt: lastSuccessAt ?? null,
      lastSynced: lastSynced ?? null,
      courtCodeMap: courtCodeMap ?? null,
      etag: typeof etag === 'string' ? etag : null,
      storeName,
      legacy: true,
    };
  }

  const metadata = await dbGet(
    db, STORE_META, `${SNAPSHOT_META_PREFIX}${storeName}`,
  ).catch(() => null);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
      typeof metadata.version !== 'string' || !Number.isSafeInteger(metadata.totalCount) ||
      metadata.totalCount < 0) {
    return null;
  }
  return { ...metadata, storeName, legacy: false };
}

/**
 * store 레코드 수.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @returns {Promise<number>}
 */
function dbCount(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(`dbCount failed: ${req.error}`));
  });
}

/**
 * 완성된 staging store와 메타데이터를 하나의 짧은 transaction으로 활성화한다.
 * 데이터 청크 transaction은 모두 이 시점 전에 완료되어 있다.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {{version: string, totalCount: number, contentHash?: string|null,
 *          lastSuccessAt?: number|null, courtCodeMap?: Object, etag?: string|null}} metadata
 * @returns {Promise<void>}
 */
function activateSnapshot(db, storeName, metadata) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    const snapshotMetadata = {
      version: metadata.version,
      totalCount: metadata.totalCount,
      lastSynced: new Date().toISOString(),
      contentHash: metadata.contentHash ?? null,
      lastSuccessAt: metadata.lastSuccessAt ?? null,
      etag: typeof metadata.etag === 'string' ? metadata.etag : null,
      courtCodeMap: metadata.courtCodeMap && typeof metadata.courtCodeMap === 'object'
        ? metadata.courtCodeMap
        : null,
    };

    // A/B의 데이터와 메타는 같은 snapshot identity로 결합한다. 전역 local_ver 등은
    // v1 legacy store 소유로 남겨, 구버전이 갱신해도 active A/B 판정에 섞이지 않는다.
    store.put(snapshotMetadata, `${SNAPSHOT_META_PREFIX}${storeName}`);
    store.put(storeName, ACTIVE_STORE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error(`snapshot activation failed: ${tx.error}`));
    tx.onabort = () => reject(new Error(`snapshot activation aborted: ${tx.error}`));
  });
}

/**
 * 비활성 store에 전체 payload를 staging한 뒤 정확한 건수를 확인하고 pointer를 전환한다.
 * 중간 실패 시 active pointer는 건드리지 않으므로 이전 snapshot이 그대로 유지된다.
 *
 * @param {IDBDatabase} db
 * @param {Object} data
 * @param {{version: string, totalCount: number, contentHash?: string|null,
 *          lastSuccessAt?: number|null, courtCodeMap?: Object, etag?: string|null}} metadata
 * @param {{chunkSize?: number, afterChunk?: Function}} [opts]
 * @returns {Promise<{count: number, activeStore: string, previousStore: string}>}
 */
async function stageAndActivateSnapshot(db, data, metadata, opts = {}) {
  const previousStore = await getActiveStoreName(db);
  const stagingStore = previousStore === STORE_CASES_A ? STORE_CASES_B : STORE_CASES_A;
  const chunkSize = opts.chunkSize || 10000;
  const entries = Object.entries(data);
  _syncActive = true;

  try {
    // 이전 실행이 남긴 비활성 staging 잔해만 지운다. active store는 건드리지 않는다.
    await dbClear(db, stagingStore);
    let inserted = 0;
    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = Object.fromEntries(entries.slice(i, i + chunkSize));
      inserted += await dbBulkInsert(db, stagingStore, chunk, chunkSize);
      if (opts.afterChunk) await opts.afterChunk({ inserted, stagingStore });
    }

    const stagedCount = await dbCount(db, stagingStore);
    if (stagedCount !== entries.length || inserted !== entries.length) {
      throw new Error(`staging count mismatch: expected=${entries.length}, actual=${stagedCount}`);
    }

    await activateSnapshot(db, stagingStore, metadata);

    // v1 legacy store는 기존 사용자 데이터와 migration 복구 원본이므로 절대 지우지
    // 않는다. (DB schema version 때문에 구 확장 바이너리 rollback 호환을 뜻하지는
    // 않는다.) v2 이후의 A/B snapshot만 서로 recycle한다.
    // pointer 전환 뒤의 A/B 정리는 best-effort다.
    if (previousStore !== STORE_CASES_LEGACY && previousStore !== stagingStore) {
      dbClear(db, previousStore).catch((err) => {
        console.warn(`[bupgogae] 이전 snapshot 정리 실패 (${previousStore}):`, err.message);
      });
    }
    return { count: stagedCount, activeStore: stagingStore, previousStore };
  } catch (err) {
    // 실패한 staging 잔해는 다음 시도 시작 시 다시 clear된다. active는 불변이다.
    throw err;
  } finally {
    _syncActive = false;
  }
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
  const conditionalETag = typeof cachedETag === 'string' && cachedETag.trim().length > 0
    ? cachedETag
    : null;
  if (conditionalETag) {
    headers['If-None-Match'] = conditionalETag;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // 행(hang) 방지: 0.8.0 사고에서 응답 없는 fetch가 동기화를 무기한 정지시킴
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

      if (res.status === 304) {
        if (!conditionalETag) {
          const err = new Error('조건 없는 요청에 HTTP 304 응답');
          err.nonRetryable = true;
          throw err;
        }
        return { data: null, etag: conditionalETag, notModified: true, contentHash: null };
      }

      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${res.statusText}`);
        // 영구적인 4xx는 같은 실행에서 재시도해도 달라지지 않는다.
        err.nonRetryable = res.status >= 400 && res.status < 500 &&
          res.status !== 408 && res.status !== 429;
        throw err;
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
      if (attempt === 3 || err.nonRetryable) throw err;
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
}

// ============================================================
// 3. 핵심 동기화 로직 — 풀 DB fetch, inactive staging, pointer switch
// ============================================================

/**
 * Core 키 수 조회 — 전체 count에서 DLC 키(TX*, KP*)를 제외.
 * buildFetchPlan/shouldLoadBundled/evaluateDrift의 건강 판정 기준값.
 * @param {IDBDatabase} db
 * @returns {Promise<number>}
 */
function countCoreKeys(db) {
  return new Promise((resolve, reject) => {
    const availableStores = SNAPSHOT_STORES.filter((name) => db.objectStoreNames.contains(name));
    const tx = db.transaction([STORE_META, ...availableStores], 'readonly');
    let total = 0, taxCount = 0, patentCount = 0;
    const RANGE_END = String.fromCharCode(0xFFFF); // 'TX'~'TX￿' 키 범위 상한
    const activeReq = tx.objectStore(STORE_META).get(ACTIVE_STORE_KEY);
    activeReq.onsuccess = () => {
      const candidate = activeReq.result;
      const storeName = availableStores.includes(candidate) ? candidate : STORE_CASES_LEGACY;
      const store = tx.objectStore(storeName);
      const reqTotal = store.count();
      reqTotal.onsuccess = () => { total = reqTotal.result; };
      const reqTax = store.count(IDBKeyRange.bound('TX', 'TX' + RANGE_END));
      reqTax.onsuccess = () => { taxCount = reqTax.result; };
      const reqPatent = store.count(IDBKeyRange.bound('KP', 'KP' + RANGE_END));
      reqPatent.onsuccess = () => { patentCount = reqPatent.result; };
    };

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
  const activeStore = await getActiveStoreName(db);
  const [metadata, coreCount] = await Promise.all([
    readActiveSnapshotMetadata(db, activeStore).catch(() => null),
    countCoreKeys(db).catch(() => 0),
  ]);
  return {
    localVer: metadata?.version ?? null,
    contentHash: metadata?.contentHash ?? null,
    lastSuccessAt: metadata?.lastSuccessAt ?? null,
    etag: metadata?.etag ?? null,
    totalCount: metadata?.totalCount ?? null,
    activeStore,
    snapshotMetadataValid: metadata !== null,
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
 * R2에서 db.json.gz를 fetch → 변경 시 snapshot 전환, 모든 시도를 원장에 기록.
 *
 * @param {{trigger?: string, force?: boolean, validatedManifest?: Object}} [opts]
 *   trigger: install|startup|alarm|force|drift (원장 라벨)
 *   force: If-None-Match 생략 (드리프트 치유용)
 *   validatedManifest: 같은 실행에서 이미 원격 검증한 manifest (내부 drift 경로 전용)
 * @returns {Promise<{success: boolean, outcome: string, reason?: string, version?: string}>}
 *   outcome: replaced|not_modified|downgrade_blocked|fetch_failed|invalid_payload|integrity_failed|db_error
 */
function syncDatabase(opts = {}) {
  if (_syncInFlight) return _syncInFlight;
  _syncInFlight = runSyncDatabase(opts)
    .finally(() => { _syncInFlight = null; });
  return _syncInFlight;
}

async function runSyncDatabase(opts = {}) {
  const trigger = opts.trigger || 'manual';
  const force = opts.force === true;
  const startedAt = Date.now();

  console.log(`[bupgogae] 동기화 시작 (trigger=${trigger}${force ? ', force' : ''})...`);

  let result;
  try {
    let manifest = opts.validatedManifest;
    if (manifest) {
      const validation = validateManifest(manifest);
      if (!validation.ok) {
        const err = new Error(`manifest 스키마 불량: ${validation.error}`);
        err.outcome = 'integrity_failed';
        throw err;
      }
    } else {
      // manifest는 게시자의 commit marker다. 이것을 확인하기 전에는 고정 DB URL을
      // 절대 내려받지 않아 "DB PUT 성공 → manifest PUT 실패" 레이스를 차단한다.
      manifest = await fetchValidatedManifest();
    }
    result = await doSyncDatabase({ force, manifest });
  } catch (err) {
    const outcome = err?.outcome || 'db_error';
    console.error(`[bupgogae] ❌ 동기화 중 오류 (${outcome}):`, err);
    result = { success: false, outcome, reason: err?.message || String(err) };
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

  return result;
}

/**
 * 동기화 핵심 로직 — fetch 계획 수립 → fetch → 검증 → snapshot 전환.
 * 결과를 outcome으로 분류해 반환한다 (번들 폴백/원장은 syncDatabase 담당).
 */
async function doSyncDatabase({ force, manifest }) {
  // ── Step 1: 로컬 상태 + ETag → fetch 계획 (304 가드 + 워치독) ──
  let local;
  try {
    local = await readLocalSyncState();
  } catch (err) {
    // 로컬 상태를 알 수 없으면 가장 보수적인 가정 → 무조건 전체 fetch
    local = { localVer: null, contentHash: null, lastSuccessAt: null, coreCount: 0 };
  }

  // ETag도 active snapshot metadata에 결합한다. 전역 storage ETag는 legacy에서만
  // readActiveSnapshotMetadata가 가져오므로 v1↔v2 전환 시 상태가 섞이지 않는다.
  const cachedETag = local.etag;

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

    // 304는 로컬 snapshot이 manifest가 지정한 정확한 commit일 때만 안전하다.
    // 버전만 같은 재게시(hash 변경)나 부분/이전 snapshot이면 반드시 전체 다운로드한다.
    const localMatchesManifest = local.localVer === manifest.core.version &&
      local.contentHash === manifest.core.sha256 &&
      local.coreCount === manifest.core.total;
    if (!localMatchesManifest) {
      conditional = false;
      plan.reasons.push('manifest_mismatch');
    }
    if (!conditional && plan.reasons.length > 0) {
      console.log(`[bupgogae] 조건부 요청 생략 → 전체 fetch (${plan.reasons.join(', ')})`);
    }
  }

  // 새 manifest는 content-addressed immutable object를 가리킨다. 기존 manifest는
  // fixed mirror를 hash cache-buster와 함께 사용하되 동일한 hash gate를 거친다.
  const url = resolveCoreDbUrl(manifest.core);

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
    const localMatchesManifest = local.localVer === manifest.core.version &&
      local.contentHash === manifest.core.sha256 &&
      local.coreCount === manifest.core.total;
    if (!localMatchesManifest) {
      return {
        success: false,
        outcome: 'integrity_failed',
        reason: '304 응답과 manifest가 로컬 snapshot에 일치하지 않음',
      };
    }
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

  // 게시자가 manifest에 확정한 commit과 수신 바이트가 다르면 스키마 검사나
  // staging 전에 즉시 거부한다. DB PUT과 manifest PUT 사이의 게시 레이스도 여기서 막힌다.
  if (contentHash !== manifest.core.sha256) {
    return {
      success: false,
      outcome: 'integrity_failed',
      reason: `manifest hash 불일치 (expected=${manifest.core.sha256}, actual=${contentHash})`,
    };
  }
  if (data.version !== manifest.core.version) {
    return {
      success: false,
      outcome: 'integrity_failed',
      reason: `manifest version 불일치 (expected=${manifest.core.version}, actual=${data.version})`,
    };
  }
  if (data.total !== manifest.core.total) {
    return {
      success: false,
      outcome: 'integrity_failed',
      reason: `manifest total 불일치 (expected=${manifest.core.total}, actual=${data.total})`,
    };
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

  // CDN/상류 오류가 로컬의 더 최신 snapshot을 과거 버전으로 되돌리지 못하게 한다.
  if (local.localVer && validateVersionDate(local.localVer).ok &&
      data.version < local.localVer) {
    console.warn(`[bupgogae] 원격 DB downgrade 차단: remote=${data.version}, local=${local.localVer}`);
    return { success: true, outcome: 'downgrade_blocked', version: local.localVer };
  }

  // ── Step 3~5: 비활성 store staging/검증 → active pointer 전환 → ETag 저장 ──
  try {
    const db = await getCachedDB();
    const version = data.version;
    const installed = await stageAndActivateSnapshot(db, data.cases, {
      version,
      totalCount: data.total,
      contentHash,
      lastSuccessAt: Date.now(),
      courtCodeMap: data.court_code_map,
      etag,
    });
    const count = installed.count;
    console.log(`[bupgogae] Core DB snapshot 전환: ${count}건, store=${installed.activeStore}`);
    if (data.court_code_map) {
      console.log(`[bupgogae] court_code_map 결합: ${Object.keys(data.court_code_map).length}개 법원`);
    }

    console.log(`[bupgogae] ✅ 동기화 완료: ${count}건 snapshot 전환, ver=${version}`);
    return { success: true, outcome: 'replaced', version };
  } catch (err) {
    console.error('[bupgogae] ❌ IndexedDB snapshot 설치 실패:', err);
    _cachedDB = null; // 커넥션 오류 가능성 — 캐시 무효화
    return { success: false, outcome: 'db_error', reason: err?.message || String(err) };
  }
}

/**
 * manifest의 optional immutable object 경로를 안전한 API URL로 해석한다.
 * validateManifest를 통과했더라도 소비 지점에서 origin/prefix/hash를 다시 확인해
 * 향후 validator 변경이 open redirect 또는 임의 host fetch로 이어지지 않게 한다.
 */
function resolveCoreDbUrl(core) {
  if (core.object_path === undefined) {
    return `${DB_URL}?cb=${encodeURIComponent(core.sha256)}`;
  }

  const expectedPath = `objects/${core.sha256}.json.gz`;
  const base = new URL(API_BASE_URL);
  const resolved = new URL(core.object_path, base);
  const valid = core.object_path === expectedPath &&
    resolved.origin === base.origin &&
    resolved.pathname === `${base.pathname}${expectedPath}` &&
    resolved.search === '' && resolved.hash === '';
  if (!valid) {
    const err = new Error('manifest core.object_path origin/prefix/hash 불일치');
    err.outcome = 'integrity_failed';
    throw err;
  }
  return resolved.href;
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
function fetchAdaptersConfig() {
  if (_adapterFetchInFlight) return _adapterFetchInFlight;
  _adapterFetchInFlight = runFetchAdaptersConfig()
    .finally(() => { _adapterFetchInFlight = null; });
  return _adapterFetchInFlight;
}

async function readResponseTextWithLimit(res, maxBytes) {
  const declared = Number(res.headers?.get?.('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    const err = new Error(`응답 크기 초과 (${declared} bytes)`);
    err.outcome = 'invalid_payload';
    throw err;
  }

  let text;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        reader.cancel();
        const err = new Error(`응답 크기 초과 (${received} bytes)`);
        err.outcome = 'invalid_payload';
        throw err;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder('utf-8').decode(bytes);
  } else if (typeof res.text === 'function') {
    text = await res.text();
  } else {
    // unit-test response doubles; production Response always has body/text.
    text = JSON.stringify(await res.json());
  }

  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    const err = new Error('응답 크기 초과');
    err.outcome = 'invalid_payload';
    throw err;
  }
  return text;
}

async function readJsonResponseWithLimit(res, maxBytes) {
  const text = await readResponseTextWithLimit(res, maxBytes);
  try {
    return JSON.parse(text);
  } catch (err) {
    err.outcome = 'invalid_payload';
    throw err;
  }
}

/**
 * 게시 완료를 나타내는 작은 manifest를 내려받아 엄격히 검증한다.
 * sync/drift 동시 호출은 같은 요청을 공유하며, 성공한 manifest는 장기 캐시하지 않는다.
 * 다음 동기화는 반드시 서버의 최신 commit marker를 다시 확인한다.
 *
 * @returns {Promise<Object>}
 */
function fetchValidatedManifest() {
  if (_manifestFetchInFlight) return _manifestFetchInFlight;
  _manifestFetchInFlight = runFetchValidatedManifest()
    .finally(() => { _manifestFetchInFlight = null; });
  return _manifestFetchInFlight;
}

async function runFetchValidatedManifest() {
  let res;
  try {
    res = await fetch(MANIFEST_URL, {
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(DRIFT.MANIFEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const err = new Error(`manifest fetch 실패: ${cause?.message || String(cause)}`);
    err.outcome = 'fetch_failed';
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`manifest HTTP ${res.status}`);
    err.outcome = 'fetch_failed';
    throw err;
  }

  let manifest;
  try {
    manifest = await readJsonResponseWithLimit(res, MAX_MANIFEST_BYTES);
  } catch (cause) {
    const err = new Error(`manifest payload 불량: ${cause?.message || String(cause)}`);
    err.outcome = 'integrity_failed';
    throw err;
  }

  const validation = validateManifest(manifest);
  if (!validation.ok) {
    const err = new Error(`manifest 스키마 불량: ${validation.error}`);
    err.outcome = 'integrity_failed';
    throw err;
  }
  return manifest;
}

async function runFetchAdaptersConfig() {
  console.log('[bupgogae] 어댑터 원격 설정 fetch 시도...');

  const now = Date.now();
  let adapterState = {};
  let existingConfig = null;
  try {
    const stored = await chrome.storage.local.get([
      ADAPTER_SYNC_STATE_KEY,
      'bupgogae_remote_adapters',
    ]);
    adapterState = stored[ADAPTER_SYNC_STATE_KEY];
    if (!adapterState || typeof adapterState !== 'object' || Array.isArray(adapterState)) {
      adapterState = {};
    }
    existingConfig = stored.bupgogae_remote_adapters || null;

    // selector miss를 포함한 모든 자동 호출은 같은 영속 cooldown을 존중한다.
    // 실패 outage도 탭/Service Worker 재시작을 넘어 throttle한다.
    if (Number.isFinite(adapterState.lastAttemptAt) &&
        now - adapterState.lastAttemptAt < ADAPTER_ATTEMPT_COOLDOWN_MS) {
      return {
        success: true,
        outcome: 'throttled',
        ...(existingConfig?.version ? { version: existingConfig.version } : {}),
      };
    }
    await chrome.storage.local.set({
      [ADAPTER_SYNC_STATE_KEY]: { ...adapterState, lastAttemptAt: now },
    });

    const headers = { 'Accept': 'application/json' };
    const conditionalETag = typeof adapterState.etag === 'string' && adapterState.etag.trim()
      ? adapterState.etag
      : null;
    if (conditionalETag) headers['If-None-Match'] = conditionalETag;

    const res = await fetch(ADAPTERS_URL, {
      headers,
      // 행 방지: 응답 없는 원격 설정이 동기화 응답 전체를 막지 않도록
      signal: AbortSignal.timeout(DRIFT.MANIFEST_TIMEOUT_MS),
    });

    if (res.status === 304) {
      const existingAdapters = existingConfig?.adapters;
      if (!conditionalETag || !existingAdapters || typeof existingAdapters !== 'object' ||
          Array.isArray(existingAdapters) || Object.keys(existingAdapters).length === 0 ||
          REQUIRED_ADAPTER_SITE_IDS.some((siteId) => !existingAdapters[siteId])) {
        await chrome.storage.local.set({
          [ADAPTER_SYNC_STATE_KEY]: {
            ...adapterState, lastAttemptAt: now, etag: null,
          },
        }).catch(() => {});
        return {
          success: false,
          outcome: 'invalid_payload',
          error: '유효한 ETag/LKG 없는 304',
        };
      }
      await chrome.storage.local.set({
        [ADAPTER_SYNC_STATE_KEY]: {
          ...adapterState,
          lastAttemptAt: now,
          lastSuccessAt: now,
          etag: conditionalETag,
          version: existingConfig.version,
        },
      });
      return { success: true, outcome: 'not_modified', version: existingConfig.version };
    }

    if (!res.ok) {
      console.warn(`[bupgogae] 어댑터 설정 fetch 실패: HTTP ${res.status}`);
      return { success: false, outcome: 'fetch_failed', error: `HTTP ${res.status}` };
    }

    const config = await readJsonResponseWithLimit(res, MAX_ADAPTER_CONFIG_BYTES);

    const versionText = typeof config?.version === 'string' ? config.version : '';
    const versionMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(versionText);
    const versionValidation = versionMatch
      ? validateVersionDate(`${versionMatch[1]}${versionMatch[2]}${versionMatch[3]}`)
      : { ok: false };
    if (!versionValidation.ok) {
      return { success: false, outcome: 'invalid_payload', error: 'version 형식 오류' };
    }

    // 기본 무결성 검증: 비어 있지 않은 adapters 객체 존재 여부
    if (!config || !config.adapters || typeof config.adapters !== 'object' ||
        Array.isArray(config.adapters)) {
      console.warn('[bupgogae] 어댑터 설정 형식 오류 — adapters 객체 없음');
      return { success: false, outcome: 'invalid_payload', error: 'adapters 객체 없음' };
    }
    if (Object.keys(config.adapters).length === 0) {
      return { success: false, outcome: 'invalid_payload', error: '빈 adapters 거부' };
    }
    if (Object.keys(config.adapters).length > MAX_ADAPTER_SITES) {
      console.warn('[bupgogae] 어댑터 설정 형식 오류 — 사이트 수 상한 초과');
      return {
        success: false,
        outcome: 'invalid_payload',
        error: `사이트 수 ${MAX_ADAPTER_SITES}개 상한 초과`,
      };
    }
    if (Object.values(config.adapters).some((siteConfig) =>
      !siteConfig || typeof siteConfig !== 'object' || Array.isArray(siteConfig))) {
      console.warn('[bupgogae] 어댑터 설정 형식 오류 — 사이트 설정 객체 불량');
      return {
        success: false,
        outcome: 'invalid_payload',
        error: '사이트 설정 객체 불량',
      };
    }
    const missingSites = REQUIRED_ADAPTER_SITE_IDS.filter(
      (siteId) => !Object.hasOwn(config.adapters, siteId),
    );
    if (missingSites.length > 0) {
      return {
        success: false,
        outcome: 'invalid_payload',
        error: `필수 adapter 누락: ${missingSites.join(', ')}`,
      };
    }

    const existingVersion = existingConfig?.version;
    if (typeof existingVersion === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(existingVersion) && versionText < existingVersion) {
      console.warn(`[bupgogae] 어댑터 설정 downgrade 차단: remote=${versionText}, local=${existingVersion}`);
      return { success: true, outcome: 'downgrade_blocked', version: existingVersion };
    }

    // 🚨 보안 검증 (Sanitization) — 화이트리스트 기반 (sync-utils)
    sanitizeAdaptersConfig(config, {
      maxPerSite: MAX_SELECTORS_PER_SITE,
      maxLen: MAX_SELECTOR_LENGTH,
      maxSites: MAX_ADAPTER_SITES,
    });

    const etag = res.headers?.get?.('ETag') || null;
    await chrome.storage.local.set({
      bupgogae_remote_adapters: config,
      [ADAPTER_SYNC_STATE_KEY]: {
        lastAttemptAt: now,
        lastSuccessAt: now,
        etag,
        version: versionText,
      },
    });
    console.log(`[bupgogae] ✅ 어댑터 원격 설정 저장 완료 (ver=${config.version || '?'})`);
    return {
      success: true,
      outcome: 'updated',
      ...(config.version ? { version: config.version } : {}),
    };

  } catch (err) {
    // 네트워크 오류, 파싱 오류 등 — 기존 저장값 유지 (silent fail)
    console.warn('[bupgogae] 어댑터 원격 설정 fetch 실패 (기존값 유지):', err.message);
    return {
      success: false,
      outcome: err?.outcome || 'fetch_failed',
      error: err?.message || String(err),
    };
  }
}

/**
 * 번들 DB 폴백 — R2 동기화 실패 시 shouldLoadBundled 게이트 통과 시에만 로드.
 * 게이트가 다운그레이드를 차단한다: 0.8.0 사고에서 동기화 실패가 최신 로컬 DB를
 * 구버전 번들(version=20260321)로 무조건 덮어쓰던 결함의 수정.
 * 번들 snapshot에는 etag:null을 결합해 이후 원격 동기화를 항상 전체 fetch로 만든다.
 * v1 legacy의 전역 ETag는 legacy 데이터 소유이므로 수정하지 않는다.
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
    const integrity = validateDbIntegrity(data, {
      minKeys: MIN_KEYS_CORE,
      versionRegex: VERSION_REGEX,
    });
    if (!integrity.ok) {
      console.warn(`[bupgogae] 번들 DB 무결성 오류: ${integrity.error}`);
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
    }, { minCoreKeys: MIN_KEYS_CORE });
    if (!gate.load) {
      console.log(`[bupgogae] 번들 폴백 게이트 차단 (${gate.reason}) — 로컬 DB 보존`);
      return;
    }
    console.log(`[bupgogae] 📦 번들 DB 폴백 시도 (${gate.reason})...`);

    const db = await getCachedDB();
    const version = data.version || 'bundled';
    // 번들도 inactive store에 완성한 뒤 전환한다. R2 성공 이력은 기록하지 않는다.
    const installed = await stageAndActivateSnapshot(db, data.cases, {
      version,
      totalCount: data.total,
      contentHash: null,
      lastSuccessAt: null,
      courtCodeMap: data.court_code_map,
      etag: null,
    });
    const count = installed.count;

    console.log(`[bupgogae] ✅ 번들 DB 로드 완료: ${count}건, ver=${version}`);
  } catch (bundledErr) {
    console.warn('[bupgogae] 번들 DB 로드 실패:', bundledErr.message);
  }
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
function verifyDbFreshness(trigger, opts = {}) {
  if (_driftCheckInFlight) return _driftCheckInFlight;
  _driftCheckInFlight = runVerifyDbFreshness(trigger, opts)
    .finally(() => { _driftCheckInFlight = null; });
  return _driftCheckInFlight;
}

async function persistDriftResult(now, trigger, strikes, result) {
  try {
    await chrome.storage.local.set({
      [DRIFT_STATE_KEY]: {
        lastCheckAt: now,
        strikes,
        lastResult: { ts: now, trigger, ...result },
      },
    });
  } catch {}
}

async function runVerifyDbFreshness(trigger, opts = {}) {
  const force = opts.force === true;
  const now = Date.now();
  let state = {};
  let strikes = 0;

  try {
    // ── 스로틀 (force 아닐 때 4h 최소 간격) ──
    try {
      ({ [DRIFT_STATE_KEY]: state = {} } =
        await chrome.storage.local.get(DRIFT_STATE_KEY));
    } catch {}
    if (!state || typeof state !== 'object') state = {};
    if (!force && state.lastCheckAt &&
        now - state.lastCheckAt < DRIFT.CHECK_MIN_INTERVAL_MS) {
      return { checked: false, skipped: 'throttled', drift: false, action: 'none', reasons: [] };
    }
    strikes = Number.isSafeInteger(state.strikes) && state.strikes >= 0 ? state.strikes : 0;

    // manifest fetch가 실패하거나 Service Worker가 중단되어도 이번 시도 시각은 남긴다.
    // 여러 페이지가 같은 outage에 연속 요청을 쏟는 것을 막는 영속 throttle 예약이다.
    try {
      await chrome.storage.local.set({
        [DRIFT_STATE_KEY]: { ...state, lastCheckAt: now, strikes },
      });
    } catch {}

    // ── manifest fetch (크기/스키마 검증 포함, drift 검사에서는 실패 시 fail-open) ──
    let manifest;
    try {
      manifest = await fetchValidatedManifest();
    } catch (err) {
      const invalid = err?.outcome === 'integrity_failed';
      console.log(`[bupgogae] drift 검사 스킵 — manifest ${invalid ? '불량' : '사용 불가'} (${err?.message})`);
      const result = {
        checked: false, skipped: invalid ? 'manifest_invalid' : 'manifest_unavailable',
        drift: false, action: 'none', reasons: [],
      };
      await persistDriftResult(now, trigger, strikes, result);
      return result;
    }

    // ── 드리프트 판정 ──
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
        // 동일 실행에서 원격 검증한 commit marker를 재사용한다. 일반 동기화도
        // manifest hash를 URL/cache 및 바이트 무결성 기준으로 강제한다.
        validatedManifest: manifest,
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

    await persistDriftResult(now, trigger, nextStrikes, result);

    return result;
  } catch (err) {
    // 안전망은 절대 reject하지 않는다
    console.warn('[bupgogae] drift 검사 오류 (fail-open):', err?.message);
    const result = {
      checked: false, skipped: 'error', drift: false,
      action: 'none', reasons: [],
    };
    await persistDriftResult(now, trigger, strikes, result);
    return result;
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
    if (_syncActive) return; // M5: 재구축 중엔 닫지 않음 — 다음 getCachedDB 호출이 타이머를 재무장
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
  const results = await lookupBatch([compressedKey]);
  return results[compressedKey] || { found: false, data: null };
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
  const response = await lookupBatchWithSnapshot(compressedKeys);
  return response.results;
}

/**
 * 조회 결과와 그 결과를 해석하는 법원 map/version을 같은 readonly transaction에서
 * 묶는다. snapshot 전환 경계에서도 content가 구 records + 신 map을 혼합하지 않는다.
 */
async function lookupBatchWithSnapshot(compressedKeys) {
  if (!compressedKeys || compressedKeys.length === 0) {
    return { results: {}, snapshot: null };
  }

  try {
    const db = await getCachedDB();
    const results = {};
    let snapshot = null;
    const availableStores = SNAPSHOT_STORES.filter((name) => db.objectStoreNames.contains(name));

    // metadata pointer와 모든 snapshot store를 같은 readonly transaction에서 읽는다.
    // pointer 전환 전 시작한 조회는 전부 구 snapshot, 전환 후 조회는 전부 신 snapshot을 본다.
    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META, ...availableStores], 'readonly');
      const metaStore = tx.objectStore(STORE_META);
      const activeReq = metaStore.get(ACTIVE_STORE_KEY);
      activeReq.onsuccess = () => {
        const candidate = activeReq.result;
        const storeName = availableStores.includes(candidate) ? candidate : STORE_CASES_LEGACY;
        const store = tx.objectStore(storeName);

        if (storeName === STORE_CASES_LEGACY) {
          const versionReq = metaStore.get('local_ver');
          const mapReq = metaStore.get('court_code_map');
          snapshot = { storeName, version: null, courtCodeMap: null };
          versionReq.onsuccess = () => { snapshot.version = versionReq.result ?? null; };
          mapReq.onsuccess = () => { snapshot.courtCodeMap = mapReq.result ?? null; };
        } else {
          const snapshotReq = metaStore.get(`${SNAPSHOT_META_PREFIX}${storeName}`);
          snapshotReq.onsuccess = () => {
            const value = snapshotReq.result;
            snapshot = {
              storeName,
              version: value?.version ?? null,
              courtCodeMap: value?.courtCodeMap ?? null,
            };
          };
        }

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
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error(`batch tx failed: ${tx.error}`));
    });

    return { results, snapshot };
  } catch (err) {
    console.error('[bupgogae] 배치 조회 실패:', err);
    _cachedDB = null;
    // 전체 실패 시 모든 키를 not found로 반환
    const fallback = {};
    for (const key of compressedKeys) {
      fallback[key] = { found: false, data: null, error: err.message };
    }
    return { results: fallback, snapshot: null };
  }
}

async function fetchLawHtml(rawUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl || '');
  } catch {
    throw new Error('Invalid URL format.');
  }
  if (parsedUrl.hostname !== 'www.law.go.kr' || parsedUrl.protocol !== 'https:' ||
      (parsedUrl.port && parsedUrl.port !== '443')) {
    throw new Error('Invalid URL or Host. Only https://www.law.go.kr is permitted.');
  }

  const res = await fetch(parsedUrl.href, {
    redirect: 'error',
    signal: AbortSignal.timeout(LAW_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  // redirect:'error'가 지원되지 않거나 response double인 경우에도 최종 목적지를 검증한다.
  if (res.url) {
    let finalUrl;
    try {
      finalUrl = new URL(res.url);
    } catch {
      throw new Error('Invalid final response URL.');
    }
    if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'www.law.go.kr' ||
        (finalUrl.port && finalUrl.port !== '443')) {
      throw new Error('Cross-host redirect blocked.');
    }
  }

  return readResponseTextWithLimit(res, MAX_LAW_HTML_BYTES);
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

  // 동기화/번들 폴백이 모두 실패해 DB가 비어 있으면 다음 알람에서 재시도
  try {
    const status = await getSyncStatus();
    if (!status.localVer) {
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
    lookupBatchWithSnapshot(message.keys)
      .then(payload => sendResponse({
        // rolling extension update 중 기존 content script는 flat key map을 기대한다.
        // 신 content는 results+snapshot envelope를 사용하므로 양쪽 모양을 함께 제공한다.
        ...payload.results,
        ...payload,
      }))
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
      .then(result => sendResponse(result))
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
    fetchLawHtml(message.url)
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
    const activeStore = await getActiveStoreName(db);
    const metadata = await readActiveSnapshotMetadata(db, activeStore);

    return {
      localVer: metadata?.version || null,
      lastSynced: metadata?.lastSynced || null,
      totalCount: metadata?.totalCount || null,
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

  // snapshot 전환과 같은 transaction에 저장된 map을 우선 사용한다.
  let activeCourtMap = null;
  let activeIsLegacy = true;
  try {
    const db = await getCachedDB();
    const activeStore = await getActiveStoreName(db);
    activeIsLegacy = activeStore === STORE_CASES_LEGACY;
    const snapshotMetadata = await readActiveSnapshotMetadata(db, activeStore);
    activeCourtMap = snapshotMetadata?.courtCodeMap || null;
  } catch {}
  // storage의 map은 구버전 legacy용 캐시다. A/B metadata가 없을 때 이를 섞으면
  // stale 데이터와 새 법원 코드가 결합되므로 A/B에서는 fail-closed한다.
  const courtMap = activeCourtMap || (activeIsLegacy ? cached.bupgogae_court_map : null);
  if (courtMap) {
    meta = {
      ...meta,
      court_code_map: { ...meta.court_code_map, ...courtMap },
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

// CommonJS 테스트 훅. 확장 Service Worker에서는 module이 없어 노출되지 않는다.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    openDB,
    dbGet,
    dbPut,
    dbClear,
    dbBulkInsert,
    dbCount,
    getActiveStoreName,
    stageAndActivateSnapshot,
    countCoreKeys,
    syncDatabase,
    fetchDB,
    fetchValidatedManifest,
    fetchAdaptersConfig,
    fetchLawHtml,
    verifyDbFreshness,
    lookupCase,
    lookupBatch,
    getSyncStatus,
    resetConnectionForTest() {
      if (_dbIdleTimer) clearTimeout(_dbIdleTimer);
      _dbIdleTimer = null;
      if (_cachedDB) _cachedDB.close();
      _cachedDB = null;
      _syncInFlight = null;
      _driftCheckInFlight = null;
      _adapterFetchInFlight = null;
      _manifestFetchInFlight = null;
    },
    constants: {
      DB_NAME,
      DB_VERSION,
      STORE_CASES_LEGACY,
      STORE_CASES_A,
      STORE_CASES_B,
      STORE_META,
      ACTIVE_STORE_KEY,
      DB_URL,
    },
  };
}
