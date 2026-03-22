/**
 * 법고개(Bupgogae) — ChatGPT Site Adapter
 * ========================================
 * OpenAI ChatGPT (chatgpt.com) 전용 DOM 셀렉터.
 *
 * DOM 특징:
 *   - React + Next.js + Tailwind CSS
 *   - 메시지 식별: data-message-author-role="assistant" / "user"
 *   - 완료 상태: div.markdown.prose 내부에 마크다운 렌더링
 *   - 스트리밍 중: .result-streaming 클래스 존재
 */

class ChatGPTAdapter extends window.bupgogaeAdapters.SiteAdapter {
  get siteId() { return 'chatgpt'; }
  get displayName() { return 'ChatGPT'; }

  getResponseSelectors() {
    return [
      // 1순위: data 속성 + 마크다운 영역 (가장 안정적)
      'div[data-message-author-role="assistant"] .markdown',
      // 2순위: data 속성만
      'div[data-message-author-role="assistant"]',
      // 3순위: 마크다운 prose 클래스
      '.markdown.prose',
    ];
  }

  isStreaming(container) {
    // result-streaming 클래스가 있으면 아직 응답 생성 중
    return !!(
      container.classList.contains('result-streaming') ||
      container.closest('.result-streaming')
    );
  }
}

// 레지스트리에 등록
if (typeof window !== 'undefined') {
  window.bupgogaeAdapters = window.bupgogaeAdapters || {};
  window.bupgogaeAdapters.ChatGPTAdapter = ChatGPTAdapter;
}
