const { createHash } = require('node:crypto');
const { test, expect } = require('./fixtures');
// Python regression asserts this artifact equals the real source -> master export.
const merged = require('../pipeline/fixtures/merged-420836-export.json');

test('병합 원문 하나의 5개 키를 같은 검증 snapshot에서 모두 조회한다', async ({ context, extensionPage }) => {
  const cases = {};
  for (let n = 1; n <= 100_500; n++) cases[`00Da${n}`] = [[n, 1, 200101, '합성 표본']];
  Object.assign(cases, merged);
  const shifted = new Date(Date.now() + 9 * 3600 * 1000);
  const version = shifted.toISOString().slice(0, 10).replaceAll('-', '');
  const body = JSON.stringify({
    version, total: Object.keys(cases).length, keys: Object.keys(cases).length,
    cases, court_code_map: { '대법원': 1, '서울행정법원': 30 },
  });
  const hash = createHash('sha256').update(body).digest('hex');
  const manifest = JSON.stringify({
    schema: 1, contract: 'v0.9.0', built_at: new Date().toISOString(),
    core: { version, sha256: hash, total: Object.keys(cases).length, bytes_raw: Buffer.byteLength(body) },
  });
  await context.route('https://api.bup.live/**', (route) => {
    const url = route.request().url();
    if (url.includes('/manifest-v0.9.0.json')) return route.fulfill({ contentType: 'application/json', body: manifest });
    if (url.includes('/db-v0.9.0.json.gz')) return route.fulfill({ contentType: 'application/json', body });
    if (url.includes('/adapters.json')) return route.fulfill({ contentType: 'application/json', body: '{"adapters":{}}' });
    return route.fulfill({ status: 404, body: 'not found' });
  });
  const sync = await extensionPage.evaluate(() => new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'FORCE_SYNC' }, resolve);
  }));
  expect(sync.success).toBe(true);
  const reply = await extensionPage.evaluate(keys => new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'LOOKUP_BATCH', keys }, resolve);
  }), Object.keys(merged));
  expect(reply.error).toBeUndefined();
  for (const key of Object.keys(merged)) {
    expect(reply.results[key].found).toBe(true);
    expect(reply.results[key].data).toEqual(merged[key]);
  }
  expect(reply.snapshot.version).toBe(version);
});
