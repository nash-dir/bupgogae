## 이름 (Name)

```
법고개 (Bupgogae)
```

## 요약 (Short Description, 132자 이내)

```
AI 답변의 한국 사건번호를 브라우저의 공개 판례 DB와 대조하고, 배지와 원문 확인 링크를 제공합니다.
```

## 상세 설명 (Detailed Description)

```
법고개(Bupgogae)는 AI 답변에 나온 한국 사건번호를 확인하는 도구입니다.
ChatGPT, Claude, Gemini, Copilot, Perplexity, Grok의 답변에서 사건번호를 찾아 현재 브라우저에 저장된 공개 판례 DB와 대조합니다.

초록은 현재 DB에서 찾은 사건번호, 주황은 로컬 DB에서 찾지 못한 사건번호입니다. 빨강은 형식·지원 범위 경고, 회색은 시간 초과나 오류로 조회를 완료하지 못한 상태를 뜻합니다.

배지를 눌러 사건명·선고일·법원과 원문 확인 링크를 볼 수 있습니다. 주황이나 빨강 표시만으로 판례가 존재하지 않는다고 단정하지 않습니다. 초록 표시 역시 인용 내용이나 AI 답변 전체의 정확성을 보장하지 않습니다. 중요한 인용은 반드시 원문을 확인하세요.

답변 텍스트의 분석과 DB 대조는 브라우저 로컬에서 수행하며, 프롬프트·답변 텍스트를 외부 분석 서버로 전송하지 않습니다. 공개 DB·manifest·검증된 화면 선택자 설정은 api.bup.live에서 확인하거나 갱신합니다. 사용자가 원문 조회를 요청하면 선택한 공개 일련번호로 법제처에 요청합니다.

데이터 출처: 법제처 국가법령정보 공동활용
개인정보처리방침: https://api.bup.live/bupgogae/privacy.html
소스코드: https://github.com/nash-dir/bupgogae
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
