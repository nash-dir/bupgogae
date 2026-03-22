# Privacy Policy for Bupgogae

**Effective Date:** March 22, 2026

> **🔒 Bupgogae operates 100% offline (inside the browser).** No conversations, prompts, or personal data are ever transmitted externally.

This Privacy Policy describes how the Bupgogae (법고개) Chrome Extension ("the Extension") handles your data. Our core principle is strict privacy: **we do not collect, store, or transmit any of your personal information, browsing history, or chat prompts to our servers.**

The source code is publicly available at [github.com/nash-dir/bupgogae](https://github.com/nash-dir/bupgogae).

### 1. Information We Do Not Collect
The Extension is designed to operate **entirely offline on your device**. We do **not** collect:
* Your name, email address, or any identifiable personal information.
* Your browsing history, IP address, or device identifiers.
* The content of your conversations, prompts, or responses on supported LLM platforms (ChatGPT, Claude, Google Gemini, Microsoft Copilot, Perplexity, Grok).

### 2. How the Extension Works — Offline Processing
To detect fabricated case law citations, the Extension reads text displayed on specific permitted websites (`chatgpt.com`, `claude.ai`, `gemini.google.com`, `copilot.microsoft.com`, `perplexity.ai`, `grok.com`).
* All text scanning, pattern matching, and database lookup happens **100% locally within your browser** — no external API calls, no cloud processing.
* The entire case law database (140,000+ entries) is stored in your browser's IndexedDB. Verification is **instant and offline-capable**.
* No text, prompt, or LLM response is ever transmitted to any external server for analysis.

### 3. Permissions and Network Requests
All permissions are used solely for the single purpose of detecting fabricated case law citations:
* **alarms** — Schedule periodic database synchronization (every 6 hours).
* **storage / unlimitedStorage** — Store the local copy of the public case law database entirely within your browser.
* **tabs** — Update the extension badge (ON/OFF) when switching tabs.

The Extension makes network requests for **exactly one purpose**:
* **Database Synchronization:** Periodically downloads a static compressed file (`db.json.gz`) from `api.bup.live` to keep the local database up to date.
* These requests **do not send** any user-specific data, telemetry, or analytics.

### 4. Data Sharing and Disclosure
Because we do not collect any personal data, we cannot and do not share, sell, or disclose your data to any third parties.

### 5. Changes to This Privacy Policy
We may update this Privacy Policy from time to time. Any changes will be reflected on this page with an updated "Effective Date."

### 6. Contact Us
If you have any questions or concerns about this Privacy Policy, please contact us at: nashdir.dev@gmail.com

---

# 법고개(Bupgogae) 개인정보처리방침

**시행일:** 2026년 3월 22일

> **🔒 법고개는 100% 오프라인(브라우저 내부)에서 동작합니다.** 사용자의 대화 내용, 프롬프트, 개인정보는 일절 외부로 전송되지 않습니다.

본 개인정보처리방침은 법고개(Bupgogae) 크롬 확장프로그램(이하 "확장프로그램")의 데이터 처리 방식을 설명합니다. 법고개의 핵심 원칙은 엄격한 프라이버시 보호입니다. **본 확장프로그램은 사용자의 개인정보, 브라우징 기록, 채팅 프롬프트 내용을 일절 수집, 저장, 또는 외부 서버로 전송하지 않습니다.**

소스코드: [github.com/nash-dir/bupgogae](https://github.com/nash-dir/bupgogae)

### 1. 수집하지 않는 정보
본 확장프로그램은 전적으로 **사용자 기기 내에서 오프라인으로 동작**하도록 설계되었습니다. 다음의 정보를 **수집하지 않습니다**:
* 이름, 이메일 주소 등 식별 가능한 개인정보
* 브라우징 기록, IP 주소 또는 기기 식별자
* 지원 LLM 플랫폼(ChatGPT, Claude, Google Gemini, Microsoft Copilot, Perplexity, Grok)에서의 대화 내용, 프롬프트 또는 응답 텍스트

### 2. 데이터 처리 방식 — 오프라인 연산
환각 판례 인용을 탐지하기 위해, 허가된 특정 웹사이트(`chatgpt.com`, `claude.ai`, `gemini.google.com`, `copilot.microsoft.com`, `perplexity.ai`, `grok.com`) 화면의 텍스트를 읽어 들입니다.
* 모든 텍스트 스캔, 패턴 매칭, DB 조회는 **100% 브라우저 내부(로컬)**에서 수행됩니다 — 외부 API 호출이나 클라우드 처리가 없습니다.
* 14만여 건의 판례 데이터베이스 전체가 브라우저 IndexedDB에 저장되어, **즉각적이고 오프라인에서도 동작하는** 검증이 가능합니다.
* 어떠한 텍스트, 프롬프트, LLM 응답 내용도 분석을 목적으로 외부 서버에 전송되지 않습니다.

### 3. 권한 및 외부 네트워크 요청
모든 권한은 환각 판례 인용 탐지라는 단일 목적을 위해서만 사용됩니다:
* **alarms** — 주기적 백그라운드 DB 동기화 스케줄링 (6시간 주기)
* **storage / unlimitedStorage** — 공공 판례 DB 로컬 사본 저장 및 캐시
* **tabs** — 탭 전환 시 확장프로그램 배지(ON/OFF) 갱신

외부 네트워크 요청은 **단 하나의 목적**을 위해서만 발생합니다:
* **데이터베이스 동기화:** 정적 업데이트 서버(`api.bup.live`)에서 압축 파일(`db.json.gz`)을 주기적으로 다운로드합니다.
* 이 요청은 어떠한 사용자 식별 정보나 사용 통계(Telemetry)도 **전송하지 않습니다.**

### 4. 제3자 제공 및 공유
개인 데이터를 애초에 수집하지 않으므로, 어떠한 제3자에게도 데이터를 공유, 판매, 제공할 수 없으며 하지 않습니다.

### 5. 개인정보처리방침의 변경
본 방침은 향후 업데이트될 수 있습니다. 변경 시 본 페이지의 "시행일"을 갱신하여 고지합니다.

### 6. 문의처
nashdir.dev@gmail.com
