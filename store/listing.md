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
법고개(Bupgogae)는 AI 답변에 표시된 한국 사건번호를 브라우저의 공개 판례 DB와 대조하고, 원문 확인을 돕는 Chrome 확장프로그램입니다.

ChatGPT, Claude, Gemini, Copilot, Perplexity, Grok의 답변에서 사건번호를 찾아 표시합니다. Copilot과 Grok은 실험적으로 지원합니다. 답변의 인용을 검토할 때 사건번호, 사건명, 선고일, 법원을 확인하고 공개 원문으로 이어갈 수 있습니다.

■ 네 가지 색으로 확인 상태 표시
• 초록 — 현재 활성 DB에서 해당 사건번호를 찾았습니다.
• 주황 — 현재 로컬 DB에서 찾지 못했습니다. 새 판례, 비공개 자료, DB 갱신 지연 등의 이유로 표시될 수 있습니다.
• 빨강 — 미래 연도, 일련번호 0, 제품의 조회 연도 범위 등 형식·지원 범위 검사에 걸린 상태입니다.
• 회색 — 시간 초과나 시스템 오류로 로컬 DB 조회를 끝내지 못했습니다. DB 미확인과 구분합니다.

주황·빨강만으로 사건이 존재하지 않는다고 단정할 수 없습니다. 초록도 인용 내용, 판례의 법적 효력, AI 답변 전체의 정확성을 보장하지 않습니다. 중요한 인용은 원문과 추가 자료를 직접 확인하세요.

■ 확인 범위
법원 판례와 헌법재판소 결정례를 대상으로 합니다. 하급심 판결도 포함하며 법원의 조세 사건과 특허법원 판결을 확인할 수 있습니다. 조세심판원·특허심판원 등 행정심판기관의 결정은 포함하지 않습니다. 공개 자료의 제공 범위와 현재 DB 수록 여부에 따라 확인 결과가 달라질 수 있습니다.

■ 원문과 미확인 번호 확인
• 배지를 열어 사건명·선고일·법원과 원문 확인 링크를 봅니다.
• 원문 링크를 선택하면 현재 페이지의 우측 뷰어에서 판결문을 열 수 있습니다.
• DB에서 찾지 못한 사건번호는 안내 배너의 복사 버튼이나 Alt+C로 모아 복사할 수 있습니다. 사이트가 단축키를 사용하는 경우 복사 버튼을 이용하세요.
• Tab으로 배지와 링크를 이동하고 Enter·Space로 배지를 열며 Escape로 툴팁·뷰어를 닫을 수 있습니다.
• 팝업에서 전체·사이트별 사용 여부, 법원·헌재 확인 범위, 미확인 번호 안내 표시를 설정합니다. 법원·헌재 필터 변경은 페이지를 새로고침하지 않고 반영합니다.

■ 브라우저 안에서 대조
답변 텍스트 분석과 사건번호 DB 대조는 브라우저 로컬에서 수행합니다. 프롬프트·답변 텍스트를 외부 분석 서버로 전송하지 않습니다.

공개 DB와 무결성·버전 정보(manifest)는 api.bup.live에서 확인하거나 갱신합니다. 화면 선택자(selector)는 확장프로그램에 포함되며 Chrome 웹 스토어 업데이트로 변경합니다. 원격 서버에서 선택자를 내려받지 않습니다.

사용자가 원문 열기를 요청하면 선택한 공개 일련번호로 www.law.go.kr에 요청합니다. 이 보조 통신을 받는 서버에는 IP 주소 등 일반적인 접속 정보가 전달될 수 있습니다. 자세한 처리 내용은 개인정보처리방침을 확인하세요.

■ 0.10.0 변경사항
• 원문을 빠르게 바꿔 열거나 닫을 때 이전 요청의 응답이 현재 뷰어를 덮지 않도록 수정했습니다.
• 법원·헌재 필터를 현재 대화에 즉시 반영하고, 작성 중인 미전송 문구와 페이지 상태를 보존하도록 개선했습니다.
• 확장프로그램 업데이트 후에도 사용자가 설정한 전체 OFF 상태를 유지합니다.
• 배지·툴팁·원문 뷰어의 키보드 조작과 포커스 복귀를 보완했습니다.
• 좁은 화면의 툴팁 접근성과 팝업 보조 글씨 대비·스크롤을 개선했습니다.
• 화면 선택자를 번들 파일로 통일하고 웹 스토어 업데이트로 배포하도록 정리했습니다.

데이터 출처: 법제처 국가법령정보센터 국가법령정보 공동활용
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
Schedules public database and integrity manifest synchronization every six hours without a persistent background page.
```

### storage

```
Stores user preferences, sync/drift metadata, and ETag state locally in chrome.storage.local. Site and original-document selectors are bundled with the extension and updated through Web Store releases.
```

### unlimitedStorage

```
Stores complete public case-law database snapshots in IndexedDB and prevents a small quota from interrupting staging before the active snapshot is switched.
```

### host_permissions

```
Supported AI-site hosts allow the content script to read displayed response text and render badges locally. https://api.bup.live/* is used for the public database and manifest. https://www.law.go.kr/* is used only when the user requests an original public document. Prompt and response text is not attached to these supporting requests.
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
