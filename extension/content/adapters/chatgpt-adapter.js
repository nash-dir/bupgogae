/**
 * 법고개(Bupgogae) — ChatGPT Site Adapter
 * ========================================
 * OpenAI ChatGPT (chatgpt.com) 전용 어댑터.
 * 셀렉터 및 streamingIndicator는 adapters.json에서 관리 (Single Source of Truth).
 */

class ChatGPTAdapter extends window.bupgogaeAdapters.SiteAdapter {
  get siteId() { return 'chatgpt'; }
  get displayName() { return 'ChatGPT'; }
}

// 레지스트리에 등록
if (typeof window !== 'undefined') {
  window.bupgogaeAdapters = window.bupgogaeAdapters || {};
  window.bupgogaeAdapters.ChatGPTAdapter = ChatGPTAdapter;
}
