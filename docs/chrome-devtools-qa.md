# Chrome DevTools를 이용한 선택적 QA

실제 AI 사이트는 사용자가 입력·전송·조작하고, 에이전트는 전달받은 결과를 분석한다.
현재 절차는 [수동 서비스 QA](standard-tester.md)를 따른다.
실제 AI 사이트의 자동 입력·클릭·스크롤·DOM 조회·네트워크 수집은 별도 명시 지시가 있을 때만 재개한다.

## 준비

- Chrome DevTools MCP의 확장 도구를 사용하는 선택적 개발 환경이다. 제품 실행에는 필요하지 않다.
- 설치와 연결 설정은 [공식 가이드](https://developer.chrome.com/docs/extensions/ai/build-with-ai?hl=ko)를 따른다.
- 사용자에게 연결할 Chrome 프로필과 디버깅 범위를 설명하고 Chrome의 연결 승인을 받는다.
- 개인 대화·계정 정보가 없는 QA 탭을 사용한다. 공개 결과에 로컬 설정·식별자·개인정보를 남기지 않는다.

## 승인된 대상의 점검 순서

1. `list_extensions`로 설치된 법고개의 버전·활성 상태를 확인한다. 정상 설치를 불필요하게 재설치하지 않는다.
2. 수정 패키지 경로를 확인하고 필요할 때만 해당 확장을 새로고침한다.
3. 실제 툴바 팝업을 열어 DB 일자·건수, 설정 유지, 대비와 스크롤 접근성을 확인한다.
4. 페이지·팝업의 `pageId`와 서비스 워커의 `serviceWorkerId`를 구분한다. ID는 도구 반환값을 사용한다.
5. 설정 변경이나 수동 동기화는 확인할 동작과 범위를 정한 뒤 실행한다.
6. 오류·네트워크·성능을 조사할 때 필요한 정보만 읽고, 개인 대화 본문·자격증명·비밀 URL 매개변수는 기록하지 않는다.
7. 설정·viewport 등 테스트 상태를 복원하고 결과와 미검증 범위를 [품질 평가](quality-evaluation.md)에 기록한다.

배지·원문 전환·키보드·필터·좁은 화면의 공통 검사는 수동 QA 프로토콜을 사용한다.
서비스 워커 상태를 검사했다는 사실만으로 실제 사이트 호환성을 통과 처리하지 않는다.

## 참고

- [실행 중인 Chrome에 연결](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md)
- [DevTools 도구 목록](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)
