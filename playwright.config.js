/**
 * 법고개(Bupgogae) — Playwright E2E 설정
 * ==========================================
 * Chrome Extension(MV3)을 로드해야 하므로 일반 browser/context 픽스쳐 대신
 * e2e/fixtures.js에서 launchPersistentContext로 직접 브라우저를 띄운다.
 * (--disable-extensions-except / --load-extension 옵션도 fixtures.js에서 주입)
 */

// MV3 Service Worker가 보내는 네트워크 요청(법제처 크롤링, R2 동기화)을
// context.route()로 가로채기 위한 실험 플래그.
// 반드시 브라우저 launch 전에 설정되어야 한다 — config는 워커 프로세스에서도
// 로드되므로 여기서 설정하면 모든 워커에 적용됨.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',

  // 확장프로그램 설치 + Service Worker 기동 + 파싱 라이브러리 로드 시간 고려
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // Persistent Context(고정 프로필) 기반이므로 테스트 파일 내 병렬화는 끈다.
  // 워커도 1개로 고정 — 동일 확장프로그램을 여러 프로필로 동시에 띄우면
  // 로컬에서는 동작하지만 CI 리소스 낭비가 크다.
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,

  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],

  use: {
    // Chrome Extension은 Chromium 계열에서만 동작.
    // channel: 'chromium' → headless 시 "새 Headless 모드"가 사용되어
    // 확장프로그램 로딩이 가능 (구 headless는 확장프로그램 미지원).
    channel: 'chromium',

    // 로컬: 창을 띄워 디버깅 (headed), CI: 새 headless 모드.
    // 로컬에서 headless로 돌리려면: $env:CI='1' 또는 use.headless 수정.
    headless: !!process.env.CI,

    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
