/**
 * Jest 전역 셋업 — 확장 프로그램 단위 테스트용 chrome.* API 모킹.
 *
 * jsdom 환경에는 chrome 네임스페이스가 없으므로, 메시지 패싱 등
 * 최소 표면을 스텁으로 제공한다. 개별 테스트에서 jest.fn 동작을
 * 재정의해 콜백/lastError 시나리오를 검증할 수 있다.
 */
function makeChromeMock() {
  return {
    runtime: {
      lastError: null,
      // 기본: 빈 응답을 즉시 콜백. 테스트에서 mockImplementation으로 교체 가능.
      sendMessage: jest.fn((_msg, cb) => {
        if (typeof cb === 'function') cb({});
      }),
      onMessage: { addListener: jest.fn() },
    },
    storage: {
      local: {
        get: jest.fn((_keys, cb) => cb && cb({})),
        set: jest.fn((_items, cb) => cb && cb()),
      },
    },
  };
}

global.chrome = makeChromeMock();

// 각 테스트 사이에 chrome 모킹 상태를 초기화해 테스트 간 간섭 방지.
beforeEach(() => {
  global.chrome = makeChromeMock();
});
