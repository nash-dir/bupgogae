/**
 * sync-utils.js 단위 테스트
 * ─────────────────────────
 * Service Worker에서 분리한 순수 검증·정제 로직 검증.
 * (chrome/IndexedDB 의존 없이 직접 require 가능)
 */
const {
  isValidCssSelector,
  sanitizeAdaptersConfig,
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
});

describe('validateDbIntegrity', () => {
  const goodData = {
    version: '20260101',
    total: 2,
    cases: { '15Da1': [[1, 1, 230101, 'x']], '16Du2': [[2, 1, 240101, 'y']] },
  };

  test('정상 데이터 통과', () => {
    const r = validateDbIntegrity(goodData, { minKeys: 1 });
    expect(r.ok).toBe(true);
    expect(r.keyCount).toBe(2);
  });

  test('cases 없으면 실패', () => {
    expect(validateDbIntegrity(null).ok).toBe(false);
    expect(validateDbIntegrity({}).ok).toBe(false);
  });

  test('키 수 하한 미달 실패', () => {
    const r = validateDbIntegrity(goodData, { minKeys: 100 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/하한/);
  });

  test('version 형식 오류 실패', () => {
    const r = validateDbIntegrity({ ...goodData, version: '2026-01' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/version/);
  });

  test('total ≠ keyCount 실패', () => {
    const r = validateDbIntegrity({ ...goodData, total: 99 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/total/);
  });

  test('레코드 구조 불량 실패', () => {
    const bad = { cases: { '15Da1': 'not-array' } };
    expect(validateDbIntegrity(bad).ok).toBe(false);
    const bad2 = { cases: { '15Da1': [] } };
    expect(validateDbIntegrity(bad2).ok).toBe(false);
    const bad3 = { cases: { '15Da1': ['not-array-entry'] } };
    expect(validateDbIntegrity(bad3).ok).toBe(false);
  });
});
