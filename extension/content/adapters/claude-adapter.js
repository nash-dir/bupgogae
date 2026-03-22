/**
 * 법고개(Bupgogae) — Claude Site Adapter
 * =======================================
 * Anthropic Claude (claude.ai) 전용 어댑터.
 * 셀렉터는 adapters.json에서 관리 (Single Source of Truth).
 */

class ClaudeAdapter extends window.bupgogaeAdapters.SiteAdapter {
  get siteId() { return 'claude'; }
  get displayName() { return 'Claude'; }
}

// 레지스트리에 등록
if (typeof window !== 'undefined') {
  window.bupgogaeAdapters = window.bupgogaeAdapters || {};
  window.bupgogaeAdapters.ClaudeAdapter = ClaudeAdapter;
}
