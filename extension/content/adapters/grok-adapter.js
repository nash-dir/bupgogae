/**
 * 법고개(Bupgogae) — Grok Site Adapter (실험적)
 * ==============================================
 * xAI Grok (grok.com) 전용 어댑터.
 * 셀렉터는 adapters.json에서 관리 (Single Source of Truth).
 */

class GrokAdapter extends window.bupgogaeAdapters.SiteAdapter {
  get siteId() { return 'grok'; }
  get displayName() { return 'Grok (실험적)'; }
}

// 레지스트리에 등록
if (typeof window !== 'undefined') {
  window.bupgogaeAdapters = window.bupgogaeAdapters || {};
  window.bupgogaeAdapters.GrokAdapter = GrokAdapter;
}
