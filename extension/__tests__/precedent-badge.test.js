/**
 * precedent-badge.js 단위 테스트
 * ──────────────────────────────
 * 배지 렌더링이 텍스트 노드를 올바르게 분할/치환하고, 분할로 생성한
 * 텍스트 노드를 _ownTextNodes(옵저버 자기유발 루프 방지용)에 등록하는지 검증.
 */
const fs = require('fs');
const path = require('path');

function loadScript(rel) {
  const code = fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8');
  (0, eval)(code); // eslint-disable-line no-eval
}

describe('renderPrecedentBadge', () => {
  let bg;

  beforeAll(() => {
    loadScript('content/precedent-badge.js');
    bg = window.bupgogae;
  });

  function makeTextNode(text) {
    const parent = document.createElement('p');
    const tn = document.createTextNode(text);
    parent.appendChild(tn);
    document.body.appendChild(parent);
    return { parent, tn };
  }

  test('매칭 문자열을 배지 span으로 치환', () => {
    const { parent, tn } = makeTextNode('참고 2015다6302 판결');
    const badge = bg.renderPrecedentBadge(tn, '2015다6302', 'green');

    expect(badge).not.toBeNull();
    expect(badge.tagName).toBe('SPAN');
    expect(badge.className).toContain('bgae-green');
    expect(badge.getAttribute('data-bgae-case')).toBe('2015다6302');
    expect(badge.textContent).toBe('2015다6302');
    // 원본 텍스트 노드는 제거되고 before/badge/after로 분할됨
    expect(parent.textContent).toBe('참고 2015다6302 판결');
    expect(parent.querySelector('.bgae-badge')).toBe(badge);
  });

  test('분할 텍스트 노드는 _ownTextNodes에 등록 (옵저버 무시 대상)', () => {
    const { parent, tn } = makeTextNode('앞 2020두1234 뒤');
    bg.renderPrecedentBadge(tn, '2020두1234', 'green');

    const childNodes = Array.from(parent.childNodes);
    const textNodes = childNodes.filter(n => n.nodeType === 3); // TEXT_NODE
    expect(textNodes.length).toBeGreaterThan(0);
    for (const t of textNodes) {
      expect(bg._ownTextNodes.has(t)).toBe(true);
    }
  });

  test('매칭 문자열이 없으면 null', () => {
    const { tn } = makeTextNode('관련 내용 없음');
    expect(bg.renderPrecedentBadge(tn, '2015다6302', 'green')).toBeNull();
  });

  test('revertPrecedentBadge: 배지를 텍스트로 원복하고 _ownTextNodes 등록', () => {
    const { parent, tn } = makeTextNode('x 99다1 y');
    const badge = bg.renderPrecedentBadge(tn, '99다1', 'gray');
    const reverted = bg.revertPrecedentBadge(badge, '99다1');
    expect(reverted.nodeType).toBe(3);
    expect(bg._ownTextNodes.has(reverted)).toBe(true);
    expect(parent.querySelector('.bgae-badge')).toBeNull();
  });
});
