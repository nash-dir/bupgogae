/**
 * 법고개(Bupgogae) — Perplexity Site Adapter
 * ============================================
 * Perplexity AI (perplexity.ai) 전용 어댑터.
 * 셀렉터는 adapters.json에서 관리 (Single Source of Truth).
 */

class PerplexityAdapter extends window.bupgogaeAdapters.SiteAdapter {
  get siteId() { return 'perplexity'; }
  get displayName() { return 'Perplexity'; }
}

// 레지스트리에 등록
if (typeof window !== 'undefined') {
  window.bupgogaeAdapters = window.bupgogaeAdapters || {};
  window.bupgogaeAdapters.PerplexityAdapter = PerplexityAdapter;
}
