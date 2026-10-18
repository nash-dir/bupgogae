# 법고개 0.9.0 잔여 최적화 정밀점검 의뢰서

- 작성일: 2026-10-11
- 대상 브랜치: `agent/0.9.0-hardening`
- 대상 버전: Chrome Extension MV3 `0.9.0`
- 점검 기준: 커밋 `HEAD`만이 아니라 **현재 작업트리 전체**. 현재 작업트리에는 아직 커밋하지 않은 정확성·무결성 하드닝이 포함되어 있으므로 `git diff`와 미추적 파일까지 함께 검토한다.
- 목적: 이미 확정한 정확성·무결성 정책을 훼손하지 않으면서, 사용자 체감 성능, 메모리·저장공간, 네트워크·IPC, DB 동기화, 수집·게시, 테스트·릴리스 비용에서 남은 병목과 불필요한 작업을 찾고 우선순위가 있는 개선안을 제시한다.

## 1. 의뢰 배경

최근 보완에서 다음 항목은 이미 구현하거나 정책을 확정했다.

- 정확히 4글자인 사건번호는 활성 DB snapshot에서 파생한 canonical key에 포함된 경우에만 탐지한다. 현재 번들 기준 목록은 약 860건이며 `Set` 조회로 거른다.
- `2026헌가1` 같은 4자리 연도 표기와 5글자 이상 사건번호는 기존 탐지 범위를 유지한다.
- DB hit, DB miss, 형식·지원범위 경고, 조회 미완료를 각각 초록·주황·빨강·회색으로 구분한다.
- 콘텐츠 DOM 작업은 200개 노드 또는 약 16ms마다 메인 스레드에 양보하고, 반복 지연에는 서킷 브레이커를 둔다.
- DB는 inactive A/B object store에 전수 staging·검증한 뒤 active pointer를 전환한다.
- 설치·시작·알람·수동·drift 동기화는 single-flight로 직렬화한다.
- payload는 hash, version, total과 전 레코드 스키마를 검증하며, 부분 수집은 게시하지 않는다.
- 최근 로컬 검증에서는 ESLint, Jest 205건, Python unittest 87건, extraction 평가 13개 표본, Playwright E2E 15건을 통과했다. 이 수치는 참고값일 뿐이며 점검자는 대상 작업트리에서 다시 측정해야 한다.
- 기준 DB는 `20260922`, 132,372건이며 번들에 canonical 4글자 key 860건이 포함된다.

이번 의뢰는 위 조치의 반복 검토가 아니라 **그 밖의 잔여 최적화 기회와 새 조치가 만든 2차 비용**을 찾기 위한 것이다.

## 2. 반드시 유지할 결정과 비기능 요구사항

다음 조건은 최적화 과정에서 변경할 수 없는 guardrail이다. 이를 바꾸는 제안은 별도 정책 변경안으로 분리하고, 기본 권고안으로 채택하지 않는다.

1. 정확히 4글자인 후보를 canonical 목록 없이 포괄 정규식으로 탐지하지 않는다.
2. canonical 판정은 오탐을 허용하는 Bloom filter 단독 판정으로 대체하지 않는다. 전처리용으로 제안할 경우에도 최종 exact membership 검사를 유지한다.
3. 5글자 이상 및 4자리 연도 사건번호의 현재 인식 범위를 축소하지 않는다.
4. lookup 실패·timeout을 DB miss로 간주하지 않는다. 회색 상태와 재시도 의미를 유지한다.
5. active snapshot의 레코드와 court map·canonical 목록을 서로 다른 세대에서 섞지 않는다.
6. payload hash·version·total·전수 스키마 검증, downgrade 차단, last-known-good, 부분 게시 차단을 생략하지 않는다.
7. 사용자 대화 원문과 추출 문자열을 외부 서버로 보내지 않는다. host 권한을 넓히지 않는다.
8. 페이지 편집 영역, 입력창, 확장 자체 배지는 스캔하지 않는다.
9. 실제 서비스 계정·개인 대화는 성능 표본으로 수집하지 않는다. 승인된 테스트 페이지나 비식별 합성 fixture를 사용한다.
10. 측정값 없이 “더 빠를 것”이라는 이유만으로 복잡도, 캐시, 병렬성 또는 영구 상태를 추가하지 않는다.

