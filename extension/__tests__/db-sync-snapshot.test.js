/**
 * IndexedDB snapshot/single-flight 회귀 테스트.
 * 실제 db-sync.js를 fake IndexedDB와 Service Worker API mock 위에서 실행한다.
 */
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { createHash, webcrypto } = require('crypto');
const { TextEncoder, TextDecoder } = require('util');

function eventTarget() {
  return { addListener: jest.fn() };
}

function makeChromeStorage() {
  const state = {};
  return {
    state,
    api: {
      async get(keys) {
        if (keys == null) return { ...state };
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(requested.map((key) => [key, state[key]]));
      },
      async set(items) { Object.assign(state, items); },
      async remove(keys) {
        for (const key of (Array.isArray(keys) ? keys : [keys])) delete state[key];
      },
    },
  };
}

function loadDbSync() {
  jest.resetModules();
  const storage = makeChromeStorage();
  global.indexedDB = new IDBFactory();
  global.IDBKeyRange = IDBKeyRange;
  Object.defineProperty(global, 'crypto', { value: webcrypto, configurable: true });
  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder;
  global.structuredClone = (value) => JSON.parse(JSON.stringify(value));
  if (typeof global.AbortSignal.timeout !== 'function') {
    global.AbortSignal.timeout = () => new AbortController().signal;
  }
  global.importScripts = () => {
    Object.assign(global, require('../background/sync-utils.js'));
  };
  global.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      onInstalled: eventTarget(),
      onStartup: eventTarget(),
      onMessage: eventTarget(),
      lastError: null,
    },
    alarms: { create: jest.fn(), get: jest.fn(), onAlarm: eventTarget() },
    storage: { local: storage.api, onChanged: eventTarget() },
    tabs: {
      query: jest.fn(), get: jest.fn(), sendMessage: jest.fn(),
      onUpdated: eventTarget(), onActivated: eventTarget(),
    },
    action: { setBadgeText: jest.fn(), setBadgeBackgroundColor: jest.fn() },
    commands: { onCommand: eventTarget() },
  };

  return { sync: require('../background/db-sync.js'), storage };
}

async function seedLegacy(sync, values, version = '20260101') {
  const db = await sync.openDB();
  await sync.dbBulkInsert(db, sync.constants.STORE_CASES_LEGACY, values, 1);
  await sync.dbPut(db, sync.constants.STORE_META, 'local_ver', version);
  return db;
}

function metadata(version, totalCount) {
  return { version, totalCount, contentHash: 'a'.repeat(64), lastSuccessAt: 1 };
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function manifestForPayload(payload, payloadText = JSON.stringify(payload)) {
  return {
    schema: 1,
    built_at: '2020-01-01T00:00:00.000Z',
    core: {
      version: payload.version,
      sha256: sha256(payloadText),
      total: payload.total,
    },
  };
}

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value };
}

function requiredAdapters() {
  return Object.fromEntries(
    ['gemini', 'chatgpt', 'claude', 'copilot', 'perplexity', 'grok']
      .map((siteId) => [siteId, {}]),
  );
}

