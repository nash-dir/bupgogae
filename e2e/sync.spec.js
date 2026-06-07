/**
 * 법고개(Bupgogae) — DB 동기화 견고성 & Drift 안전망 E2E 명세 (SDD/TDD)
 * ========================================================================
 * 0.8.0 "DB 2달 정체" 사고(재설치만으로 복구, 새로고침 무력)의 재발 방지 명세.
 * 이 테스트들은 현재 구현에서 실패해야 하며(Red), 목표 구현에서만 통과한다.
 *
 * [동작 명세]
 *  S1-1 (304 가드)   : 로컬 IndexedDB가 비정상(빈 DB 등)이면 저장된 ETag를 신뢰하지
 *                       않고 무조건 fetch로 전체 복구한다.
 *  S1-2 (워치독)     : 마지막 성공 동기화가 48시간을 초과하면 If-None-Match를 생략한다.
 *  S1-3 (다운그레이드 금지): 동기화 실패 시 더 오래된 번들 DB로 로컬을 덮어쓰지 않는다.
 *  S1-4 (정직한 결과): FORCE_SYNC는 실패 시 {success:false, outcome}을 반환하고,
 *                       팝업 새로고침은 사용자에게 실패를 알린다.
 *  S1-5 (원장)       : 모든 동기화 시도는 storage.local의 bupgogae_sync_ledger에 기록된다.
 *  S1-6 (해시 기록)  : 성공 동기화는 수신 바이트의 SHA-256과 성공 시각을 메타에 남긴다.
 *  S2-1 (드리프트 치유): VERIFY_DB_FRESHNESS는 manifest와 대조해 버전이 뒤처지면
 *                       캐시 버스터(?cb=)로 강제 재동기화하고 치유 여부를 보고한다.
 *  S2-2 (진입 트리거): 지원 사이트(LLM) 진입 시 content script가 신선도 검사를 발화한다.
 *
 * [네트워크 모킹]
 *  fixtures.js의 기본 라우트는 api.bup.live를 영구 보류(hold)하므로 설치 시점
 *  동기화는 잠들어 있고, 각 테스트가 mockBupApi()로 자체 라우트를 등록(우선 매칭)해
 *  FORCE_SYNC / VERIFY_DB_FRESHNESS 메시지로 흐름을 직접 구동한다.
 */

const { createHash } = require('node:crypto');
const { test, expect } = require('./fixtures');

// ============================================================
// 테스트 픽스쳐 빌더
// ============================================================

/** 무결성 게이트(MIN_KEYS_CORE=100,000)를 통과하는 유효 DB 페이로드 JSON 문자열 */
function buildDbPayload(version, keyCount = 100_500) {
  const cases = {};
  for (let i = 1; i <= keyCount; i++) {
    cases[`00Da${i}`] = [[i, 1, 200101, '테스트사건']];
  }
  return JSON.stringify({ version, total: keyCount, cases });
}

const sha256 = (s) => createHash('sha256').update(s, 'utf-8').digest('hex');

// 모의 버전은 번들 DB(extension/data/db.json — 릴리스마다 갱신됨)보다 항상
// 미래여야 한다. S1-3의 "로컬이 번들보다 최신" 전제가 번들 갱신으로 무너지면
// 테스트가 시간이 지나며 거짓 실패하므로 먼 미래(2099년)로 고정한다.
const VER_V1 = '20990601';
const VER_V2 = '20990607';
const PAYLOAD_V1 = buildDbPayload(VER_V1);
const PAYLOAD_V2 = buildDbPayload(VER_V2);

/**
 * api.bup.live 모의 라우트 설치.
 * fixtures의 hold 라우트보다 나중에 등록되므로 우선 매칭된다.
 * @param {import('@playwright/test').BrowserContext} context
 * @param {{onDb: function, onManifest?: function}} handlers
 *   onDb(route, request): db.json.gz 요청 처리 (시나리오별 가변)
 *   onManifest(route): manifest.json 요청 처리 (없으면 404)
 */
async function mockBupApi(context, handlers) {
  await context.route('https://api.bup.live/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/adapters.json')) {
      return route.fulfill({ contentType: 'application/json', body: '{"adapters":{}}' });
    }
    if (url.includes('/manifest.json')) {
      if (handlers.onManifest) return handlers.onManifest(route);
      return route.fulfill({ status: 404, body: 'not found' });
    }
    if (url.includes('/db.json.gz')) {
      return handlers.onDb(route, route.request());
    }
    return route.fulfill({ status: 404, body: 'not found' });
  });
}

// ============================================================
// Service Worker 상태 조작/조회 헬퍼
// ============================================================

async function getBackground(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return sw;
}