## 3. 점검 질문

### 3.1 콘텐츠 스크립트와 DOM hot path

다음을 Chrome Performance/Memory trace와 계측값으로 확인한다.

- MutationObserver가 스트리밍 토큰·강조 태그·응답 재렌더를 얼마나 잘 병합하는가. 같은 컨테이너 또는 같은 텍스트가 불필요하게 재스캔되는가.
- `findResponseContainers()`의 selector 질의, 컨테이너 중복, 중첩 컨테이너, 이미 처리한 응답의 재순회 비용은 얼마인가.
- TreeWalker의 `parent.closest(...)` 연쇄 호출이 대형 DOM에서 지배 비용이 되는가. 필터 순서나 subtree 제외로 실질적인 이득이 있는가.
- 수집 단계가 모든 텍스트 노드를 배열로 보관한 뒤 탐지하는 방식 때문에 peak heap 또는 GC가 불필요하게 증가하는가. 수집·탐지의 streaming/iterator 결합이 유효한가.
- `extractCaseNumbers`, 파싱, 검증, 압축 키 생성이 한 후보에 중복 수행되는가. 결과 재사용이 정확성을 해치지 않고 가능한가.
- 정확히 4글자인 독립 노드의 `Set` fast path가 실제로 regex와 IPC를 충분히 제거하는가. canonical이 아닌 대량 4글자 텍스트에서 `LOOKUP_BATCH`가 0회인지 확인한다.
- 정규식 생성·실행 시간이 사건부호 수, 단일 텍스트 길이, 숫자 밀도에 대해 선형적으로 유지되는가. catastrophic backtracking 또는 긴 무매치 tail이 없는가.
- 노드 분할, 배지 생성, tooltip·toast event listener, Shadow DOM, 스타일 계산과 layout이 긴 작업 또는 retained node를 만드는가.
- 처리 중 새 mutation이 들어올 때 reschedule 상한, 12초 starvation 방지, `_isProcessing` 상태가 누락·중복·긴 지연을 만들지 않는가.
- 탭을 오래 열어 둔 뒤 이미 제거된 메시지, badge, tooltip, timer 또는 callback이 heap에 남는가.
- `scheduler.yield()`와 `setTimeout(0)` fallback의 실제 slice 길이·입력 응답성 차이가 지원 브라우저에서 적절한가.
- 현재 서킷 브레이커가 총 동기 비용을 누적해 판정하는 방식이 실제 long task와 충분히 상관하는가. 정상적인 큰 응답을 반복 처리했을 때 불필요한 정지가 없는가.

### 3.2 사건번호 탐지와 canonical metadata

- `shortCaseKeys` 약 860개를 배열로 저장·전달한 뒤 각 콘텐츠 컨텍스트에서 `Set`으로 만드는 비용과 메모리는 어느 정도인가.
- 동일 canonical 목록이 번들 meta, IndexedDB snapshot metadata, runtime message 또는 여러 탭에 중복 보관되어도 현재 규모에서 의미 있는 비용인가. 의미가 없다면 “최적화 불필요”로 명시한다.
- 목록 정렬, compact encoding, prefix grouping, trie, bitset 등의 대안은 실제 byte·초기화 시간·조회 시간 개선이 있는가. 압축 해제 비용과 구현 복잡도까지 포함한다.
- metadata generation 변경 알림이 열린 모든 탭에서 불필요한 regex/Set 재구축이나 전체 DOM 재검사를 유발하는가.
- canonical 목록 생성이 DB 전체 순회와 별도 키 압축을 요구한다. 이미 수행하는 무결성 검증 또는 staging 순회와 안전하게 결합할 수 있는가.
- legacy snapshot의 `getAllKeys()` migration은 정확히 한 번만 수행되는가. 큰 legacy DB에서 startup을 막거나 여러 트리거로 반복되지 않는가.

단, 목록이 작아 최적화 이익이 수 ms 또는 수십 KiB에 그친다면 구조 변경 대신 현 상태 유지를 권고한다.

