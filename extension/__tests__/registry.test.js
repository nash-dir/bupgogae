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
  (0, eval)(code);
}

describe('registry SITE_DEFS 파생', () => {
  let adapters;

  beforeAll(() => {
    loadScript('content/adapters/base-adapter.js');
    loadScript('content/adapters/registry.js');
    adapters = window.bupgogaeAdapters;
  });

  test('ADAPTER_MAP: 9개 호스트 매핑', () => {
    expect(Object.keys(adapters.ADAPTER_MAP)).toHaveLength(9);
    expect(adapters.ADAPTER_MAP['chatgpt.com']).toBe('ChatGPTAdapter');
    expect(adapters.ADAPTER_MAP['claude.ai']).toBe('ClaudeAdapter');
    expect(adapters.ADAPTER_MAP['copilot.com']).toBe('CopilotAdapter');
    expect(adapters.ADAPTER_MAP['copilot.cloud.microsoft']).toBe('CopilotAdapter');
    expect(adapters.ADAPTER_MAP['copilot.microsoft.com']).toBe('CopilotAdapter');
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
    // ADAPTER_MAP은 9개 호스트이지만, Perplexity가 2개, Copilot이 3개 → 어댑터 기준 6개
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

  test('원격 streamingIndicator 문법 오류는 전체 스캔을 깨지 않고 번들로 후퇴', () => {
    const inst = new adapters.GeminiAdapter();
    inst.setBundledConfig({
      responseSelectors: [],
      streamingIndicator: '.bundled-streaming',
    });
    inst.setRemoteConfig({
      version: 'test',
      adapters: { gemini: { streamingIndicator: 'div[' } },
    });
    const parent = document.createElement('div');
    parent.className = 'bundled-streaming';
    const container = document.createElement('div');
    parent.appendChild(container);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => inst.isStreaming(container)).not.toThrow();
    expect(inst.isStreaming(container)).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});


describe('six-site response DOM contracts', () => {
  const config = require('../data/adapters.json');
  const fixtures = [
    ['GeminiAdapter', '<model-response><message-content id="answer">89두1</message-content></model-response>'],
    ['ChatGPTAdapter', '<ol data-conversation-transcript><li data-message-role="assistant" data-message-complete id="answer">89두1</li></ol>'],
    ['ClaudeAdapter', '<div data-testid="chat-message-content" id="answer">89두1</div>'],
    ['CopilotAdapter', '<div class="group/assistant" id="answer">89두1</div>'],
    ['PerplexityAdapter', '<div class="prose" id="answer">89두1</div>'],
    ['GrokAdapter', '<div class="markdown" id="answer">89두1</div>'],
  ];
  afterEach(() => { document.body.innerHTML = ''; });
  test.each(fixtures)('%s finds a reply despite stale remote selectors and excludes the prompt', (name, html) => {
    document.body.innerHTML = '<main><div data-message-role="user"><div class="prose markdown" data-testid="chat-message-content">2016도10912</div></div>' + html + '<textarea>2026헌가1</textarea></main>';
    const instance = new window.bupgogaeAdapters[name]();
    instance.setBundledConfig(config.adapters[instance.siteId]);
    instance.setRemoteConfig({ adapters: { [instance.siteId]: { responseSelectors: ['.stale-selector', 'main'] } } });
    expect(instance.findResponseContainers().map(e => e.id)).toEqual(['answer']);
  });
  test('work Copilot selects the assistant article and rejects a user prose match', () => {
    const instance = new window.bupgogaeAdapters.CopilotAdapter();
    instance.setBundledConfig(config.adapters.copilot);
    instance.setRemoteConfig({ adapters: { copilot: { responseSelectors: ['.prose'] } } });
    document.body.innerHTML = '<div role="article" aria-labelledby="user-message-a-title user-message-a"><div class="prose">89두1</div></div><div id="answer" role="article" aria-labelledby="copilot-message-b-title copilot-message-b">2016도10912</div>';
    expect(instance.findResponseContainers().map(e => e.id)).toEqual(['answer']);
  });
  test('ChatGPT complete marker and character-data stream use the same reply container', () => {
    const instance = new window.bupgogaeAdapters.ChatGPTAdapter();
    instance.setBundledConfig(config.adapters.chatgpt);
    document.body.innerHTML = '<li data-message-role="assistant">89두</li>';
    const reply = instance.findResponseContainers()[0];
    expect(instance.isStreaming(reply)).toBe(true);
    reply.firstChild.data += '1';
    reply.setAttribute('data-message-complete', '');
    expect(instance.findResponseContainers()).toEqual([reply]);
    expect(instance.isStreaming(reply)).toBe(false);
    expect(instance.getObserverOptions().attributeFilter).toContain('data-message-complete');
    reply.replaceWith(reply.cloneNode(true));
    expect(instance.findResponseContainers()[0]).not.toBe(reply);
  });
  test('logged-in ChatGPT search-unit markers select only the assistant despite stale remote prose', () => {
    const instance = new window.bupgogaeAdapters.ChatGPTAdapter();
    instance.setBundledConfig(config.adapters.chatgpt);
    instance.setRemoteConfig({ adapters: { chatgpt: { responseSelectors: ['.markdown.prose'] } } });
    document.body.innerHTML = '<main><div data-talvt-turn-state="complete"><div data-chatgpt-search-unit-key="fallback-turn-0:0:user"><div class="markdown prose">89두1</div></div><div id="answer" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant"><h4 data-conversation-role="assistant">ChatGPT 답변:</h4><table><tbody><tr><td>2016도10912</td></tr></tbody></table></div></div></main>';
    expect(instance.findResponseContainers().map(e => e.id)).toEqual(['answer']);
    expect(instance.getObserverOptions().attributeFilter).toContain('data-chatgpt-search-unit-key');
    document.querySelector('#answer').setAttribute('data-chatgpt-search-unit-key', 'fallback-turn-0:1:user');
    expect(instance.findResponseContainers()).toEqual([]);
  });
});
