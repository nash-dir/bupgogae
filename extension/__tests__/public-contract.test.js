const corpus = require('../../pipeline/fixtures/public-payload-contract.json');
const { validateDbIntegrity, deriveShortCaseKeys } = require('../background/sync-utils');

test.each(corpus.samples)('shared payload contract: $name', (sample) => {
  const payload = JSON.parse(JSON.stringify(corpus.base));
  for (const key of ['version', 'keys', 'cases']) {
    if (Object.hasOwn(sample, key)) payload[key] = sample[key];
  }
  for (const [key, index] of [['serial', 0], ['courtCode', 1], ['title', 3]]) {
    if (Object.hasOwn(sample, key)) Object.values(payload.cases)[0][0][index] = sample[key];
  }
  if (sample.omitKeys) delete payload.keys;
  expect(validateDbIntegrity(payload, { minKeys: 1 }).ok).toBe(sample.valid);
});

test('shared exact four-character canonical derivation', () => {
  const { keys, caseCodeMap, expected } = corpus.canonical;
  expect(deriveShortCaseKeys(keys, caseCodeMap)).toEqual(expected);
});
