# 법제처 실제 응답 회귀 표본

2026-10-17 KST에 공식 공개 샘플 인증값 `OC=test`로 조회한 공개 판례 XML이다.
개인 대화나 사용자 사건번호 추출 결과를 수집한 자료가 아니다.
gzip은 `mtime=0`으로 저장했다. 테스트는 네트워크 없이 원본 XML을 해제한다.

| 파일 | 공개 요청 조건 | 응답 |
| --- | --- | --- |
| exact.xml.gz | target=prec, nb=2016도10912 | 1건, ID 206264 |
| day.xml.gz | target=prec, date=20181101, mobileYn=Y, display=100 | 26건 |
| month-1.xml.gz … month-5.xml.gz | target=prec, prncYd=20181101~20181130, mobileYn=Y, display=100, page=1…5 | 100/100/100/100/26건, totalCnt=426 |

월 표본에는 국세법령정보시스템 252건, 대법원 166건, 지방세법령정보시스템
8건이 포함된다. 출처를 제한하거나 문제가 있는 레코드를 삭제하지 않았다.
법원명 접두사, 괄호로 표시된 재판부, 점으로 구분된 날짜도 원형 그대로다.

공식 계약: <https://open.law.go.kr/LSO/openApi/guideResult.do?htmlName=precListGuide>
원문: <https://law.go.kr/LSW/precInfoP.do?precSeq=206264>
