const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../content/precedent-badge.js'), 'utf8');
const { renderPrecedentBadge } = new Function(`${source}\nreturn { renderPrecedentBadge };`)();

function makeBadge(parentTag = 'p') {
  const parent = document.createElement(parentTag);
  if (parentTag === 'a') parent.href = 'https://example.com/original';
  const text = document.createTextNode('2015다6302');
  parent.appendChild(text);
  document.body.appendChild(parent);
  const badge = renderPrecedentBadge(text, '2015다6302', 'green', {
    serialNumber: '123', courtCode: 1, dateInt: 150115, courtCodeMap: { 대법원: 1 },
  });
  return { parent, badge };
}

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.body.replaceChildren();
  jest.restoreAllMocks();
});

test.each(['Enter', ' '])('keyboard %s opens the same pinned information and Escape restores focus', key => {
  const { badge } = makeBadge();
  expect(badge.tabIndex).toBe(0);
  expect(badge.getAttribute('role')).toBe('button');
  badge.focus();
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  badge.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  const popup = document.querySelector('.bgae-global-tooltip');
  expect(popup.classList.contains('bgae-pinned')).toBe(true);
  expect(popup.getAttribute('aria-hidden')).toBe('false');
  expect(badge.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(popup.querySelector('a'));
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(popup.classList.contains('bgae-show')).toBe(false);
  expect(popup.hasAttribute('inert')).toBe(true);
  expect(badge.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(badge);
});

test('a citation already inside a native link gets no nested keyboard button', () => {
  const { parent, badge } = makeBadge('a');
  expect(parent.href).toBe('https://example.com/original');
  expect(badge.hasAttribute('tabindex')).toBe(false);
  expect(badge.hasAttribute('role')).toBe(false);
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  badge.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});

test('tooltip flips below a top edge and clamps to a narrow viewport, then follows resize', () => {
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 200 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
  let rect = { left: 180, top: 2, bottom: 22, width: 20, height: 20 };
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.classList.contains('bgae-global-tooltip')) return { width: 240, height: 140 };
    return rect;
  });
  const { badge } = makeBadge();
  badge.click();
  const popup = document.querySelector('.bgae-global-tooltip');
  expect(popup.style.left).toBe('8px');
  expect(popup.style.top).toBe('30px');
  rect = { left: 40, top: 270, bottom: 290, width: 20, height: 20 };
  window.dispatchEvent(new Event('resize'));
  expect(popup.style.top).toBe('122px');
  expect(popup.style.left).toBe('8px');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
});
