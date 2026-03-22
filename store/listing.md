## 이름 (Name)

```
법고개 (Bupgogae)
```

## 요약 (Short Description, 132자 이내)

```
AI(LLM)가 생성한 허위 판례 인용을 실시간으로 탐지합니다. 13만여 건의 대한민국 공공 판례 DB를 로컬에 내장하여, 개인정보 수집 없이 100% 브라우저 내에서 동작합니다.
```

## 상세 설명 (Detailed Description)

```
법고개 (Bupgogae) — LLM 환각 판례 탐지기

◆ 무엇을 하나요?
AI 챗봇(ChatGPT, Gemini, Copilot, Claude, Perplexity, Grok)이 생성한 응답에서 한국 판례 사건번호를 실시간으로 감지하고, 실제 존재하는 판례인지 3단계(Green/Orange/Red) 신호등으로 즉시 알려드립니다.

◆ 왜 필요한가요?
AI가 존재하지 않는 판례를 그럴듯하게 인용하는 "환각(hallucination)" 현상은 법률 업무에서 치명적인 위험을 초래합니다. 법고개는 이 위험을 브라우저에서 즉시 차단합니다.

◆ 주요 기능
✓ 판례번호 자동 감지 및 공개 DB 대조 검증
✓ 검증 결과에 따른 3단계 컬러 배지 (초록/주황/빨강)
✓ AI 환각(Hallucination) 의심 판례 경고
✓ 법제처 사이트 원문 바로가기 링크
✓ 판례 상세 정보 툴팁 (사건명, 선고일, 사건유형)

🟢 실존 판례 : 공개 판례 DB와 교차 검증된 안전한 판례 (판례일련번호 기반 원문 직접 링크)
🟠 의심 판례 : 사건번호 형식은 맞으나 DB에서 확인되지 않는 판례 (사법정보공개포털 검증 유도)
🔴 형식 오류 : 미래 연도, 존재하지 않는 사건부호, 대한민국 사법부 설립(1945년) 이전 등 명백한 AI 환각 지적

◆ 특징
✓ 14만여 건 대한민국 공공 판례 DB 내장 (설치 즉시 동작)
✓ 100% 로컬 처리 — 개인정보·채팅 내용 일절 수집하지 않음
✓ 오픈소스 (GitHub: github.com/nashdir/bupgogae)

◆ 지원 플랫폼
• ChatGPT
• Google Gemini
• Microsoft Copilot
• Claude (Anthropic)
• Perplexity
• Grok (xAI)

◆ 데이터 출처
대법원 종합법률정보, 국가법령정보센터 등 공공 데이터 활용

13만여 건의 판례 DB를 내장하여 설치 용량이 약 12MB입니다. 이는 네트워크 없이도 즉시 동작하기 위함입니다.
```

## 카테고리

```
Productivity (생산성)
```

## 단일 목적 설명 (Single Purpose)

```
LLM이 생성한 한국 법률 판례의 사건번호 진위를 내장 DB를 통해 실시간으로 검증하는 도구입니다
```

---

## 권한 정당화 (Permission Justification)

### alarms
```
Used to schedule periodic background database synchronization (every 6 hours) to keep the local case law database up to date.
```

### storage
```
Used to cache metadata (case code mapping) locally for efficient case number validation.
```

### unlimitedStorage
```
Required to store the full Korean public case law database (~12MB, 140K+ entries) locally in IndexedDB for offline-capable, privacy-preserving lookups.
```

### tabs
```
Used to update extension badge status (ON/OFF) when switching or loading tabs.
```

### host_permissions
```
Required to read LLM-generated response text on supported chatbot pages (ChatGPT, Gemini, Claude, Copilot, Perplexity, Grok) to detect and validate case law citations. No data is collected or transmitted. api.bup.live is the extension's own API server for database synchronization.
```

---

## 스크린샷

| 순서 | 파일 | 내용 |
|------|------|------|
| 1 | `1_chatgpt_green.png` | ChatGPT – 초록 배지 (검증 완료) |
| 2 | `2_gemini_orange.png` | Gemini – 주황 배지 (DB 미확인) |
| 3 | `3_copilot_red.png` | Copilot – 빨강 배지 (형식 오류 / AI 환각) |

## 프로모션 이미지

| 파일 | 크기 | 용도 |
|------|------|------|
| `icon128.png` | 128×128 | 스토어 아이콘 (96×96 + 16px 투명 패딩) |
| `promo_small_440x280.png` | 440×280 | 작은 프로모션 타일 |
| `marquee_1400x560.png` | 1400×560 | 마키 프로모션 배너 |

## Privacy Policy URL

```
https://github.com/nashdir/bupgogae/blob/main/PRIVACY.md
```
