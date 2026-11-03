const { test, expect, buildPrecDetailHtml } = require('./fixtures');
const fs = require('fs');
const path = require('path');

async function captureEvidence(page, testInfo, name) {
  const directory = path.resolve('tmp/qa-evidence');
  await fs.promises.mkdir(directory, { recursive: true });
  const file = path.join(directory, name + '.png');
  await page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

async function mountAnswer(context, answerStyle = 'margin:180px 60px') {
  await context.route('https://gemini.google.com/**', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><head><meta charset="utf-8"></head><body>'
      + '<button id="before">앞 테스트</button>'
      + `<model-response><message-content><p style="${answerStyle}">89두1</p>`
      + '</message-content></model-response><button id="after">뒤 테스트</button>'
      + '<div id="prompt" data-message-role="user">사용자 인용 89두1</div>'
      + '<textarea id="draft" aria-label="테스트 입력"></textarea>'
      + '</body></html>',
  }));
  const page = await context.newPage();
  await page.goto('https://gemini.google.com/');
  await expect(page.locator('.bgae-green')).toHaveCount(1);
  return page;
}

function detailHtml(title, body) {
  return buildPrecDetailHtml(body).replace('<body>',
    `<body><div id="contentBody"><h2>${title}</h2></div>`);
}

// Inspect the real closed shadow root through DevTools rather than changing
// attachShadow(), injecting product functions, or making the production root open.
async function sidebarNode(cdp, selector) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  function findHost(node) {
    const attributes = node.attributes || [];
    if (attributes.some((value, index) => value === 'id'
        && attributes[index + 1] === 'bupgogae-sidebar-host')) return node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
      const result = findHost(child);
      if (result) return result;
    }
    return null;
  }
  const host = findHost(root);
  if (!host?.shadowRoots?.[0]) return null;
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: host.shadowRoots[0].nodeId, selector,
  });
  return nodeId || null;
}

