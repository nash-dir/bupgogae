const fs = require('fs');
const path = require('path');
const caseRegex = require('../content/case-regex.js');
require('../content/precedent-badge.js');
const source = fs.readFileSync(path.join(__dirname, '../content/bupgogae-content.js'), 'utf8');

describe('category filter storage changes', () => {
  let harness;
  let change;
  let article;

  beforeEach(async () => {
    jest.useFakeTimers();
    document.body.replaceChildren();
    article = document.createElement('article');
    article.textContent = '2015다6302 및 2020헌마123';
    const draft = document.createElement('textarea');
    draft.value = '아직 전송하지 않은 질문';
    document.body.append(article, draft);
    draft.focus();
    caseRegex.__setMetaForTest({ 다: 'Da', 헌마: 'HeonMa' }, { 대법원: 1 }, []);
    jest.spyOn(window.bupgogaeCaseRegex, 'initMeta').mockResolvedValue();
    chrome.storage.local.get.mockResolvedValue({});
    chrome.tabs = { reload: jest.fn() };
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'LOOKUP_BATCH') {
        callback(Object.fromEntries(message.keys.map(key => [key, { found: false }])));
      } else callback({ enabled: true });
    });
    window.bupgogaeAdapters = { initAdapters: async () => ({
      displayName: 'test', siteId: 'test', findResponseContainers: () => [article],
      getObserverTarget: () => document.body, getObserverOptions: () => ({ childList: true, subtree: true }),
    }) };
    harness = new Function('module', `${source}\nreturn {
      init, processContainer,
      stop() { pauseProcessing(); _observer?.disconnect(); }
    };`)({ exports: {} });
    await harness.init();
    change = chrome.storage.onChanged.addListener.mock.calls[0][0];
  });

  afterEach(() => {
    harness.stop();
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete window.bupgogaeAdapters;
  });

  test('updates existing and future badges without replacing the page, draft or focus', async () => {
    await harness.processContainer(article);
    expect(article.querySelectorAll('.bgae-badge')).toHaveLength(2);
    const draft = document.querySelector('textarea');
    change({ bupgogae_filter_court: { newValue: false } }, 'local');
    await jest.advanceTimersByTimeAsync(2500);
    expect([...article.querySelectorAll('.bgae-badge')].map(b => b.textContent)).toEqual(['2020헌마123']);
    expect(article.textContent).toBe('2015다6302 및 2020헌마123');
    expect(document.activeElement).toBe(draft);
    expect(draft.value).toBe('아직 전송하지 않은 질문');
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
    change({ bupgogae_filter_court: { newValue: true }, bupgogae_filter_constitutional: { newValue: false } }, 'local');
    await jest.advanceTimersByTimeAsync(2500);
    expect([...article.querySelectorAll('.bgae-badge')].map(b => b.textContent)).toEqual(['2015다6302']);
  });

  test('an in-flight lookup cannot restore a disabled category', async () => {
    let reply;
    chrome.runtime.sendMessage.mockImplementation((message, callback) => { reply = callback; });
    const pending = harness.processContainer(article);
    change({ bupgogae_filter_court: { newValue: false }, bupgogae_filter_constitutional: { newValue: false } }, 'local');
    reply({ '15Da6302': { found: false }, '20HeonMa123': { found: false } });
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(article.querySelector('.bgae-badge')).toBeNull();
    await jest.advanceTimersByTimeAsync(2500);
    expect(article.querySelector('.bgae-badge')).toBeNull();
    expect(document.querySelector('textarea').value).toBe('아직 전송하지 않은 질문');
  });
});