### 3.3 콘텐츠–서비스 워커 IPC와 조회 경로

- 한 처리 주기에서 압축 키 dedup이 제대로 작동하며, 같은 key를 여러 노드에서 발견해도 한 번만 조회하는가.
- 50개 단위 `LOOKUP_BATCH`의 최적 크기를 cold/warm IndexedDB와 서비스 워커 재기동 상태에서 비교한다.
- 여러 chunk를 직렬 처리하는 현재 방식과 제한 병렬 처리의 차이를 측정한다. snapshot 일관성·서비스 워커 부하·메시지 크기를 함께 평가한다.
- 매 chunk마다 court map을 응답하는 비용이 payload cloning과 탭 수 증가에서 의미 있는가. snapshot generation ID를 이용한 세션 캐시가 안전하고 이득이 있는가.
- hit뿐 아니라 miss를 캐시할 가치가 있는가. 제안 시 snapshot generation 변경 때 반드시 무효화하고, stale miss가 새 DB hit를 가리지 않는지 입증한다.
- timeout 8초, 최대 3회, 1초·2초 backoff가 실제 장애에서 중복 서비스 워커 wake-up 또는 최대 약 27초의 UI 지연을 만드는가.
- 탭 close/navigation, DOM 제거, 새 generation 도착 시 진행 중 lookup·retry를 취소할 수 있는가. 취소가 회색/평문 상태 의미를 왜곡하지 않는가.
- background의 readonly transaction 범위와 active pointer 읽기 횟수가 batch마다 최소인지, pointer 전환 중에도 세대 일관성이 유지되는지 확인한다.
- 브라우저 시작·content script 시작·popup 조회가 같은 metadata 또는 DB open을 중복 요청하는가.

### 3.4 DB 다운로드·검증·IndexedDB 설치

- 다운로드 청크 배열, 결합 `Uint8Array`, UTF-8 문자열, `JSON.parse` 객체, SHA-256 입력, A/B store가 동시에 존재할 때의 peak 메모리를 측정한다.
- SHA-256을 JSON parse 전후 어느 시점에 계산하는 것이 peak lifetime을 줄이는지 확인한다. integrity gate의 의미는 유지한다.
- 브라우저 Fetch가 gzip을 자동 해제한 뒤 50MB 제한을 적용하는 현재 경로에서 압축·비압축 크기의 의미와 방어 상한이 정확한가.
- 전수 `validateDbIntegrity`, canonical 파생, object store staging, count 검증에서 같은 132,372건을 몇 번 순회하는가. 안전하게 한 pass 또는 chunk pipeline으로 합칠 수 있는가.
- staging transaction의 chunk 크기와 commit 횟수가 설치 시간·메모리·중간 실패 복구에 적절한가.
- A/B store가 정상 상태에서 최대 2세대 전체 DB를 계속 보유하는지, 이전 store를 언제 비우는지, quota pressure에서 last-known-good를 보존할 수 있는지 확인한다.
- IndexedDB connection 30초 idle cache가 서비스 워커 수명, wake-up 수, 재open latency에 실질적으로 도움이 되는가.
- core count 계산에서 total/TX/KP range count와 metadata 조회를 반복하는 빈도, index/range 설계, 측정 가능한 비용을 확인한다.
- manifest, immutable payload, ETag, watchdog, 6시간 alarm, drift 치유가 같은 파일의 중복 fetch를 유발하지 않는가.
- DB 동기화 성공·실패와 무관하게 adapter config를 다시 가져오는 현재 흐름이 필요한가. ETag/TTL/독립 alarm이 더 나은지 측정한다.
- 설치 실패 후 staging 잔해 정리와 다음 재시도가 quota·시간에 미치는 영향을 확인한다.

### 3.5 확장 초기화, UI와 리소스

