# 데이터 무결성·게시 계약

현재 제품 범위는 법원과 헌법재판소의 판결·결정이다. 사건 주제나 제공 출처로
조세·특허 사건을 제외하지 않는다. 조세심판원·특허심판원의 비법원 자료와 별도
분류 기능은 지원하지 않는다.

이 문서는 파일 생성 시각, 원천 수집 완료, 클라이언트 설치 완료가 서로 다른
상태임을 명시한다.

## 상태의 의미

| 상태 | 의미 | 의미하지 않는 것 |
| --- | --- | --- |
| payload `version` | 공개 snapshot을 만든 날짜 식별자 | 원천 전체를 그날 전수 확인했다는 뜻 |
| manifest `built_at` | 해당 manifest 바이트를 생성한 시각 | 원천자료의 완전성·법률적 정확성 |
| manifest hash/total | 내려받은 payload의 동일성·키 수 | 누락 없는 원천 수집 또는 판결 내용 정확성 |
| pipeline report `success/complete` | 계획된 범위와 durable backlog가 모두 해소되어 게시 가능 | 공개 원천 자체가 완전하다는 뜻 |
| client sync success | 검증된 게시 snapshot을 로컬에 활성화 | 이번 원천 수집이 클라이언트에서 수행됐다는 뜻 |

## 게시 정책

- 사용자용 DB는 `R2_BUCKET`, 재개용 master/backlog/pointer는 별도 비공개
  `R2_STATE_BUCKET`에 저장한다. state 버킷은 사용자 도메인과 r2.dev 접근을 모두
  꺼야 한다. 별도 버킷 미설정·공개 버킷과 동일 설정은 R2 접근 전에 차단한다.
  기존 공개 버킷의 state로 자동 fallback하지 않는다. 전환 전에 검증된 state를
  비공개 버킷에 이관하고 기존 공개 경로 및 캐시 노출을 별도 해소해야 한다.

- 통신 실패, 잘못된 XML, 스키마 불일치, 일부 페이지 실패는 정상 빈 결과와
  구분한다.
- 실패 범위/페이지는 `failed_dates.json` backlog에 원자적으로 남기고 다음 실행에서
  신규 계획보다 먼저 재시도한다.
- backlog가 남거나 baseline health gate가 실패하면 사용자용 DB와 manifest를
  게시하지 않는다. 기존 last-known-good 공개본을 유지한다.
- 정상 0건은 예상 root와 명시적인 `totalCnt=0`이 모두 확인된 경우에만 인정한다.
- 공개 payload는 게시 전 전수 구조 검증을 통과해야 한다.

## 클라이언트 설치 정책

### 계약별 파일명과 구버전 지원

- 계약 식별자는 구조 변경을 처음 도입한 버전(`v0.9.0`)으로 고정한다.
  앱 패치 버전 및 payload의 일별 `version`(`YYYYMMDD`)과 별개다.
- 0.9.0 클라이언트는 `manifest-v0.9.0.json`과 `db-v0.9.0.json.gz`만
  사용한다. manifest의 `contract`도 `v0.9.0`인지 검증한다. 계약별 manifest가
  없거나 잘못되면 기존 snapshot/번들을 유지하며 무접미사 경로로 우회하지 않는다.
- 기존 클라이언트용 `manifest.json`, `db.json.gz`는 유지한다. 현재는 두 계약이
  같은 payload 구조이므로 검증된 gzip 바이트를 복사하여 같은 데이터를 제공한다.
  `court_code_map` 및 기존 사건부호 codec의 의미를 재할당하지 않는다.
- 각 manifest는 content-addressed `objects/<raw SHA-256>.json.gz`를 참조한다.
  현재 게시 순서는 immutable 객체 → 기존 manifest → 기존 고정 DB → 계약별
  고정 DB → 계약별 manifest이다. 두 계약의 동시 commit은 보장하지 않는다.
  계약별 manifest 실패 시 해당 계약의 이전 immutable snapshot이 유효하다.
  기존 클라이언트의 고정 DB·manifest 사이 짧은 불일치는 기존 재시도 정책으로 처리한다.
