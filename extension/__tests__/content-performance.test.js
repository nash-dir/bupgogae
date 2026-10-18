const caseRegex = require('../content/case-regex.js');
require('../content/precedent-badge.js');
const content = require('../content/bupgogae-content.js');

const CASE_CODE_MAP = { 다: 'Da', 두: 'Du' };

describe('DOM 처리 예산과 circuit breaker', () => {
  afterEach(() => {
    delete global.scheduler;
    document.body.innerHTML = '';
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    caseRegex.__setMetaForTest(CASE_CODE_MAP, { 대법원: 1 }, ['89Du1']);
    content.__resetForTest();
    content.__setCategoryFiltersForTest({ court: true, constitutional: true });
  });

  test('live scan diagnostics contain numeric timings without conversation text', async () => {
    const root = document.createElement('div');
    root.textContent = '비공개 문장 표본: 2026다0';
    document.body.appendChild(root);
    content.__setAdapterForTest({ findResponseContainers: () => [root] });
    jest.spyOn(chrome.storage.local, 'get').mockResolvedValue({});
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      await content.processAllResponses();
      const message = debug.mock.calls.map(call => call[0]).find(s => s.startsWith('[bupgogae] scan '));
      expect(message).toBeDefined();
      expect(message).not.toMatch(/비공개|2026다0/);
      const metrics = JSON.parse(message.slice('[bupgogae] scan '.length));
      expect(metrics.detected).toBe(1);
      expect(metrics.containers).toBe(1);
      expect(metrics.syncMs).toBeGreaterThanOrEqual(0);
      expect(metrics.maxMeasuredSliceMs).toBeGreaterThanOrEqual(0);
    } finally {
      content.__setAdapterForTest(null);
    }
  });

  test('큰 DOM 수집은 고정 chunk마다 메인 스레드에 양보한다', async () => {
    global.scheduler = { yield: jest.fn(() => Promise.resolve()) };
    const root = document.createElement('div');
    for (let i = 0; i < content.DOM_WORK_CHUNK_SIZE * 2 + 1; i++) {
      const span = document.createElement('span');
      span.textContent = `텍스트 ${i}`;
      root.appendChild(span);
    }
    document.body.appendChild(root);

    const result = await content.processContainer(root);
    expect(result.detected).toBe(0);
    // 시간 slice가 먼저 소진되면 추가 yield가 가능하므로 최소 chunk 경계만 보장한다.
    expect(global.scheduler.yield.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.syncDuration).toBeGreaterThanOrEqual(0);
  });

  test('느린 TreeWalker 시간은 동기 처리 예산에 포함된다', async () => {
    const originalCreateTreeWalker = document.createTreeWalker.bind(document);
    let clock = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => clock);
    jest.spyOn(document, 'createTreeWalker').mockImplementation((...args) => {
      const walker = originalCreateTreeWalker(...args);
      const originalNextNode = walker.nextNode.bind(walker);
      walker.nextNode = () => {
        clock += content.CIRCUIT_THRESHOLD_MS + 1;
        return originalNextNode();
      };
      return walker;
    });
    global.scheduler = { yield: jest.fn(() => Promise.resolve()) };
    const root = document.createElement('div');
    root.textContent = '일반 텍스트';
    document.body.appendChild(root);

    const result = await content.processContainer(root);
    expect(result.syncDuration).toBeGreaterThan(content.CIRCUIT_THRESHOLD_MS);
    expect(content.evaluateCircuitBreakerState(
      { strikes: 0, fastStreak: 0 }, result.syncDuration,
    ).action).toBe('strike');
  });

  test('DB 응답 대기는 동기 처리 예산에 포함되지 않는다', async () => {
    jest.useFakeTimers();
    global.chrome.runtime.sendMessage = jest.fn((message, callback) => {
      if (message?.type === 'LOOKUP_BATCH') {
        setTimeout(() => callback({
          '89Du1': { found: true, data: [[1, 1, 890101, '테스트사건']] },
        }), 5000);
      } else if (callback) {
        callback({});
      }
    });
    const root = document.createElement('div');
    root.textContent = '89두1';
    document.body.appendChild(root);

    const startedAt = Date.now();
    const pending = content.processContainer(root);
    await jest.advanceTimersByTimeAsync(5000);
    const result = await pending;

    expect(Date.now() - startedAt).toBe(5000);
    expect(result.syncDuration).toBeLessThan(content.CIRCUIT_FAST_MS);
    expect(root.querySelector('.bgae-green')).not.toBeNull();
  });

  test('임계값과 연속 지연 경계에서 다섯 번째만 현재 탭 pause', () => {
    let state = { strikes: 0, fastStreak: 0 };
    const atBoundary = content.evaluateCircuitBreakerState(
      state, content.CIRCUIT_THRESHOLD_MS,
    );
    expect(atBoundary.action).toBe('none');

    for (let i = 1; i <= content.CIRCUIT_MAX_STRIKES; i++) {
      state = content.evaluateCircuitBreakerState(
        state, content.CIRCUIT_THRESHOLD_MS + 1,
      );
      expect(state.action).toBe(i === content.CIRCUIT_MAX_STRIKES ? 'pause' : 'strike');
    }
    expect(state.strikes).toBe(0);
  });

  test('빠른 처리 연속 확인은 과거 strike를 복구한다', () => {
    let state = { strikes: 2, fastStreak: 0 };
    for (let i = 1; i <= content.CIRCUIT_RECOVERY_STREAK; i++) {
      state = content.evaluateCircuitBreakerState(state, content.CIRCUIT_FAST_MS);
      expect(state.action).toBe(
        i === content.CIRCUIT_RECOVERY_STREAK ? 'recovered' : 'recovering',
      );
    }
    expect(state).toMatchObject({ strikes: 0, fastStreak: 0 });
  });

  test('중간 비용은 strike나 회복 카운트를 변경하지 않는다', () => {
    expect(content.evaluateCircuitBreakerState(
      { strikes: 2, fastStreak: 1 },
      content.CIRCUIT_FAST_MS + 1,
    )).toEqual({ strikes: 2, fastStreak: 1, action: 'none' });
  });

  test('실제 controller가 circuit pause하면 pending drain과 새 예약도 재개하지 않는다', async () => {
    jest.useFakeTimers();
    content.__resetSchedulerForTest();
    const root = document.createElement('div');
    root.textContent = '일반 텍스트';
    document.body.appendChild(root);
    const find = jest.fn(() => [root]);
    content.__setAdapterForTest({ findResponseContainers: find });
    chrome.storage.local.get = jest.fn(async () => ({
      bupgogae_circuit_strikes: content.CIRCUIT_MAX_STRIKES - 1,
    }));
    chrome.storage.local.set = jest.fn(async () => {});
    jest.spyOn(window, 'alert').mockImplementation(() => {});
    let clock = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => {
      clock += content.CIRCUIT_THRESHOLD_MS + 1;
      return clock;
    });
    global.scheduler = { yield: jest.fn(async () => { content.scheduleProcessing(); }) };
    await content.processAllResponses();
    expect(window.alert).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
      bupgogae_circuit_last_pause: expect.any(Object),
    }));
    content.scheduleProcessing();
    await jest.advanceTimersByTimeAsync(content.SETTLE_MAX_DEFER_MS * 3);
    expect(find).toHaveBeenCalledTimes(1);
    content.__resetSchedulerForTest();
  });
});