/** SW 컨텍스트에서 로컬 동기화 상태(메타 + 건수 + storage)를 읽는다 */
function readLocalState(sw) {
  return sw.evaluate(async () => {
    const db = await getCachedDB();
    const get = (store, key) => new Promise((res, rej) => {
      const r = db.transaction(store).objectStore(store).get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const count = await new Promise((res, rej) => {
      const r = db.transaction('cases').objectStore('cases').count();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const storage = await chrome.storage.local.get(null);
    return {
      localVer: (await get('metadata', 'local_ver')) ?? null,
      totalCount: (await get('metadata', 'total_count')) ?? null,
      contentHash: (await get('metadata', 'content_hash')) ?? null,
      lastSuccessAt: (await get('metadata', 'last_success_at')) ?? null,
      caseCount: count,
      etag: storage.bupgogae_etag ?? null,
      ledger: storage.bupgogae_sync_ledger ?? null,
    };
  });
}

/** IndexedDB의 cases + metadata 스토어를 비워 손상/축출 상태를 시뮬레이션 */
function wipeLocalDb(sw) {
  return sw.evaluate(async () => {
    const db = await getCachedDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(['cases', 'metadata'], 'readwrite');
      tx.objectStore('cases').clear();
      tx.objectStore('metadata').clear();
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  });
}

/** metadata.last_success_at을 임의 시각으로 조작 (워치독 시나리오) */
function backdateLastSuccess(sw, epochMs) {
  return sw.evaluate(async (ts) => {
    const db = await getCachedDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('metadata', 'readwrite');
      tx.objectStore('metadata').put(ts, 'last_success_at');
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }, epochMs);
}

/** 확장 페이지에서 FORCE_SYNC 메시지 전송 */
function forceSync(page) {
  return page.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FORCE_SYNC' }, (res) => {
      void chrome.runtime.lastError;
      resolve(res ?? null);
    });
  }));
}

/** 확장 페이지에서 VERIFY_DB_FRESHNESS 메시지 전송 */
function verifyFreshness(page, opts = {}) {
  return page.evaluate((o) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'VERIFY_DB_FRESHNESS', ...o }, (res) => {
      void chrome.runtime.lastError;
      resolve(res ?? null);
    });
  }), opts);
}

// ============================================================
// S1-1. 304 가드 — ETag↔IndexedDB 상태 불일치 자가 복구
// ============================================================

test('S1-1: 로컬 DB가 비어도 304에 갇히지 않고 전체 DB를 복구한다', async ({ context, extensionPage }) => {
  await mockBupApi(context, {
    // 조건부 요청이면 304 (서버 입장에선 "etag 기준 변경 없음"이 사실)
    onDb: (route, req) => {
      if (req.headers()['if-none-match']) {
        return route.fulfill({ status: 304 });
      }
      return route.fulfill({
        contentType: 'application/json',
        headers: { ETag: '"sync-e1"' },
        body: PAYLOAD_V1,
      });
    },
  });
  const sw = await getBackground(context);

  // ── 1차 동기화: 정상 수신 → etag 저장 ──
  await forceSync(extensionPage);
  let state = await readLocalState(sw);
  expect(state.localVer).toBe(VER_V1);
  expect(state.caseCount).toBeGreaterThanOrEqual(100_000);
  expect(state.etag).toBe('"sync-e1"');

  // ── 손상 시뮬레이션: IndexedDB만 비우고 etag는 잔존 (사고의 상태 불일치) ──
  await wipeLocalDb(sw);
  expect((await readLocalState(sw)).caseCount).toBe(0);

  // ── 2차 동기화: 현재 구현은 etag→304→스킵으로 빈 DB 방치, 목표 구현은 전체 복구 ──
  await forceSync(extensionPage);
  state = await readLocalState(sw);
  expect(state.caseCount).toBeGreaterThanOrEqual(100_000);
  expect(state.localVer).toBe(VER_V1);
});

// ============================================================
// S1-2. 워치독 — 48시간 무성공 시 ETag 무시
// ============================================================

test('S1-2: 마지막 성공이 48시간을 넘기면 ETag를 무시하고 최신 DB를 받는다', async ({ context, extensionPage }) => {
  const served = { version: VER_V1, body: PAYLOAD_V1 };
  await mockBupApi(context, {
    // "낡은 엣지 캐시" 시뮬레이션: 조건부 요청에는 영원히 304
    onDb: (route, req) => {
      if (req.headers()['if-none-match']) {
        return route.fulfill({ status: 304 });
      }
      return route.fulfill({
        contentType: 'application/json',
        headers: { ETag: `"sync-${served.version}"` },
        body: served.body,
      });
    },
  });
  const sw = await getBackground(context);

  // 1차 동기화 성공 (v1)
  await forceSync(extensionPage);
  expect((await readLocalState(sw)).localVer).toBe(VER_V1);

  // 마지막 성공을 3일 전으로 조작 + 서버는 v2로 갱신됨
  await backdateLastSuccess(sw, Date.now() - 72 * 3600 * 1000);
  served.version = VER_V2;
  served.body = PAYLOAD_V2;

  // 2차 동기화: 현재 구현은 etag 동봉→304→정체, 목표 구현은 워치독이 무조건 fetch
  await forceSync(extensionPage);
  expect((await readLocalState(sw)).localVer).toBe(VER_V2);
});

