'use strict';

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium, expect, test } = require('@playwright/test');

const CURRENT_EXTENSION_PATH = path.resolve(__dirname, '..', 'extension');
const LEGACY_CASE_KEY = '15Da6302';
const LEGACY_CASE_RECORDS = [[235282, 1, 150521, 'legacy 판결']];
const LEGACY_VERSION = '20260701';
const LEGACY_COURT_MAP = { 대법원: 1 };

const V1_SERVICE_WORKER = String.raw`
const DB_NAME = 'bupgogae';
const DB_VERSION = 1;

let seedInFlight = null;

function seedLegacyDatabase() {
  if (seedInFlight) return seedInFlight;
  seedInFlight = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('cases')) {
        db.createObjectStore('cases');
      }
      if (!db.objectStoreNames.contains('metadata')) {
        db.createObjectStore('metadata');
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['cases', 'metadata'], 'readwrite');
      const cases = tx.objectStore('cases');
      const metadata = tx.objectStore('metadata');
      cases.put([[235282, 1, 150521, 'legacy 판결']], '15Da6302');
      cases.put([[999999, 1, 220101, '두 번째 legacy 판결']], '22Da1');
      metadata.put('20260701', 'local_ver');
      metadata.put(2, 'total_count');
      metadata.put(Date.now(), 'last_success_at');
      metadata.put('2026-07-01T00:00:00.000Z', 'last_synced');
      metadata.put({ '대법원': 1 }, 'court_code_map');
      metadata.put('"legacy-etag"', 'db_etag');
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = async () => {
        db.close();
        await chrome.storage.local.set({ migration_fixture_seeded: true });
        resolve();
      };
    };
  });
  return seedInFlight;
}

chrome.runtime.onInstalled.addListener(() => {
  seedLegacyDatabase().catch(() => {});
});

seedLegacyDatabase().catch(() => {});
`;

async function createV1Extension(extensionPath) {
  await fs.promises.mkdir(extensionPath, { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: 'Bupgogae v1 migration fixture',
    version: '0.8.2',
    permissions: ['storage', 'unlimitedStorage'],
    background: { service_worker: 'background.js' },
  };
  await Promise.all([
    fs.promises.writeFile(
      path.join(extensionPath, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    ),
    fs.promises.writeFile(
      path.join(extensionPath, 'background.js'),
      V1_SERVICE_WORKER,
      'utf8',
    ),
  ]);
}

async function installCurrentExtensionFixture(extensionPath) {
  await fs.promises.rm(extensionPath, { recursive: true, force: true });
  await fs.promises.cp(CURRENT_EXTENSION_PATH, extensionPath, { recursive: true });

  // 저장소의 release version bump와 독립적으로 실제 0.8.2→0.9.0 update
  // lifecycle을 재현한다. 제품 소스의 manifest는 수정하지 않고 임시 복사본만
  // release version으로 고정한다.
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(
    await fs.promises.readFile(manifestPath, 'utf8'),
  );
  manifest.version = '0.9.0';
  await fs.promises.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  // 자동 install/startup sync가 legacy fallback을 A/B snapshot으로 교체하지
  // 못하게 하는 health-invalid 번들이다. 실행 코드는 현재 extension 소스 그대로며,
  // 원격 네트워크도 launch flag와 route로 차단한다.
  const invalidBundle = {
    version: LEGACY_VERSION,
    total: 0,
    keys: 0,
    cases: {},
    court_code_map: {},
  };
  await fs.promises.writeFile(
    path.join(extensionPath, 'data', 'db.json'),
    `${JSON.stringify(invalidBundle)}\n`,
    'utf8',
  );
}

async function launchExtension(userDataDir, extensionPath) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !!process.env.CI,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--host-resolver-rules=MAP api.bup.live 127.0.0.1',
    ],
    serviceWorkers: 'allow',
  });

  await context.route('https://api.bup.live/**', route => route.fulfill({
    status: 503,
    contentType: 'text/plain',
    body: 'migration fixture is hermetic',
  }));
  return context;
}

async function waitForServiceWorker(context, scriptSuffix) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const worker = context.serviceWorkers().find(
      candidate => candidate.url().endsWith(scriptSuffix),
    );
    if (worker) return worker;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`service worker did not start: ${scriptSuffix}`);
}