describe('dual-store snapshot installation', () => {
  let sync;

  beforeEach(() => {
    ({ sync } = loadDbSync());
  });

  afterEach(() => {
    sync.resetConnectionForTest();
    delete global.fetch;
    delete global.importScripts;
    delete global.validateDbIntegrity;
  });

  test('staging 중간 예외가 나면 기존 snapshot이 그대로 조회된다', async () => {
    const db = await seedLegacy(sync, {
      a: [['old-a']],
      b: [['old-b']],
    });

    await expect(sync.stageAndActivateSnapshot(db, {
      a: [['new-a']],
      b: [['new-b']],
    }, metadata('20260202', 2), {
      chunkSize: 1,
      afterChunk: ({ inserted }) => {
        if (inserted === 1) throw new Error('injected staging failure');
      },
    })).rejects.toThrow('injected staging failure');

    expect(await sync.getActiveStoreName(db)).toBe(sync.constants.STORE_CASES_LEGACY);
    expect(await sync.lookupBatch(['a', 'b'])).toEqual({
      a: { found: true, data: [['old-a']] },
      b: { found: true, data: [['old-b']] },
    });
  });

  test('pointer 전환 전후의 한 batch에서 구·신 snapshot이 섞이지 않는다', async () => {
    const db = await seedLegacy(sync, {
      a: [['old-a']],
      b: [['old-b']],
    });
    let during;

    await sync.stageAndActivateSnapshot(db, {
      a: [['new-a']],
      b: [['new-b']],
    }, metadata('20260202', 2), {
      chunkSize: 1,
      afterChunk: async ({ inserted }) => {
        if (inserted === 1) during = await sync.lookupBatch(['a', 'b']);
      },
    });

    expect(during).toEqual({
      a: { found: true, data: [['old-a']] },
      b: { found: true, data: [['old-b']] },
    });
    expect(await sync.lookupBatch(['a', 'b'])).toEqual({
      a: { found: true, data: [['new-a']] },
      b: { found: true, data: [['new-b']] },
    });
  });

  test('전환 후 Service Worker 연결을 다시 열어도 새 snapshot을 선택한다', async () => {
    const db = await seedLegacy(sync, { a: [['old']] });
    await sync.stageAndActivateSnapshot(
      db, { a: [['new']] }, metadata('20260202', 1), { chunkSize: 1 },
    );

    sync.resetConnectionForTest();

    expect(await sync.lookupCase('a')).toEqual({ found: true, data: [['new']] });
    expect((await sync.getSyncStatus()).localVer).toBe('20260202');
  });

  test('v1 legacy cases store는 복사 없이 비파괴적으로 계속 조회된다', async () => {
    await seedLegacy(sync, { legacy: [['preserved']] }, '20251231');
    sync.resetConnectionForTest();

    expect(await sync.lookupCase('legacy')).toEqual({
      found: true,
      data: [['preserved']],
    });
  });

  test('첫 v2 snapshot 전환 뒤에도 기존 v1 legacy rows를 보존한다', async () => {
    const db = await seedLegacy(sync, {
      legacyA: [['v1-a']],
      legacyB: [['v1-b']],
    }, '20251231');

    await sync.stageAndActivateSnapshot(
      db,
      { current: [['v2']] },
      metadata('20260202', 1),
      { chunkSize: 1 },
    );

    expect(await sync.getActiveStoreName(db)).toBe(sync.constants.STORE_CASES_A);
    expect(await sync.dbGet(db, sync.constants.STORE_CASES_LEGACY, 'legacyA'))
      .toEqual([['v1-a']]);
    expect(await sync.dbGet(db, sync.constants.STORE_CASES_LEGACY, 'legacyB'))
      .toEqual([['v1-b']]);
  });
});

