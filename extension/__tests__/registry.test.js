/**
 * registry.js 단위 테스트
 * ───────────────────────
 * SITE_DEFS 단일 소스에서 ADAPTER_MAP / 어댑터 클래스 / 표시명이
 * 올바르게 파생되는지 검증한다.
 *
 * registry.js는 module.exports 없이 window 전역에만 부착하므로,
 * 파일 내용을 읽어 jsdom 전역 스코프에서 평가한다.
 */
const fs = require('fs');
const path = require('path');

function loadScript(rel) {
  const code = fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8');
  // 간접 eval → 전역 스코프 실행 (window.bupgogaeAdapters에 부착됨)
  (0, eval)(code); // eslint-disable-line no-eval
}

describe('registry SITE_DEFS 파생', () => {
  let adapters;

  beforeAll(() => {
    loadScript('content/adapters/base-adapter.js');
    loadScript('content/adapters/registry.js');
    adapters = window.bupgogaeAdapters;
  });

  test('ADAPTER_MAP: 7개 호스트 매핑', () => {
    expect(Object.keys(adapters.ADAPTER_MAP)).toHaveLength(7);
    expect(adapters.ADAPTER_MAP['chatgpt.com']).toBe('ChatGPTAdapter');
    expect(adapters.ADAPTER_MAP['claude.ai']).toBe('ClaudeAdapter');
    // perplexity는 호스트 2개가 같은 어댑터로
    expect(adapters.ADAPTER_MAP['perplexity.ai']).toBe('PerplexityAdapter');
    expect(adapters.ADAPTER_MAP['www.perplexity.ai']).toBe('PerplexityAdapter');
  });

  test('어댑터 클래스가 siteId/displayName getter를 제공', () => {
    const inst = new adapters.GeminiAdapter();
    expect(inst.siteId).toBe('gemini');
    expect(inst.displayName).toBe('Google Gemini');
  });

  test('getSupportedSites: 어댑터별 중복 없이 표시명 반환', () => {
    const sites = adapters.getSupportedSites();
    // ADAPTER_MAP은 7개 호스트이지만, Perplexity가 2개 → 어댑터 기준 6개
    expect(sites).toHaveLength(6);
    // 중복이 없는지 확인
    const names = sites.map(s => s.adapterName);
    expect(new Set(names).size).toBe(names.length);
    const chatgpt = sites.find(s => s.hostname === 'chatgpt.com');
    expect(chatgpt).toMatchObject({
      hostname: 'chatgpt.com',
      displayName: 'ChatGPT',
      adapterName: 'ChatGPTAdapter',
    });
  });

  test('모든 매핑된 클래스가 레지스트리에 등록됨', () => {
    for (const className of Object.values(adapters.ADAPTER_MAP)) {
      expect(typeof adapters[className]).toBe('function');
    }
  });
});
