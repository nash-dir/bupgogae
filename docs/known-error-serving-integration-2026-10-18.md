# 정정 사전 연결과 Cloudflare master 대조 결과

> 이 문서의 수치와 범위는 당시 감사 기록입니다. 현재 범위와 후속 검증은 [법원·헌재 전용 전환 결과](court-only-cleanup-2026-10-18.md)를 따릅니다. 법원·헌재 판례는 국세 출처·특허 주제로 제외하지 않습니다.


2026-10-18 KST. **운영 게시 전 검토용 결과**다. 정정 사전의 실제 수집·export 경로 연결과 Cloudflare master 사본 병합을 수행했다. 운영 업로드·pointer 전환·workflow 실행·push는 하지 않았다. `publishBlocked=true`다.

## 실제 master를 사용한 복구

Cloudflare R2에서 기존 `sync_state`의 읽기 경로로 master를 내려받았다. 현재 `current.json` generation pointer와 legacy backlog 객체는 없으며 master는 legacy fixed key에 있다. backlog 객체의 404를 수집 실패가 모두 해소됐다는 뜻으로 해석하지 않았다.

| 항목 | 결과 |
| --- | ---: |
| 내려받은 master | 322,855행 / 91,279,360 bytes |
| 검증된 복구 부분집합 | 29,273 ID |
| 실제 신규 INSERT | 29,269행 |
| 기존 필드 완전 일치 | 3행: `192184`, `419106`, `420836` |
| 기존 raw 보존 후 정정 overlay | 1행: `119266` |
| 최종 로컬 master | **352,124행** |
| 복구분 전수 export 대조 | **29,273 ID / 29,280키 / 29,357개 연결** |
| 기존 raw 변경 | **0행**, `inserted_at`·clean 번호를 포함한 7개 열 전부 대조 |

`119266`의 저장 번호 `92가단2901판결`은 raw 그대로 남기고, 이미 원문·공식 목록에서 검증한 `92가단2901`을 export에 적용했다. 법원 약칭을 일반적인 규칙으로 확장하지 않았다. 기대 raw가 바뀌면 정정 적용을 중단한다.

복구분 내부의 동일 번호·법원·날짜 5쌍은 각 출처 ID의 상세 XML과 이전 전수 검증 결과를 다시 확인했다. `619309/617237`, `622281/619009`, `622367/618825`, `623417/623399`, `624099/622905` 모두 원래의 별도 게재 ID를 보존했다. 서로 다른 판결이라고 추정하거나 한쪽 게재를 삭제하지 않았다. 이 예외는 정확한 레코드·상대 ID·근거를 고정한 병합 검토 파일에 한정했다.

원격 master를 마지막으로 GET 스트림 전체 해시 및 HEAD/GET/HEAD ETag로 다시 확인했다. 내려받은 원본 SHA는 `afe4660876f2bc6913f35853be3f4e75b9b85f6ee807dfb810833860dfff0237`, 병합 사본 SHA는 `b2ec95a28d81e66a9ba41c2f9b9c8ee47a362d3c467fbb2d1585e81861518a84`다. 원격 원본과 로컬 입력 사본은 변경하지 않았다.

현재 공개 DB의 모든 ID는 내려받은 master에 있고, 앞서 만든 로컬 후보의 모든 ID는 병합 master에 있음을 확인했다. 복구 ID의 번호·법원·날짜·사건명은 앞선 검증 후보와 모두 일치한다. 기존 `kipris_cases`, `kipris_backfill_log` 테이블도 전부 대조했다. 이 원격 master에서 두 테이블은 각각 0행이었다. 국세·특허 레코드 삭제나 정기 수집 범위 변경은 없다.

근거: [원격 재확인](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/production-state/remote-readback-verification.json), [병합 영수증](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/merged-master/recovery-merge-receipt.json), [독립 전수 검사](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/merged-master-independent-verification.json), [공개본·master ID 대조](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/public-master-identity-drift.json).

## 검토용 새 서빙 세대

병합 master를 읽기 전용으로 열어 승인된 29,273 ID를 다시 export하고, 현재 공개본의 모든 레코드를 보존한 **검토용 version `20261018`**을 만들었다. 승인된 roster 밖의 기존 raw를 자동 추가하지 않았다. 정정된 값은 master export에서 가져왔으며, 앞선 후보와 키·레코드별로 전수 대조했다.

