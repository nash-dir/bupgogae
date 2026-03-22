/**
 * 법고개(Bupgogae) — Copilot Site Adapter (실험적)
 * =================================================
 * Microsoft Copilot (copilot.microsoft.com) 전용 어댑터.
 * 셀렉터는 adapters.json에서 관리 (Single Source of Truth).
 */

class CopilotAdapter extends window.bupgogaeAdapters.SiteAdapter {
  get siteId() { return 'copilot'; }
  get displayName() { return 'Copilot (실험적)'; }
}

// 레지스트리에 등록
if (typeof window !== 'undefined') {
  window.bupgogaeAdapters = window.bupgogaeAdapters || {};
  window.bupgogaeAdapters.CopilotAdapter = CopilotAdapter;
}
