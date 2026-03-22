/**
 * 법고개(Bupgogae) — Grok Site Adapter (실험적)
 * ==============================================
 * xAI Grok (grok.com) 전용 DOM 셀렉터.
 *
 * DOM 특징:
 *   - React 기반 SPA
 *   - AI 응답: 마크다운 렌더링 컨테이너
 *   - grok.com 독립 도메인과 x.com/i/grok 두 가지 경로 존재
 *     (x.com은 host_permissions 범위가 넓어지므로 grok.com만 지원)
 *
 * 주의:
 *   - DOM 구조가 빈번하게 변경됨
 *   - "실험적 지원" 등급으로 분류
 */

class GrokAdapter extends window.bupgogaeAdapters.SiteAdapter {
  get siteId() { return 'grok'; }
  get displayName() { return 'Grok (실험적)'; }

  getResponseSelectors() {
    return [
      // 1순위: 마크다운 응답 영역
      '.markdown',
      // 2순위: prose 스타일 컨테이너
      '.prose',
      // 3순위: message 관련 컨테이너 (추정)
      '[class*="message"] [class*="content"]',
      // 4순위: 일반 응답 블록
      '[class*="response"]',
    ];
  }
}

// 레지스트리에 등록
if (typeof window !== 'undefined') {
  window.bupgogaeAdapters = window.bupgogaeAdapters || {};
  window.bupgogaeAdapters.GrokAdapter = GrokAdapter;
}
