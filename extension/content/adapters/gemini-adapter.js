/**
 * 법고개(Bupgogae) — Gemini Site Adapter
 * =======================================
 * Google Gemini (gemini.google.com) 전용 DOM 셀렉터.
 * 기존 bupgogae-content.js의 GEMINI_RESPONSE_SELECTORS를 어댑터로 분리.
 */

class GeminiAdapter extends window.bupgogaeAdapters.SiteAdapter {
  get siteId() { return 'gemini'; }
  get displayName() { return 'Google Gemini'; }

  getResponseSelectors() {
    return [
      'message-content',                        // Gemini 커스텀 엘리먼트
      '.model-response-text',                   // 클래스 기반
      '.response-container',                    // 대체 후보
      '.markdown-main-panel',                   // 마크다운 렌더링 패널
      '[data-message-author-role="model"]',     // role 속성
    ];
  }
}

// 레지스트리에 등록
if (typeof window !== 'undefined') {
  window.bupgogaeAdapters = window.bupgogaeAdapters || {};
  window.bupgogaeAdapters.GeminiAdapter = GeminiAdapter;
}
