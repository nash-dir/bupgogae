# 남은 29,081행 원출처 전수 대조와 누락 복구 결과

> 이 문서의 수치와 범위는 당시 감사 기록입니다. 현재 범위와 후속 검증은 [법원·헌재 전용 전환 결과](court-only-cleanup-2026-10-18.md)를 따릅니다. 법원·헌재 판례는 국세 출처·특허 주제로 제외하지 않습니다.


> 후속 결과: [정정 사전 연결·Cloudflare master 병합·운영 데이터 gate 점검](C:/projects/bupgogae/docs/known-error-serving-integration-2026-10-18.md). 아래는 원출처 census 단계의 기록이며, 이후 실제 운영 master를 받아 352,124행의 로컬 사본과 검토용 20261018 세대를 만들었다. 운영 게시 차단은 유지한다.

2026-10-18 KST 완료 보고. 대상은 **2026-10-17에 확보한 전체 목록의 고정 모집단**이다. 운영 게시·원격 master 갱신·번들 교체는 하지 않았다.

## 결과 요약

29,081행 전부에 최종 판단을 남겼다. 이번 모집단에서 **28,773개 원문 ID를 추가**, 184행은 동일 사건번호·검증된 법원 신원·날짜의 연결이 있어 추가하지 않았고, **124행은 보류**, 0행은 제외했다. 합계는 29,081이다. 이미 연결된 행을 서로 다른 판결이라고 단정하거나 기존 기록을 덮어쓰지 않았다.

별도로 이전 표본에서 보류했던 2행을 재검토했다. 이번 실제 추가분은 그중 2행을 포함해 **총 28,775 ID·28,830개 조회 연결·28,748개 새 키**다. 이전 단계까지 합친 복구 누적은 29,273 ID이며, 현재 공개 DB 대비 키 29,243개·레코드 연결 29,357개가 늘었다.

원출처 `401336`은 7회의 HTTP 500(기존 일지 6회와 마지막 재확인 1회)을 보존해 접속 불가로 보류했다. **모든 ID 검토 완료와 모든 원문 열람 성공은 다르다:** `allIdsReviewed=true`, `sourceComparisonsComplete=false`다. 통신 실패를 부존재나 정상 0건으로 처리하지 않았다. `publishBlocked=true`를 유지한다.

국세법령정보시스템 출처와 특허 분류·특허법원은 이번 보완·복구에서 제외한다. 기존 레코드 삭제나 정기 수집 범위의 영구 변경은 없다.

## 기준선과 로컬 결과

| 항목 | 현재 공개본 | 직전 로컬 후보 | 최종 로컬 후보 |
| --- | ---: | ---: | ---: |
| version | 20261017 | 20261017 | 20261017 |
| 조회 키 | 132,476 | 132,971 | 161,719 |
| 레코드 연결 | 134,121 | 134,648 | 163,478 |
| 비압축 bytes | 9,864,128 | 9,907,382 | 12,011,201 |
| canonical 4글자 키 | 860 | 861 | 861 |

최종 SHA-256: `5066bd01fb75a10548e00dadbdccee26784e93076c5812e54e6958a06e51489e`. gzip 2,615,756 bytes. 후보 경로: [candidate/db.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/candidate/db.json).

초기 고정 공개본은 version 20261016이었다. 2026-10-18 읽기 전용 재확인에서는 공개 version이 20261017로 바뀌었으나, 내려받은 본문을 manifest 해시로 확인하고 전 필드를 대조한 결과 **version만 다르고 모든 사건 레코드·법원 코드는 같았다**. 현재 공개본 SHA는 `3908d53e0ac1d785b1ac8e52823e2696f9fa17b7b13f0840b87a378abc34283e`다. 최종 후보에서도 직전 로컬 134,648개 연결과 현재 공개본 134,121개 연결·기존 법원 코드를 전부 보존했다. 출처: [public-baseline-drift-check.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/public-baseline-drift-check.json).

## 누락 원인과 검증된 보완

