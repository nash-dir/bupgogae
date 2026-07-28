# 0.9.0 release milestones

이 문서는 0.9.0 감사·무결성 보강을 production에 적용하는 순서와
go/no-go 기준을 정의한다. 코드 merge, R2 파이프라인 전환, Chrome Web Store
배포는 서로 다른 변경면이므로 한 번에 진행하지 않는다.

## 선정한 splash zone

### 1. 백엔드: 새 게시 프로토콜을 먼저 적용

첫 splash zone은 **0.8.2 Store 확장을 그대로 둔 상태에서 새 pipeline만
적용하는 구간**이다.

- 0.8.2는 계속 `db.json.gz` legacy mirror를 사용한다.
- 0.9.0 QA build만 manifest의 content-addressed `object_path`를 사용한다.
- immutable 객체 업로드는 manifest 전환 전까지 일반 사용자에게 보이지 않는다.
- 첫 성공 실행은 `current.json`을 만들고, 다음 성공 실행이 기존 current를
  검증해 `previous.json`으로 보존한다.

따라서 Store 제출의 backend 선행조건은 연속 두 번의 성공 실행과 최소
24시간, 권장 48시간의 관찰이다.

### 2. 클라이언트: 운영자 소유 QA 프로필

Chrome Web Store 공개 사용자가 10,000명 미만이면 percentage rollout을
사용할 수 없다. 공개 Store 사용자를 canary로 쓰지 않고 다음 세 전용 프로필을
사용한다.

1. 실제 0.8.2 IndexedDB v1 데이터가 있는 업그레이드 프로필
2. 데이터가 없는 0.9.0 신규 설치 프로필
3. stale ETag·실패 ledger를 가진 offline → online 복구 프로필

자동화는 Playwright bundled Chromium의 persistent context를 사용한다.
Chrome Stable parity는 별도의 QA 프로필 또는 별도 Trusted Testers Store
item으로 확인한다. 별도 Store item은 extension ID가 달라 실제 v1 → v2
migration의 대체물이 될 수 없다.

### 3. 실제 사이트 smoke

실제 사이트의 첫 대상은 selector 범위가 명확한 **읽기 전용 ChatGPT shared
conversation**으로 한다. 사용자 prompt를 제출하거나 개인 대화·개인 프로필을
사용하지 않는다. 그 다음 Gemini, 이후 Claude·Copilot·Perplexity·Grok
순으로 확대한다.

## M0 — Release candidate 고정

- [ ] `extension/manifest.json`, `package.json`, `package-lock.json`이 모두
      `0.9.0`인지 확인
- [ ] clean checkout에 `extension/data/db.json`이 존재하는지 확인
- [ ] `npm run bundle:meta` 후 bundle version·건수·법원 map 일치 확인
- [ ] `npm run package`로 `dist/bupgogae-0.9.0.zip` 생성
- [ ] ZIP SHA-256 기록 및 manifest·bundle·필수 실행 파일 존재 확인
- [ ] 신규 권한이 없는지 0.8.2 manifest와 비교
- [ ] 권한 있는 저장소 관리자가 Cloudflare Application Terms를 검토하고
      `CLOUDFLARE_WARP_TOS_ACCEPTED=true` repository variable 설정
- [ ] 고정된 공식 WARP package version·SHA-256과 `ubuntu-24.04` runner 확인

Go: 버전·bundle·ZIP·권한·WARP 약관 승인 precondition이 모두 일치한다.
No-go: clean checkout package가 로컬 package와 다르거나 실제 credential이
저장소에 포함된다.

현재 로컬 RC 증적(2026-07-28):

- manifest/package/lock version: `0.9.0`
- 내장 DB: `20260603`, 130,778 unique cases, 131 courts
- DB SHA-256:
  `553e5d49102bd987b583236204d739be4e6e192911645df0f7db0f4a8310dc7c`
- 결정적 ZIP: 19 entries, 2,337,710 bytes
- ZIP SHA-256:
  `a811e95b23a8f623fef523f746109ee9aa68f148c8411f9a69bd22e4e45c73ed`
- 0.8.2 대비 extension permission·host permission 추가 없음

같은 source tree에서 ZIP을 연속 두 번 생성해 SHA 일치를 확인했다. 이 값은
commit 후 clean-checkout CI가 다시 생성한 값과 일치해야 M0가 완료된다.
WARP consumer 등록에는 private key나 대체 Cloudflare credential이 필요하지
않다. 단, `CLOUDFLARE_WARP_TOS_ACCEPTED`는 법적 승인을 대신하는 자동값이
아니므로 권한 있는 저장소 관리자가 약관을 검토한 뒤 직접 설정해야 한다.

## M1 — Branch, CI, merge

- [ ] 감사 변경을 별도 branch에 push하고 Draft PR 생성
- [ ] Jest, Ruff, Python unittest, Playwright E2E를 PR commit SHA에서 통과
- [ ] secret이 없는 격리 `Official WARP local-proxy smoke` job에서 공식
      client 설치·ephemeral registration·MASQUE 연결·`warp=on|plus` 검증 통과
- [ ] v1 → v2 persistent-profile migration E2E 통과
- [ ] flaky test가 없고 실패 artifact에 secret·사건 원문이 없는지 확인
- [ ] 승인된 commit에서 release ZIP을 다시 생성해 SHA가 같은지 확인

