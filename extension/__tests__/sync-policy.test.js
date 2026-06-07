/**
 * 동기화 정책 순수 함수 명세 (SDD) — sync-utils.js 확장 API
 * ================================================================
 * 0.8.0 "DB 2달 정체" 사고의 재발 방지 로직을 순수 함수로 명세한다.
 * db-sync.js는 이 함수들의 판정 결과만 따르고, 판정 자체는 여기서 검증한다.
 *
 * [명세 계약]
 *
 * buildFetchPlan(local, nowMs, opts) → { conditional: boolean, reasons: string[] }
 *   조건부 요청(If-None-Match)은 "로컬이 건강하고 최근 성공 이력이 있을 때"만 허용.
 *   local: { etag, lastSuccessAt, localVer, coreCount }
 *   opts:  { watchdogMs, minCoreKeys }
 *   불허 사유(reasons): 'no_etag' | 'no_local_version' | 'local_db_unhealthy'
 *                        | 'no_success_record' | 'watchdog_expired'
 *
 * shouldLoadBundled(bundledVersion, local) → { load: boolean, reason: string }
 *   번들 폴백은 "빈 DB를 채우거나 더 최신일 때"만. 절대 다운그레이드 금지.
 *   local: { localVer, coreCount }
 *   reason: 'local_empty' | 'no_local_version' | 'bundled_newer' | 'bundled_not_newer'
 *
 * validateManifest(m) → { ok: boolean, error?: string }
 *   원격 manifest 엄격 스키마 검증. 검증 실패한 manifest는 어떤 행동도 유발하면 안 됨.
 *
 * evaluateDrift(manifest, local, nowMs, opts) → { action, reasons: string[] }
 *   action: 'none' | 'defer' | 'backoff' | 'force_sync'
 *   local: { localVer, contentHash, coreCount, strikes }
 *   opts:  { graceMs, maxStrikes }
 *   판정 우선순위: backoff(strike 초과) > defer(grace window/미래 built_at)
 *                  > force_sync(version_behind | no_local_version | hash_mismatch | count_mismatch)
 *                  > none (local_ahead 포함 — 클라이언트가 더 최신이면 절대 강제 동기화 금지)
 *
 * appendLedger(ledger, entry, max) → 새 배열 (최신순, max 초과분 절삭, 입력 불변)
 */

const {
  buildFetchPlan,
  shouldLoadBundled,
  validateManifest,
  evaluateDrift,
  appendLedger,
} = require('../background/sync-utils.js');

const HOUR = 3600 * 1000;
const NOW = 1_780_000_000_000; // 고정 기준 시각

// ============================================================
// 1. buildFetchPlan — 304 가드 + 워치독
// ============================================================

describe('buildFetchPlan', () => {
  const OPTS = { watchdogMs: 48 * HOUR, minCoreKeys: 100_000 };
  const healthy = {
    etag: '"e1"',
    lastSuccessAt: NOW - 1 * HOUR,
    localVer: '20260601',
    coreCount: 150_000,
  };

  test('건강한 로컬 + 최근 성공 → 조건부 요청 허용', () => {
    const plan = buildFetchPlan(healthy, NOW, OPTS);
    expect(plan.conditional).toBe(true);
    expect(plan.reasons).toEqual([]);
  });

  test('etag 없음 → 무조건 fetch (no_etag)', () => {
    const plan = buildFetchPlan({ ...healthy, etag: null }, NOW, OPTS);
    expect(plan.conditional).toBe(false);
    expect(plan.reasons).toContain('no_etag');
  });

  test('로컬 버전 없음 → 무조건 fetch (no_local_version)', () => {
    const plan = buildFetchPlan({ ...healthy, localVer: null }, NOW, OPTS);
    expect(plan.conditional).toBe(false);
    expect(plan.reasons).toContain('no_local_version');
  });

  test('코어 건수 0 (304 트랩 시나리오: etag는 있는데 DB는 빔) → 무조건 fetch', () => {
    const plan = buildFetchPlan({ ...healthy, coreCount: 0 }, NOW, OPTS);
    expect(plan.conditional).toBe(false);
    expect(plan.reasons).toContain('local_db_unhealthy');
  });

  test('코어 건수가 하한 미달 (부분 삽입 잔해) → 무조건 fetch', () => {
    const plan = buildFetchPlan({ ...healthy, coreCount: 99_999 }, NOW, OPTS);
    expect(plan.conditional).toBe(false);
    expect(plan.reasons).toContain('local_db_unhealthy');
  });

  test('성공 이력 자체가 없음 (구버전에서 업그레이드) → 무조건 fetch', () => {
    const plan = buildFetchPlan({ ...healthy, lastSuccessAt: null }, NOW, OPTS);
    expect(plan.conditional).toBe(false);
    expect(plan.reasons).toContain('no_success_record');
  });

  test('마지막 성공이 48시간 초과 (워치독) → 무조건 fetch', () => {
    const plan = buildFetchPlan(
      { ...healthy, lastSuccessAt: NOW - 49 * HOUR }, NOW, OPTS);
    expect(plan.conditional).toBe(false);
    expect(plan.reasons).toContain('watchdog_expired');
  });

  test('워치독 경계: 정확히 48시간 미만이면 조건부 허용', () => {
    const plan = buildFetchPlan(
      { ...healthy, lastSuccessAt: NOW - 47 * HOUR }, NOW, OPTS);
    expect(plan.conditional).toBe(true);
  });

  test('복수 사유는 모두 수집된다', () => {
    const plan = buildFetchPlan(
      { etag: null, lastSuccessAt: null, localVer: null, coreCount: 0 }, NOW, OPTS);
    expect(plan.conditional).toBe(false);
    expect(plan.reasons).toEqual(expect.arrayContaining(
      ['no_etag', 'no_local_version', 'local_db_unhealthy', 'no_success_record']));
  });
});

