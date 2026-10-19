'use strict';

const fs = require('fs');
const path = require('path');
const caseRegex = require('../extension/content/case-regex.js');

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : numerator / denominator;
}

function main() {
  const root = path.join(__dirname, '..');
  const fixtures = JSON.parse(fs.readFileSync(
    path.join(root, 'evaluation', 'extraction-fixtures.json'), 'utf8',
  ));
  const meta = JSON.parse(fs.readFileSync(
    path.join(root, 'extension', 'data', 'bupgogae_meta.json'), 'utf8',
  ));
  caseRegex.__setMetaForTest(
    meta.case_code_map,
    meta.court_code_map,
    meta.short_case_keys,
  );

  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  const failures = [];

  for (const fixture of fixtures.cases) {
    const expected = new Set(fixture.expected);
    const actualValues = caseRegex.extractCaseNumbers(fixture.text).map((item) => item.raw);
    const actual = new Set(actualValues);
    for (const value of actual) {
      if (expected.has(value)) truePositive += 1;
      else falsePositive += 1;
    }
    for (const value of expected) {
      if (!actual.has(value)) falseNegative += 1;
    }
    if (actualValues.length !== actual.size ||
        [...expected].some((value) => !actual.has(value)) ||
        [...actual].some((value) => !expected.has(value))) {
      failures.push({ id: fixture.id, expected: [...expected], actual: actualValues });
    }
  }

  const precision = ratio(truePositive, truePositive + falsePositive);
  const recall = ratio(truePositive, truePositive + falseNegative);
  const result = {
    fixture_schema: fixtures.schema,
    samples: fixtures.cases.length,
    true_positive: truePositive,
    false_positive: falsePositive,
    false_negative: falseNegative,
    precision,
    recall,
    failures,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (precision < fixtures.minimum_precision || recall < fixtures.minimum_recall || failures.length > 0) {
    process.exitCode = 1;
  }
}

main();