- 모든 지원 사이트에서 content script 6개를 즉시 로드하는 비용과 실제 parse/compile/execute 시간을 측정한다.
- meta, adapter config, DB 준비 순서 때문에 첫 탐지까지 불필요한 대기가 있는가. 초기 정확성을 희생하지 않는 범위에서 병렬화 가능한 부분을 찾는다.
- popup/sidebar의 상태 조회, sync ledger 렌더, tooltip 데이터 조립이 불필요한 전체 객체 복사·정렬·DOM rebuild를 하는가.
- 배지 CSS, tooltip layout, 접근성 속성, dark mode 대응이 layout shift나 과도한 style recalculation을 유발하는가.
- `console.log`의 대량 출력이 정상 사용·대형 응답·프로덕션 빌드에서 의미 있는 비용 또는 정보 노출을 만드는가.
- manifest의 권한, `web_accessible_resources`, 번들 파일이 실제 필요 범위보다 넓거나 큰지 검토한다. 권한 축소는 기능 회귀 없이 가능한 경우에만 제안한다.

### 3.6 수집·가공·게시 파이프라인

- `crawler_runner.py`의 날짜 범위 계획, DETC 최대 400페이지, 판례 범위당 최대 1,000페이지가 API 호출 중복과 긴 tail을 만들지 않는가.
- durable backlog 우선 재시도와 신규 수집이 starvation 또는 반복 실패 폭주를 만들지 않는가. retry-after, jitter, concurrency 제한을 평가한다.
- master DB upsert, dedup, 정렬, 검증, JSON 직렬화, gzip, SHA 생성 과정에서 같은 데이터를 몇 번 읽고 쓰는가.
- SQLite를 사용한다면 실제 주요 query에 `EXPLAIN QUERY PLAN`을 제시하고, index의 읽기 이득과 쓰기 비용을 함께 비교한다.
- 전체 snapshot을 매번 다시 직렬화·업로드해야 하는지 측정하되, 클라이언트의 단순하고 원자적인 full snapshot 계약을 훼손하는 delta update는 기본 권고안에서 제외한다.
- publication 전수 검증과 client 전수 검증의 역할이 중복인지 방어 계층인지 구분한다. 신뢰 경계를 바꾸지 않고 비용을 줄일 수 있는 경우만 제안한다.
- state/backlog snapshot의 최대 크기, 원자 저장, 원격 왕복, 오래된 객체 보존 정책과 운영 비용을 점검한다.
- 재현 가능한 deterministic package/payload를 유지하면서 gzip level, JSON separators, key order가 크기와 CPU에 미치는 영향을 비교한다.

### 3.7 테스트·CI·릴리스 경로

- Jest, Python, extraction evaluation, package, Playwright가 같은 정적 검증·패키징을 중복 수행하는지 의존 그래프로 정리한다.
- 전체 E2E 실행 시간이 최근 약 4분이었던 원인을 fixture별로 분해한다. 테스트 격리·결정성을 유지하는 범위에서 worker 병렬화, 공통 extension 준비, fixture 축소가 가능한지 평가한다.
- CI job마다 `npm ci`, Python setup, Chromium 설치, ZIP 생성이 발생하는 비용과 cache 가능 범위를 제시한다.
- package deterministic 검증이 같은 ZIP을 몇 번 만드는지, artifact 전달로 중복을 제거해도 clean-checkout 보증이 유지되는지 검토한다.
- 단위 테스트가 타이머와 JSDOM 구현 세부사항만 검사하고 실제 long task·heap·service worker lifecycle을 놓치는 부분을 찾는다.
- 실제 6개 서비스 smoke 미실행 상태를 성능 통과로 오인하지 않는다. 계정·약관 범위 안에서 수동 smoke의 최소 성능 기록 양식을 제안한다.
- flaky test를 단순 retry로 숨기는 방안은 채택하지 않는다. 원인과 재현율을 먼저 보고한다.

### 3.8 관측성·운영 비용

- 현재 sync ledger가 사용자가 문제를 진단하기에 충분하면서 쓰기·storage churn은 과하지 않은가.
- 성능 telemetry를 제안할 경우 기본값은 로컬 보관이어야 한다. 원격 전송은 이번 범위 밖이며 별도 동의·개인정보 검토 없이는 제안하지 않는다.
- 실패 reason, 단계별 duration, DB version, active store, payload byte, key count 중 어떤 최소 지표가 병목 재현에 필요한지 정한다.
- 로그와 계측을 제거했을 때 문제가 재현 불가능해지는 영역과, 프로덕션에서 항상 켜 둘 필요가 없는 verbose 로그를 구분한다.

