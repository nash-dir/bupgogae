/**
 * sync-utils.js 단위 테스트
 * ─────────────────────────
 * Service Worker에서 분리한 순수 검증·정제 로직 검증.
 * (chrome/IndexedDB 의존 없이 직접 require 가능)
 */
const {
  isValidCssSelector,
  sanitizeAdaptersConfig,
  validateVersionDate,
  validateDbIntegrity,
} = require('../background/sync-utils.js');

describe('isValidCssSelector', () => {
  test('정상 셀렉터 통과', () => {
    expect(isValidCssSelector('div.response > p')).toBe(true);
    expect(isValidCssSelector('[data-message-author-role="assistant"]')).toBe(true);
    expect(isValidCssSelector('.markdown, .prose')).toBe(true);
  });

  test('위험 패턴 차단', () => {
    expect(isValidCssSelector('div:has(script)')).toBe(false);
    expect(isValidCssSelector('background:url(x)')).toBe(false);
    expect(isValidCssSelector('@import "evil"')).toBe(false);
    expect(isValidCssSelector('a[href=javascript:alert(1)]')).toBe(false);
  });

  test('빈 값/비문자열/과길이 거부', () => {
    expect(isValidCssSelector('')).toBe(false);
    expect(isValidCssSelector(null)).toBe(false);
    expect(isValidCssSelector(123)).toBe(false);
    expect(isValidCssSelector('a'.repeat(151))).toBe(false);
    expect(isValidCssSelector('a'.repeat(10), 5)).toBe(false); // maxLen 파라미터
  });

  test('허용 문자 외 문자(한글 등) 거부', () => {
    expect(isValidCssSelector('div.응답')).toBe(false);
  });
});

describe('sanitizeAdaptersConfig', () => {
  test('responseSelectors: 크기 제한 + 무효 셀렉터 제거', () => {
    const config = {
      adapters: {
        chatgpt: {
          responseSelectors: ['.good', 'div:has(x)', '.also-good'],
        },
      },
    };
    sanitizeAdaptersConfig(config, { maxPerSite: 10, maxLen: 150 });
    expect(config.adapters.chatgpt.responseSelectors).toEqual(['.good', '.also-good']);
  });

  test('responseSelectors 배열 크기 maxPerSite로 제한', () => {
    const config = {
      adapters: { x: { responseSelectors: ['.a', '.b', '.c', '.d'] } },
    };
    sanitizeAdaptersConfig(config, { maxPerSite: 2 });
    expect(config.adapters.x.responseSelectors).toEqual(['.a', '.b']);
  });

  test('비배열 responseSelectors는 제거', () => {
    const config = { adapters: { x: { responseSelectors: 'not-array' } } };
    sanitizeAdaptersConfig(config);
    expect(config.adapters.x.responseSelectors).toBeUndefined();
  });

  test('무효 streamingIndicator 제거', () => {
    const config = {
      adapters: { x: { streamingIndicator: 'div:has(loading)' } },
    };
    sanitizeAdaptersConfig(config);
    expect(config.adapters.x.streamingIndicator).toBeUndefined();
  });

  test('scraping_adapters 무효 셀렉터 제거', () => {
    const config = {
      adapters: {},
      scraping_adapters: { site: { title: '.t', body: 'url(evil)' } },
    };
    sanitizeAdaptersConfig(config);
    expect(config.scraping_adapters.site).toEqual({ title: '.t' });
  });

  test('null/array 사이트 설정을 예외 없이 제거하고 사이트 수를 제한', () => {
    const config = {
      adapters: {
        good: { responseSelectors: ['.good'] },
        nullSite: null,
        arraySite: [],
        overflow: { responseSelectors: ['.overflow'] },
      },
      scraping_adapters: { bad: null, good: { title: '.title' } },
    };

    expect(() => sanitizeAdaptersConfig(config, { maxSites: 3 })).not.toThrow();
    expect(config.adapters).toEqual({ good: { responseSelectors: ['.good'] } });
    expect(config.scraping_adapters).toEqual({ good: { title: '.title' } });
  });
});

