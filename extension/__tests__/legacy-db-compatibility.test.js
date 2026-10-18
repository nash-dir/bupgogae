/** Frozen production-baseline consumers: never update these with the new client. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const legacy = require('./fixtures/legacy-0.8.2/sync-utils.cjs');
const legacyRegex = require('./fixtures/legacy-0.8.2/case-regex.cjs');
const provenance = require('./fixtures/legacy-0.8.2/provenance.json');
const oldMeta = require('./fixtures/legacy-0.8.2/meta.json');
const newMeta = require('../data/bupgogae_meta.json');
const db = require('../data/db.json');
const { validateDbIntegrity } = require('../background/sync-utils');

test('legacy consumer fixtures retain their pinned production source bytes', () => {
  for (const [name, { sha256 }] of Object.entries(provenance.files)) {
    const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/legacy-0.8.2', name));
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
  }
});

test('one release DB passes both legacy and current validation without weakening either', () => {
  expect(legacy.validateDbIntegrity(db, { minKeys: 100000 }).ok).toBe(true);
  expect(validateDbIntegrity(db, { minKeys: 100000 }).ok).toBe(true);
  const bytes = Buffer.from(JSON.stringify(db));
  const manifest = { schema: 1, built_at: new Date().toISOString(), core: {
    version: db.version, total: Object.keys(db.cases).length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes_raw: bytes.length,
    object_path: `objects/${crypto.createHash('sha256').update(bytes).digest('hex')}.json.gz`,
  } };
  expect(legacy.validateManifest(manifest).ok).toBe(true);
});

test('existing case codecs and court identities cannot be reassigned', () => {
  for (const [code, codec] of Object.entries(oldMeta.case_code_map)) {
    if (Object.hasOwn(newMeta.case_code_map, code)) expect(newMeta.case_code_map[code]).toBe(codec);
  }
  for (const [court, code] of Object.entries(oldMeta.court_code_map)) {
    if (Object.hasOwn(db.court_code_map, court)) expect(db.court_code_map[court]).toBe(code);
  }
});

test('the recovered 2016도10912 is reachable by the frozen legacy extractor and codec', () => {
  legacyRegex.__setMetaForTest(oldMeta.case_code_map, { ...oldMeta.court_code_map, ...db.court_code_map });
  try {
    const matches = legacyRegex.extractCaseNumbers('2016도10912');
    const keys = matches.map(match => legacyRegex.compressCaseKey(match.parsed || match));
    expect(keys).toContain('16Do10912');
    expect(db.cases['16Do10912'].some(record => record[0] === 206264)).toBe(true);
  } finally {
    legacyRegex.__resetMetaForTest();
  }
});
