## 이름 (Name)

```
법고개 (Bupgogae)
```

## 요약 (Short Description, 132자 이내)

```
AI 답변의 한국 사건번호를 찾아 현재 브라우저의 공개 판례 DB와 로컬에서 대조하고 원문 확인 링크를 제공합니다.
```

## 상세 설명 (Detailed Description)

```
법고개 (Bupgogae) — AI 답변 사건번호 확인 도구

◆ 무엇을 하나요?
ChatGPT, Gemini, Copilot, Claude, Perplexity, Grok의 답변에서 한국 사건번호를 찾아 현재 브라우저의 공개 판례 DB와 대조합니다.

◆ 표시 의미
🟢 DB에서 찾음: 현재 활성 공개 DB에서 해당 사건번호를 찾았습니다.
🟠 DB에서 찾지 못함: 현재 로컬 DB에 해당 사건번호가 없습니다. 새 판례, 비공개 판례 또는 DB 갱신 지연일 수도 있습니다.
🔴 형식 오류: 미래 연도 등 사건번호 형식 검사를 통과하지 못했습니다.

이 표시는 판례의 진위·법적 유효성·안전성 또는 AI 답변 전체의 정확성을 보장하지 않습니다. 중요한 인용은 반드시 원문과 추가 자료로 확인하세요.

◆ 주요 기능
✓ 사건번호 자동 감지와 로컬 공개 DB 대조
✓ 초록/주황/빨강 상태 배지
✓ 법제처 원문 조회와 공공 확인 링크
✓ 사건명·선고일·사건유형 툴팁
✓ 미확인 사건번호 일괄 복사
✓ 주요 AI 챗봇 호환

◆ 개인정보와 네트워크
프롬프트·답변 텍스트의 판별은 브라우저 로컬에서 수행하며 그 텍스트를 외부로 전송하지 않습니다.
공개 판례 DB·manifest·검증된 selector 설정은 설치·시작·주기 동기화와 지원 사이트 진입 시 api.bup.live에서 확인하거나 갱신합니다. 이 요청에 프롬프트·답변 텍스트를 첨부하지 않습니다. 사용자가 원문 조회를 요청하면 선택한 공개 일련번호로 www.law.go.kr에 요청합니다. 자세한 내용은 개인정보처리방침을 확인하세요.

◆ 오픈소스
GitHub: github.com/nash-dir/bupgogae
```

## 카테고리

```
Productivity (생산성)
```

## 단일 목적 설명 (Single Purpose)

```
AI 답변에 표시된 한국 사건번호를 현재 로컬 공개 판례 DB와 대조하고 원문 확인을 돕는 도구입니다.
```

---

## 권한 정당화 (Permission Justification)

### alarms

```
Schedules public database, integrity manifest, and validated selector-configuration synchronization every six hours without a persistent background page.
```

### storage

```
Stores user preferences, sync/drift metadata, ETag state, and validated remote selector configuration locally in chrome.storage.local.
```

### unlimitedStorage

```
Stores complete public case-law database snapshots in IndexedDB and prevents a small quota from interrupting staging before the active snapshot is switched.
```

### host_permissions

```
Supported AI-site hosts allow the content script to read displayed response text and render badges locally. https://api.bup.live/* is used for the public database, manifest, and selector configuration. https://www.law.go.kr/* is used only when the user requests an original public document. Prompt and response text is not attached to these supporting requests.
```

The manifest does not request the `tabs` permission.

---

## 스크린샷

| 순서 | 파일 | 내용 |
|---|---|---|
| 1 | `1_chatgpt_green.png` | ChatGPT – 초록 배지 (현재 DB에서 찾음) |
| 2 | `2_gemini_orange.png` | Gemini – 주황 배지 (현재 로컬 DB에서 찾지 못함) |
| 3 | `3_copilot_red.png` | Copilot – 빨강 배지 (형식 오류) |

## 프로모션 이미지

| 파일 | 크기 | 용도 |
|---|---|---|
| `icon128.png` | 128×128 | 스토어 아이콘 (96×96 + 16px 투명 패딩) |
| `promo_small_440x280.png` | 440×280 | 작은 프로모션 타일 |
| `marquee_1400x560.png` | 1400×560 | 마키 프로모션 배너 |

## Privacy Policy URL

```
https://api.bup.live/bupgogae/privacy.html
```