- 향후 구조 변경 시 새 접미사를 추가하고 기존 계약의 serializer·validator·게시를
  유지한다. 현재 publisher는 계약 식별자만 변경하여 기존 파일을 덮어쓰려 하면
  업로드 전에 차단한다. 별도 변환기 없이 신형 payload를 구형 경로에 복사하면 안 된다.
- GitHub Actions는 네트워크 접근 없는 `--prepare-only`로 계약별 파일을 생성하고
  artifact에 포함한다. finalize는 받은 원본과 gzip을 다시 검증하여 게시 파일을
  재생성한다. 현재 구조에서는 추가 압축 없이 파일 복사만 필요하다.
- 저장소 main의 0.8.2 코드를 고정한 호환성 테스트를 유지한다. 이는 Store 실제
  패키지 일치나 구버전의 탐지 기능 개선을 보장하지 않는다. 신규 부호·긴 번호 등
  구형 탐지기의 한계 때문에 정상 설치된 DB의 일부 키가 인식되지 않을 수 있다.

- manifest의 version, total, SHA-256과 content-addressed 객체를 확인한다.
- 모든 키·레코드·법원 코드 참조를 전수 검사한 후 비활성 A/B store에 staging한다.
- staging 완료 전에는 이전 snapshot을 계속 조회한다.
- 데이터, court map, 해당 데이터에서 파생한 정확히 4글자 사건번호 canonical key
  목록을 snapshot metadata로 결합해 pointer를 원자적으로 전환한다.
- 설치 실패나 Service Worker 재시작 시 staging 잔해를 활성 데이터로 간주하지 않는다.
- 설치·알람·수동·drift 요청은 single-flight 결과를 공유한다.

## 최적화 후 조회·복구 계약 (2026-10-11)

- 동기화 상태는 active pointer, snapshot metadata와 전체 physical count를
  같은 readonly transaction에서 읽는다. 모든 키가 법원·헌재 전용이므로
  manifest total과 최소 건강성은 같은 전체 키 수로 판정한다.
- 새 snapshot metadata에는 전수 검증된 범위를 나타내는 `caseScope: 2`를 기록한다.
  이 표식이 없는 이전 snapshot은 304로 재사용하지 않는다. 검증된 전체 payload를
  inactive store에 설치하고 원자 전환한 뒤에만 이전 A/B 및 legacy 데이터를 정리한다.
  같은 버전 번들로 범위를 전환할 수 있지만 건강한 최신 로컬을 구버전으로 덮지 않는다.
- 304 응답 뒤에도 현재 상태를 다시 읽어 version/hash/total과 core 건강성을
  확인한다. 불완전한 snapshot에 대한 304는 설치 성공으로 처리하지 않는다.
- GET_META의 동시 요청은 진행 중 Promise만 공유한다. 영구 결과 캐시는 두지
  않는다. active court map과 canonical 목록은 pointer와 같은 transaction에서
  읽으며, legacy canonical 파생이 필요하면 readwrite transaction에서 pointer와
  metadata를 다시 읽고 파생·기록한다. `active_snapshot`의 storeName/version/hash는
  해당 응답이 읽은 snapshot의 식별자다.
- 번들 fallback은 storage에 저장된 과거 meta version을 사전 gate에 사용하지
  않는다. 현재 확장 파일의 meta를 읽고 건강한 같은/최신 로컬 DB이면 payload
  parse를 생략한다. meta가 없거나 잘못되면 기존 full payload 검증 경로를 따른다.
- timeout은 회색 상태로 남긴다. 진행 중 들어온 mutation은 완료 후 처리하며,
  서킷 브레이커나 확장 컨텍스트 무효화로 중단한 처리를 자동 재개하지 않는다.
  삭제된 컨테이너에는 추가 chunk/retry/렌더를 하지 않는다. 이미 발송한 runtime
  message는 취소할 수 없어 현재 timeout까지 남을 수 있다.