| 발견 / 상태 / 우선순위 | 재현 가능한 증거 | 원인·보완과 경계 |
| --- | --- | --- |
| OPT-DB-04 / 검증됨 / P1 / 원천 메타데이터 결손 | 원 목록 29,081행 전부 사건번호·법원 공란, 날짜 `0001.01.01` | 단순 구분자 정규화로 복구할 수 없다. 법제처 원문 화면의 실제 ID·링크와 공단 원출처 표제를 대조해 필수 정보를 보강했다. 법제처 내부의 어느 적재 단계가 원인인지는 확정하지 않았다. |
| OPT-DB-05 / 검증됨 / P1 / 표제와 원문 차이 | 병합 표제 94행, 서명 구역 날짜 518행, 날짜·병합 동시 검토 1행, 개별 종결부 22행, 명시적 사건 라벨 1행, 개별 결정·명령 3행 | 명시된 전체 번호·해당 문서 자체의 날짜만 채택했다. 일반적인 본문 날짜 탐색으로 확장하지 않았다. 사건연도·날짜·64자 제한·사건부호 검증을 그대로 통과해야 한다. |
| OPT-DB-06 / 검증됨 / P0 / 원출처 자체의 오류 | 법원명 123행 재검토, 미검증 법원 5행 보류, 재판부명이 사건명인 4행 보류, 문자가 손실된 사건명 3행 원문 복구 | `서울행정병원`, `천천지방법원`, `의정부지방법원원`, `창원고등법원`, `대법관`을 추정 정정하지 않았다. 완전한 법원명의 공백·문서 표제 차이와 공식 원외재판부 안내로 확인된 경우만 근거를 보존해 반영했다. |

모든 최초 누락을 앞서 수정한 날짜 요청 인자 오류 하나에 귀속하지 않는다. 목록 응답 결손, 응답 정규화 문제, 원출처 자체의 오기·문서 종류·지원 부호 제한을 구분한다. 각 ID가 과거 운영 master에 처음부터 없었는지, export에서 탈락했는지, 언제 원천에 등록됐는지는 과거 운영 master·실행 로그 없이 확정하지 않았다.

