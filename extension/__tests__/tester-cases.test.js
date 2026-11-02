const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const caseRegex = require('../content/case-regex');
const metadata = require('../data/bupgogae_meta.json');
const bundle = require('../data/db.json');
const fixture = require('../../evaluation/standard-tester.json');
const { evaluateStandardTester } = require('../../scripts/evaluate-standard-tester');
const repository = path.resolve(__dirname, '../..');

describe('user-supplied QA table: requested expectations versus product observations', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date(fixture.validationAsOf));
    caseRegex.__setMetaForTest(metadata.case_code_map, metadata.court_code_map,
      metadata.short_case_keys);
  });
  afterEach(() => {
    caseRegex.__resetMetaForTest();
    jest.useRealTimers();
  });

  test('the reusable original prompt preserves all ten original labels and expectations', () => {
    const prompt = fs.readFileSync(path.join(__dirname, '../../evaluation', fixture.originalPrompt), 'utf8');
    for (const sample of fixture.cases) {
      expect(prompt).toContain(`| ${sample.row} | ${sample.raw} | ${sample.requested.classification} | ${sample.requested.expectation} |`);
    }
    expect(caseRegex.extractCaseNumbers(prompt).map(item => item.raw))
      .toEqual(fixture.cases.map(sample => sample.raw));
  });

  test('all recorded observations match the current extraction, validation and bundle lookup', () => {
    const report = evaluateStandardTester(path.join(repository, 'extension'));
    expect(report.rows.map(row => row.raw)).toEqual(fixture.cases.map(sample => sample.raw));
    expect(report.rows.filter(row => !row.passed)).toEqual([]);
    expect(report.passed).toBe(fixture.cases.length);
    expect(report.failed).toBe(0);
  });

  test('the CLI evaluates an explicit unpacked extension path', () => {
    const extension = path.join(repository, 'extension');
    for (const args of [['--extension-path', extension], [extension]]) {
      const child = spawnSync(process.execPath, [path.join(repository, 'scripts/evaluate-standard-tester.js'),
        ...args], { encoding: 'utf8' });
      expect(child.status).toBe(0);
      const report = JSON.parse(child.stdout);
      expect(report.total).toBe(10);
      expect(report.failed).toBe(0);
      expect(report.snapshot.version).toBe(bundle.version);
      expect(report.snapshot.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('the CLI exits nonzero when a selected snapshot loses an expected record', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bupgogae-standard-tester-mismatch-'));
    try {
      fs.mkdirSync(path.join(folder, 'content'));
      fs.mkdirSync(path.join(folder, 'data'));
      fs.copyFileSync(path.join(repository, 'extension/content/case-regex.js'), path.join(folder, 'content/case-regex.js'));
      fs.copyFileSync(path.join(repository, 'extension/data/bupgogae_meta.json'), path.join(folder, 'data/bupgogae_meta.json'));
      const changed = { ...bundle, cases: { ...bundle.cases } };
      delete changed.cases['16Do10912'];
      fs.writeFileSync(path.join(folder, 'data/db.json'), JSON.stringify(changed));
      const child = spawnSync(process.execPath, [path.join(repository, 'scripts/evaluate-standard-tester.js'),
        '--extension-path', folder], { encoding: 'utf8' });
      expect(child.status).toBe(1);
      const report = JSON.parse(child.stdout);
      expect(report.failed).toBe(1);
      expect(report.rows[0].mismatches).toEqual(['badge', 'records']);
      expect(report.snapshotMatchesRecorded).toBe(false);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