- backlog JSON은 compact separators로 기록한다. checkpoint 횟수, 선행 journal,
  임시 파일 작성 후 atomic replace, 부분 게시 차단은 유지한다.

이 계약은 구조와 배포 일관성을 보장한다. 사건번호 존재, 공개 원천의 완전성,
인용문 의미와 법률적 결론의 정확성은 각각 별도 검증 대상이다.

## 병합 사건번호 보존 계약

- master DB는 원문 ID당 한 행을 유지하고 병합 사건번호 원문 전체를 저장한다.
  기존 64자 상한을 넘는 병합 문자열은 저장 전 실패시켜 뒤쪽 번호가 잘리지 않게 한다.
- 각 구성원이 완전한 사건번호로 명시됐거나, 맨 앞 완전한 번호와 유일한
  연도·사건부호를 공유하고 생략 구성원마다 `(병합)`이 명시된 경우만 처리한다.
  원문 근거는 지방세 법령정보시스템 결정 60090520의 1심 표제와 법제처 목록
  ID 420836이다. 법원 약칭이나 불명확한 연도·사건부호를 추측하지 않는다.
- 빈 구성원, 알 수 없는 꼬리, 중복 번호, 서로 다른 완전한 번호의 공통 부분이
  경합하는 생략 표기, 압축 후 키 충돌은 전체 범위의 실패다. 앞 번호만 남기지 않는다.
- export는 모든 구성원의 키에 같은 원문 ID·법원·날짜·사건명을 연결한다.
  같은 키의 다른 ID도 기존 1:N 배열에 함께 보존한다. 같은 ID가 여러 키에
  존재하는 것은 별도 원문 생성이나 master 행 복제를 의미하지 않는다.
- 원천 totalCnt와 master 건수는 원문 행, payload total/keys는 조회 키 수다.
  canonical 4글자 목록은 이 export 전체에서 파생하며 snapshot과 함께 전환한다.
- 오래된 master의 병합 문자열이 잘못됐거나 raw/clean 필드가 불일치하면 export를
  실패시켜 게시를 막는다. 기존 원문이 이미 잘린 경우 재수집으로 확인해야 한다.
  기존 공개 snapshot에 없던 과거 raw는 입력 SHA와 7개 필드의 행 SHA를 고정한
  명시적 검토 대기 목록으로만 격리할 수 있다. 공개된 키·레코드·법원 코드 전체의
  보존을 대조하고, 새 오류나 격리 행의 변경·삭제는 실패한다. 이 목록은 복구 완료가 아니다.
- 후속 갱신이 기존 병합 구성원의 일부만 제공하면 transaction을 실패시킨다.
  알려진 구성원을 삭제하는 정정은 원문 근거를 별도 검토한 뒤 명시적으로 처리한다.
- 공식 표제에 완전한 두 번호와 `(본소)`·`(반소)`가 각각 명시된 쌍도 모든
  구성원을 보존한다. 두 역할 중 하나가 없거나 번호를 생략했거나 추가 구성원이
  섞이면 거부한다. 64자 상한, 압축 키 충돌 검사, 부분 갱신 거부는 동일하다.
- 원문 대조를 거쳐 격리 복구 DB에서 번호·재판부를 정정하는 경우에는 원본
  필드·원문 표제·근거 URL·보존 파일 해시와 정정한 전체 값을 같은 복구 DB의
  provenance에 함께 남긴다. 근거 없는 전역 별칭 규칙이나 원문 덮어쓰기로
  처리하지 않으며, 운영 master 반영·게시에는 별도 검토가 필요하다.

## 검토된 known-error 정정 계약 (2026-10-18)