- 161,719키 / 163,478개 연결 / canonical 861키, 비압축 12,011,201 bytes / gzip 2,615,756 bytes.
- 새 payload SHA: `ba25aa34836c3989c0747817270a8eda836ed8b80b15bb8024a6b31031fc0dd5`.
- 실제 Store ZIP의 새 프로필에 설치하고 **29,280키 전수 조회·법원 사전·canonical·hash·동일 A/B 세대를 검증**, 19.5초, retry 0, 기존 제한 60초.
- 기존 국세·특허 계열 TX/KP 639키를 그대로 유지했다. 전체 physical 161,719와 core 161,080을 각각 확인했다.

이는 **고정된 last-known-good와 검증된 복구 roster를 결합한 검토용 생성 경로**다. 아래에서 실패한 일반 master 전체 export·증분 health gate를 통과했다고 표시하거나 자동 게시 경로로 우회하지 않았다. 원문 목록 cutoff는 여전히 2026-10-17이고 `sourceComparisonsComplete=false`다. 19.5초는 이 데이터 검증 1회의 측정값이며 성능 개선 전후 비교가 아니다.

결과물: [새 세대 build 영수증](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/reviewed-generation/build-receipt.json), [새 DB](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/reviewed-generation/db.json), [브라우저 검증](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/browser-verification.json).

## 정정 dictionary의 영구 경로 연결

