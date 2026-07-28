# 법고개 E2E 테스트 (Playwright)

Chrome Extension(MV3) 전체를 실제 Chromium에 로드하여
DB 동기화 견고성·Drift 안전망의 핵심 플로우를 검증한다.

## 구성

| 파일 | 역할 |
| --- | --- |
| `playwright.config.js` (루트) | E2E 전용 설정 — SW 네트워크 인터셉트 플래그, 워커 1개 고정, CI에서만 headless |
| `e2e/fixtures.js` | 커스텀 픽스쳐: 확장 로드된 Persistent Context / 동적 `extensionId` / `extensionPage` + 법제처·R2 모킹 |
| `e2e/sync.spec.js` | 동기화 견고성 + drift 안전망 11개 시나리오 |
| `e2e/render.spec.js` | Gemini 형태 DOM의 다중 사건번호 렌더링 2개 시나리오 |
| `e2e/migration.spec.js` | 동일 확장 경로·브라우저 프로필에서 실제 v1 legacy IndexedDB를 v2로 올리고, 비파괴 fallback 조회와 재시작 보존을 검증 |

> Intelligent Document Reader(viewer)는 이번 0.9.0 무결성 릴리스 범위에
> 포함하지 않으며 별도 기능 릴리스로 보류한다.

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

npx playwright test e2e/render.spec.js --headed # 실제 창의 렌더 smoke
npx playwright test e2e/migration.spec.js # 실제 브라우저 v1→v2 migration만 실행
```

CI는 `scripts/package.py`가 만든 Store ZIP을 임시 디렉터리에 풀고
`BUPGOGAE_EXTENSION_PATH`로 그 디렉터리를 지정한다. 따라서 CI 전체 E2E는
개발 소스가 아니라 실제 제출 산출물을 로드한다. 로컬에서 같은 경로를
재현하려면 ZIP을 임시 디렉터리에 푼 뒤 다음처럼 실행한다.

```powershell
$env:BUPGOGAE_EXTENSION_PATH = 'C:\tmp\bupgogae-store-package'
npx playwright test --headed
Remove-Item Env:BUPGOGAE_EXTENSION_PATH
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
4. **Service Worker 네트워크 모킹** — 법제처 조회(`FETCH_LAW_HTML`)와 R2 동기화는
   백그라운드 SW(`db-sync.js`)가 fetch한다. SW의 요청을 `context.route()`로 가로채려면
   `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1`이 필요하며, 이는
   `playwright.config.js` / `fixtures.js`가 자동 설정한다. `page.route()`는 SW 요청을 잡지 못한다.
5. **Hermetic 기본 모킹** — 픽스쳐가 기본으로 `api.bup.live` 요청을 404로
   차단해 실제 bundle fallback을 실행하고, `www.law.go.kr`는 모의
   검색/상세 HTML로 fulfill한다. 테스트가 등록한 route는 나중 등록 우선순위로
   기본 응답을 덮어쓸 수 있다. launch 인자에서도 두 production host를
   loopback으로 고정하므로 route 등록 전 최초 요청도 외부로 나가지 않는다.
6. **실제 profile migration** — `migration.spec.js`는 임시 경로에 최소 v1 확장을 먼저
   실행해 legacy `cases`/`metadata`를 기록한다. 브라우저 종료 후 같은 확장 경로와
   `userDataDir`에 현재 소스를 넣어 다시 실행하므로 unpacked extension ID와 IndexedDB
   origin이 유지된다. 원격 호스트와 번들 교체는 차단해 테스트를 hermetic하게 유지한다.

## 주의사항

- SW가 확장 설치 직후 route 등록보다 먼저 요청할 수 있으므로 DNS를 loopback에
  고정한다. 이 fail-closed launch 인자를 제거하면 PR E2E가 production endpoint에
  닿을 수 있으므로 유지해야 한다.
- 새 테스트에서 법제처 응답을 커스텀하려면 `fixtures.js`의
  `buildSearchResultHtml()` / `buildPrecDetailHtml()` 빌더를 재사용할 것 —
  클라이언트가 파싱하는 셀렉터(`.contsList .conts_list_title a`, `#conScroll`)를 보장한다.
- 실패 시 `playwright-report/`에 트레이스·스크린샷이 남는다 (`npm run test:e2e:report`).
