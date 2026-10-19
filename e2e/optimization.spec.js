const { test, expect } = require('./fixtures');
const bundled = require('../extension/data/db.json');
const bundledMeta = require('../extension/data/bupgogae_meta.json');

async function mountController(page, extensionId) {
  await page.evaluate(() => {
    window.module = { exports: {} }; // auto-init 대신 합성 adapter로 제품 controller를 구동
    document.body.innerHTML = '<main id="audit-response"></main>';
  });
  for (const name of ['case-regex', 'precedent-badge', 'bupgogae-content']) {
    await page.addScriptTag({ url: `chrome-extension://${extensionId}/content/${name}.js` });
  }
  await page.evaluate(async () => {
    await window.bupgogaeCaseRegex.initMeta();
    _adapter = {
      findResponseContainers: () => [document.querySelector('#audit-response')],
      getObserverTarget: () => document.querySelector('#audit-response'),
      getObserverOptions: () => ({ childList: true, subtree: true, characterData: true }),
    };
    _showOrangeToast = false;
  });
}

test('OPT-01: 실제 27초 timeout 중 새 mutation을 drain하고 Gray와 Orange를 구별한다', async ({ extensionPage, extensionId }) => {
  await mountController(extensionPage, extensionId);
  await extensionPage.evaluate(() => {
    window.auditLookups = 0;
    chrome.runtime.sendMessage = (message, callback) => {
      if (message.type !== 'LOOKUP_BATCH') return callback?.({});
      window.auditLookups++;
      if (message.keys.includes('89Du1')) return;
      callback(Object.fromEntries(message.keys.map(key => [key, { found: false }])));
    };
    document.querySelector('#audit-response').textContent = '89두1';
    startObserver();
    scheduleProcessing();
  });
  await expect.poll(() => extensionPage.evaluate(() => window.auditLookups)).toBe(1);
  await extensionPage.evaluate(() => {
    const node = document.createElement('p');
    node.id = 'new-response';
    node.textContent = '2015다99999';
    document.querySelector('#audit-response').appendChild(node);
  });
  await expect(extensionPage.locator('#new-response .bgae-orange')).toHaveCount(1, { timeout: 35000 });
  await expect(extensionPage.locator('#audit-response .bgae-gray')).toHaveCount(1);
  await expect(extensionPage.locator('#audit-response .bgae-badge')).toHaveCount(2);
  expect(await extensionPage.evaluate(() => window.auditLookups)).toBe(4);
});

test('OPT-03: 메시지 삭제만으로 pin을 풀고 다음 tooltip이 동작한다', async ({ extensionPage, extensionId }) => {
  await mountController(extensionPage, extensionId);
  await extensionPage.evaluate(() => {
    const root = document.querySelector('#audit-response');
    root.textContent = '89두1';
    window.bupgogae.renderPrecedentBadge(root.firstChild, '89두1', 'green').click();
  });
  await expect(extensionPage.locator('.bgae-global-tooltip')).toHaveClass(/bgae-pinned/);
  await extensionPage.evaluate(() => document.querySelector('#audit-response').remove());
  await expect(extensionPage.locator('.bgae-global-tooltip')).not.toHaveClass(/bgae-pinned/);
  await expect(extensionPage.locator('.bgae-tooltip-content-box')).toBeEmpty();
  await extensionPage.evaluate(() => {
    const root = document.createElement('p');
    root.textContent = '2015다99999';
    document.body.appendChild(root);
    window.bupgogae.renderPrecedentBadge(root.firstChild, root.textContent, 'orange')
      .dispatchEvent(new MouseEvent('mouseenter'));
  });
  await expect(extensionPage.locator('.bgae-global-tooltip')).toHaveClass(/bgae-tooltip-orange/);
});

