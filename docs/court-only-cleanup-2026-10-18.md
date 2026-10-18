# 법원·헌재 전용 전환 및 검사 실패 수정

2026-10-18, 현재 미커밋·미추적 작업트리와 Cloudflare에서 내려받아 보존한 master 기준. 운영 DB·manifest·state pointer 게시, 배포, push는 하지 않았다.

## 적용 범위

법원과 헌법재판소 판례만 취급한다. 조세·특허라는 제품 분류, 비법원 심판 데이터 형식과 설정을 제거했다. **법원의 조세 사건, 특허법원 판결, 국세법령정보시스템이 제공하는 실제 법원 판결은 유지한다.** 사건명이나 출처만으로 삭제하지 않는다. 이전 감사 문서의 국세·특허 제외 조건은 당시 복구 실험의 기록이며 현재 제품 정책이 아니다.

- 프론트엔드: 콘텐츠의 별도 분류 설정, 팝업의 분류 잔재 명칭·미사용 CSS, TX/KP 전용 건수 질의를 제거했다. 확인 범위는 법원·헌재 두 가지다.
- payload·pipeline: 비법원 키·일련번호 수용, 별도 압축·입력 정제 함수와 별도 manifest 인자를 제거했다. 신규 수집이나 export의 알 수 없는 번호는 조용히 버리지 않고 실패한다. 법원 사건부호 목록과 병합 구성원 보존 규칙은 유지한다.
- 저장 데이터: 새 master 사본에서 비법원 행과 빈 특허심판 테이블을 제거했다. 입력 원본은 그대로 보존했다. 새 번들은 검증된 법원·헌재 후보로 갱신했다.
- 설치 전환: 전수 검증 후 활성화된 snapshot에 `caseScope: 2`를 결합한다. 표식이 없는 설치본은 304로 정상 재사용하지 않고 전체 검증을 거친다. 같은 버전의 정상 번들로 전환할 수 있지만 건강한 최신 로컬의 다운그레이드는 허용하지 않는다. 새 snapshot 활성화 후 이전 A/B·legacy 데이터를 정리한다. 설치 실패 때는 기존 active 데이터를 보존한다.

## 확인된 실패 원인과 수정

1. 과거 raw 전체를 공개 데이터처럼 export했다. 기존 공개 후보에 없던 잘못된 병합 문자열 17행 중 하나라도 만나면 전체 export가 중단됐다. 반대로 단일 번호의 해석 실패는 조용히 skip되어 같은 raw 영역을 서로 다른 정책으로 취급했다.
2. health 검사는 `D` 접두사를 제외한 raw 전체를 법원 판례로 세었다. 이 집계에는 조세심판원 행이 포함됐고, 빈 날짜·`0`·서로 다른 날짜 표기 때문에 `MIN(date)`와 `MAX(date)`가 역사·최근 범위를 대표하지 못했다.
3. WAL을 사용하는 live DB에서 만든 상태 업로드용 backup이 WAL 설정을 물려받았다. readonly 전수 검사가 임시 `-wal`·`-shm` 파일을 남겨 정리 회귀가 실패했다. backup을 닫기 전에 DELETE journal의 독립 파일로 확정하도록 수정했다.

이제 health는 **표준 export와 동일한 검증된 서빙 집합**에서 실제 달력 날짜를 정규화해 계산한다. 100,000건 최소 규모, 1960년 이전 역사 범위, 최근 2년 범위와 헌재 포함 조건은 그대로다. 날짜 불명·잘못된 달력 날짜·미래 날짜·sentinel은 건강성을 채우지 못한다. 기존 payload의 미상 날짜를 임의의 날짜로 고치지는 않았다.