// ============================================================
// 2. shouldLoadBundled — 번들 폴백 다운그레이드 금지
// ============================================================

describe('shouldLoadBundled', () => {
  test('로컬 DB가 비어있으면 번들 로드 허용 (최초 부트스트랩)', () => {
    const d = shouldLoadBundled('20260321', { localVer: null, coreCount: 0 });
    expect(d.load).toBe(true);
  });

  test('로컬 버전이 없으면 번들 로드 허용', () => {
    const d = shouldLoadBundled('20260321', { localVer: null, coreCount: 500 });
    expect(d.load).toBe(true);
  });

  test('번들이 로컬보다 오래되면 로드 금지 — 0.8.0 사고의 핵심 (다운그레이드 금지)', () => {
    const d = shouldLoadBundled('20260321', { localVer: '20260601', coreCount: 150_000 });
    expect(d.load).toBe(false);
    expect(d.reason).toBe('bundled_not_newer');
  });

  test('번들과 로컬이 같은 버전이면 로드 금지 (불필요한 전체 교체 방지)', () => {
    const d = shouldLoadBundled('20260601', { localVer: '20260601', coreCount: 150_000 });
    expect(d.load).toBe(false);
  });

  test('번들이 로컬보다 최신이면 로드 허용', () => {
    const d = shouldLoadBundled('20260701', { localVer: '20260601', coreCount: 150_000 });
    expect(d.load).toBe(true);
    expect(d.reason).toBe('bundled_newer');
  });

  test('번들 버전이 YYYYMMDD 형식이 아니면(예: "bundled") 빈 DB에만 허용', () => {
    expect(shouldLoadBundled('bundled', { localVer: '20260601', coreCount: 150_000 }).load).toBe(false);
    expect(shouldLoadBundled('bundled', { localVer: null, coreCount: 0 }).load).toBe(true);
  });
});

// ============================================================
// 3. validateManifest — 원격 입력 엄격 검증
// ============================================================

describe('validateManifest', () => {
  const VALID = {
    schema: 1,
    built_at: '2026-06-06T03:12:45Z',
    core: {
      version: '20260606',
      sha256: 'a'.repeat(64),
      total: 214_233,
    },
  };

  test('유효한 manifest 통과', () => {
    expect(validateManifest(VALID).ok).toBe(true);
  });

  test('tax 항목이 있으면 같은 스키마로 검증 — 유효하면 통과', () => {
    const m = { ...VALID, tax: { version: '20260606', sha256: 'b'.repeat(64), total: 31_204 } };
    expect(validateManifest(m).ok).toBe(true);
  });

  test.each([
    ['null', null],
    ['schema 불일치', { ...VALID, schema: 2 }],
    ['core 없음', { schema: 1, built_at: VALID.built_at }],
    ['version 형식 오류 (대시 포함)', { ...VALID, core: { ...VALID.core, version: '2026-06-06' } }],
    ['sha256 길이 오류', { ...VALID, core: { ...VALID.core, sha256: 'abc' } }],
    ['sha256 비 hex 문자', { ...VALID, core: { ...VALID.core, sha256: 'z'.repeat(64) } }],
    ['total 0', { ...VALID, core: { ...VALID.core, total: 0 } }],
    ['total 음수', { ...VALID, core: { ...VALID.core, total: -1 } }],
    ['total 비정수', { ...VALID, core: { ...VALID.core, total: 1.5 } }],
    ['total 상한 초과', { ...VALID, core: { ...VALID.core, total: 10_000_001 } }],
    ['built_at 파싱 불가', { ...VALID, built_at: 'not-a-date' }],
    ['tax 형식 불량', { ...VALID, tax: { version: 'bad' } }],
  ])('거부: %s', (_label, m) => {
    expect(validateManifest(m).ok).toBe(false);
  });
});

// ============================================================
// 4. evaluateDrift — 드리프트 판정 + 폭주 방지
// ============================================================