// ============================================================
// S1-3. 번들 폴백 다운그레이드 금지
// ============================================================

test('S1-3: 동기화 실패가 최신 로컬 DB를 구버전 번들로 롤백하지 않는다', async ({ context, extensionPage }) => {
  const mode = { fail: false };
  await mockBupApi(context, {
    onDb: (route) => {
      if (mode.fail) return route.fulfill({ status: 500, body: 'server error' });
      return route.fulfill({
        contentType: 'application/json',
        headers: { ETag: '"sync-e1"' },
        body: PAYLOAD_V1,
      });
    },
  });
  const sw = await getBackground(context);

  // 1차 동기화 성공: 로컬은 VER_V1(2099년) — 번들 DB보다 항상 최신
  await forceSync(extensionPage);
  expect((await readLocalState(sw)).localVer).toBe(VER_V1);

  // 서버 장애 시작 → 동기화 실패
  mode.fail = true;
  await forceSync(extensionPage);

  // 현재 구현: 번들 폴백이 local_ver를 20260321로 롤백 + 데이터 92k건으로 격하
  // 목표 구현: 실패는 실패로 남기고 로컬 데이터는 보존
  const state = await readLocalState(sw);
  expect(state.localVer).toBe(VER_V1);
  expect(state.caseCount).toBeGreaterThanOrEqual(100_000);
});

// ============================================================
// S1-4 + S1-5. 정직한 실패 보고 + 동기화 원장
// ============================================================

test('S1-4/5: FORCE_SYNC 실패는 success:false와 원장 기록을 남긴다', async ({ context, extensionPage }) => {
  await mockBupApi(context, {
    onDb: (route) => route.fulfill({ status: 500, body: 'server error' }),
  });
  const sw = await getBackground(context);

  const response = await forceSync(extensionPage);

  // 현재 구현은 어떤 실패든 {success:true}로 보고한다 — 이 침묵이 사고를 숨겼다
  expect(response).not.toBeNull();
  expect(response.success).toBe(false);
  expect(response.outcome).toBe('fetch_failed');

  // 원장: 시도 자체가 기록되어야 현장 진단이 가능하다
  const { ledger } = await readLocalState(sw);
  expect(Array.isArray(ledger)).toBe(true);
  expect(ledger.length).toBeGreaterThanOrEqual(1);
  expect(ledger[0]).toMatchObject({ trigger: 'force', outcome: 'fetch_failed' });
  expect(typeof ledger[0].ts).toBe('number');
});

test('S1-4: 팝업 새로고침 버튼은 동기화 실패를 사용자에게 알린다', async ({ context, extensionId }) => {
  await mockBupApi(context, {
    onDb: (route) => route.fulfill({ status: 500, body: 'server error' }),
  });

  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);

  const dialogPromise = popupPage.waitForEvent('dialog', { timeout: 30_000 });
  await popupPage.locator('#dbRefreshBtn').click();

  const dialog = await dialogPromise; // 현재 구현: success:true → alert 없음 → 타임아웃
  expect(dialog.message()).toContain('동기화 실패');
  await dialog.dismiss();
});

// ============================================================
// S1-5b. 팝업 동기화 이력 — 원장 가시화 (현장 진단용 UI)
// ============================================================

test('S1-5b: 팝업의 동기화 이력 섹션이 원장을 렌더링한다', async ({ context, extensionId }) => {
  // mockBupApi를 등록하지 않는다 — fixture의 hold가 설치 동기화를 잠재워
  // 시드한 원장에 실제 동기화 엔트리가 끼어드는 레이스를 차단한다.
  const sw = await getBackground(context);

  // 원장 시드 (렌더링 검증이 목적 — 기록 자체의 정확성은 S1-4/5가 검증)
  await sw.evaluate(() => chrome.storage.local.set({
    bupgogae_sync_ledger: [
      { ts: Date.now(), trigger: 'force', outcome: 'fetch_failed', reason: 'HTTP 500', durationMs: 6500 },
      { ts: Date.now() - 3600_000, trigger: 'alarm', outcome: 'replaced', version: '20990601', durationMs: 4200 },
    ],
  }));

  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);

  await popupPage.locator('#ledgerToggleBtn').click();
  const rows = popupPage.locator('#ledgerList li');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('force');
  await expect(rows.nth(0)).toContainText('다운로드 실패');
  await expect(rows.nth(1)).toContainText('alarm');
  await expect(rows.nth(1)).toContainText('교체 완료');
});

