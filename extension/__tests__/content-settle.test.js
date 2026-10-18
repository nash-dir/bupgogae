/**
 * bupgogae-content.js — Settle(정지 감지) 처리 게이트 단위 테스트
 * ================================================================
 * Gemini/Grok/Copilot 등은 응답 생성 중 프레임워크가 서브트리를 재렌더하며
 * 우리가 심은 배지를 지운다(churn). 스트리밍 중 렌더는 깜빡임만 유발하므로,
 * "응답이 SETTLE_MS 동안 조용해진 뒤 1회 처리"하도록 스케줄러를 정지 감지형으로 둔다.
 *
 * jsdom + fake timer로 scheduleProcessing의 타이밍 계약만 검증한다
 * (처리 함수는 __setProcessFnForTest로 스파이 주입).
 */

const caseRegex = require('../content/case-regex.js');
require('../content/precedent-badge.js');
const content = require('../content/bupgogae-content.js');

describe('scheduleProcessing — settle 게이트', () => {
  let processSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    processSpy = jest.fn();
    content.__setProcessFnForTest(processSpy);
    content.__resetSchedulerForTest();
  });

  afterEach(() => {
    content.__resetSchedulerForTest();
    jest.useRealTimers();
  });

  test('연속 변경 중에는 처리하지 않고, 정지 후 SETTLE_MS 뒤 1회 처리', () => {
    // 스트리밍 흉내: 200ms 간격 12회 변경 (각 변경이 settle 타이머를 리셋)
    for (let i = 0; i < 12; i++) {
      content.scheduleProcessing();
      jest.advanceTimersByTime(200);
    }
    expect(processSpy).not.toHaveBeenCalled();

    // 정지: 추가 변경 없이 SETTLE_MS 경과 → 1회 처리
    jest.advanceTimersByTime(content.SETTLE_MS);
    expect(processSpy).toHaveBeenCalledTimes(1);
  });

  test('SETTLE_MS 이전에는 처리하지 않는다', () => {
    content.scheduleProcessing();
    jest.advanceTimersByTime(content.SETTLE_MS - 50);
    expect(processSpy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(50);
    expect(processSpy).toHaveBeenCalledTimes(1);
  });

  test('정지 후 새 변경이 오면 다시 1회 처리(재무장)', () => {
    content.scheduleProcessing();
    jest.advanceTimersByTime(content.SETTLE_MS);
    expect(processSpy).toHaveBeenCalledTimes(1);

    content.scheduleProcessing();
    jest.advanceTimersByTime(content.SETTLE_MS);
    expect(processSpy).toHaveBeenCalledTimes(2);
  });

  test('안전망(starvation 방지): 끝없는 변경에도 SETTLE_MAX_DEFER_MS 내에 강제 처리', () => {
    // 정지 구간이 생기지 않도록 100ms 간격으로 캡 시간보다 길게 계속 변경
    const steps = Math.ceil(content.SETTLE_MAX_DEFER_MS / 100) + 10;
    for (let i = 0; i < steps; i++) {
      content.scheduleProcessing();
      jest.advanceTimersByTime(100);
    }
    // 순수 settle만 있으면 0회(영구 보류) — 캡 덕분에 최소 1회는 처리되어야 한다.
    expect(processSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('27초 조회 timeout 중 추가된 변경을 완료 후 처리하며 기존 Gray를 보존한다', async () => {
    caseRegex.__setMetaForTest({ 두: 'Du', 다: 'Da' }, { 대법원: 1 }, ['89Du1']);
    const root = document.createElement('div');
    root.textContent = '89두1';
    document.body.appendChild(root);
    content.__setAdapterForTest({ findResponseContainers: () => [root] });
    content.__setShowOrangeToastForTest(false);
    chrome.storage.local.get = jest.fn(async () => ({}));
    chrome.runtime.sendMessage = jest.fn((message, callback) => {
      if (message.type !== 'LOOKUP_BATCH') return callback?.({});
      if (message.keys.includes('89Du1')) return; // 실제 8초 × 3회 timeout
      callback(Object.fromEntries(message.keys.map(key => [key, { found: false }])));
    });
    content.scheduleProcessing();
    await jest.advanceTimersByTimeAsync(2500);
    const added = document.createElement('span');
    added.textContent = '2015다12345';
    root.appendChild(added);
    content.scheduleProcessing();
    await jest.advanceTimersByTimeAsync(32000);
    expect(root.querySelectorAll('.bgae-gray')).toHaveLength(1);
    expect(added.querySelectorAll('.bgae-orange')).toHaveLength(1);
    expect(root.querySelectorAll('.bgae-badge')).toHaveLength(2);
    expect(chrome.runtime.sendMessage.mock.calls.filter(([m]) => m.type === 'LOOKUP_BATCH'))
      .toHaveLength(4);
    root.remove();
  });
});
