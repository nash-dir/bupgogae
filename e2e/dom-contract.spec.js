const { test, expect } = require('./fixtures');
const adapters = require('../extension/data/adapters.json');

test('six-site DOM fixtures exclude prompts and survive streaming and reply replacement', async ({ extensionPage, extensionId }) => {
  await extensionPage.evaluate(() => { window.module = { exports: {} }; });
  for (const script of ['adapters/base-adapter', 'adapters/registry', 'case-regex', 'precedent-badge', 'bupgogae-content']) {
    await extensionPage.addScriptTag({ url: `chrome-extension://${extensionId}/content/${script}.js` });
  }
  await extensionPage.evaluate(async () => {
    await window.bupgogaeCaseRegex.initMeta();
    _showOrangeToast = false;
  });
  const fixtures = [
    ['GeminiAdapter', '<model-response><message-content id="answer"></message-content></model-response>'],
    ['ChatGPTAdapter', '<ol data-conversation-transcript><li id="answer" data-message-role="assistant"></li></ol>'],
    ['ClaudeAdapter', '<div id="answer" data-testid="chat-message-content"></div>'],
    ['CopilotAdapter', '<div id="answer" class="group/assistant"></div>'],
    ['PerplexityAdapter', '<div id="answer" class="prose"></div>'],
    ['GrokAdapter', '<div id="answer" class="markdown"></div>'],
  ];
  for (const [name, html] of fixtures) {
    const result = await extensionPage.evaluate(async ({ name, html, adapters }) => {
      document.body.innerHTML = '<main><div data-message-role="user"><div class="prose markdown">89두1 2016도10912 2026헌가1</div></div>' + html + '<textarea>89두1</textarea></main>';
      const instance = new window.bupgogaeAdapters[name]();
      instance.setBundledConfig(adapters.adapters[instance.siteId]);
      instance.setRemoteConfig({ adapters: { [instance.siteId]: { responseSelectors: ['.stale-selector', 'main'] } } });
      let answer = instance.findResponseContainers()[0];
      answer.textContent = '89두';
      answer.firstChild.data += '1, 2016도10912, 2026헌가1.';
      answer.setAttribute('data-message-complete', '');
      await processContainer(answer);
      const first = answer.querySelectorAll('.bgae-badge').length;
      const replacement = answer.cloneNode(false);
      replacement.textContent = '89두1, 2016도10912, 2026헌가1.';
      answer.replaceWith(replacement);
      answer = instance.findResponseContainers()[0];
      await processContainer(answer);
      return { first, replaced: answer.querySelectorAll('.bgae-badge').length,
        total: document.querySelectorAll('.bgae-badge').length,
        prompt: document.querySelector('[data-message-role="user"]').querySelectorAll('.bgae-badge').length };
    }, { name, html, adapters });
    expect(result, name).toEqual({ first: 3, replaced: 3, total: 3, prompt: 0 });
  }
});

test('packaged content scripts automatically observe all six permitted site fixtures and logged-in ChatGPT', async ({ context }) => {
  test.setTimeout(120_000);
  const fixtures = [
    ['gemini.google.com', '<model-response><message-content id="answer"></message-content></model-response>'],
    ['chatgpt.com', '<ol data-conversation-transcript><li id="answer" data-message-role="assistant"></li></ol>'],
    ['chatgpt.com', '<div data-talvt-turn-state="complete"><div id="answer" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant"><h4 data-conversation-role="assistant">ChatGPT 답변:</h4></div></div>', '<div id="prompt" data-chatgpt-search-unit-key="fallback-turn-0:0:user"><div class="markdown prose">89두1 2016도10912 2026헌가1</div></div>'],
    ['claude.ai', '<div id="answer" data-testid="chat-message-content"></div>'],
    ['copilot.microsoft.com', '<div id="answer" class="group/assistant"></div>'],
    ['copilot.com', '<div id="answer" class="group/assistant"></div>'],
    ['copilot.cloud.microsoft', '<div id="answer" role="article" aria-labelledby="copilot-message-b-title copilot-message-b"></div>', '<div id="prompt" role="article" aria-labelledby="user-message-a-title user-message-a"><div class="prose">89두1</div></div>'],
    ['www.perplexity.ai', '<div id="answer" class="prose"></div>'],
    ['grok.com', '<div id="answer" class="markdown"></div>'],
  ];
  for (const [host, html, promptHtml] of fixtures) {
    const url = `https://${host}/`;
    const prompt = promptHtml || '<div id="prompt" data-message-role="user"><div class="prose markdown">89두1 2016도10912 2026헌가1</div></div>';
    await context.route(url, route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><html><body><main>' + prompt + html + '<textarea>89두1</textarea></main></body></html>' }));
    const page = await context.newPage();
    await page.goto(url);
    await page.locator('#answer').evaluate(element => {
      element.textContent = '89두';
      element.firstChild.data += '1, 2016도10912, 2026헌가1.';
      element.setAttribute('data-message-complete', '');
    });
    await expect(page.locator('#answer .bgae-badge'), host).toHaveCount(3);
    await page.locator('#answer').evaluate(element => {
      const replacement = element.cloneNode(false);
      replacement.textContent = '89두1, 2016도10912, 2026헌가1.';
      element.replaceWith(replacement);
    });
    await expect(page.locator('#answer .bgae-badge'), host).toHaveCount(3);
    await expect(page.locator('#prompt .bgae-badge'), host).toHaveCount(0);
    await expect(page.locator('textarea .bgae-badge'), host).toHaveCount(0);
    await expect(page.locator('.bgae-badge'), host).toHaveCount(3);
    await page.close();
  }
});
