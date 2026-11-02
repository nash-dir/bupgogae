const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

test('packaged popup renders metadata and preserves global OFF when reopened', async ({ context, extensionId }, testInfo) => {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 320, height: 600 });
  const url = `chrome-extension://${extensionId}/popup/popup.html`;
  await page.goto(url);
  await expect(page.locator('.popup-title')).toHaveText('법고개');
  await expect(page.locator('#dbCount')).toContainText(/판례 수 : [\d,]+건/);
  await expect(page.locator('#dbDate')).not.toHaveText('DB 일자 : —');
  await expect(page.locator('#courtFilterToggle')).toBeChecked();
  await expect(page.locator('#constitutionalFilterToggle')).toBeChecked();
  const ratios = await page.locator('body').evaluate(body => {
    const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number);
    const luminance = color => rgb(color).map(value => value / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const background = luminance(getComputedStyle(body).backgroundColor);
    return ['#dbDate', '#dbCount', '.popup-data-source', '.popup-contact', '.popup-contact a']
      .map(selector => ({ selector, ratio:
        (luminance(getComputedStyle(document.querySelector(selector)).color) + 0.05) / (background + 0.05) }));
  });
  for (const item of ratios) expect(item.ratio, item.selector).toBeGreaterThanOrEqual(4.5);
  const evidence = path.resolve(__dirname, '../tmp/qa-evidence/popup.png');
  await fs.promises.mkdir(path.dirname(evidence), { recursive: true });
  await page.locator('body').screenshot({ path: evidence });
  await testInfo.attach('popup', { path: evidence, contentType: 'image/png' });
  await page.locator('#scopeToggleBtn').click();
  await page.locator('#ledgerToggleBtn').click();
  await page.locator('#contactLink').scrollIntoViewIfNeeded();
  await expect(page.locator('#contactLink')).toBeInViewport();
  await page.locator('#scopeToggleBtn').click();
  await page.locator('#ledgerToggleBtn').click();
  await page.locator('label[for="globalToggle"]').click();
  await expect(page.locator('#globalToggle')).not.toBeChecked();
  await expect(page.locator('#statusText')).toHaveText('전체 비활성 상태');
  await page.goto('about:blank');
  await page.goto(url);
  await expect(page.locator('#globalToggle')).not.toBeChecked();
  await expect(page.locator('#statusText')).toHaveText('전체 비활성 상태');
  expect(errors).toEqual([]);
});
