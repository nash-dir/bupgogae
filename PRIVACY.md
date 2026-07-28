# Privacy Policy for Bupgogae

**Effective date:** July 20, 2026

Bupgogae (법고개) examines case numbers shown in responses on supported AI chat
sites. Prompt and response text is scanned and compared with a case-number database
locally in the browser. The Extension does not send that text to the Bupgogae update
server or to another analysis service.

Source code: [github.com/nash-dir/bupgogae](https://github.com/nash-dir/bupgogae)

## 1. Data processed locally

On the configured pages for ChatGPT, Claude, Gemini, Copilot, Perplexity, and Grok,
the Extension reads displayed response text to find Korean case-number patterns. It
performs pattern matching and database lookup in the browser. The Extension does not
persist prompt or response text.

The Extension stores the following on the device:

- a copy of the public case-law database and snapshot metadata in IndexedDB;
- the database ETag, sync/drift history, validated remote selector configuration,
  and extension preferences in `chrome.storage.local`; and
- supported-site host names only when needed for site-specific enable/disable
  preferences.

## 2. Network communications

Local text analysis is separate from the following supporting communications:

| When | Host | Purpose | Persistent storage by the Extension |
|---|---|---|---|
| Automatically at install/startup, on the sync schedule, and when a supported site is opened | `api.bup.live` | Check or download the public database (`db.json.gz`), its integrity/version manifest (`manifest.json`), and validated CSS selector configuration (`adapters.json`) | Database and metadata are stored locally; the selector configuration is stored in `chrome.storage.local` |
| When the user opens an original decision from a badge/sidebar | `www.law.go.kr` | Request the selected public statute/decision HTML using its public serial identifier | The retrieved HTML is displayed in the current tab and is not written to persistent extension storage |
| When the user follows an external verification link | `portal.scourt.go.kr` or a displayed public source link | Navigate the browser to the page selected by the user | The Extension does not persist the destination page contents |

These requests necessarily expose ordinary connection information, such as an IP
address, to the contacted host under that host's own policies. Bupgogae does not add
prompt text, response text, telemetry, advertising identifiers, or analytics payloads
to its update/configuration requests.

The supported AI-site host permissions allow the content script to run on those
pages and allow the popup/background process to identify the current supported host.
They are not used to upload chat text. Fetches of packaged files such as
`data/adapters.json`, `data/bupgogae_meta.json`, and a bundled database fallback use
the Extension's own local URL and are not external network requests.

## 3. Permissions

- **`alarms`** schedules database synchronization every six hours.
- **`storage`** stores preferences, sync state, and validated remote selector
  configuration locally.
- **`unlimitedStorage`** permits the public case-law database snapshots to be kept in
  IndexedDB without a small storage quota interrupting an update.
- **Host access to supported AI sites** lets the Extension inspect displayed response
  text and render badges on those sites.
- **Host access to `api.bup.live`** permits database, manifest, and selector downloads.
- **Host access to `www.law.go.kr`** permits a user-requested original-document fetch.

The manifest does not request the `tabs` permission.

## 4. Badge meaning and limitations

- **Green** means the case number was found in the public database currently active
  in the browser.
- **Orange** means the case number was not found in that local database.
- **Red** means the case-number form failed the Extension's structural checks.

These states do not guarantee authenticity, legal validity, safety, completeness of
the public source, or the accuracy of the surrounding AI answer. Orange can also mean
that a public record is new, unavailable, or absent from the current database.

## 5. Changes and contact

Changes to this policy will be published here with an updated effective date.
Questions: [nashdir.dev@gmail.com](mailto:nashdir.dev@gmail.com)

---

# 법고개(Bupgogae) 개인정보처리방침

**시행일:** 2026년 7월 20일

법고개는 지원되는 AI 채팅 사이트의 응답에 표시된 사건번호를 확인합니다.
프롬프트·답변 텍스트의 패턴 탐색과 판례 DB 대조는 브라우저 로컬에서 수행하며,
그 텍스트를 법고개 업데이트 서버나 외부 분석 서비스로 전송하지 않습니다.

소스코드: [github.com/nash-dir/bupgogae](https://github.com/nash-dir/bupgogae)

## 1. 로컬에서 처리·저장하는 데이터

ChatGPT, Claude, Gemini, Copilot, Perplexity, Grok의 설정된 페이지에서 화면에
표시된 답변 텍스트를 읽어 한국 사건번호 패턴을 찾고 로컬 DB와 대조합니다.
확장프로그램은 프롬프트나 답변 텍스트를 영구 저장하지 않습니다.

기기에는 다음 항목을 저장합니다.

- IndexedDB의 공개 판례 DB 사본과 snapshot 메타데이터
- `chrome.storage.local`의 DB ETag, 동기화·drift 이력, 검증된 원격 selector 설정,
  확장프로그램 환경설정
- 사이트별 활성/비활성 설정에 필요한 지원 사이트 호스트명

## 2. 외부 통신

로컬 텍스트 판별과 아래 보조 통신은 구분됩니다.

| 시점 | 호스트 | 목적 | 확장프로그램의 영구 저장 |
|---|---|---|---|
| 설치·시작·주기 동기화 시와 지원 사이트 진입 시 자동 | `api.bup.live` | 공개 판례 DB(`db.json.gz`), 무결성·버전 manifest(`manifest.json`), 검증된 CSS selector 설정(`adapters.json`) 확인 또는 다운로드 | DB와 메타데이터를 로컬에 저장하고 selector 설정은 `chrome.storage.local`에 저장 |
| 사용자가 배지/사이드바에서 원문을 열 때 | `www.law.go.kr` | 공개 일련번호를 사용해 선택한 법령·판례 원문 HTML 요청 | 현재 탭에 표시하며 가져온 HTML을 확장프로그램 영구 저장소에 기록하지 않음 |
| 사용자가 외부 확인 링크를 선택할 때 | `portal.scourt.go.kr` 또는 표시된 공공 출처 링크 | 사용자가 선택한 페이지로 브라우저 이동 | 대상 페이지 내용을 확장프로그램이 영구 저장하지 않음 |

이 요청을 받는 호스트에는 해당 호스트의 정책에 따라 IP 주소 같은 일반적인 연결
정보가 보일 수 있습니다. 법고개의 업데이트·설정 요청에는 프롬프트, 답변 텍스트,
사용 통계, 광고 식별자 또는 분석 payload를 추가하지 않습니다.

지원 AI 사이트의 호스트 권한은 해당 페이지에 content script를 실행하고 팝업·백그라운드
프로세스가 현재 지원 호스트를 식별하기 위해 사용합니다. 채팅 텍스트 업로드에는 사용하지
않습니다. `data/adapters.json`, `data/bupgogae_meta.json`, 번들 DB fallback 등 패키지
내 파일의 `fetch`는 확장프로그램 로컬 URL을 사용하며 외부 네트워크 요청이 아닙니다.

## 3. 권한

- **`alarms`**: 6시간 주기의 DB 동기화 예약
- **`storage`**: 환경설정, 동기화 상태, 검증된 원격 selector 설정의 로컬 저장
- **`unlimitedStorage`**: DB snapshot 갱신이 작은 저장공간 한도로 중단되지 않도록
  공개 판례 DB를 IndexedDB에 저장
- **지원 AI 사이트 호스트 접근**: 표시된 답변 텍스트 확인과 배지 표시
- **`api.bup.live` 접근**: DB, manifest, selector 설정 다운로드
- **`www.law.go.kr` 접근**: 사용자가 요청한 원문 조회

manifest는 `tabs` 권한을 요청하지 않습니다.

## 4. 배지 의미와 한계

- **초록**: 현재 브라우저의 활성 공개 DB에서 해당 사건번호를 찾음
- **주황**: 현재 로컬 DB에서 해당 사건번호를 찾지 못함
- **빨강**: 확장프로그램의 사건번호 형식 검사를 통과하지 못함

이 표시는 판례의 진위·법적 유효성·안전성, 공공 출처의 완전성 또는 AI 답변 전체의
정확성을 보장하지 않습니다. 주황은 새 판례이거나 공개되지 않았거나 현재 DB에 아직
포함되지 않은 경우에도 표시될 수 있습니다.

## 5. 변경 및 문의

방침 변경 시 시행일과 함께 이 문서에 게시합니다.
문의: [nashdir.dev@gmail.com](mailto:nashdir.dev@gmail.com)