async function inspectDatabase(worker) {
  return worker.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('bupgogae');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const storeNames = Array.from(db.objectStoreNames);
      const tx = db.transaction(storeNames, 'readonly');
      const result = {
        version: db.version,
        storeNames,
        counts: {},
        legacyRecord: null,
        activeStore: null,
        localVersion: null,
        courtCodeMap: null,
      };

      for (const storeName of ['cases', 'cases_a', 'cases_b']) {
        if (!storeNames.includes(storeName)) continue;
        const countRequest = tx.objectStore(storeName).count();
        countRequest.onsuccess = () => {
          result.counts[storeName] = countRequest.result;
        };
      }

      const legacyRequest = tx.objectStore('cases').get('15Da6302');
      legacyRequest.onsuccess = () => {
        result.legacyRecord = legacyRequest.result ?? null;
      };

      const metadata = tx.objectStore('metadata');
      const activeRequest = metadata.get('active_cases_store');
      const versionRequest = metadata.get('local_ver');
      const courtMapRequest = metadata.get('court_code_map');
      activeRequest.onsuccess = () => {
        result.activeStore = activeRequest.result ?? null;
      };
      versionRequest.onsuccess = () => {
        result.localVersion = versionRequest.result ?? null;
      };
      courtMapRequest.onsuccess = () => {
        result.courtCodeMap = courtMapRequest.result ?? null;
      };

      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
    };
  }));
}

async function lookupLegacyWithSnapshot(worker) {
  return worker.evaluate(key => lookupBatchWithSnapshot([key]), LEGACY_CASE_KEY);
}

test('동일 profile에서 v1 legacy DB를 v2로 비파괴 migration하고 재시작 후 보존한다', async () => {
  test.setTimeout(120_000);

  const sandbox = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'bupgogae-migration-e2e-'),
  );
  const extensionPath = path.join(sandbox, 'extension-under-test');
  const userDataDir = path.join(sandbox, 'chromium-profile');
  let context = null;

  try {
    await createV1Extension(extensionPath);
    context = await launchExtension(userDataDir, extensionPath);
    const v1Worker = await waitForServiceWorker(context, '/background.js');

    await expect.poll(
      () => v1Worker.evaluate(async () => {
        const state = await chrome.storage.local.get('migration_fixture_seeded');
        return state.migration_fixture_seeded === true;
      }),
      { timeout: 20_000 },
    ).toBe(true);

    const beforeUpgrade = await inspectDatabase(v1Worker);
    expect(beforeUpgrade).toMatchObject({
      version: 1,
      storeNames: ['cases', 'metadata'],
      counts: { cases: 2 },
      legacyRecord: LEGACY_CASE_RECORDS,
      activeStore: null,
      localVersion: LEGACY_VERSION,
      courtCodeMap: LEGACY_COURT_MAP,
    });

    await context.close();
    context = null;

    // 소스 경로와 profile 경로를 유지해야 unpacked extension ID와 IndexedDB
    // origin이 동일하다. 이 상태에서 현재 DB_VERSION=2 코드를 재실행한다.
    await installCurrentExtensionFixture(extensionPath);
    context = await launchExtension(userDataDir, extensionPath);
    const v2Worker = await waitForServiceWorker(
      context,
      '/background/db-sync.js',
    );

    const migratedLookup = await lookupLegacyWithSnapshot(v2Worker);
    expect(migratedLookup).toEqual({
      results: {
        [LEGACY_CASE_KEY]: {
          found: true,
          data: LEGACY_CASE_RECORDS,
        },
      },
      snapshot: {
        storeName: 'cases',
        version: LEGACY_VERSION,
        courtCodeMap: LEGACY_COURT_MAP,
      },
    });

    const afterUpgrade = await inspectDatabase(v2Worker);
    expect(afterUpgrade).toMatchObject({
      version: 2,
      storeNames: ['cases', 'cases_a', 'cases_b', 'metadata'],
      counts: { cases: 2, cases_a: 0, cases_b: 0 },
      legacyRecord: LEGACY_CASE_RECORDS,
      activeStore: null,
      localVersion: LEGACY_VERSION,
      courtCodeMap: LEGACY_COURT_MAP,
    });

    await context.close();
    context = null;

    context = await launchExtension(userDataDir, extensionPath);
    const restartedWorker = await waitForServiceWorker(
      context,
      '/background/db-sync.js',
    );

    const restartedLookup = await lookupLegacyWithSnapshot(restartedWorker);
    expect(restartedLookup).toEqual(migratedLookup);
    expect(await inspectDatabase(restartedWorker)).toMatchObject(afterUpgrade);
  } finally {
    if (context) await context.close();
    await fs.promises.rm(sandbox, { recursive: true, force: true });
  }
});