과거 공개 snapshot에 없던 법원 raw는 원본 7필드 SHA, 고정 입력 SHA와 전체 격리 목록 digest를 가진 명시적 검토 대기로 보존했다. 공개된 모든 키·전체 레코드 배열·법원 코드를 보존하는 검사를 통과해야 한다. 격리 행의 변경·삭제, 목록 변경, 새 미해석 행과 기존 공개 레코드 손실은 실패한다. 격리 목록은 새 오류를 자동 제외하는 필터가 아니다. 수동 partial-bootstrap 옵션도 이러한 무결성 실패를 우회하지 못한다.

17개 과거 병합 오류 중 조세심판원 1행은 이번 범위 제거 대상이다. 나머지 법원 16행은 원문 전체를 보존하고 검토 대기 상태다. 번호 일부만 남기거나 법원 약칭을 추정해 해결한 것으로 표시하지 않았다.

## 데이터 전수 대조 결과

| 항목 | 결과 |
| --- | ---: |
| 삭제한 비법원 raw | 조세심판원 139,708행 |
| 제거한 공개 비법원 키 / 연결 레코드 | 639 / 640 |
| 보존한 법원·헌재 raw | 212,416행, 원본 7필드 전체 동일 |
| 새 공개 후보 키 / 연결 레코드 / 원문 ID | 161,080 / 162,838 / 162,754 |
| 법원 코드 사전 | 135개, 기존 법원 코드 동일 |
| 특허법원 판결 연결 | 653개 보존 |
| canonical 4글자 키 | 861개 |
| 과거 미검증 법원 raw 검토 대기 | 49,662행 |
| 유효 날짜가 있는 법원 / 헌재 ID | 124,021 / 33,653 |
| 법원 날짜 범위 | 1947-03-23 ~ 2026-09-01 |
| 공개 집합의 미상·비정상 날짜 | 5,080개 ID, 보존하되 health 계산에서 제외 |
| payload / gzip | 11,896,576 / 2,589,420 bytes |
| 검토용 master | 112,025,600 bytes |

이전 검토 후보와 이전 번들에 들어 있던 **법원·헌재 레코드 전체와 배열 순서가 보존됨**을 별도 전수 대조했다. `2016도10912`는 `16Do10912` → 공개 ID `206264`로 조회된다. 날짜 범위와 후보 version `20261018`은 원천 전체를 그날까지 전수 수집했다는 뜻이 아니다. 49,662행의 검토 대기를 복구 완료나 부존재로 해석하면 안 된다.

근거: [전환 검증](../backfill/2026-10-18-court-only/validation.json), [독립 대조](../backfill/2026-10-18-court-only/independent-verification.json), [제거 raw 목록과 행 SHA](../backfill/2026-10-18-court-only/removed-non-court-raw.json).

## 회귀와 실제 산출물 검증

Python 전체, Jest 전체, Ruff, ESLint, 추출 평가와 실제 새 Store ZIP의 브라우저 회귀를 실행했다. hash·version·total·전 레코드 검증, canonical exact membership, 병합 구성원, last-known-good와 snapshot 세대 일관성을 유지했다. 운영 네트워크는 모킹했으며 테스트 로그의 R2 업로드 문구는 메모리 mock 대상이다.

- 실제 새 ZIP E2E: **24/24**, retry·skip·flaky 0, 404.625초.
- 별도 실제 ZIP 런타임: 복구 관련 **29,280개 조회 키와 canonical 861개** 전수 일치, 33.8초, retry 0. court map과 canonical도 같은 활성 snapshot에 결합됨을 확인했다.
- Python **152/152**, 13.272초. Jest **216/216**, 14.825초. Ruff·ESLint 통과. 추출 평가 **13표본**, TP 9, FP·FN 0, precision·recall 1.0.
- 빈 프로필 설치 **5/5**, retry·skip·flaky 0. fixture 준비 시간은 19.271·14.429·17.348·14.634·14.440초, 중앙값 **14.634초**, 최댓값 **19.271초**다. 브라우저 시작과 새 전체 번들 활성화를 포함하며 분리된 CPU 시간은 아니다. [5회 원시 결과](../backfill/2026-10-18-court-only/cold-five.json), [계측 집계](../backfill/2026-10-18-court-only/cold-install-timings.json).
- 재개 명령은 입력 SHA와 완료 산출물 SHA를 재검사하고 변경 없이 완료 후보를 재사용했다.
- 새 ZIP을 두 차례 생성해 동일 SHA를 확인했다: `ae1ce6d185389b3fe05e3313d496888fa2c220febc697c5edc51b332341d5d45`.

