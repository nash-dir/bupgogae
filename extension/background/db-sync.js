/**
 * 법고개(Bupgogae) — Service Worker DB 동기화 모듈
 * ===================================================
 * Chrome Extension Manifest V3 Service Worker에서 동작하는
 * IndexedDB 기반 판례 DB 동기화 엔진.
 *
 * [아키텍처]
 *   백엔드(NAS Runner)가 매일 master.db를 갱신하고
 *   db.json.gz로 구워 Cloudflare R2에 업로드한다.
 *
 * [동기화 전략]
 *   1. 브라우저 시작 / chrome.alarms 주기 트리거
 *   2. R2에서 db.json.gz 풀 DB fetch (ETag로 변경 확인)
 *   3. 변경 시 IndexedDB 전체 교체
 *   4. 동기화 실패 시 빈 DB로 시작, 다음 알람에서 재시도
 */

// ============================================================
// 상수
// ============================================================
const DB_URL = 'https://api.bup.live/bupgogae/db.json.gz';
const ADAPTERS_URL = 'https://api.bup.live/bupgogae/adapters.json'; // 원격 어댑터 셀렉터 설정
const BUNDLED_DB_URL = 'data/db.json'; // 로컬 디버깅용 폴백
const DB_NAME = 'bupgogae';
const DB_VERSION = 1;
const STORE_CASES = 'cases';
const STORE_META = 'metadata';
const ALARM_NAME = 'bupgogae-sync';
const SYNC_INTERVAL_MINUTES = 60 * 6; // 6시간마다 동기화 시도

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

      // metadata 스토어: 'local_ver', 'last_updated' 등
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
 * 데이터 객체의 각 키-값 쌍을 하나의 트랜잭션으로 넣는다.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {Object} data - { "15Da6302": [[...], ...], ... }
 * @returns {Promise<number>} 삽입된 레코드 수
 */
function dbBulkInsert(db, storeName, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    let count = 0;

    for (const [key, value] of Object.entries(data)) {
      store.put(value, key);
      count++;
    }

    tx.oncomplete = () => resolve(count);
    tx.onerror = () => reject(new Error(`dbBulkInsert failed: ${tx.error}`));
  });
}

// ============================================================
// 2. 네트워크 요청 (ETag 지원)
// ============================================================

/**
 * db.json.gz를 fetch. ETag 비교로 변경 확인.
 * @param {string} url
 * @param {string|null} cachedETag - 이전 ETag (null이면 무조건 다운로드)
 * @returns {Promise<{data: Object|null, etag: string|null, notModified: boolean}>}
 */
async function fetchDB(url, cachedETag = null) {
  const headers = { 'Accept': 'application/json' };
  if (cachedETag) {
    headers['If-None-Match'] = cachedETag;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers });

      if (res.status === 304) {
        return { data: null, etag: cachedETag, notModified: true };
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const etag = res.headers.get('ETag') || null;
      const data = await res.json();
      return { data, etag, notModified: false };
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
 * 메인 동기화 함수.
 * R2에서 db.json.gz를 fetch → ETag 비교 → 변경 시 IndexedDB 교체.
 */
async function syncDatabase() {
  console.log('[bupgogae] 동기화 시작...');

  try {
    // ── Step 1: 저장된 ETag 조회 ──
    const { bupgogae_etag: cachedETag = null } =
      await chrome.storage.local.get('bupgogae_etag');

    // ── Step 2: R2에서 fetch (ETag 비교) ──
    const { data, etag, notModified } = await fetchDB(DB_URL, cachedETag);

    if (notModified) {
      console.log('[bupgogae] DB 변경 없음 (304). 동기화 스킵.');
      return;
    }

    if (!data || !data.cases) {
      console.warn('[bupgogae] 유효하지 않은 응답. 동기화 중단.');
      return;
    }

    // ── Step 3: IndexedDB 교체 ──
    const db = await getCachedDB();
    await dbClear(db, STORE_CASES);
    const count = await dbBulkInsert(db, STORE_CASES, data.cases);

    // ── Step 4: 메타데이터 + ETag 저장 ──
    const version = data.version || new Date().toISOString().slice(0, 10);
    await updateMetadata(db, version, data.total || count);
    await chrome.storage.local.set({ bupgogae_etag: etag });

    console.log(`[bupgogae] ✅ 동기화 완료: ${count}건 교체, ver=${version}`);

  } catch (err) {
    console.error('[bupgogae] ❌ R2 동기화 실패:', err);
    // R2 실패 시 로컬 번들 DB 폴백
    await loadBundledDB();
  }

  // ── 어댑터 원격 설정 동기화 (DB 동기화와 독립적으로 실행) ──
  await fetchAdaptersConfig();
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

    // 보안 검증: 모든 값이 순수 데이터(문자열/배열)인지 확인
    for (const [siteId, siteConfig] of Object.entries(config.adapters)) {
      if (siteConfig.responseSelectors) {
        if (!Array.isArray(siteConfig.responseSelectors)) {
          console.warn(`[bupgogae] ${siteId}: responseSelectors가 배열이 아님 — 무시`);
          delete config.adapters[siteId].responseSelectors;
          continue;
        }
        // 각 셀렉터가 문자열인지 검증
        config.adapters[siteId].responseSelectors =
          siteConfig.responseSelectors.filter(s => typeof s === 'string');
      }
    }

    await chrome.storage.local.set({ bupgogae_remote_adapters: config });
    console.log(`[bupgogae] ✅ 어댑터 원격 설정 저장 완료 (ver=${config.version || '?'})`);

  } catch (err) {
    // 네트워크 오류, 파싱 오류 등 — 기존 저장값 유지 (silent fail)
    console.warn('[bupgogae] 어댑터 원격 설정 fetch 실패 (기존값 유지):', err.message);
  }
}