describe('syncDatabase single-flight', () => {
  let sync;
  let storage;

  beforeEach(() => {
    ({ sync, storage } = loadDbSync());
  });

  afterEach(() => {
    sync.resetConnectionForTest();
    delete global.fetch;
    delete global.importScripts;
    delete global.validateDbIntegrity;
  });

  test('동시 호출자는 같은 Promise/결과를 공유하고 DB fetch·install은 한 번만 수행한다', async () => {
    const payload = {
      version: '20260202',
      total: 2,
      cases: { a: [['new-a']], b: [['new-b']] },
    };
    const payloadText = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(payloadText);
    let releaseFetch;
    const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
    let dbFetches = 0;

    // 작은 fixture에서도 실제 install 경로를 실행하도록 무결성 결과만 대체한다.
    global.validateDbIntegrity = jest.fn(() => ({ ok: true, keyCount: 2 }));
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('/manifest.json')) {
        return jsonResponse(manifestForPayload(payload, payloadText));
      }
      if (url.startsWith(sync.constants.DB_URL)) {
        dbFetches += 1;
        await fetchGate;
        let delivered = false;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: (name) => name.toLowerCase() === 'etag' ? '"etag-1"' : null },
          body: {
            getReader: () => ({
              async read() {
                if (delivered) return { done: true, value: undefined };
                delivered = true;
                return { done: false, value: bytes };
              },
              cancel: jest.fn(),
            }),
          },
        };
      }
      return jsonResponse({ version: '1', adapters: {} });
    });

    const first = sync.syncDatabase({ trigger: 'drift', force: true });
    const second = sync.syncDatabase({ trigger: 'force', force: true });
    const third = sync.syncDatabase({ trigger: 'alarm' });

    expect(second).toBe(first);
    expect(third).toBe(first);
    releaseFetch();
    const results = await Promise.all([first, second, third]);

    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
    expect(results[0]).toMatchObject({ success: true, outcome: 'replaced', version: '20260202' });
    expect(dbFetches).toBe(1);
    expect(await sync.lookupBatch(['a', 'b'])).toEqual({
      a: { found: true, data: [['new-a']] },
      b: { found: true, data: [['new-b']] },
    });
  });

  test('manifest core.object_path가 있으면 same-origin immutable object를 fetch한다', async () => {
    const payload = {
      version: '20260202',
      total: 1,
      cases: { a: [['immutable']] },
    };
    const payloadText = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(payloadText);
    const hash = sha256(payloadText);
    const objectUrl = `https://api.bup.live/bupgogae/objects/${hash}.json.gz`;
    global.validateDbIntegrity = jest.fn(() => ({ ok: true, keyCount: 1 }));
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('/manifest.json')) {
        const manifest = manifestForPayload(payload, payloadText);
        manifest.core.object_path = `objects/${hash}.json.gz`;
        return jsonResponse(manifest);
      }
      if (String(url) === objectUrl) {
        let delivered = false;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: { getReader: () => ({
            async read() {
              if (delivered) return { done: true, value: undefined };
              delivered = true;
              return { done: false, value: bytes };
            },
            cancel: jest.fn(),
          }) },
        };
      }
      return jsonResponse({ version: '2026-07-20', adapters: { chatgpt: {} } });
    });

    await expect(sync.syncDatabase({ trigger: 'alarm' })).resolves.toMatchObject({
      success: true,
      outcome: 'replaced',
    });
    expect(global.fetch).toHaveBeenCalledWith(objectUrl, expect.any(Object));
    expect(await sync.lookupCase('a')).toEqual({ found: true, data: [['immutable']] });
  });

  test('정상 스키마여도 원격 버전이 낮으면 active snapshot을 downgrade하지 않는다', async () => {
    await seedLegacy(sync, { a: [['local-newer']] }, '20260303');
    const payload = {
      version: '20260202',
      total: 1,
      cases: { a: [['remote-older']] },
    };
    const payloadText = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(payloadText);
    global.validateDbIntegrity = jest.fn(() => ({ ok: true, keyCount: 1 }));
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('/manifest.json')) {
        return jsonResponse(manifestForPayload(payload, payloadText));
      }
      if (url.startsWith(sync.constants.DB_URL)) {
        let delivered = false;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => null },
          body: { getReader: () => ({
            async read() {
              if (delivered) return { done: true, value: undefined };
              delivered = true;
              return { done: false, value: bytes };
            },
            cancel: jest.fn(),
          }) },
        };
      }
      return jsonResponse({ adapters: {} });
    });

    const result = await sync.syncDatabase({ trigger: 'drift', force: true });

    expect(result).toMatchObject({
      success: true,
      outcome: 'downgrade_blocked',
      version: '20260303',
    });
    expect(await sync.lookupCase('a')).toEqual({
      found: true,
      data: [['local-newer']],
    });
  });

  test('새 DB가 먼저 게시되고 manifest가 이전 commit이면 기존 snapshot을 보존한다', async () => {
    await seedLegacy(sync, { a: [['preserved']] }, '20260201');
    const payload = {
      version: '20260202',
      total: 1,
      cases: { a: [['unexpected']] },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    global.validateDbIntegrity = jest.fn(() => ({ ok: true, keyCount: 1 }));
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('/manifest.json')) {
        // publisher가 DB PUT에는 성공했지만 manifest PUT 전/실패 상태인 게시 레이스.
        return jsonResponse({
          schema: 1,
          built_at: '2020-01-01T00:00:00.000Z',
          core: { version: '20260201', sha256: 'b'.repeat(64), total: 1 },
        });
      }
      if (url.startsWith(sync.constants.DB_URL)) {
        let delivered = false;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: { getReader: () => ({
            async read() {
              if (delivered) return { done: true, value: undefined };
              delivered = true;
              return { done: false, value: bytes };
            },
            cancel: jest.fn(),
          }) },
        };
      }
      if (url.startsWith('chrome-extension://test/')) return { ok: false };
      return jsonResponse({ adapters: {} });
    });

    const result = await sync.syncDatabase({ trigger: 'alarm' });

    expect(result).toMatchObject({
      success: false,
      outcome: 'integrity_failed',
      reason: expect.stringMatching(/manifest hash 불일치/),
    });
    expect(await sync.lookupCase('a')).toEqual({ found: true, data: [['preserved']] });
    expect(global.fetch).toHaveBeenCalledWith(
      `${sync.constants.DB_URL}?cb=${'b'.repeat(64)}`,
      expect.any(Object),
    );
  });

  test('manifest를 사용할 수 없으면 DB URL을 요청하지 않고 기존 snapshot을 보존한다', async () => {
    await seedLegacy(sync, { a: [['preserved']] }, '20260201');
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('/manifest.json')) return { ok: false, status: 503 };
      if (String(url).startsWith('chrome-extension://test/')) return { ok: false };
      if (String(url).includes('/adapters.json')) return jsonResponse({ adapters: {} });
      throw new Error(`DB must not be fetched without a manifest: ${url}`);
    });

    await expect(sync.syncDatabase({ trigger: 'alarm' })).resolves.toMatchObject({
      success: false,
      outcome: 'fetch_failed',
      reason: expect.stringMatching(/manifest HTTP 503/),
    });
    expect(global.fetch.mock.calls.some(([url]) => String(url).startsWith(sync.constants.DB_URL)))
      .toBe(false);
    expect(await sync.lookupCase('a')).toEqual({ found: true, data: [['preserved']] });
  });

  test('v1 전역 metadata/ETag 갱신이 stale A/B를 정상으로 가장하지 못한다', async () => {
    const db = await seedLegacy(sync, { legacy: [['v1-old']] }, '20260101');
    await sync.stageAndActivateSnapshot(
      db,
      { a: [['stale-a']] },
      {
        version: '20260201', totalCount: 1,
        contentHash: 'a'.repeat(64), lastSuccessAt: Date.now(), etag: '"a"',
      },
      { chunkSize: 1 },
    );

    const payload = { version: '20260202', total: 1, cases: { a: [['fresh']] } };
    const payloadText = JSON.stringify(payload);
    const payloadHash = sha256(payloadText);
    const bytes = new TextEncoder().encode(payloadText);

    // 구 v1이 legacy rows와 전역 metadata만 갱신하고 A/B pointer를 모르는 상황.
    await sync.dbPut(db, sync.constants.STORE_META, 'local_ver', payload.version);
    await sync.dbPut(db, sync.constants.STORE_META, 'content_hash', payloadHash);
    await sync.dbPut(db, sync.constants.STORE_META, 'last_success_at', Date.now());
    await storage.api.set({ bupgogae_etag: '"v1-new"' });

    let dbHeaders;
    global.validateDbIntegrity = jest.fn(() => ({ ok: true, keyCount: 1 }));
    global.fetch = jest.fn(async (url, opts) => {
      if (String(url).includes('/manifest.json')) {
        return jsonResponse(manifestForPayload(payload, payloadText));
      }
      if (String(url).startsWith(sync.constants.DB_URL)) {
        dbHeaders = opts.headers;
        let delivered = false;
        return {
          ok: true,
          status: 200,
          headers: { get: () => '"v2-fresh"' },
          body: { getReader: () => ({
            async read() {
              if (delivered) return { done: true, value: undefined };
              delivered = true;
              return { done: false, value: bytes };
            },
            cancel: jest.fn(),
          }) },
        };
      }
      return jsonResponse({ version: '2026-07-20', adapters: { chatgpt: {} } });
    });

    await expect(sync.syncDatabase({ trigger: 'startup' })).resolves.toMatchObject({
      success: true,
      outcome: 'replaced',
      version: '20260202',
    });
    expect(dbHeaders).not.toHaveProperty('If-None-Match');
    expect(await sync.lookupCase('a')).toEqual({ found: true, data: [['fresh']] });
  });

  test('빈 로컬 상태의 무조건부 304는 fetch 실패로 처리하고 번들로 복구한다', async () => {
    const bundled = {
      version: '20260101',
      total: 1,
      cases: { '15Da1': [[1, 1, 230101, 'bundled']] },
    };
    let dbFetches = 0;
    global.validateDbIntegrity = jest.fn(() => ({ ok: true, keyCount: 1 }));
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('/manifest.json')) {
        return jsonResponse({
          schema: 1,
          built_at: '2020-01-01T00:00:00.000Z',
          core: { version: '20260202', sha256: 'a'.repeat(64), total: 1 },
        });
      }
      if (url.startsWith(sync.constants.DB_URL)) {
        dbFetches += 1;
        return { ok: false, status: 304, statusText: 'Not Modified' };
      }
      if (url.startsWith('chrome-extension://test/')) {
        return { ok: true, json: async () => bundled };
      }
      return jsonResponse({ adapters: {} });
    });

    const result = await sync.syncDatabase({ trigger: 'alarm' });

    expect(result).toMatchObject({
      success: false,
      outcome: 'fetch_failed',
      reason: expect.stringMatching(/조건 없는 요청.*304/),
    });
    expect(dbFetches).toBe(1);
    expect(await sync.lookupCase('15Da1')).toEqual({
      found: true,
      data: [[1, 1, 230101, 'bundled']],
    });
    expect((await sync.getSyncStatus()).localVer).toBe('20260101');
  });
});