Go: 원격 CI가 모두 green이고 검증 commit과 package commit이 같다.
No-go: 로컬 결과만 있거나 CI가 다른 commit을 검사했다.

## M2 — Backend splash

staffed window에서 main merge 후 `full_bootstrap=false`로 workflow를 수동
실행한다.

- [ ] 첫 실행: healthy legacy state → generation `current.json` 전환
- [ ] 두 번째 실행: 검증된 `previous.json` 생성
- [ ] current/previous가 각각 완전한 DB·backlog pair를 참조
- [ ] backlog 0, baseline·최근 데이터·헌재 health gate 통과
- [ ] manifest SHA = immutable gzip을 푼 raw SHA
- [ ] legacy mirror raw SHA도 manifest와 일치
- [ ] 기존 0.8.2 QA 프로필이 legacy mirror로 계속 동기화
- [ ] 0.9.0 QA 프로필이 `object_path`로 동기화
- [ ] 공식 WARP client registration/connect/trace 성공
- [ ] law.go.kr 403/429 및 finalize 오류 없음

Go: 연속 두 번 성공 후 24시간 이상 안정 상태.
No-go: pointer pair, object/manifest/mirror 중 하나라도 불일치하거나 backlog가
남은 결과가 공개된다.

## M3 — 브라우저 release smoke

### 자동 gate

```powershell
npm run lint
npm test -- --runInBand
.venv\Scripts\python.exe -m ruff check --no-cache pipeline scripts
.venv\Scripts\python.exe -m unittest discover -s pipeline -p "test_*.py" -v
npm run test:e2e
npm run package
```

Playwright는 임시 persistent profile을 사용한다. PR CI는 결정적 Store ZIP을
다시 만든 뒤 임시 디렉터리에 풀어 **실제 제출 산출물**을 로드하고, 로컬 개발
실행은 기본적으로 source extension을 로드한다.
`migration.spec.js`는 동일 extension 경로와 profile을 유지하면서 v1 legacy
DB를 만든 뒤 0.9.0으로 재시작하여 다음을 확인한다.

- DB version 2 및 `cases`, `cases_a`, `cases_b`, `metadata`
- legacy 레코드와 metadata의 비파괴 보존
- active pointer가 없을 때 legacy fallback
- 브라우저 재시작 후 같은 snapshot과 lookup 결과

### 실제 창 디버깅

```powershell
npm run test:e2e:headed
npm run test:e2e:debug
npx playwright test e2e/migration.spec.js --headed --trace on
npm run test:e2e:report
```

PR E2E는 `api.bup.live`와 `law.go.kr`을 route로 모킹하고 DNS도 loopback으로
고정해 초기 service-worker 요청이 production으로 빠져나가지 못하게 한다.
실환경 smoke는 별도 수동/scheduled job에서만 실행하며 extension origin의
outbound host를 `api.bup.live`와 사용자 요청 시 `www.law.go.kr`로 제한한다.

Go: 신규 설치, v1 migration, offline 복구, 재시작이 모두 green이다.
No-go: service worker/page exception, snapshot count/hash 회귀, allowlist 외
요청이 하나라도 있다.

## M4 — Chrome Web Store staging

- [ ] Store listing을 `store/listing.md`와 동일하게 갱신
- [ ] Privacy practices와 HTTPS privacy URL 갱신
- [ ] 0.9.0 ZIP 업로드 후 자동 게시를 끄고 deferred publishing 선택
- [ ] 심사 승인 artifact의 version·SHA를 M0 artifact와 대조
- [ ] QA Chrome Stable 프로필에서 설치·동기화·재시작 smoke
- [ ] 호환 DB_VERSION 2를 유지하는 0.9.1 emergency package 준비

현재 사용자 규모에서는 percentage rollout을 전제로 하지 않는다. 심사 통과는
공개가 아니며, 담당자가 수동 게시하기 전까지 0.8.2가 유지된다.

## M5 — 공개와 관찰

담당자가 즉시 대응할 수 있는 시간에 100% 게시한다.

- 게시 직후: Store/update endpoint의 실제 CRX version 확인
- 1시간: QA upgrade profile의 DB version·active store·sync ledger
- 6시간: 정기 sync 후 version·count·hash
- 24시간/48시간: Store 상태와 current/previous state 양면 점검

클라이언트 telemetry를 새로 수집하지 않으므로 QA profile과 공개 backend
무결성 검사가 주 관측 수단이다.

## Rollback

0.9.0이 IndexedDB를 v2로 올린 뒤 DB_VERSION 1인 0.8.2 package로 되돌리면
DB open이 실패할 수 있다. 클라이언트 rollback은 0.8.2 재배포가 아니라
DB_VERSION 2와 legacy/A/B 읽기 호환을 유지하는 **0.9.1 forward fix**로 한다.

백엔드는 별도로 직전 검증 manifest/mirror와 `previous.json`이 가리키는 완전한
state를 복구한다. 코드 revert만으로 이미 전환된 R2 pointer는 복구되지 않는다.

## 참고

- Chrome Web Store update·partial rollout:
  <https://developer.chrome.com/docs/webstore/update/>
- Playwright extension persistent-context testing:
  <https://playwright.dev/docs/next/chrome-extensions>
- Playwright trace debugging:
  <https://playwright.dev/docs/trace-viewer>
