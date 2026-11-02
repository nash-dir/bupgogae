'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function evaluateStandardTester(extensionPath) {
  const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname,
    '../evaluation/standard-tester.json'), 'utf8'));
  const root = path.resolve(extensionPath);
  const caseRegex = require(path.join(root, 'content/case-regex.js'));
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'data/bupgogae_meta.json'), 'utf8'));
  const bytes = fs.readFileSync(path.join(root, 'data/db.json'));
  const bundle = JSON.parse(bytes);
  caseRegex.__setMetaForTest(metadata.case_code_map, metadata.court_code_map,
    metadata.short_case_keys);
  const rows = fixture.cases.map(sample => {
    const matches = caseRegex.extractCaseNumbers(sample.raw);
    const parsed = matches[0];
    const verdict = parsed ? caseRegex.validateCaseNumber(parsed) : null;
    const key = parsed ? caseRegex.compressCaseKey(parsed) : null;
    const records = key ? bundle.cases[key] || [] : [];
    const actual = {
      extracted: matches.length === 1 && parsed.raw === sample.raw,
      valid: verdict ? verdict.valid : false,
      key,
      badge: !parsed ? 'none' : !verdict.valid ? 'red' : records.length ? 'green' : 'orange',
      records,
    };
    const mismatches = Object.keys(sample.expected).filter(field =>
      JSON.stringify(actual[field]) !== JSON.stringify(sample.expected[field]));
    return { row: sample.row, raw: sample.raw, expected: sample.expected,
      actual, validationReason: verdict?.reason || null,
      passed: mismatches.length === 0, mismatches };
  });
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    fixtureSchema: fixture.schema,
    extensionPath: root,
    snapshot: { version: bundle.version, keys: Object.keys(bundle.cases).length, sha256 },
    recordedSnapshot: fixture.recordedBundle,
    snapshotMatchesRecorded: sha256 === fixture.recordedBundle.sha256,
    interpretation: 'The tester checks extraction, validation and local DB lookup. Badge is derived from those results; the renderer and service DOM are not exercised. Orange is a local DB miss, not a determination that a case does not exist. Green does not validate the narrative attached to an identifier.',
    total: rows.length,
    passed: rows.filter(row => row.passed).length,
    failed: rows.filter(row => !row.passed).length,
    rows,
  };
}

function main(args) {
  let extensionPath = path.resolve(__dirname, '../extension');
  if (args.length) {
    // PowerShell's npm.ps1 can consume a forwarded named option; support the
    // directory itself as a positional argument as well as the explicit flag.
    if (args.length === 1 && !args[0].startsWith('--')) {
      extensionPath = path.resolve(args[0]);
    } else if (args.length === 2 && args[0] === '--extension-path' && args[1]) {
      extensionPath = path.resolve(args[1]);
    } else {
      throw new Error('Usage: node scripts/evaluate-standard-tester.js [--extension-path <unpacked-extension-directory>]');
    }
  }
  const result = evaluateStandardTester(extensionPath);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Standard tester failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { evaluateStandardTester };