describe('validateDbIntegrity', () => {
  const goodData = {
    version: '20260101',
    total: 2,
    court_code_map: { '대법원': 1, '헌법재판소': 2 },
    cases: {
      '15Da1': [[1, 1, 230101, 'x']],
      '17HB323': [['D57476', 2, 0, '헌법소원']],
    },
  };

  test('정상 데이터 통과', () => {
    const r = validateDbIntegrity(goodData, { minKeys: 1 });
    expect(r.ok).toBe(true);
    expect(r.keyCount).toBe(2);
  });

  test('cases가 없거나 배열이면 실패', () => {
    expect(validateDbIntegrity(null).ok).toBe(false);
    expect(validateDbIntegrity({}).ok).toBe(false);
    expect(validateDbIntegrity({ ...goodData, cases: [] }).ok).toBe(false);
  });

  test('키 수 하한 미달 실패', () => {
    const r = validateDbIntegrity(goodData, { minKeys: 100 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/하한/);
  });

  test.each([
    ['누락', undefined],
    ['날짜 형식 오류', '2026-01'],
    ['숫자 타입', 20260101],
    ['존재하지 않는 날짜', '20260230'],
    ['월 범위 오류', '20261301'],
    ['비정상 원거리 미래', '99999999'],
  ])('version %s 실패', (_label, version) => {
    expect(validateDbIntegrity({ ...goodData, version })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/version/),
    });
  });

  test('KST 오늘 +1일까지만 허용하고 nowMs를 주입할 수 있다', () => {
    const nowMs = Date.parse('2026-07-20T00:00:00.000Z');
    expect(validateVersionDate('20260721', { nowMs, futureSkewDays: 1 }).ok).toBe(true);
    expect(validateVersionDate('20260722', { nowMs, futureSkewDays: 1 })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/미래/),
    });
    expect(validateDbIntegrity(
      { ...goodData, version: '20260722' },
      { nowMs, futureSkewDays: 1 },
    ).ok).toBe(false);
  });

  test.each([
    ['누락', undefined],
    ['문자열', '2'],
    ['비정수', 2.5],
    ['키 수 불일치', 99],
  ])('total %s 실패', (_label, total) => {
    expect(validateDbIntegrity({ ...goodData, total })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/total/),
    });
  });

  test.each(['not-a-key', '15Da', '../15Da1', 'TX25중'])('압축 키 %s 실패', (key) => {
    const payload = {
      version: '20260101', total: 1,
      court_code_map: { '대법원': 1 },
      cases: { [key]: [[1, 1, 230101, 'x']] },
    };
    expect(validateDbIntegrity(payload).ok).toBe(false);
  });

  test.each([
    ['엔트리 비배열', 'not-array-entry'],
    ['필드 수 부족', [1, 1, 230101]],
    ['serial 형식', ['X1', 1, 230101, 'x']],
    ['courtCode 타입', [1, '1', 230101, 'x']],
    ['decisionDate 타입', [1, 1, '230101', 'x']],
    ['caseName 타입', [1, 1, 230101, null]],
  ])('레코드 %s 실패', (_label, entry) => {
    const payload = {
      version: '20260101', total: 1,
      court_code_map: { '대법원': 1 },
      cases: { '15Da1': [entry] },
    };
    expect(validateDbIntegrity(payload).ok).toBe(false);
  });

  test('모든 레코드를 검사하여 뒤쪽 손상도 차단한다', () => {
    const cases = {};
    for (let i = 1; i <= 7; i++) cases[`15Da${i}`] = [[i, 1, 230101, 'x']];
    cases['15Da7'] = [[7, 1, 230101, 123]];
    expect(validateDbIntegrity({
      version: '20260101', total: 7,
      court_code_map: { '대법원': 1 }, cases,
    }).ok).toBe(false);
  });

  test.each([
    ['누락', undefined],
    ['배열', []],
    ['빈 객체', {}],
    ['0 코드', { '대법원': 0 }],
    ['중복 코드', { '대법원': 1, '헌법재판소': 1 }],
    ['과도한 법원명', { ['가'.repeat(129)]: 1 }],
  ])('court_code_map %s 실패', (_label, courtCodeMap) => {
    expect(validateDbIntegrity({ ...goodData, court_code_map: courtCodeMap }).ok).toBe(false);
  });

  test('레코드의 미등록 법원 코드 참조를 거부하고 unknown 0은 허용한다', () => {
    const unknownReference = {
      version: '20260101', total: 1,
      court_code_map: { '대법원': 1 },
      cases: { '15Da1': [[1, 2, 230101, 'x']] },
    };
    expect(validateDbIntegrity(unknownReference).ok).toBe(false);
    unknownReference.cases['15Da1'][0][1] = 0;
    expect(validateDbIntegrity(unknownReference).ok).toBe(true);
  });

  test('현재 번들 전체 payload와 헌재 D-prefix serial을 전수 검증한다', () => {
    const bundled = require('../data/db.json');
    const result = validateDbIntegrity(bundled, { minKeys: 100_000 });
    expect(result).toEqual({ ok: true, keyCount: bundled.total });
  });
});
