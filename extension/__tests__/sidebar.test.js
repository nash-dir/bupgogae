const fs = require('fs');
const path = require('path');
const config = require('../data/adapters.json');
const source = fs.readFileSync(path.join(__dirname, '../content/sidebar.js'), 'utf8');
const Sidebar = new Function(`${source}\nreturn BupgogaeSidebar;`)();

describe('bundled law.go.kr parsing', () => {
  let sidebar;
  beforeEach(() => {
    sidebar = new Sidebar();
    sidebar.headerTitle = document.createElement('h2');
    sidebar.contentArea = document.createElement('div');
    window.bupgogaeAdapters = { loadBundledConfig: jest.fn(async () => config) };
    chrome.storage.local.get.mockResolvedValue({ bupgogae_remote_adapters: {
      scraping_adapters: { law_go_kr: { body_container: 'body', title_selector: 'script' } },
    } });
    chrome.runtime.sendMessage.mockImplementation((message, respond) => respond({ html:
      '<div id="contentBody"><h2>대법원 판결</h2></div><div id="conScroll"><h4>판시사항</h4><p class="pty4">공개 본문 &lt;script&gt;alert(1)&lt;/script&gt;</p></div><aside>제외할 텍스트</aside>',
    }));
  });
  afterEach(() => { delete window.bupgogaeAdapters; });

  test('extracts the bundled title and sections without consulting legacy storage', async () => {
    await sidebar.fetchAndParse('https://www.law.go.kr/precInfoP.do?precSeq=1');
    expect(sidebar.headerTitle.textContent).toBe('대법원 판결');
    expect(sidebar.contentArea.textContent).toContain('판시사항');
    expect(sidebar.contentArea.textContent).toContain('공개 본문 <script>alert(1)</script>');
    expect(sidebar.contentArea.textContent).not.toContain('제외할 텍스트');
    expect(sidebar.contentArea.querySelector('script')).toBeNull();
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage.mock.calls.map(([message]) => message.type)).toEqual(['FETCH_LAW_HTML']);
  });

  test('a missing bundle displays an error without requesting remote selectors', async () => {
    window.bupgogaeAdapters.loadBundledConfig.mockResolvedValue(null);
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    await sidebar.fetchAndParse('https://www.law.go.kr/precInfoP.do?precSeq=1');
    expect(sidebar.headerTitle.textContent).toBe('조회 실패');
    expect(sidebar.contentArea.textContent).toContain('번들 법령정보센터 셀렉터');
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  const html = title => `<div id="contentBody"><h2>${title}</h2></div><div id="conScroll"><p class="pty4">${title} 본문</p></div>`;

  test('a slow older response cannot replace the latest title, body or source link', async () => {
    const replies = [];
    chrome.runtime.sendMessage.mockImplementation((_message, reply) => replies.push(reply));
    const old = sidebar.fetchAndParse('https://www.law.go.kr/precInfoP.do?precSeq=1');
    const latest = sidebar.fetchAndParse('https://www.law.go.kr/precInfoP.do?precSeq=2');
    replies[1]({ html: html('최신 판례') });
    await latest;
    replies[0]({ html: html('이전 판례') });
    await old;
    expect(sidebar.headerTitle.textContent).toBe('최신 판례');
    expect(sidebar.contentArea.textContent).toContain('최신 판례 본문');
    expect(sidebar.contentArea.textContent).not.toContain('이전 판례');
    expect(sidebar.contentArea.querySelector('a').href).toContain('precSeq=2');
  });

  test('an older failure cannot overwrite a newer successful response', async () => {
    const replies = [];
    chrome.runtime.sendMessage.mockImplementation((_message, reply) => replies.push(reply));
    const old = sidebar.fetchAndParse('https://www.law.go.kr/precInfoP.do?precSeq=1');
    const latest = sidebar.fetchAndParse('https://www.law.go.kr/precInfoP.do?precSeq=2');
    replies[1]({ html: html('최신 판례') });
    await latest;
    replies[0]({ error: '이전 요청 실패' });
    await old;
    expect(sidebar.headerTitle.textContent).toBe('최신 판례');
    expect(sidebar.contentArea.textContent).not.toContain('이전 요청 실패');
  });

  test('closing invalidates a pending response and does not fill the closed panel', async () => {
    let reply;
    chrome.runtime.sendMessage.mockImplementation((_message, respond) => { reply = respond; });
    sidebar.container = document.createElement('div');
    sidebar.isOpen = true;
    sidebar.showLoading();
    const pending = sidebar.fetchAndParse('https://www.law.go.kr/precInfoP.do?precSeq=1');
    sidebar.close();
    reply({ html: html('닫은 뒤 도착한 판례') });
    await pending;
    expect(sidebar.isOpen).toBe(false);
    expect(sidebar.headerTitle.textContent).toBe('원문 불러오는 중...');
    expect(sidebar.contentArea.textContent).not.toContain('닫은 뒤 도착한 판례');
  });

  test('a superseded request waiting for bundle loading cannot replace the latest view', async () => {
    let finishBundle;
    window.bupgogaeAdapters.loadBundledConfig
      .mockImplementationOnce(() => new Promise(resolve => { finishBundle = resolve; }));
    chrome.runtime.sendMessage.mockImplementation((message, reply) => reply({
      html: html(message.url.endsWith('1') ? '이전 판례' : '최신 판례'),
    }));
    const old = sidebar.fetchAndParse('https://www.law.go.kr/precInfoP.do?precSeq=1');
    await Promise.resolve();
    const latest = sidebar.fetchAndParse('https://www.law.go.kr/precInfoP.do?precSeq=2');
    await latest;
    finishBundle(config);
    await old;
    expect(sidebar.headerTitle.textContent).toBe('최신 판례');
  });
});

describe('sidebar keyboard lifecycle', () => {
  test('closing falls back to the source badge if the tooltip opener became inert', () => {
    document.body.replaceChildren();
    const badge = document.createElement('span');
    badge.tabIndex = 0;
    badge.className = 'bgae-badge';
    badge.setAttribute('role', 'button');
    badge.setAttribute('aria-expanded', 'true');
    const tooltip = document.createElement('div');
    tooltip.className = 'bgae-global-tooltip';
    const link = document.createElement('a');
    link.href = 'https://www.law.go.kr/precInfoP.do?precSeq=1';
    tooltip.appendChild(link);
    document.body.append(badge, tooltip);
    link.focus();
    chrome.runtime.sendMessage.mockImplementation(() => {});
    const sidebar = new Sidebar();
    sidebar.open(link.href);
    tooltip.setAttribute('inert', '');
    tooltip.setAttribute('aria-hidden', 'true');
    sidebar.closeButton.click();
    expect(document.activeElement).toBe(badge);
    sidebar.hostElement.remove();
  });

  test('opening enables and focuses the panel; Escape closes it and restores its opener', () => {
    document.body.replaceChildren();
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    chrome.runtime.sendMessage.mockImplementation(() => {});
    const sidebar = new Sidebar();
    sidebar.init();
    expect(sidebar.container.hasAttribute('inert')).toBe(true);
    expect(sidebar.container.getAttribute('aria-hidden')).toBe('true');
    sidebar.open('https://www.law.go.kr/precInfoP.do?precSeq=1');
    expect(sidebar.container.hasAttribute('inert')).toBe(false);
    expect(sidebar.container.getAttribute('aria-hidden')).toBe('false');
    expect(sidebar.shadow.activeElement).toBe(sidebar.closeButton);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true });
    sidebar.closeButton.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(sidebar.isOpen).toBe(false);
    expect(sidebar.container.hasAttribute('inert')).toBe(true);
    expect(sidebar.container.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(opener);
    sidebar.hostElement.remove();
  });
});
