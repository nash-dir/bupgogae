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
  (0, eval)(code);
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

  test('주황 툴팁은 로컬 DB miss만 설명하고 허위 여부를 단정하지 않음', () => {
    const { tn } = makeTextNode('2026다1234');
    const badge = bg.renderPrecedentBadge(tn, '2026다1234', 'orange');
    badge.dispatchEvent(new MouseEvent('mouseenter'));

    const tooltip = document.querySelector('.bgae-global-tooltip');
    expect(tooltip.textContent).toContain('현재 브라우저의 로컬 공개 DB에서 찾지 못한');
    expect(tooltip.textContent).toContain('원문·추가 자료에서 직접 확인');
    expect(tooltip.textContent).not.toContain('검증되지 않은');
    expect(tooltip.textContent).not.toContain('허위 사건번호 여부를 판별');
    badge.dispatchEvent(new MouseEvent('mouseleave'));
  });

  test('빨강 툴팁은 형식 오류만으로 인용 진위를 확정하지 않음', () => {
    const { tn } = makeTextNode('2030다1');
    const badge = bg.renderPrecedentBadge(tn, '2030다1', 'red', {
      redReason: '미래 연도입니다.',
    });
    badge.dispatchEvent(new MouseEvent('mouseenter'));

    const tooltip = document.querySelector('.bgae-global-tooltip');
    expect(tooltip.textContent).toContain('형식 오류만으로 인용의 진위 여부를 확정할 수 없습니다');
    expect(tooltip.textContent).not.toContain('AI 환각');
    badge.dispatchEvent(new MouseEvent('mouseleave'));
  });

  test('renderPrecedentBadges: 한 텍스트노드 내 다중 매칭을 1회 분할로 모두 배지 (M2)', () => {
    const { parent, tn } = makeTextNode('a 2015다6302 b 2020두1234 c 99다1234 d');
    const created = bg.renderPrecedentBadges(tn, [
      { precedentString: '2015다6302', startIdx: 2, level: 'green' },
      { precedentString: '2020두1234', startIdx: 15, level: 'orange' },
      { precedentString: '99다1234', startIdx: 28, level: 'red', options: { redReason: 'x' } },
    ]);

    expect(created).toHaveLength(3);
    const badges = parent.querySelectorAll('.bgae-badge');
    expect(badges).toHaveLength(3);
    // 텍스트 보존 + 위치 순서 유지
    expect(parent.textContent).toBe('a 2015다6302 b 2020두1234 c 99다1234 d');
    expect(badges[0].getAttribute('data-bgae-case')).toBe('2015다6302');
    expect(badges[0].className).toContain('bgae-green');
    expect(badges[1].className).toContain('bgae-orange');
    expect(badges[2].className).toContain('bgae-red');
    // 원본 텍스트노드는 제거됨
    expect(parent.contains(tn)).toBe(false);
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
