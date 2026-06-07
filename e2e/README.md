# 법고개 E2E 테스트 (Playwright)

Chrome Extension(MV3) 전체를 실제 Chromium에 로드하여
Intelligent Document Reader(`viewer.html`)의 핵심 플로우를 검증한다.

## 구성

| 파일 | 역할 |
| --- | --- |
| `playwright.config.js` (루트) | E2E 전용 설정 — SW 네트워크 인터셉트 플래그, 워커 1개 고정, CI에서만 headless |
| `e2e/fixtures.js` | 커스텀 픽스쳐: 확장 로드된 Persistent Context / 동적 `extensionId` / `viewerPage` + 법제처·R2 모킹 |
| `e2e/viewer.spec.js` | 시나리오 6종 (초기 렌더링, 업로드·파싱, 드래그&드롭, 칩 클릭→법제처 조회, 초기화) |

## 설치 (최초 1회)

```powershell
npm install                       # @playwright/test 포함 의존성 설치
npx playwright install chromium   # Chromium 브라우저 바이너리 설치
```

## 실행

```powershell
npm run test:e2e          # 로컬: 창을 띄워(headed) 실행 / CI($env:CI 설정 시): 새 headless
npm run test:e2e:headed   # 항상 창을 띄워 실행
npm run test:e2e:debug    # Playwright Inspector로 스텝 디버깅
npm run test:e2e:report   # 마지막 실행의 HTML 리포트 열기

npx playwright test --grep "칩 클릭"   # 특정 테스트만 실행
```

기존 단위 테스트(`npm test`, Jest)와는 완전히 분리되어 있다
(Jest는 `testPathIgnorePatterns`로 `e2e/`를 제외).

## 동작 원리 (확장프로그램 특수 처리)

1. **Persistent Context 강제** — 확장프로그램은 일반 `browser.newContext()`로 로드할 수 없어,
   `fixtures.js`에서 매 테스트마다 임시 프로필 디렉터리로 `chromium.launchPersistentContext()`를 호출하고
   `--disable-extensions-except` / `--load-extension`으로 `./extension/`을 강제 로드한다.
   테스트 간 상태(IndexedDB, storage)가 격리된다.
2. **Headless 지원** — `channel: 'chromium'` + 새 Headless 모드 조합으로만 확장프로그램이 동작한다
   (구 headless는 미지원). 로컬 기본은 headed, `CI` 환경변수 설정 시 headless.
3. **동적 확장 ID** — MV3에는 `backgroundPage`가 없으므로 `context.serviceWorkers()` /
   `waitForEvent('serviceworker')`로 백그라운드 SW를 찾아 URL에서 ID를 추출한다.
4. **Service Worker 네트워크 모킹** — 법제처 조회(`FETCH_LAW_HTML`)는 viewer가 아니라
   백그라운드 SW(`db-sync.js`)가 fetch한다. SW의 요청을 `context.route()`로 가로채려면
   `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1`이 필요하며, 이는
   `playwright.config.js` / `fixtures.js`가 자동 설정한다. `page.route()`는 SW 요청을 잡지 못한다.
5. **Hermetic 기본 모킹** — 픽스쳐가 기본으로 `api.bup.live`(R2 동기화)는 abort,
   `www.law.go.kr`는 모의 검색/상세 HTML로 fulfill한다. 테스트에서 `context.route()`를
   다시 등록하면 그 핸들러가 우선한다(나중 등록 우선) — 칩 클릭 테스트가 이 방식으로
   요청 URL 감시 + 지연 응답을 구현한다.

## 주의사항

- SW가 확장 설치 직후(라우트 등록 전) 보내는 최초 동기화 요청 1회는 인터셉트를
  빠져나갈 수 있다. 테스트는 동기화 결과(verified/unverified 칩 색상)에 의존하지 않도록 작성되어 있다.
- 새 테스트에서 법제처 응답을 커스텀하려면 `fixtures.js`의
  `buildSearchResultHtml()` / `buildPrecDetailHtml()` 빌더를 재사용할 것 —
  viewer가 파싱하는 셀렉터(`.contsList .conts_list_title a`, `#conScroll`)를 보장한다.
- 실패 시 `playwright-report/`에 트레이스·스크린샷이 남는다 (`npm run test:e2e:report`).
