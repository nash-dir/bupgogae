/**
 * bupgogae-content.js — 룩업 결과 렌더링(L13 회귀 수정) 단위 테스트
 * ================================================================
 * 0.8.1 회귀 잔여 증상: 배치 조회 타임아웃/에러(8s) 시 gray(pending) 배지를
 * orange(DB 미확인)로 덮어쓰고, 늦게 도착한 진짜 응답을 버린다.
 *
 * DB 콜드 스타트(~20s)·SW 일시 정지로 인한 지연을 'DB 미확인'으로 단정하면
 * 진짜 판례가 orange로 오표시된다. 목표 동작:
 *   - 타임아웃/시스템 에러 → gray 유지 + 재조회(늦게 온 응답 회복)
 *   - genuine miss(found:false, error 아님) → orange
 *   - DB hit(found:true) → green
 *
 * jsdom + chrome.runtime 모킹으로 content script 내부(processContainer)를 직접 구동한다.
 */

// 세 스크립트를 같은 jsdom window/모듈 상태로 로드 (require 시 window.* 와 module.exports 동시 설정)
const caseRegex = require('../content/case-regex.js');
require('../content/precedent-badge.js');
const content = require('../content/bupgogae-content.js');

// 테스트용 메타: "다" → "Da", 법원코드 대법원=1
const CASE_CODE_MAP = { 다: 'Da', 두: 'Du', 도: 'Do' };
const COURT_CODE_MAP = { 대법원: 1 };

function makeContainer(text) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  document.body.appendChild(div);
  return div;
}

beforeEach(() => {
  // jest.setup.js가 global.chrome를 새로 만들어 두므로 메타/필터만 주입
  caseRegex.__setMetaForTest(CASE_CODE_MAP, COURT_CODE_MAP);
  content.__resetForTest();
  content.__setCategoryFiltersForTest({ court: true, constitutional: true, tax: false });
  document.body.innerHTML = '';
});

afterEach(() => {
  jest.useRealTimers();
});

describe('processContainer — 룩업 결과 렌더링 (L13)', () => {
  test('타임아웃/에러는 orange로 오탐하지 않고(평문 유지), 재조회로 늦게 온 진짜 응답(green)을 반영한다', async () => {
    jest.useFakeTimers();

    let lookupCalls = 0;
    global.chrome.runtime.sendMessage = jest.fn((msg, cb) => {
      if (!msg || msg.type !== 'LOOKUP_BATCH') {
        if (cb) cb({});
        return;
      }
      lookupCalls += 1;
      if (lookupCalls === 1) {
        // 1차: SW 일시 정지/콘텍스트 무효화와 동급의 시스템 에러 — 응답을 신뢰할 수 없음
        global.chrome.runtime.lastError = { message: 'Extension context busy' };
        cb({});
        global.chrome.runtime.lastError = null;
      } else {
        // 2차(재조회): 늦게나마 진짜 응답 도착 — DB hit
        cb({ '15Da6302': { found: true, data: [[1, 1, 150115, '테스트사건']] } });
      }
    });

    const container = makeContainer('관련 판례 2015다6302 를 참조하라');
    const p = content.processContainer(container);
    await jest.advanceTimersByTimeAsync(10_000); // 재조회 백오프 타이머 흘려보내기
    await p;

    const badge = container.querySelector('.bgae-badge');
    expect(badge).not.toBeNull();
    expect(badge.getAttribute('data-bgae-case')).toBe('2015다6302');
    expect(badge.className).toContain('bgae-green');     // 늦게 온 진짜 응답이 반영됨
    expect(badge.className).not.toContain('bgae-orange'); // 타임아웃을 miss로 단정하지 않음
    expect(lookupCalls).toBeGreaterThanOrEqual(2);        // 재조회 발생
  });

  test('진짜 타임아웃(콜백 미호출, 8s)도 orange가 아니라 평문 유지 후 재조회로 green이 된다', async () => {
    jest.useFakeTimers();

    let lookupCalls = 0;
    global.chrome.runtime.sendMessage = jest.fn((msg, cb) => {
      if (!msg || msg.type !== 'LOOKUP_BATCH') {
        if (cb) cb({});
        return;
      }
      lookupCalls += 1;
      // 1차: 콜백을 끝내 호출하지 않음 (SW 무응답 → 8s 타임아웃 가드 발동)
      // 2차(재조회): 진짜 응답 도착
      if (lookupCalls >= 2) {
        cb({ '15Da6302': { found: true, data: [[1, 1, 150115, '테스트사건']] } });
      }
    });

    const container = makeContainer('판례 2015다6302 인용');
    const p = content.processContainer(container);
    // 1차 8s 타임아웃 + 백오프 + 2차 응답까지 충분히 흘려보냄
    await jest.advanceTimersByTimeAsync(20_000);
    await p;

    const badge = container.querySelector('.bgae-badge');
    expect(badge).not.toBeNull();
    expect(badge.className).toContain('bgae-green');
    expect(badge.className).not.toContain('bgae-orange');
    expect(lookupCalls).toBeGreaterThanOrEqual(2);
  });

  test('genuine miss(found:false)는 orange로 렌더링한다 (회귀 없음)', async () => {
    global.chrome.runtime.sendMessage = jest.fn((msg, cb) => {
      if (msg && msg.type === 'LOOKUP_BATCH') {
        cb({ '15Da6302': { found: false, data: null } });
      } else if (cb) {
        cb({});
      }
    });

    const container = makeContainer('출처 2015다6302 확인');
    await content.processContainer(container);

    const badge = container.querySelector('.bgae-badge');
    expect(badge).not.toBeNull();
    expect(badge.className).toContain('bgae-orange');
    expect(badge.className).not.toContain('bgae-green');
  });

  test('DB hit(found:true)는 green으로 렌더링한다 (회귀 없음)', async () => {
    global.chrome.runtime.sendMessage = jest.fn((msg, cb) => {
      if (msg && msg.type === 'LOOKUP_BATCH') {
        cb({ '15Da6302': { found: true, data: [[1, 1, 150115, '테스트사건']] } });
      } else if (cb) {
        cb({});
      }
    });

    const container = makeContainer('판례 2015다6302 인용');
    await content.processContainer(container);

    const badge = container.querySelector('.bgae-badge');
    expect(badge).not.toBeNull();
    expect(badge.className).toContain('bgae-green');
    expect(badge.className).not.toContain('bgae-orange');
  });

  test('M2: 한 텍스트노드 내 여러 사건번호가 단일 처리로 전부 배지된다', async () => {
    // 전부 miss/red — 한 텍스트노드에 4개(valid 2 + red 2)
    global.chrome.runtime.sendMessage = jest.fn((msg, cb) => {
      if (msg && msg.type === 'LOOKUP_BATCH') cb({}); // 응답은 받되 키 없음 → miss → orange
      else if (cb) cb({});
    });

    // 2015다6302/2020두1234 → valid(miss→orange), 2099다1(미래)/2015다0(일련번호0) → red
    const container = makeContainer('판례 2015다6302 2020두1234 2099다1 2015다0 참조');
    await content.processContainer(container);

    const badges = container.querySelectorAll('.bgae-badge');
    expect(badges.length).toBe(4); // M2 수정 전엔 첫 분할로 노드가 detach되어 1개만 떴다
    const cases = Array.from(badges).map((b) => b.getAttribute('data-bgae-case'));
    expect(cases).toEqual(
      expect.arrayContaining(['2015다6302', '2020두1234', '2099다1', '2015다0']),
    );
  });
});