async function sidebarState(cdp, selector) {
  const nodeId = await sidebarNode(cdp, selector);
  if (!nodeId) return null;
  const { object } = await cdp.send('DOM.resolveNode', { nodeId });
  try {
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        return { text: this.textContent, href: this.getAttribute('href'),
          ariaHidden: this.getAttribute('aria-hidden'), inert: this.hasAttribute('inert'),
          focused: this.getRootNode().activeElement === this };
      }`,
      returnByValue: true,
    });
    return result.value;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: object.objectId });
  }
}

async function clickSidebarClose(page, cdp) {
  const viewport = page.viewportSize();
  await expect.poll(async () => {
    const nodeId = await sidebarNode(cdp, '.bgae-sidebar-close');
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId });
    return model.border[0] >= 0 && model.border[4] <= viewport.width;
  }).toBe(true);
  const nodeId = await sidebarNode(cdp, '.bgae-sidebar-close');
  const { model } = await cdp.send('DOM.getBoxModel', { nodeId });
  const q = model.border;
  await page.mouse.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2);
}

test('packaged badge opens an original, closes and loads it again through the real worker', async ({ context }, testInfo) => {
  let requests = 0;
  await context.route('https://www.law.go.kr/**', route => {
    requests++;
    return route.fulfill({ contentType: 'text/html',
      body: detailHtml(`원문 ${requests}`, `원문 본문 ${requests}`) });
  });
  const page = await mountAnswer(context);
  const cdp = await context.newCDPSession(page);
  const badge = page.locator('.bgae-green');
  await badge.click();
  const link = page.locator('.bgae-main-link').first();
  await expect(link).toBeVisible();
  const originalUrl = await link.getAttribute('href');
  await link.click();
  await expect.poll(async () => (await sidebarState(cdp, '.bgae-sidebar-title'))?.text).toBe('원문 1');
  expect((await sidebarState(cdp, '.bgae-sidebar-content')).text).toContain('원문 본문 1');
  expect((await sidebarState(cdp, '.bgae-footer-link')).href).toBe(originalUrl);
  await expect.poll(async () => {
    const nodeId = await sidebarNode(cdp, '.bgae-sidebar-container');
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId });
    return model.border[0] >= 0 && model.border[4] <= page.viewportSize().width;
  }).toBe(true);
  await captureEvidence(page, testInfo, 'sidebar-open');
  await clickSidebarClose(page, cdp);
  await expect.poll(async () => (await sidebarState(cdp, '.bgae-sidebar-container'))?.ariaHidden).toBe('true');
  expect((await sidebarState(cdp, '.bgae-sidebar-container')).inert).toBe(true);
  // A mouse click outside the tooltip unpins it; reopen through the badge.
  await badge.click();
  await link.click();
  await expect.poll(async () => (await sidebarState(cdp, '.bgae-sidebar-title'))?.text).toBe('원문 2');
  expect(requests).toBe(2);
});

test('original fetch failure is visible and reopening recovers without stale error UI', async ({ context }) => {
  let requests = 0;
  await context.route('https://www.law.go.kr/**', route => {
    requests++;
    return requests === 1
      ? route.fulfill({ status: 503, body: 'unavailable' })
      : route.fulfill({ contentType: 'text/html', body: detailHtml('복구한 원문', '복구한 본문') });
  });
  const page = await mountAnswer(context);
  const cdp = await context.newCDPSession(page);
  await page.locator('.bgae-green').click();
  const link = page.locator('.bgae-main-link').first();
  await link.click();
  await expect.poll(async () => (await sidebarState(cdp, '.bgae-sidebar-title'))?.text).toBe('조회 실패');
  expect((await sidebarState(cdp, '.bgae-error-msg')).text).toContain('HTTP 503');
  expect((await sidebarState(cdp, '.bgae-footer-link')).href).toBe(await link.getAttribute('href'));
  await page.keyboard.press('Escape');
  await expect(link).toBeFocused();
  await link.click();
  await expect.poll(async () => (await sidebarState(cdp, '.bgae-sidebar-title'))?.text).toBe('복구한 원문');
  expect((await sidebarState(cdp, '.bgae-sidebar-content')).text).toContain('복구한 본문');
  expect(await sidebarState(cdp, '.bgae-error-msg')).toBeNull();
  expect(requests).toBe(2);
});

test('Tab and Enter reach the original; Escape restores focus and skips the closed sidebar', async ({ context }, testInfo) => {
  await context.route('https://www.law.go.kr/**', route => route.fulfill({
    contentType: 'text/html', body: detailHtml('키보드 원문', '키보드 본문'),
  }));
  const page = await mountAnswer(context);
  const cdp = await context.newCDPSession(page);
  const badge = page.locator('.bgae-green');
  await page.locator('#before').focus();
  await page.keyboard.press('Tab');
  await expect(badge).toBeFocused();
  await page.keyboard.press('Enter');
  const link = page.locator('.bgae-main-link').first();
  await expect(link).toBeFocused();
  await captureEvidence(page, testInfo, 'tooltip-keyboard-open');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sidebarState(cdp, '.bgae-sidebar-title'))?.text).toBe('키보드 원문');
  expect((await sidebarState(cdp, '.bgae-sidebar-close')).focused).toBe(true);
  await page.keyboard.press('Escape');
  await expect(link).toBeFocused();
  expect((await sidebarState(cdp, '.bgae-sidebar-container')).inert).toBe(true);
  await page.keyboard.press('Escape');
  await expect(badge).toBeFocused();
  await expect(page.locator('.bgae-global-tooltip')).not.toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator('#after')).toBeFocused();
});

test('category storage changes rescan the current page without reloading or losing a draft', async ({ context, extensionPage }) => {
  const page = await mountAnswer(context);
  const url = page.url();
  const draft = page.locator('#draft');
  await draft.fill('전송하지 않은 합성 테스트 입력 89두1');
  const originalRealm = await page.evaluate(() => {
    window.__qaNavigationMarker = 'keep-this-realm';
    return performance.timeOrigin;
  });
  await extensionPage.evaluate(() => chrome.storage.local.set({ bupgogae_filter_court: false }));
  await expect(page.locator('message-content .bgae-badge')).toHaveCount(0);
  await expect(page.locator('message-content')).toContainText('89두1');
  await expect(draft).toHaveValue('전송하지 않은 합성 테스트 입력 89두1');
  await expect(draft).toBeFocused();
  await extensionPage.evaluate(() => chrome.storage.local.set({ bupgogae_filter_court: true }));
  await expect(page.locator('message-content .bgae-green')).toHaveCount(1);
  await expect(page.locator('#prompt .bgae-badge')).toHaveCount(0);
  await expect(draft).toHaveValue('전송하지 않은 합성 테스트 입력 89두1');
  await expect(draft).toBeFocused();
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => ({ marker: window.__qaNavigationMarker,
    origin: performance.timeOrigin }))).toEqual({ marker: 'keep-this-realm', origin: originalRealm });
});

test('tooltip stays inside a narrow viewport at the top right edge', async ({ context }, testInfo) => {
  const page = await mountAnswer(context, 'position:fixed;top:0;right:0;margin:0');
  await page.setViewportSize({ width: 360, height: 500 });
  await page.locator('.bgae-green').focus();
  await page.keyboard.press('Enter');
  const tooltip = page.locator('.bgae-global-tooltip');
  await expect(tooltip).toBeVisible();
  await expect.poll(async () => {
    const box = await tooltip.boundingBox();
    return !!box && box.x >= 0 && box.y >= 0
      && box.x + box.width <= 360 && box.y + box.height <= 500;
  }).toBe(true);
  await expect(tooltip.locator('.bgae-main-link')).toBeInViewport();
  await captureEvidence(page, testInfo, 'tooltip-edge');
});