## 4. 필수 시험 시나리오

합성 페이지와 고정 payload로 최소 다음 시나리오를 cold/warm 각각 5회 이상 수행한다. 중앙값과 p95 또는, 표본이 부족하면 최댓값과 개별값을 함께 보고한다.

| ID | 시나리오 | 필수 확인사항 |
| --- | --- | --- |
| PERF-DOM-01 | 사건번호 없는 텍스트 노드 10,000개 | scan 시간, 최대 sync slice, long task, heap 증가, IPC 0회 |
| PERF-DOM-02 | canonical이 아닌 고립 4글자 후보 10,000개 | regex 호출 수, lookup 0회, 배지 0개, 오탐 0건 |
| PERF-DOM-03 | 실제 canonical 4글자 후보 1·10·50·200개 | recall, dedup, batch 수, IDB transaction 수, 렌더 시간 |
| PERF-DOM-04 | 5글자 이상과 `2026헌가1` 혼합 200개 | 기존 recall 유지, partial match 없음, batch 분할 |
| PERF-DOM-05 | 숫자·한글이 많은 1MB 단일 텍스트 노드 | regex 시간, long task, 메모리, backtracking 징후 |
| PERF-DOM-06 | 1토큰/1mutation 스트리밍 5분 | observer callback 수, 실제 scan 수, settle 지연, 누락·중복 |
| PERF-DOM-07 | 컨테이너 교체·메시지 삭제·재생성 100회 | retained nodes/listeners/timers, duplicate badge |
| PERF-IPC-01 | 서비스 워커 cold start + 1·50·51·200 key | wake-up, message byte, latency, transaction, generation 일관성 |
| PERF-IPC-02 | timeout·SW restart·navigation | 재시도 수, 취소 가능성, 최종 Gray, stale callback 부작용 없음 |
| PERF-DB-01 | 빈 설치에서 번들 DB 활성화 | parse·검증·staging 단계별 시간, peak heap/storage |
| PERF-DB-02 | 이전 snapshot에서 새 snapshot 갱신 | A/B peak storage, lookup 중 갱신, pointer atomicity |
| PERF-DB-03 | hash 불일치·중간 쓰기 실패·quota 부족 | last-known-good 유지, 잔해 크기, 다음 재시도 비용 |
| PERF-DB-04 | 304, 같은 version/다른 hash, offline | 요청 수·byte, watchdog, 불필요한 full fetch 여부 |
| PERF-PIPE-01 | 증분 수집 없음·소량·대량·backlog 존재 | API 호출, DB I/O, CPU, peak RSS, 산출물 동일성 |
| PERF-CI-01 | 전체 release gate | job/step별 시간, cache hit/miss, 중복 작업, flaky 여부 |

실제 지원 사이트에서는 ChatGPT, Gemini, Claude, Copilot, Perplexity, Grok 각각의 DOM 구조와 스트리밍 패턴을 최소 한 번 확인하되, 자동화가 서비스 이용조건이나 계정 정책에 맞지 않으면 합성 fixture와 수동 기록으로 대체하고 그 한계를 명시한다.

## 5. 필수 측정 지표

각 수치는 측정 환경, 확장/DB 버전, cold/warm 여부, 표본 크기와 함께 기록한다.

- 사용자 경로: 첫 사건번호 탐지까지 시간, 전체 처리 완료 시간, 최대 sync slice, 50ms 초과 long task 수·총시간, 프레임 드롭 또는 INP 영향
- 탐지 경로: 스캔한 컨테이너·텍스트 노드·문자 수, regex 호출·후보·canonical 거절·배지 수, precision/recall
- IPC/DB: runtime message 수·byte, key 수, IndexedDB open·transaction·get/count/put 수, cold/warm latency, 서비스 워커 wake-up 수
- 메모리/저장공간: JS heap peak·settled·retained, 다운로드 중 peak, A/B staging 중 origin storage peak, 설치 후 정상 storage
- 네트워크: 요청 수, transferred/resource size, 200/304 비율, adapter/manifest/DB 중복 fetch, retry 수
- 파이프라인: 원천 API 호출 수, 재시도·backlog 수, wall/CPU time, peak RSS, DB/JSON/gzip byte, upload byte
- CI: job·step별 wall time, 설치·캐시·package·test 비중, artifact size