// ============================================================
// S1-6. 수신 바이트 해시 + 성공 시각 기록 (drift 대조의 기준값)
// ============================================================

test('S1-6: 동기화 성공 시 수신 바이트의 SHA-256과 성공 시각을 기록한다', async ({ context, extensionPage }) => {
  await mockBupApi(context, {
    onDb: (route) => route.fulfill({
      contentType: 'application/json',
      headers: { ETag: '"sync-e1"' },
      body: PAYLOAD_V1,
    }),
  });
  const sw = await getBackground(context);

  const before = Date.now();
  await forceSync(extensionPage);

  const state = await readLocalState(sw);
  expect(state.contentHash).toBe(sha256(PAYLOAD_V1));
  expect(state.lastSuccessAt).toBeGreaterThanOrEqual(before);
  expect(state.lastSuccessAt).toBeLessThanOrEqual(Date.now());
});

// ============================================================
// S2-1. Drift 안전망 — manifest 대조 → 캐시 버스터 강제 치유
// ============================================================

test('S2-1: manifest와 버전이 어긋나면 캐시 버스터로 강제 재동기화해 치유한다', async ({ context, extensionPage }) => {
  const dbRequests = [];
  const manifestState = { body: null };

  await mockBupApi(context, {
    onDb: (route, req) => {
      const url = req.url();
      dbRequests.push(url);
      // 캐시 버스터가 붙은 요청만 최신(v2)을 반환 — "낡은 CDN 캐시 우회" 시뮬레이션
      if (url.includes('cb=')) {
        return route.fulfill({
          contentType: 'application/json',
          headers: { ETag: '"sync-e2"' },
          body: PAYLOAD_V2,
        });
      }
      if (req.headers()['if-none-match']) {
        return route.fulfill({ status: 304 });
      }
      return route.fulfill({
        contentType: 'application/json',
        headers: { ETag: '"sync-e1"' },
        body: PAYLOAD_V1,
      });
    },
    onManifest: (route) => {
      if (!manifestState.body) return route.fulfill({ status: 404, body: 'not yet' });
      return route.fulfill({ contentType: 'application/json', body: manifestState.body });
    },
  });
  const sw = await getBackground(context);

  // 1차 동기화: v1 (etag 저장됨)
  await forceSync(extensionPage);
  expect((await readLocalState(sw)).localVer).toBe(VER_V1);

  // 서버에 v2 manifest 게시 (built_at은 grace window를 지난 24시간 전)
  manifestState.body = JSON.stringify({
    schema: 1,
    built_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    core: { version: VER_V2, sha256: sha256(PAYLOAD_V2), total: 100_500 },
  });

  // 신선도 검사 발화 — 현재 구현은 이 메시지 타입 자체가 없다
  const result = await verifyFreshness(extensionPage, { force: true });
  expect(result).not.toBeNull();
  expect(result.checked).toBe(true);
  expect(result.drift).toBe(true);
  expect(result.reasons).toContain('version_behind');
  expect(result.healed).toBe(true);

  // 치유 결과: 최신 버전 + 해시 일치
  const state = await readLocalState(sw);
  expect(state.localVer).toBe(VER_V2);
  expect(state.contentHash).toBe(sha256(PAYLOAD_V2));

  // 치유 fetch는 캐시 버스터를 사용했어야 한다
  expect(dbRequests.some((u) => u.includes('cb='))).toBe(true);
});

// ============================================================
// S2-2. 지원 사이트(LLM) 진입 시 신선도 검사 트리거
// ============================================================

test('S2-2: LLM 사이트 진입 시 content script가 신선도 검사를 발화한다', async ({ context }) => {
  let manifestRequested = false;
  await mockBupApi(context, {
    onDb: (route) => route.fulfill({ status: 500, body: 'irrelevant' }),
    onManifest: (route) => {
      manifestRequested = true;
      return route.fulfill({ status: 404, body: 'not found' });
    },
  });

  // 지원 호스트를 모의 페이지로 대체 — content script는 URL 매칭으로 주입된다
  await context.route('https://gemini.google.com/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!DOCTYPE html><html><body><main>모의 LLM 페이지</main></body></html>',
  }));

  const page = await context.newPage();
  await page.goto('https://gemini.google.com/');

  // content script 진입 → VERIFY_DB_FRESHNESS → SW가 manifest를 조회해야 한다
  await expect.poll(() => manifestRequested, { timeout: 15_000 }).toBe(true);
});