법원 약칭을 포괄적으로 확장하지 않았다. 원외재판부 비교는 보존한 공식 안내로 확인한 광주(전주), 부산(창원·울산), 서울(춘천)의 명시적 표기에 한정했다. 기존 코드와 레코드는 변경하지 않고 같은 법원 신원의 기존 연결을 비교했다. 근거: [법원 공식 안내](https://www.scourt.go.kr/region/location/RegionLocationListAction.work?pageIndex=2), [court-name-reviews.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/court-name-reviews.json), [full-metadata-cross-field-audit.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/full-metadata-cross-field-audit.json).

## 보류와 기존 제한

| 최종 보류 사유 | 행 수 |
| --- | ---: |
| `case_year_after_decision_year` | 9 |
| `invalid_original_date` | 2 |
| `original_case_title_is_court_division_label` | 4 |
| `original_decision_date_missing_or_ambiguous` | 90 |
| `original_link_identity_mismatch` | 4 |
| `original_number_court_and_appeal_level_conflict` | 1 |
| `original_source_unavailable_http_500` | 1 |
| `unregistered_case_code` | 1 |
| `unsupported_original_date` | 7 |
| `unverified_original_court_name` | 5 |

행별 원래 판정과 최종 판정은 [review.csv](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/review.csv), [final-dispositions.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/final-dispositions.json)에 있다. 중복 기재된 병합 번호를 임의 삭제하거나 64자 제한을 넘는 번호 중 일부만 추가하지 않았다. `2020누41153`을 대법원 사건으로 표기한 `411874`는 `누`를 `두`로 바꾸지 않았다. `2022재무13`은 해당 문서의 날짜를 확인했지만 기존 codec에 `재무`가 없어 보류했다. 조정권고안·소장·다른 사건의 날짜도 판결 선고일로 대신하지 않았다.

이전 표본 보류 중 `409398`, `416770`은 해당 판결의 종결부 날짜로 다시 검증했다. `412470`은 계속 보류한다. 이전 상세 충돌의 미해결 5건과 전체 목록 1차 분류의 다른 충돌·미지원 항목을 이번 결과로 해결 완료라고 표시하지 않는다. 이전 결과: [상세 충돌 검토](C:/projects/bupgogae/docs/source-conflict-recovery-2026-10-17.md), [전체 목록 분류](C:/projects/bupgogae/docs/full-catalog-recovery-2026-10-17.md).

## known errors dictionary와 서빙 경계

[known-error-corrections.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/known-error-corrections.json)에 schema 1, version `20261018`, 규칙 profile SHA, **884개 항목**을 남겼다. 키는 `출처:원문ID`이며 원래 표제·번호·양쪽 원문 해시, 정정된 레코드, 근거 규칙, 검증 상태와 후보 반영 여부를 보존한다. 미해결 항목에는 정정 레코드를 넣지 않는다. 일반적인 원 목록 결손은 원출처 보강 경로로 처리하며, 모든 공란을 무조건 채우는 예외 규칙을 만들지 않았다.

운영에 연결할 때는 이 사전을 버전 관리하고 **출처·ID·기대 원래 값·원문 해시가 모두 일치할 때만** 적용해야 한다. 입력이 바뀌면 재검토한다. 정정 사전은 raw 원본을 덮어쓰거나 클라이언트의 active store에 덧대는 patch feed가 아니다. 정정을 반영한 완전한 DB generation을 만들어 hash·version·total·전수 스키마·court map·canonical을 함께 검증한 뒤 inactive A/B staging으로 교체한다. 이번 작업은 로컬 후보와 사전 초안까지이며 운영 pipeline의 영구 사전 연결·업로드는 실행하지 않았다. 후보·사전·검증 근거를 연결한 해시는 [generation-receipt.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/generation-receipt.json)에 있다.

## 검증 결과와 측정 범위

- 저장 원문 **58,166개 참조 / 58,100개 파일**, 비압축 합계 3,110,101,258 bytes를 다시 읽어 해시·바이트 수·수집 시각·URL을 확인하고 최초 판단을 재현했다. HTTP 500 응답은 성공 원문과 별도 보존·검증했다. [source-proof-inventory.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/source-proof-inventory.json), [availability-evidence/401336.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/availability-evidence/401336.json).
- 최종 회귀 **29개 통과**, 실패·오류·skip 0, 7.36초, Python 3.12.14. 중단·재개, 변조, ID 오연결, 부분 병합 손실, 날짜 추정, 법원 오기, 원문 사건명 손실, 지원되지 않는 부호, 동일 URL 동시성, 국세·특허 범위를 검사했다. [regression-results.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/regression-results.json), [regression-tests.log](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/regression-tests.log).
- 전체 스키마·manifest·gzip·canonical exact set·기존 데이터 보존, 추가분 전수와 독립 재구성 JSON의 **바이트 동일성**을 확인했다. SQLite integrity 및 복구 master 29,273행의 원문·provenance·재수출을 대조했다. [verification.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/verification.json).
- 실제 Store ZIP의 19개 파일이 추출본과 바이트 단위로 동일함을 확인했다. 새 프로필에서 전체 후보 설치 후 이전·이번 추가분 **29,280키 전수 조회**, canonical **861키**·법원 사전·hash·활성 세대 일치를 검증했다. **28.7초**, retry 0, 제한 60초. Node 22.17.1, Chromium 148.0.7778.96. 모든 외부 요청을 모의 응답으로 차단했다. [store-zip-runtime-integrity.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/store-zip-runtime-integrity.json), [browser-verification.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/browser-verification.json).

동일 URL을 두 작업자가 동시에 받으며 영수증 시각이 달라지는 경합은 구 코드에서 2회 요청, 수정 후 1회 요청으로 재현·해결했다. 원문 SHA·바이트·판정은 같았고 54개 이전 영수증을 확정 일지 근거로 별도 보존했다. 잠금은 캐시 확인부터 저장까지 같은 URL에 적용한다. [cache-race-before-after.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/cache-race-before-after.json), [evidence-receipt-repair.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/evidence-receipt-repair.json).

위 브라우저 시간은 이 데이터 검증 1회의 측정값이다. cold/warm 5회 성능 개선이나 전체 릴리스 통과를 의미하지 않는다. **이전 전체 E2E의 cold 번들 설치 60초 실패는 미해결**이다. 이번 단계에서 변경하지 않은 Jest·전체 Python pipeline·전체 E2E를 새로 통과했다고 표시하지 않는다.

오프라인 후보 생성은 총 496.719초(원문 재검증 482.266초, 이후 생성·master 대조 14.453초), 해당 프로세스 CPU 375.609초였다. 고정 100행 진단 표본의 원문·영수증·경로·gzip·해시 확인 1.344초, 파싱 0.234초는 [source-validation-sample-timing.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/source-validation-sample-timing.json)에 있다. 서로 다른 표본을 성능 개선 전후로 비교하지 않았다.

최초 신고한 `2016도10912`도 후보에서 ID `206264`로 유지되며, 이번 실제 ZIP 조회 대상에 포함되어 통과했다. [initial-reported-case-check.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/initial-reported-case-check.json).

## 결과물·재개·게시 전 절차

작업 루트는 `C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers`이며 기존 `.gitignore`의 `backfill/` 아래에 있다. 원문과 이전 두 후보를 덮어쓰지 않았다.

| 결과물 | 용도 |
| --- | --- |
| [journal.sqlite3](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/journal.sqlite3), [progress.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/progress.json) | 고정 모집단·단계·확정 이벤트·중단 후 재개 |
| [results.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/results.json), [final-dispositions.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/final-dispositions.json) | 최종 수치와 29,081행 전수 판정 |
| [additions.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/additions.json) | 실제 추가한 전체 원문과 보강 근거 |
| [candidate/recovery-master.db](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/candidate/recovery-master.db) | 이전 498행과 이번 추가 원문·provenance의 복구 부분집합 |
| [candidate/manifest.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/candidate/manifest.json), [candidate/bupgogae_meta.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/candidate/bupgogae_meta.json) | 로컬 후보와 동일 세대의 검증 metadata |
| [known-error-corrections.json](C:/projects/bupgogae/backfill/2026-10-17-full-audit/followup/full-workers/known-error-corrections.json) | 버전·기대 원본·근거가 있는 정정 dictionary 초안 |

프로젝트 디렉터리에서 원문 캐시를 사용한 재현:

```powershell
.venv/Scripts/python.exe backfill/2026-10-17-full-audit/followup/full_workers.py
.venv/Scripts/python.exe backfill/2026-10-17-full-audit/followup/test_full_workers.py
.venv/Scripts/python.exe backfill/2026-10-17-full-audit/followup/build_full_workers.py
.venv/Scripts/python.exe backfill/2026-10-17-full-audit/followup/check_full_workers.py
```

완료 항목은 재요청하지 않는다. 중단 시 `stop.request`로 안전하게 멈추고, 재개 전 그 파일을 지운다. 모집단·기준 후보·1차 검증 profile이 다르면 이어 붙이지 않는다. 완료 후 보류 원출처가 바뀌면 기존 증거와 후보를 유지한 **별도 새 세대**에서 재검토한다. `--retry-failures`는 재시도 소진 상태에만 적용되며, 이미 근거를 남겨 보류 확정한 행을 자동 해제하지 않는다.

**게시 전 선행조건:** 운영 master와 추가분을 serial·전체 번호·출처별로 가산 대조하고 기존 state/backlog를 보존한다. 위 SQLite는 복구 부분집합이므로 운영 master의 대체본으로 올릴 수 없다. 접속 실패·미해결 항목과 릴리스 제한을 검토하고, 검토된 사전의 영구 pipeline 연결·회귀 검증, 완전한 generation·immutable payload·원자적 pointer 전환 검증 후 사용자 검토를 거친다. 이번에는 R2 업로드·운영 pointer 전환·remote workflow 실행·새 ZIP 게시·push를 하지 않았다.