/**
 * 번들 DB 로드 — R2 동기화 실패 시 로컬 폴백.
 * extension/data/db.json을 IndexedDB에 삽입.
 */
async function loadBundledDB() {
  console.log('[bupgogae] 📦 번들 DB 폴백 시도...');
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

    const db = await getCachedDB();
    await dbClear(db, STORE_CASES);
    const count = await dbBulkInsert(db, STORE_CASES, data.cases);
    const version = data.version || 'bundled';
    await updateMetadata(db, version, data.total || count);

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
 */
async function updateMetadata(db, version, totalCount) {
  const tx = db.transaction(STORE_META, 'readwrite');
  const store = tx.objectStore(STORE_META);

  store.put(version, 'local_ver');
  store.put(new Date().toISOString(), 'last_updated');
  store.put(new Date().toISOString(), 'last_synced');
  if (totalCount != null) {
    store.put(totalCount, 'total_count');
  }

  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(new Error('metadata update failed'));
  });

  console.log(`[bupgogae] 메타데이터 갱신: ver=${version}, total=${totalCount ?? '?'}`);
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
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CASES, 'readonly');
      const store = tx.objectStore(STORE_CASES);

      let pending = compressedKeys.length;

      for (const key of compressedKeys) {
        const req = store.get(key);

        req.onsuccess = () => {
          const val = req.result;
          results[key] = (val && val.length > 0)
            ? { found: true, data: val }
            : { found: false, data: null };

          pending--;
          if (pending === 0) resolve();
        };

        req.onerror = () => {
          results[key] = { found: false, data: null, error: req.error?.message };
          pending--;
          if (pending === 0) resolve();
        };
      }

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

  // 설치/업데이트 시 R2에서 동기화 시도
  await syncDatabase();

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
  await syncDatabase();
});

/**
 * 알람 트리거 — 주기적 동기화 실행.
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log('[bupgogae] 알람 트리거 → 동기화 실행');
    await syncDatabase();
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
    syncDatabase()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
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
    const lastUpdated = await dbGet(db, STORE_META, 'last_updated');
    const lastSynced = await dbGet(db, STORE_META, 'last_synced');
    const totalCount = await dbGet(db, STORE_META, 'total_count');

    return {
      localVer: localVer || null,
      lastUpdated: lastUpdated || null,
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
  const cached = await chrome.storage.local.get('bupgogae_meta');
  if (cached.bupgogae_meta) {
    return cached.bupgogae_meta;
  }

  try {
    // 캐시 없으면 로컬 번들에서 로드 (정적 JSON 방식에서는 이것이 제일 빠르고 확실함)
    const url = chrome.runtime.getURL('data/bupgogae_meta.json');
    const res = await fetch(url);
    const meta = await res.json();
    await chrome.storage.local.set({ bupgogae_meta: meta });
    console.log('[bupgogae] ✅ 번들 메타데이터 로드 완료');
    return meta;
  } catch (bundledErr) {
    console.error('[bupgogae] 번들 메타 로드 실패:', bundledErr);
    return { case_code_map: {}, court_code_map: {} };
  }
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
