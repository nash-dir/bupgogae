/**
 * 법고개(Bupgogae) — Gemini Site Adapter
 * =======================================
 * Google Gemini (gemini.google.com) 전용 어댑터.
 * 셀렉터는 adapters.json에서 관리 (Single Source of Truth).
 */

class GeminiAdapter extends window.bupgogaeAdapters.SiteAdapter {
  get siteId() { return 'gemini'; }
  get displayName() { return 'Google Gemini'; }
}

// 레지스트리에 등록
if (typeof window !== 'undefined') {
  window.bupgogaeAdapters = window.bupgogaeAdapters || {};
  window.bupgogaeAdapters.GeminiAdapter = GeminiAdapter;
}
