# 정정 사전 원문 fixture

2026-10-17에 보존한 법제처 화면과 근로복지공단 원문, 2026-10-18에 재확인한 법제처 화면이다. 모두 원래 응답의 gzip 보관본이며 판결 내용을 합성하거나 수정하지 않았다.

| ID | 검증 사례 | 법제처 화면 |
| --- | --- | --- |
| 362082 | 전체 병합 번호 보존 | https://www.law.go.kr/LSW/precInfoP.do?precSeq=362082 |
| 409398 | 개별 검토한 해당 판결 종결부 날짜 | https://www.law.go.kr/LSW/precInfoP.do?precSeq=409398 |
| 363788 | 사건명 `요양･보험급여불승인처분취소` 문자 보존 | https://www.law.go.kr/LSW/precInfoP.do?precSeq=363788 |

`ID-law.html.gz`는 처음 보관한 화면, `ID-original.html.gz`는 그 화면에 연결된 공단 원문이다. 정확한 공단 URL·양쪽 raw SHA·기대 목록 값은 `pipeline/known-errors.json`의 같은 ID에 있다. `ID-law-timevariant.html.gz`는 다음 날 GET한 화면으로, 차이가 확인된 `<head>`의 16개 리소스 캐시 `Time` 외의 모든 바이트를 비교한다. 현재 raw 응답과 대조 영수증은 로컬 gitignore의 `backfill/2026-10-18-serving-integration/live-source-probes/`에 보존한다.

회귀는 번호·날짜를 추정하거나 일부 병합 구성원을 버리지 않으며, 일반 본문·링크·head 구조·리소스 경로의 변경은 거부한다. 기대·관측 raw SHA를 모두 보존한다.