- 출처·ID·기대 목록 필드와 검토된 원문 비교 해시가 일치하는 항목에만 정정 사전을 적용한다. 입력 변경·통신 실패·미검증·지원되지 않는 번호는 정상 0건으로 만들지 않고 기존 실패·게시 차단 경로를 유지한다.
- 법제처 HTML은 `law_head_resource_cache_time_v1`에 명시한 `<head>`의 16개 JS·CSS 경로에서 10자리 캐시 `Time` 값만 비교용으로 정규화한다. 그 밖의 전체 바이트와 공단 원문 전체 raw SHA는 그대로 검증하며, 기대·관측 raw SHA를 별도로 남긴다. 비교 프로필 변경은 검토·회귀·새 사전 생성을 요구한다.
- raw 원본·기존 master 행·전체 병합 번호를 보존한다. 기대 raw와 정정값·근거를 묶은 overlay를 export에서 검사하고, clean key가 변조돼 다른 조회 키로 향하는 것도 차단한다.
- 검증된 정정이라도 기존 연결로 판정한 ID와 미해결 ID는 임의로 신규 추가하지 않는다. 별개의 검증된 게재 ID를 보존하는 예외는 정확한 레코드와 근거를 고정한 검토에 한정한다.
- 정정 영수증은 master 변경과 동일 transaction에 저장한다. source roster·입력 hash·후보 전체 구조 검증·기존 공개 레코드 보존을 확인한 뒤 완전한 새 snapshot을 생성한다. active snapshot에 in-place patch를 적용하지 않는다.
- raw master 병합 성공·코드 회귀 통과·검토용 후보 검증은 일반 운영 export와 health gate의 통과를 대신하지 않는다. 보류나 게시 차단을 임의 해제하지 않는다.

## export·패키징·재개 검증 보완 (2026-10-18)

- 한 전체 export는 SQLite read snapshot 안에서 policy를 한 번 로드하고, 격리 raw의 행 해시를 각각 한 번 검증한다. 전체 격리 ID가 실제 raw에서 확인됐는지와 기존 공개 배열·법원 코드 보존도 검사한다. 다음 export는 정책과 원본을 다시 읽으며 검토 결과를 영구 캐시하지 않는다.
- 복구 도구의 부분 `compress_rows`는 검토용이다. 전체 master 검증이나 게시 승인을 대신하지 않는다. 전체 export·health·payload 검증을 통과해야 공개 후보가 된다.
- Store ZIP과 번들 메타 갱신도 pipeline의 전체 payload validator를 사용한다. JS 안전 정수 범위, ASCII 숫자 키·D 일련번호, 실제 버전 날짜와 선택 필드 `keys`의 존재 시 값 검증을 공유 fixture로 대조한다. canonical Python 파생은 공용 순수 함수를 사용한다.
- 해시로 고정하는 입력에 비어 있지 않은 WAL이 있으면 먼저 checkpoint를 요구한다. 완료 영수증은 지정된 산출물 전체의 이름과 SHA를 가져야 하며 실제 파일이 모두 일치해야 재사용한다.
- Windows checkpoint 교체의 일시적 접근·공유 잠금 오류(5·32·33)만 최초 시도 뒤 50·100·200ms 간격으로 재시도한다. 교체는 항상 원자적 rename이며 기존 영수증을 삭제하지 않는다. 지속 잠금이나 다른 오류는 실패를 전파해 게시를 막는다. 테스트 자체의 retry는 0이다.

## 이전 서버 계약과 최신 번들의 동기화 (2026-10-18)

- manifest 검증 후, 현재 정책으로 검증한 최신 A/B snapshot의 버전이 서버보다 높고 실제 전체 행 수가 snapshot metadata와 일치하면 이전 payload 다운로드 전에 `downgrade_blocked`로 유지한다. 원격 갱신 성공으로 기록하지 않는다.
- 빈 설치나 행 수가 불일치한 로컬 DB에서는 서버보다 최신인 번들을 기존 전수 검증·inactive staging·원자 전환으로 복구한 뒤 같은 조건을 다시 확인한다. 번들 오류는 원격 검증 생략의 근거가 될 수 없다.
- 같거나 더 최신인 원격 payload의 hash·version·total·전 레코드 검증은 유지한다. 과거 TX/KP 레코드를 부분 제거해 받아들이거나 무결성 실패를 성공으로 바꾸지 않는다. 운영 서버 계약 갱신은 별도 게시 검토 대상이다.