- [known-errors.json](C:/projects/bupgogae/pipeline/known-errors.json): schema **3**, version `20261018`, 884항목. 검증된 정정 760항목 중 이번 후보에 추가한 **704항목**을 자동 적용 대상으로 삼았다. 기존 연결로 확인된 56항목과 미해결 124항목은 자동 추가하지 않는다.
- [known_errors.py](C:/projects/bupgogae/pipeline/known_errors.py): 출처·ID·기대 목록 7필드·법제처 비교 해시·공단 원문 전체 해시가 일치해야 적용한다. 지정한 두 HTTPS 경로만 허용하고 redirect를 허용하지 않는다. 원문당 10 MiB, 연결 10초/읽기 30초 제한이며 별도 재시도 확대는 없다.
- [crawler_runner.py](C:/projects/bupgogae/pipeline/crawler_runner.py): 기존 사건번호·날짜 검증 전에 알려진 오류를 보강한다. 정정 후에도 실제 요청 날짜 범위를 검사한다. 변경·접속 실패·보류는 분류된 오류로 durable backlog에 남겨 기존 게시 차단 정책을 유지한다.
- [master_db.py](C:/projects/bupgogae/pipeline/master_db.py): 정정 영수증과 레코드를 같은 transaction에 저장한다. 원래 목록 필드와 해시를 보존하며, 정정 대상에 대한 무근거 갱신이나 raw/clean 번호 변조를 export에서 차단한다. 기존 master 정정은 raw 행을 덮어쓰지 않는 별도 overlay다.
- [prepare_known_errors.py](C:/projects/bupgogae/scripts/prepare_known_errors.py): 해시로 고정한 검토 사전·목록·원문 inventory에서 배포용 사전을 재생성한다. 당사자·주소·원문 전문·API 인증 링크는 사전에 복사하지 않았다. 재생성 바이트 동일성을 확인했다.
- [sync_state.py](C:/projects/bupgogae/pipeline/sync_state.py): Cloudflare 공식 설정에 맞춰 R2 region을 `auto`로 명시했다. 다른 AWS region 환경변수의 영향을 막는 회귀를 추가했다. [Cloudflare 공식 boto3 문서](https://developers.cloudflare.com/r2/examples/aws/boto3/).

배포용 dictionary SHA는 `f1436667f7096e02ea045e3957ac4730659cb27b579dbefed8b648b507b674c8`다. 이전 상세 검토 사전과 원문 archive는 그대로 보존했다. 이번 사전이 모든 미래의 원 목록 결손을 포괄하는 일반 원문 수집기라는 뜻은 아니다. 미등록 형식은 기존 검증·실패 경로를 따른다.

### 실측한 법제처 화면의 가변 값

현재 화면 3건을 다시 GET했을 때 공단 원문 3건은 raw SHA가 동일했지만 법제처 HTML 3건은 달랐다. 전 바이트 대조 결과 차이는 `<head>`에 있는 **확인된 16개 JS·CSS 리소스의 숫자형 `?Time=` 값**뿐이었다. 이 때문에 HTML 전체 raw SHA만 기대하면 정상 판결도 매번 차단된다.

`law_head_resource_cache_time_v1`은 정확히 그 16개 경로의 10자리 숫자만 비교용으로 정규화한다. `<head>`의 유일성·16개 경로·각 1회 출현을 요구하며, **그 밖의 HTML 전체 바이트를 해시에 포함한다.** 판결 본문·식별 필드·URL·리소스 경로·HTML 구조·공백을 제거하거나 느슨하게 비교하지 않는다. 공단 원문은 여전히 raw 전체 SHA가 정확히 일치해야 한다. 기대 raw SHA와 실제 관측 raw SHA도 영수증에 각각 남긴다.

현재 3건 모두 정규화 후 통과했고, 본문 변경·추가 head·리소스 경로/외부 URL 변경은 회귀에서 차단했다. 저장 증거 704항목/1,408개 본문도 전부 재생해 같은 정정 결과를 확인했다. 접속 불가 `401336`은 마지막 재확인에서도 HTTP 500이며 자동 해제하거나 추가하지 않았다.

근거: [현재 raw 응답](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/live-source-probes/results.json), [현재 정규화 대조](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/live-normalized-dictionary-check.json), [704항목 재현](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/dictionary-replay.json), [사전 재생성](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/dictionary-regeneration-check.json).

정정은 서버의 새 완전한 snapshot 생성에 반영한다. 이후 hash·version·total·전수 스키마·법원 사전·canonical 검증과 inactive A/B staging을 거친다. 클라이언트 active store에 별도 patch feed를 덧대지 않는다. 이번 변경은 작업트리에 있으며 정기 운영 서버에는 아직 배포하지 않았다.

## 검증 결과

| 검사 | 결과 / 범위 |
| --- | --- |
| Python 전체 | **142개 통과**, 8.474초. 새 회귀 29개: 정정 15·병합/재개/readonly 13·R2 region 1 |
| 기존 원출처 census 회귀 | **29개 통과**, 5.949초 |
| Jest | **214개 / 10 suites 통과**, 8.173초 |
| ESLint / Ruff | 통과 |
| extraction | 13표본, TP 9 / FP 0 / FN 0, precision·recall 1.0 |
| 실제 Store ZIP 전체 E2E | **24개 통과**, 309.383초, retry 0 / skipped 0 / flaky 0 |
| 같은 ZIP cold 설치 5회 | **5개 통과**, retry 0, 기존 60초 제한 유지 |
| package | 19파일, 기존 제출 ZIP 및 테스트 추출본과 바이트 동일 |
| 병합 master | SQLite integrity·기존 전체 행·나머지 테이블·복구분 전수 필드 대조 통과 |

실제 ZIP SHA는 `e4926f236eb37c4707b189b7bab24cbe4b90312420695da95a87ed6b1adb575e`다. 이 단계의 확장 제품 코드는 바꾸지 않았고, 검증용 ZIP은 gitignore 아래 별도 경로에 생성했다.

cold fixture의 실제 준비 시간은 10.797 / 11.062 / 11.125 / 11.198 / 11.717초, 중앙값 **11.125초**, 최댓값 **11.717초**다. 브라우저 시작·실제 번들 설치·상태 확인을 포함하고 teardown은 제외했다. Node 22.17.1 / Chromium 148.0.7778.96 / Windows / headless / 실제 Store ZIP, fresh profile이다. 이전 cold 60초 실패는 이번 1회 전체 suite와 5회 반복에서는 재현되지 않았다. **원인을 고쳤다거나 모든 환경에서 재현되지 않는다고 결론 내리지 않았다.** warm 5회나 전체 최적화 시나리오를 새로 측정했다는 주장도 하지 않는다.

최초 샌드박스 실행에서는 Chromium 시작 차단, Jest temp cache rename 오류, 로컬 SOCKS 접속 차단이 있었다. 원인과 로그를 보존하고 Chromium·로컬 소켓은 허용된 실행 환경에서, Jest는 프로젝트 내부 cache에서 검사했다. 병합 영수증 저장 중 Windows 임시 파일 교체 오류 1회도 보존했고, 저장을 고유 임시 파일·fsync·원자 rename으로 바꿨다. 시험 retry·timeout 확대는 하지 않았다.

근거: [Python](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/python-release-gate-final.log), [Jest](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/jest-final.log), [E2E](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/e2e-baseline-unsandboxed.json), [cold 개별값](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/cold-install-timings.json), [package](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/package-verification.json).

## 운영 게시가 여전히 차단된 이유

코드 회귀 통과와 실제 운영 데이터 gate 통과는 다르다. 복구한 master 사본으로 기존 함수를 실제 실행한 결과:

1. `MasterDB.export_core()`는 기존 raw 병합 번호에서 **`ambiguous_merged_case_number`**로 실패한다. raw 전수 사전 검사에서 병합 형식 실패는 17행이다: 지방세 출처 11·국세 출처 5·조세심판 T-prefix 1. 지원하지 않는 축약이나 64자 초과 번호에서 일부만 골라 export하지 않았다.
2. `_verify_incremental_health()`는 **`historical_coverage_missing`**으로 실패한다. 전체 raw의 최소 날짜가 빈 문자열인 기존 상태가 원인이다. 역사 자료가 전혀 없다는 판정은 아니며, 이 오류를 무시하거나 건강성 gate를 약화하지 않았다.

현재 압축기가 그대로 해석하지 못하는 raw는 188,728행이다. 국세 출처 49,566, 별도 조세심판 T-prefix 자료 139,068, 지방세 출처 32, 대법원 4, 현재 고정 목록에서 출처를 확인할 수 없는 기존 ID 58행이다. 이 수치는 **새로 발견한 누락 판결 수가 아니다.** 기존 다른 데이터 경로·미지원 형식·오류를 포함한 raw 형식 점검 결과다. 기존 raw·국세·특허 자료를 삭제하거나 이번 범위로 끌어와 추정 복구하지 않았다. `119266` 1행은 위 raw 집계에 남아 있으나 검증된 overlay로 조회 번호를 복구했다.

앞선 29,081행 중 보류 124행, 이전 표본 보류 `412470`, 상세 충돌 보류 5건과 다른 목록 분류의 미해결 항목도 유지한다. 이번 단계는 기존 전수 분류의 보류 전체를 해제한 것이 아니다.

다음 운영 준비는 이 기존 raw hold를 출처·ID별로 명시해 원문/전체 번호를 보존하는 검토 기록과 연결하고, 대상 scope의 health 검사를 검증된 export 결과와 대조하는 것이다. 국세·특허 제외 범위와 기존 미해결 backlog 정책을 변경하지 않는 별도 정리가 필요하다. **현재 master를 그대로 업로드하거나, 두 gate를 우회해 후보를 자동 게시하면 안 된다.** 전체 master의 무인 운영 export는 아직 통과하지 않았다.

근거: [실제 운영 데이터 gate](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/actual-production-data-gates.json), [기존 형식·범위 집계](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/baseline-hold-scope-summary.json), [17개 병합 raw](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/baseline-merged-holds.json).

## 중단 후 재개와 재현

모든 원본·후보·로그는 `backfill/`의 gitignore 디렉터리에 있다. 새 도구 [recover_missing.py](C:/projects/bupgogae/pipeline/recover_missing.py)는 읽기 전용 입력 SHA·최소 기준선 규모·별도 출력 경로를 요구한다. 같은 출력에 대한 OS 잠금, 전체 INSERT transaction, raw/overlay provenance, 단계 영수증을 사용한다. 중단 시 `--resume`으로 동일 입력을 검사하고 원본 기준선에서 재생한다. 완료 파일은 해시가 같을 때만 재사용하며, 서로 다른 입력이나 임의로 수정한 결과는 거부한다.

프로젝트 루트에서:

```powershell
.venv/Scripts/python.exe -m unittest discover -s pipeline -p "test_*.py" -v
.venv/Scripts/python.exe backfill/2026-10-18-serving-integration/replay_dictionary.py
.venv/Scripts/python.exe backfill/2026-10-18-serving-integration/verify_merged_master.py
```

완료된 병합의 재개 명령은 [continuation.json](C:/projects/bupgogae/backfill/2026-10-18-serving-integration/continuation.json)에 고정한다. 추가 원문이나 운영 state가 바뀌면 기존 사본을 유지한 새 작업 디렉터리에서 대조해야 한다. 이전 source census 일지와 이 단계의 master 병합 기록을 혼합하지 않는다.