describe('remote helper observability and outage coalescing', () => {
  let sync;
  let storage;

  beforeEach(() => {
    ({ sync, storage } = loadDbSync());
  });

  afterEach(() => {
    sync.resetConnectionForTest();
    delete global.fetch;
    delete global.importScripts;
    delete global.validateDbIntegrity;
  });

  test('어댑터 HTTP 실패를 success:false로 정직하게 반환한다', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));

    await expect(sync.fetchAdaptersConfig()).resolves.toEqual({
      success: false,
      outcome: 'fetch_failed',
      error: 'HTTP 503',
    });
    expect(storage.state.bupgogae_remote_adapters).toBeUndefined();
  });

  test('과대/과다/불량 어댑터 설정은 기존 저장값을 보존한다', async () => {
    const preserved = { version: '2026-07-19', adapters: { kept: {} } };
    await storage.api.set({ bupgogae_remote_adapters: preserved });

    global.fetch = jest.fn(async () => ({
      ok: true,
      headers: { get: () => String(300 * 1024) },
    }));
    await expect(sync.fetchAdaptersConfig()).resolves.toMatchObject({
      success: false,
      outcome: 'invalid_payload',
    });
    await storage.api.remove('bupgogae_adapter_sync_state');

    const tooManySites = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`site${index}`, {}]),
    );
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2026-07-20', adapters: tooManySites }),
    }));
    await expect(sync.fetchAdaptersConfig()).resolves.toMatchObject({
      success: false,
      outcome: 'invalid_payload',
      error: expect.stringMatching(/사이트 수/),
    });
    await storage.api.remove('bupgogae_adapter_sync_state');

    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2026-07-20', adapters: { broken: null } }),
    }));
    await expect(sync.fetchAdaptersConfig()).resolves.toMatchObject({
      success: false,
      outcome: 'invalid_payload',
      error: expect.stringMatching(/설정 객체/),
    });
    expect(storage.state.bupgogae_remote_adapters).toBe(preserved);
  });

  test('동시 어댑터 요청은 같은 fetch와 결과를 공유한다', async () => {
    let releaseFetch;
    const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
    global.fetch = jest.fn(async () => {
      await fetchGate;
      return {
        ok: true,
        headers: { get: () => '"adapter-v1"' },
        json: async () => ({ version: '2026-07-20', adapters: requiredAdapters() }),
      };
    });

    const first = sync.fetchAdaptersConfig();
    const second = sync.fetchAdaptersConfig();
    expect(second).toBe(first);
    releaseFetch();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toBe(firstResult);
    expect(firstResult).toEqual({
      success: true,
      outcome: 'updated',
      version: '2026-07-20',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('유효한 adapter LKG의 ETag는 조건부 요청과 안전한 304에 사용한다', async () => {
    const config = { version: '2026-07-20', adapters: requiredAdapters() };
    await storage.api.set({
      bupgogae_remote_adapters: config,
      bupgogae_adapter_sync_state: {
        lastAttemptAt: 0,
        lastSuccessAt: 1,
        etag: '"adapter-etag"',
        version: config.version,
      },
    });
    global.fetch = jest.fn(async () => ({ ok: false, status: 304 }));

    await expect(sync.fetchAdaptersConfig()).resolves.toEqual({
      success: true,
      outcome: 'not_modified',
      version: config.version,
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/adapters\.json$/),
      expect.objectContaining({
        headers: expect.objectContaining({ 'If-None-Match': '"adapter-etag"' }),
      }),
    );
    expect(storage.state.bupgogae_remote_adapters).toBe(config);
  });

  test('어댑터 outage 실패도 영속 cooldown으로 순차 탭 재시도를 막는다', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));

    await expect(sync.fetchAdaptersConfig()).resolves.toMatchObject({
      success: false,
      outcome: 'fetch_failed',
    });
    await expect(sync.fetchAdaptersConfig()).resolves.toMatchObject({
      success: true,
      outcome: 'throttled',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(storage.state.bupgogae_adapter_sync_state.lastAttemptAt)
      .toEqual(expect.any(Number));
  });

  test('빈 설정과 낮은 version은 adapter LKG를 덮어쓰지 않는다', async () => {
    const preserved = { version: '2026-07-20', adapters: { kept: {} } };
    await storage.api.set({ bupgogae_remote_adapters: preserved });

    global.fetch = jest.fn(async () => jsonResponse({
      version: '2026-07-19', adapters: requiredAdapters(),
    }));
    await expect(sync.fetchAdaptersConfig()).resolves.toEqual({
      success: true,
      outcome: 'downgrade_blocked',
      version: '2026-07-20',
    });
    expect(storage.state.bupgogae_remote_adapters).toBe(preserved);

    await storage.api.remove('bupgogae_adapter_sync_state');
    global.fetch = jest.fn(async () => jsonResponse({
      version: '2026-07-20', adapters: {},
    }));
    await expect(sync.fetchAdaptersConfig()).resolves.toMatchObject({
      success: false,
      outcome: 'invalid_payload',
      error: expect.stringMatching(/빈 adapters/),
    });
    expect(storage.state.bupgogae_remote_adapters).toBe(preserved);
  });

  test('필수 known-site가 빠진 adapter config는 LKG를 덮어쓰지 않는다', async () => {
    const preserved = { version: '2026-07-19', adapters: requiredAdapters() };
    await storage.api.set({ bupgogae_remote_adapters: preserved });
    global.fetch = jest.fn(async () => jsonResponse({
      version: '2026-07-20',
      adapters: { chatgpt: {} },
    }));

    await expect(sync.fetchAdaptersConfig()).resolves.toMatchObject({
      success: false,
      outcome: 'invalid_payload',
      error: expect.stringMatching(/필수 adapter 누락/),
    });
    expect(storage.state.bupgogae_remote_adapters).toBe(preserved);
  });

  test('manifest outage 검사들은 single-flight를 공유하고 실패 시각도 throttle한다', async () => {
    let releaseFetch;
    const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
    let manifestFetches = 0;
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('/manifest.json')) {
        manifestFetches += 1;
        await fetchGate;
        return { ok: false, status: 503 };
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const first = sync.verifyDbFreshness('content');
    const second = sync.verifyDbFreshness('content');
    expect(second).toBe(first);

    releaseFetch();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toBe(firstResult);
    expect(firstResult).toMatchObject({
      checked: false,
      skipped: 'manifest_unavailable',
    });
    expect(manifestFetches).toBe(1);
    expect(storage.state.bupgogae_drift_state.lastCheckAt).toEqual(expect.any(Number));

    await expect(sync.verifyDbFreshness('another_page')).resolves.toMatchObject({
      checked: false,
      skipped: 'throttled',
    });
    expect(manifestFetches).toBe(1);
  });

  test('manifest 응답은 64KiB 상한을 넘으면 파싱하지 않는다', async () => {
    const json = jest.fn();
    global.fetch = jest.fn(async () => ({
      ok: true,
      headers: { get: () => String(65 * 1024) },
      json,
    }));

    await expect(sync.verifyDbFreshness('oversized_manifest', { force: true }))
      .resolves.toMatchObject({
        checked: false,
        skipped: 'manifest_invalid',
      });
    expect(json).not.toHaveBeenCalled();
  });

  test('법제처 fetch는 timeout/redirect 정책과 5MiB body 상한을 적용한다', async () => {
    const html = '<html>판례</html>';
    const bytes = new TextEncoder().encode(html);
    global.fetch = jest.fn(async () => {
      let delivered = false;
      return {
        ok: true,
        url: 'https://www.law.go.kr/precInfoP.do?precSeq=1',
        headers: { get: () => null },
        body: { getReader: () => ({
          async read() {
            if (delivered) return { done: true, value: undefined };
            delivered = true;
            return { done: false, value: bytes };
          },
          cancel: jest.fn(),
        }) },
      };
    });

    await expect(sync.fetchLawHtml('https://www.law.go.kr/precInfoP.do?precSeq=1'))
      .resolves.toBe(html);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://www.law.go.kr/precInfoP.do?precSeq=1',
      expect.objectContaining({ redirect: 'error', signal: expect.any(Object) }),
    );

    global.fetch = jest.fn(async () => ({
      ok: true,
      url: 'https://www.law.go.kr/large',
      headers: { get: () => String(6 * 1024 * 1024) },
    }));
    await expect(sync.fetchLawHtml('https://www.law.go.kr/large'))
      .rejects.toThrow(/응답 크기 초과/);

    global.fetch = jest.fn(async () => ({
      ok: true,
      url: 'https://evil.example/redirected',
      headers: { get: () => null },
      text: async () => html,
    }));
    await expect(sync.fetchLawHtml('https://www.law.go.kr/redirect'))
      .rejects.toThrow(/Cross-host redirect blocked/);
  });

  test('법제처 fetch는 Content-Length가 없어도 실제 body 상한을 집행한다', async () => {
    const chunks = [new Uint8Array(3 * 1024 * 1024), new Uint8Array(3 * 1024 * 1024)];
    global.fetch = jest.fn(async () => ({
      ok: true,
      url: 'https://www.law.go.kr/large-stream',
      headers: { get: () => null },
      body: { getReader: () => ({
        read: jest.fn(async () => chunks.length > 0
          ? { done: false, value: chunks.shift() }
          : { done: true, value: undefined }),
        cancel: jest.fn(),
      }) },
    }));

    await expect(sync.fetchLawHtml('https://www.law.go.kr/large-stream'))
      .rejects.toThrow(/응답 크기 초과/);
  });

  test('같은 날짜 버전 재게시의 drift 치유는 manifest hash를 cache buster로 쓴다', async () => {
    const db = await seedLegacy(sync, {
      '15Da1': [[1, 1, 230101, 'old']],
    }, '20260202');
    await sync.dbPut(db, sync.constants.STORE_META, 'content_hash', 'a'.repeat(64));
    await sync.dbPut(db, sync.constants.STORE_META, 'last_success_at', Date.now());

    const payload = {
      version: '20260202',
      total: 1,
      cases: { '15Da1': [[1, 1, 230101, 'republished']] },
    };
    const payloadText = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(payloadText);
    const payloadHash = createHash('sha256').update(payloadText).digest('hex');
    const dbUrls = [];
    global.validateDbIntegrity = jest.fn(() => ({ ok: true, keyCount: 1 }));
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('/manifest.json')) {
        return {
          ok: true,
          json: async () => ({
            schema: 1,
            built_at: '2020-01-01T00:00:00.000Z',
            core: { version: '20260202', sha256: payloadHash, total: 1 },
          }),
        };
      }
      if (String(url).startsWith(sync.constants.DB_URL)) {
        dbUrls.push(String(url));
        let delivered = false;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => null },
          body: { getReader: () => ({
            async read() {
              if (delivered) return { done: true, value: undefined };
              delivered = true;
              return { done: false, value: bytes };
            },
            cancel: jest.fn(),
          }) },
        };
      }
      return { ok: true, json: async () => ({ adapters: {} }) };
    });

    const result = await sync.verifyDbFreshness('same_day_republish', { force: true });

    expect(result).toMatchObject({
      checked: true,
      drift: true,
      reasons: expect.arrayContaining(['hash_mismatch']),
      healed: true,
    });
    expect(dbUrls).toEqual([
      `${sync.constants.DB_URL}?cb=${payloadHash}`,
    ]);
    expect(await sync.lookupCase('15Da1')).toEqual({
      found: true,
      data: [[1, 1, 230101, 'republished']],
    });
  });
});
