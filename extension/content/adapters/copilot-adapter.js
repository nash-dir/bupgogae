/**
 * 법고개(Bupgogae) — Copilot Site Adapter (실험적)
 * =================================================
 * Microsoft Copilot (copilot.microsoft.com) 전용 DOM 셀렉터.
 *
 * DOM 특징:
 *   - React + Tailwind CSS + Container Queries
 *   - 사용자 메시지: group/user-message 유틸리티 클래스
 *   - AI 응답: group/assistant-message (추정), 형제 요소로 배치
 *   - 텍스트 렌더링: whitespace-pre-wrap + break-words
 *   - 채팅 영역: @container/chat 기반 컨테이너 쿼리
 *
 * 주의:
 *   - DOM 구조가 매우 빈번하게 변경됨
 *   - Edge 브라우저에서 restricted URL로 취급될 수 있음
 *   - "실험적 지원" 등급으로 분류
 */

class CopilotAdapter extends window.bupgogaeAdapters.SiteAdapter {
  get siteId() { return 'copilot'; }
  get displayName() { return 'Copilot (실험적)'; }

  getResponseSelectors() {
    return [
      // 1순위: 어시스턴트 그룹 (추정, 클래스에 슬래시 포함)
      '[class*="group/assistant"]',
      // 2순위: 마크다운 응답 영역
      '[class*="prose"]',
      // 3순위: 텍스트 렌더링 컨테이너
      '[class*="whitespace-pre-wrap"]',
      // 4순위: 채팅 영역 내 메시지 블록
      '[class*="space-y-"] > div.relative',
    ];
  }
}

// 레지스트리에 등록
if (typeof window !== 'undefined') {
  window.bupgogaeAdapters = window.bupgogaeAdapters || {};
  window.bupgogaeAdapters.CopilotAdapter = CopilotAdapter;
}