test('OPT-04: detach 뒤에는 나머지 batch와 timeout retry를 보내지 않는다', async ({ extensionPage, extensionId }) => {
  await mountController(extensionPage, extensionId);
  await extensionPage.evaluate(() => {
    window.auditLookups = 0;
    chrome.runtime.sendMessage = () => { window.auditLookups++; };
    const root = document.querySelector('#audit-response');
    root.textContent = Array.from({ length: 200 }, (_, i) => `2015다${10000 + i}`).join(' ');
    window.auditPending = processContainer(root).then(result => { window.auditResult = result; });
  });
  await expect.poll(() => extensionPage.evaluate(() => window.auditLookups)).toBe(1);
  await extensionPage.evaluate(() => document.querySelector('#audit-response').remove());
  await expect.poll(() => extensionPage.evaluate(() => window.auditResult?.cancelled), { timeout: 10000 }).toBe(true);
  expect(await extensionPage.evaluate(() => window.auditLookups)).toBe(1);
});

test('navigation 후 이전 content realm의 timeout retry가 발화하지 않는다', async ({ extensionPage, extensionId }) => {
  await mountController(extensionPage, extensionId);
  const lookups = [];
  extensionPage.on('console', message => {
    if (message.text() === 'audit-nav-lookup') lookups.push(message.text());
  });
  await extensionPage.evaluate(() => {
    chrome.runtime.sendMessage = () => console.log('audit-nav-lookup');
    document.querySelector('#audit-response').textContent = '89두1';
    void processContainer(document.querySelector('#audit-response'));
  });
  await expect.poll(() => lookups.length).toBe(1);
  await extensionPage.goto(`chrome-extension://${extensionId}/privacy.html`);
  await extensionPage.waitForTimeout(10000); // 원래 8초 timeout + 1초 backoff 이후까지 관찰
  expect(lookups).toHaveLength(1);
  await expect(extensionPage.locator('.bgae-badge')).toHaveCount(0);
});

test('동일 DB에서 SW realm이 재시작돼도 snapshot과 court map이 유지된다', async ({ context, extensionPage }) => {
  const cdp = await context.newCDPSession(extensionPage);
  const versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', event => {
    for (const version of event.versions) versions.set(version.versionId, version);
  });
  await cdp.send('ServiceWorker.enable');
  const sw = context.serviceWorkers()[0];
  await sw.evaluate(() => { globalThis.auditLifetimeMarker = true; });
  await expect.poll(() => [...versions.values()].some(version => version.runningStatus === 'running')).toBe(true);
  const active = [...versions.values()].find(version => version.runningStatus === 'running');
  await cdp.send('ServiceWorker.stopWorker', { versionId: active.versionId });
  const result = await extensionPage.evaluate(() => chrome.runtime.sendMessage({ type: 'LOOKUP_BATCH', keys: ['89Du1'] }));
  expect(result.results['89Du1'].found).toBe(true);
  expect(result.snapshot.version).toBe(bundled.version);
  expect(Object.keys(result.snapshot.courtCodeMap).length).toBeGreaterThan(0);
  expect(await context.serviceWorkers()[0].evaluate(() => globalThis.auditLifetimeMarker)).toBeUndefined();
});

test('profile copy는 test가 쓴 storage를 template에 역전파하지 않는다', async ({ extensionPage }) => {
  const before = await extensionPage.evaluate(() => chrome.storage.local.get('audit_fixture_isolation'));
  expect(before.audit_fixture_isolation).toBeUndefined();
  await extensionPage.evaluate(() => chrome.storage.local.set({ audit_fixture_isolation: 'synthetic-test' }));
});

test('다음 isolated profile에는 이전 test의 storage가 없다', async ({ extensionPage }) => {
  const result = await extensionPage.evaluate(() => chrome.storage.local.get('audit_fixture_isolation'));
  expect(result.audit_fixture_isolation).toBeUndefined();
});

test.describe('cold bundle installation', () => {
  test.use({ freshInstall: true });
  test('profile template 없이 실제 번들 전수 설치와 canonical metadata를 활성화한다', async ({ context }) => {
    const value = await context.serviceWorkers()[0].evaluate(async () => ({
      state: await readLocalSyncState(), meta: await getMetadata(),
    }));
    expect(value.state.physicalTotalCount).toBe(bundled.total);
    expect(value.state.coreCount).toBe(bundled.total);
    expect(value.state.etag).toBeNull();
    expect(value.meta.short_case_keys).toHaveLength(bundledMeta.short_case_keys.length);
  });
});
