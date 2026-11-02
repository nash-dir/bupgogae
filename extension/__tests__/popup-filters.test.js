const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../popup/popup.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../popup/popup.html'), 'utf8');

function loadPopup(supported = true) {
  document.documentElement.innerHTML = html;
  // Control initialization explicitly so this test exercises the real listeners.
  const registration = jest.spyOn(document, 'addEventListener').mockImplementation(() => {});
  const popup = new Function(`${source}\nreturn {
    bindEvents,
    configure() { _currentTabId = 42; _isSupportedSite = ${supported}; }
  };`)();
  registration.mockRestore();
  popup.configure();
  popup.bindEvents();
}

describe('popup category filters', () => {
  beforeEach(() => {
    chrome.tabs = { reload: jest.fn(async () => {}) };
    chrome.storage.local.set.mockResolvedValue();
  });

  test.each([
    ['courtFilterToggle', 'bupgogae_filter_court', 'courtFilterDesc'],
    ['constitutionalFilterToggle', 'bupgogae_filter_constitutional', 'constitutionalFilterDesc'],
  ])('%s persists and updates the label without reloading the supported tab', async (id, key, description) => {
    loadPopup();
    let persist;
    chrome.storage.local.set.mockImplementation(() => new Promise(resolve => { persist = resolve; }));
    const toggle = document.getElementById(id);
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ [key]: false });
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
    persist();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.getElementById(description).textContent).toContain('비활성');
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });

  test('changing a filter from an unsupported tab stores the preference without reloading it', async () => {
    loadPopup(false);
    const toggle = document.getElementById('courtFilterToggle');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ bupgogae_filter_court: false });
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });
});