원시 결과: [Python](../backfill/2026-10-18-court-only/python-tests.log), [Jest](../backfill/2026-10-18-court-only/jest-tests.log), [E2E](../backfill/2026-10-18-court-only/e2e-tests.json), [브라우저 전수 대조](../backfill/2026-10-18-court-only/browser-verification.json), [추출 평가](../backfill/2026-10-18-court-only/extraction.log).

[최종 generation receipt](../backfill/2026-10-18-court-only/generation-receipt.json)에 소스·테스트·번들 84개와 산출물·로그 25개의 SHA를 고정하고 `tooling-snapshot/`에 당시 도구를 보존했다. 이후 재현 시 현재 코드와 이 receipt의 소스 SHA가 같은지 먼저 확인한다.

다른 크기의 이전 번들과 현재 번들의 실행 시간을 직접 비교해 성능 개선으로 주장하지 않는다. 이번 브라우저 검증은 합성 fixture와 모킹된 외부 응답이며 실제 개인 대화나 로그인 서비스의 성능 측정이 아니다.

## 중단 후 재개와 게시 전 순서

원본 다운로드, 이전 검토 후보와 과거 감사 일지는 수정하지 않았다. 새 후보·로그·검토 기록은 gitignore 디렉터리 `backfill/2026-10-18-court-only/`에 있다. 작업 중 중단됐다면 같은 명령이 OS 잠금·입력 SHA를 검사하고 staging을 원본에서 다시 만든다. 완료 상태에서는 산출물 SHA가 다르면 재사용을 거부한다.

이전 source census의 도구 해시와 journal은 이전 결과에 고정돼 있다. 이번 `compress.py` 변경을 이전 프로필로 가장해 그 journal에 이어 쓰지 않는다. 과거 결과는 당시 동결한 도구로 재현하고, 새 대조 작업은 새 프로필과 별도 journal을 사용한다.

```powershell
.venv/Scripts/python.exe pipeline/prepare_court_master.py `
  --master backfill/2026-10-18-serving-integration/merged-master/master.db `
  --reference backfill/2026-10-18-serving-integration/reviewed-generation/db.json `
  --output backfill/2026-10-18-court-only `
  --master-sha256 b2ec95a28d81e66a9ba41c2f9b9c8ee47a362d3c467fbb2d1585e81861518a84 `
  --reference-sha256 ba25aa34836c3989c0747817270a8eda836ed8b80b15bb8024a6b31031fc0dd5

.venv/Scripts/python.exe backfill/2026-10-18-court-only/verify_candidate.py
```

게시 검토 때는 이 보고서와 새 master·payload·ZIP 해시를 함께 확인한다. 현재 Cloudflare의 구 master에는 비법원 행과 미검토 raw가 남아 있으므로 **새 strict 코드만 배포하고 구 master를 그대로 사용하는 순서로 전환하면 안 된다.** 검증된 새 master와 기존 durable backlog를 결합한 state generation, 법원·헌재 전용 public payload·manifest, 해당 형식을 검증하는 확장 배포를 조율해야 한다. 기존 backlog와 이전 generation은 임의로 완료 처리하거나 삭제하지 않는다. 실제 게시 직전에는 원격 generation 변경 여부를 다시 확인하고 변경분을 새 로컬 후보로 대조해야 한다.

현재는 **로컬 검증 후보 완료·운영 게시 전 검토 대기**다. 과거 법원 raw 49,662행과 이전 원문 보류 항목의 추가 복구는 별도 근거가 확보될 때만 명시적으로 해제한다.