목표값을 임의로 맞추기 위해 fixture를 축소하지 않는다. 우선 baseline을 측정한 후 사용자가 체감할 수 있는 개선 목표를 제안한다. 단, 아래 항목은 최소 합격조건이다.

- canonical이 아닌 정확히 4글자 후보는 lookup과 배지를 만들지 않는다.
- 기존 extraction fixture의 precision과 recall을 낮추지 않는다.
- 합성 정상 시나리오에서 제품 코드가 만든 단일 동기 long task가 50ms를 넘는다면 원인과 완화안을 필수 보고한다.
- snapshot 전환 중에도 한 lookup 응답 안에서 세대가 섞이지 않는다.
- 장애 시 last-known-good와 Green/Orange/Gray 의미를 보존한다.
- 네트워크로 사용자 원문을 보내지 않는다.

## 6. 점검 방법

1. 먼저 현재 작업트리와 기준 환경을 고정한다.

   ```powershell
   git status --short --branch
   git rev-parse HEAD
   node --version
   npm --version
   python --version
   ```

2. 기존 gate를 재실행하고 실패가 있으면 최적화 논의보다 기준선 복구를 우선한다.

   ```powershell
   npm run lint:js
   npm test -- --runInBand
   npm run eval:extraction
   python -m ruff check pipeline scripts
   python -m unittest discover -s pipeline -p "test_*.py" -v
   npm run package
   npm run test:e2e
   git diff --check
   ```

3. 정적 코드 검토에서 의심 지점을 목록화하되 이를 곧바로 병목으로 단정하지 않는다.
4. 대표 fixture와 실제 브라우저 trace로 baseline을 측정한다.
5. 제안별로 최소 prototype 또는 benchmark에서 before/after를 비교한다. 제품 동작을 바꾸는 코드는 감사 결과와 분리한다.
6. 속도만이 아니라 정확성, 메모리, 저장공간, 복잡도, 장애 복구, 테스트 가능성의 손익을 함께 평가한다.
7. 측정 오차보다 작은 개선, 드물게 한 번 발생하는 수 ms 절약, 유지보수 복잡도가 더 큰 변경은 “하지 않을 최적화”로 분류한다.

## 7. 우선 검토할 파일

### 확장 runtime

- `extension/content/bupgogae-content.js`
- `extension/content/case-regex.js`
- `extension/content/precedent-badge.js`
- `extension/content/sidebar.js`
- `extension/content/adapters/*.js`
- `extension/background/db-sync.js`
- `extension/background/sync-utils.js`
- `extension/popup/popup.js`
- `extension/data/bupgogae_meta.json`
- `extension/data/db.json`
- `extension/data/adapters.json`
- `extension/manifest.json`

### 수집·게시·패키징

- `pipeline/api.py`
- `pipeline/crawler_runner.py`
- `pipeline/master_db.py`
- `pipeline/sync_state.py`
- `pipeline/manifest.py`
- `pipeline/publish_outputs.py`
- `pipeline/compress.py`
- `pipeline/validate.py`
- `scripts/package.py`
- `scripts/refresh_bundle_meta.py`

### 테스트·계약

- `extension/__tests__/`
- `evaluation/`
- `e2e/`
- `playwright.config.js`
- `.github/workflows/ci.yml`
- `docs/improvement-response-2026-09-23.md`
- `docs/data-integrity-contract.md`
- `docs/quality-evaluation.md`
- `docs/case-code-sources.md`

## 8. 결과물 형식

### 8.1 한 페이지 요약

- 가장 큰 병목 3개 이내
- 즉시 적용할 quick win
- 구조 변경이 필요한 항목
- 측정상 변경 가치가 없는 항목
- 정확성·보안·운영 측면의 주요 위험