describe('evaluateDrift', () => {
  const OPTS = { graceMs: 2 * HOUR, maxStrikes: 3 };
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);

  /** built_at이 24시간 전인 (grace 통과) manifest */
  const manifest = (over = {}) => ({
    schema: 1,
    built_at: new Date(NOW - 24 * HOUR).toISOString(),
    core: { version: '20260606', sha256: HASH_A, total: 150_000, ...over },
  });

  const local = (over = {}) => ({
    localVer: '20260606',
    contentHash: HASH_A,
    coreCount: 150_000,
    strikes: 0,
    ...over,
  });

  test('버전·해시·건수 모두 일치 → none', () => {
    const v = evaluateDrift(manifest(), local(), NOW, OPTS);
    expect(v.action).toBe('none');
  });

  test('로컬 버전이 뒤처짐 → force_sync (version_behind)', () => {
    const v = evaluateDrift(manifest(), local({ localVer: '20260321' }), NOW, OPTS);
    expect(v.action).toBe('force_sync');
    expect(v.reasons).toContain('version_behind');
  });

  test('로컬 버전 없음 → force_sync (no_local_version)', () => {
    const v = evaluateDrift(manifest(), local({ localVer: null, coreCount: 0 }), NOW, OPTS);
    expect(v.action).toBe('force_sync');
    expect(v.reasons).toContain('no_local_version');
  });

  test('같은 버전인데 해시 불일치 (CDN이 낡은 본문을 줬던 경우) → force_sync', () => {
    const v = evaluateDrift(manifest(), local({ contentHash: HASH_B }), NOW, OPTS);
    expect(v.action).toBe('force_sync');
    expect(v.reasons).toContain('hash_mismatch');
  });

  test('같은 버전·같은 해시인데 건수 불일치 (부분 삽입 잔해) → force_sync', () => {
    const v = evaluateDrift(manifest(), local({ coreCount: 87_123 }), NOW, OPTS);
    expect(v.action).toBe('force_sync');
    expect(v.reasons).toContain('count_mismatch');
  });

  test('해시 미기록 (구버전 업그레이드 직후) + 버전·건수 일치 → none (해시 검사 스킵)', () => {
    const v = evaluateDrift(manifest(), local({ contentHash: null }), NOW, OPTS);
    expect(v.action).toBe('none');
  });

  test('manifest가 grace window(2h) 이내에 갓 게시됨 → defer (CDN 전파 대기)', () => {
    const m = manifest();
    m.built_at = new Date(NOW - 0.5 * HOUR).toISOString();
    const v = evaluateDrift(m, local({ localVer: '20260321' }), NOW, OPTS);
    expect(v.action).toBe('defer');
  });

  test('built_at이 미래 (시계 스큐) → defer', () => {
    const m = manifest();
    m.built_at = new Date(NOW + 5 * HOUR).toISOString();
    const v = evaluateDrift(m, local({ localVer: '20260321' }), NOW, OPTS);
    expect(v.action).toBe('defer');
  });

  test('strike 한도 도달 → backoff (드리프트가 있어도 자가치유 중단)', () => {
    const v = evaluateDrift(manifest(), local({ localVer: '20260321', strikes: 3 }), NOW, OPTS);
    expect(v.action).toBe('backoff');
  });

  test('로컬이 manifest보다 최신 (게시 레이스) → none — 절대 다운그레이드 동기화 금지', () => {
    const v = evaluateDrift(manifest(), local({ localVer: '20260701' }), NOW, OPTS);
    expect(v.action).toBe('none');
    expect(v.reasons).toContain('local_ahead');
  });
});

// ============================================================
// 5. appendLedger — 동기화 시도 원장
// ============================================================

describe('appendLedger', () => {
  test('빈 원장에 추가', () => {
    const out = appendLedger([], { ts: 1, outcome: 'replaced' }, 20);
    expect(out).toEqual([{ ts: 1, outcome: 'replaced' }]);
  });

  test('최신 항목이 맨 앞', () => {
    const out = appendLedger([{ ts: 1 }], { ts: 2 }, 20);
    expect(out[0]).toEqual({ ts: 2 });
  });

  test('max 초과분은 절삭', () => {
    const ledger = Array.from({ length: 20 }, (_, i) => ({ ts: i }));
    const out = appendLedger(ledger, { ts: 99 }, 20);
    expect(out).toHaveLength(20);
    expect(out[0]).toEqual({ ts: 99 });
  });

  test('입력 배열을 변이하지 않는다', () => {
    const ledger = [{ ts: 1 }];
    appendLedger(ledger, { ts: 2 }, 20);
    expect(ledger).toEqual([{ ts: 1 }]);
  });

  test('비배열 입력은 빈 원장으로 취급', () => {
    const out = appendLedger(undefined, { ts: 1 }, 20);
    expect(out).toEqual([{ ts: 1 }]);
  });
});
