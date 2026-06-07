/**
 * 법고개(Bupgogae) — Chrome Extension E2E 커스텀 픽스쳐
 * ========================================================
 * MV3 확장프로그램 테스트를 위한 픽스쳐 모음.
 *
 *   context       — 확장프로그램이 강제 로드된 Persistent Context.
 *                   외부 네트워크(R2 동기화, 법제처)는 기본적으로 모킹되어
 *                   테스트가 인터넷 없이도(hermetic) 돌아간다.
 *   extensionId   — 백그라운드 Service Worker URL에서 동적으로 추출한 확장 ID.
 *   extensionPage — 확장 오리진의 정적 페이지(privacy.html)로 이동을 마친 Page.
 *                   chrome.runtime 메시지를 SW로 보내는 구동용 (페이지 자체
 *                   스크립트가 없어 부수효과 없이 깨끗하다).
 *
 * 사용 예:
 *   const { test, expect } = require('./fixtures');
 *   test('...', async ({ extensionPage }) => { ... });
 */

// Service Worker가 보내는 fetch를 context.route()로 가로채기 위한 실험 플래그.
// playwright.config.js에서도 설정하지만, 픽스쳐 단독 사용 대비 이중 안전장치.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { test: base, chromium, expect } = require('@playwright/test');

/** 확장프로그램 소스 루트 (manifest.json 위치) */
const EXTENSION_PATH = path.resolve(__dirname, '..', 'extension');

// ============================================================
// 법제처(law.go.kr) 모의 응답 HTML 빌더
// ============================================================

/**
 * 판례 검색 결과 페이지 모의 HTML.
 * 법제처 검색 결과를 파싱하는 클라이언트 셀렉터(.contsList .conts_list_title a)와
 * href 패턴(javascript:showPrec('NNNN'))을 그대로 재현한다.
 * @param {string} precSeq - 판례 일련번호
 * @param {string} title   - 검색 결과 제목
 */
function buildSearchResultHtml(precSeq = '235282', title = '대법원 판결') {
  return `<!DOCTYPE html><html><body>
    <div class="contsList">
      <div class="conts_list_title">
        <a href="javascript:showPrec('${precSeq}')">${title}</a>
      </div>
    </div>
  </body></html>`;
}

/**
 * 판례 상세 페이지 모의 HTML.
 * 법제처 상세 페이지의 #conScroll 컨테이너 구조를 재현.
 * @param {string} bodyText - 판례 본문 텍스트
 */
function buildPrecDetailHtml(bodyText = '모의 판례 본문입니다.') {
  return `<!DOCTYPE html><html><body>
    <div id="conScroll">
      <h2>판시사항</h2>
      <p>${bodyText}</p>
    </div>
  </body></html>`;
}

/**
 * context에 법제처 기본 모의 라우트를 설치.
 * 테스트에서 context.route()를 다시 등록하면 그 핸들러가 우선 적용된다
 * (Playwright는 나중에 등록된 라우트부터 매칭).
 * @param {import('@playwright/test').BrowserContext} context
 */
async function installDefaultLawMock(context) {
  await context.route('https://www.law.go.kr/**', (route) => {
    const url = route.request().url();
    if (url.includes('/precSc.do')) {
      return route.fulfill({ contentType: 'text/html', body: buildSearchResultHtml() });
    }
    if (url.includes('/precInfoP.do')) {
      return route.fulfill({ contentType: 'text/html', body: buildPrecDetailHtml() });
    }
    return route.fulfill({ contentType: 'text/html', body: '<html></html>' });
  });
}

// ============================================================
// 커스텀 픽스쳐
// ============================================================

const test = base.extend({
  /**
   * 확장프로그램이 로드된 Persistent Context.
   * 매 테스트마다 임시 프로필 디렉터리를 새로 만들어 상태(IndexedDB 등)를 격리.
   */
  context: async ({ headless, channel }, use) => {
    const userDataDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'bupgogae-e2e-'),
    );

    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: channel || 'chromium',
      headless,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
      // MV3 Service Worker 허용 (기본값이지만 명시)
      serviceWorkers: 'allow',
    });

    // ── Hermetic 네트워크 기본값 ──
    // 1) R2/원격 설정 요청은 "영구 보류" — abort가 아닌 hold인 이유:
    //    abort는 설치 시점 동기화를 실패시켜 번들 DB 폴백(92k건 삽입)을
    //    유발하므로 테스트 초기 상태가 비결정적으로 오염된다.
    //    hold는 설치 동기화를 fetch 단계에서 잠재워 DB를 빈 상태로 유지하고,
    //    동기화 테스트는 자체 route를 나중에 등록해(우선 매칭) 흐름을 직접 구동한다.
    await context.route('https://api.bup.live/**', () => { /* 의도적 미응답 */ });
    // 2) 법제처 요청은 기본 모의 응답 (테스트에서 재등록하여 오버라이드 가능)
    await installDefaultLawMock(context);

    await use(context);

    await context.close();
    await fs.promises.rm(userDataDir, { recursive: true, force: true })
      .catch(() => { /* Windows 파일 잠금 등으로 실패해도 테스트는 통과 */ });
  },

  /**
   * 백그라운드 Service Worker로부터 동적으로 추출한 확장프로그램 ID.
   * MV3에서는 backgroundPage 대신 serviceWorker 이벤트를 사용한다.
   */
  extensionId: async ({ context }, use) => {
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker');
    }
    // URL 형식: chrome-extension://<EXTENSION_ID>/background/db-sync.js
    const extensionId = serviceWorker.url().split('/')[2];
    await use(extensionId);
  },

  /**
   * 확장 오리진의 정적 페이지로 이동을 마친 Page.
   * SW에 chrome.runtime.sendMessage를 보내는 구동용 — privacy.html은
   * 자체 스크립트가 없어 테스트에 부수효과를 만들지 않는다.
   */
  extensionPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/privacy.html`);
    await page.waitForLoadState('domcontentloaded');
    await use(page);
  },
});

module.exports = {
  test,
  expect,
  EXTENSION_PATH,
  buildSearchResultHtml,
  buildPrecDetailHtml,
};