### 8.2 기준선 표

환경과 모든 필수 시험 시나리오의 baseline을 표로 제시한다. 재현 명령, fixture, raw trace 또는 로그 위치를 포함한다.

### 8.3 발견사항 표

각 발견사항은 다음 열을 가진다.

| 필드 | 내용 |
| --- | --- |
| ID | `OPT-01` 형식 |
| 상태 | `검증됨` / `가설` / `재현 실패` / `변경 비권고` |
| 우선순위 | P0 정확성·중단 위험, P1 큰 체감/운영 이득, P2 보통, P3 미미 |
| 영역 | DOM, regex, IPC, IndexedDB, sync, pipeline, CI, memory 등 |
| 현재 동작 | 파일·함수·조건과 재현 절차 |
| 증거 | before 수치, trace/log/test 링크 |
| 원인 | 단순 증상이 아닌 root cause |
| 제안 | 구체적인 변경 경계와 대안 |
| 예상 효과 | latency/CPU/heap/byte/호출 수의 수치 또는 범위 |
| 비용·위험 | 정확성, 장애 복구, 복잡도, 호환성, 유지보수 |
| 검증 | 추가할 benchmark·단위·E2E·회귀 테스트 |
| 규모 | S/M/L 및 영향 파일 |

### 8.4 상세안과 실행 순서

- Phase 0: 계측·회귀 fixture 보강
- Phase 1: 동작 의미를 바꾸지 않는 low-risk quick win
- Phase 2: 충분한 측정 이득이 있는 구조 변경
- Phase 3: 운영 데이터가 쌓인 뒤 재평가할 항목

각 phase에는 선행조건, 합격 기준, rollback 조건, 예상 작업량을 적는다. 서로 독립적인 변경은 분리해 효과를 개별 측정할 수 있게 한다.

### 8.5 변경 비권고 목록

검토했으나 이득이 작거나 위험이 큰 아이디어도 누락하지 말고 기록한다. 특히 다음 유형은 수치가 없으면 비권고로 분류한다.

- 860개 canonical `Set`을 복잡한 자료구조로 교체
- 검증 pass 제거
- snapshot 원자성을 약화하는 in-place update
- 오탐 가능성이 있는 확률 자료구조 단독 판정
- 무제한 병렬 fetch·IndexedDB transaction
- 사용자 원문 원격 telemetry
- 테스트 의미를 줄이는 fixture 축소나 retry 확대

## 9. 구현으로 넘길 때의 완료 기준

점검 결과 구현을 제안하는 항목은 다음 조건을 모두 만족해야 한다.

1. 재현 가능한 baseline과 before/after 결과가 있다.
2. 기존 정확성·상태·snapshot·privacy 계약을 유지한다.
3. 회귀 테스트 또는 benchmark가 실패를 실제로 잡는다.
4. 단일 변경의 효과를 독립적으로 확인할 수 있다.
5. 오류·중단·quota·offline·서비스 워커 재시작 경로가 설명되어 있다.
6. 이득이 없는 환경에서 성능과 복잡도가 크게 악화되지 않는다.
7. 전체 release gate와 실제 Store ZIP E2E를 통과한다.
8. 문서화가 필요한 새 상수·캐시·만료·동시성 정책을 명시한다.

## 10. 최종 요청

코드 모양만 보고 미세 최적화 목록을 나열하지 말고, 실제 사용자 경로와 배포·운영 경로를 각각 측정해 병목의 크기를 입증해 달라. 특히 최근 도입한 canonical 4글자 정책, A/B snapshot, 전수 무결성 검증, cooperative DOM 처리의 비용을 투명하게 계측하되, 그 보호 기능을 제거하는 것을 성능 개선으로 계산하지 말아 달라.

최종 보고서는 “무엇을 바꿀까”뿐 아니라 “무엇은 이미 충분히 싸므로 바꾸지 않을까”까지 결론 내려야 한다. 권고 순서는 예상 체감·운영 효과, 정확성 위험, 구현·검증 비용을 함께 반영한다.
