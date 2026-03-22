/**
 * 법고개(Bupgogae) — Claude Site Adapter
 * =======================================
 * Anthropic Claude (claude.ai) 전용 DOM 셀렉터.
 *
 * DOM 특징:
 *   - React + Tailwind CSS
 *   - 메시지 식별: data-testid="chat-message-content" (AI 응답 본문)
 *   - 대화 턴: data-testid="conversation-turn"
 *   - 폰트 구분: .font-claude-message 클래스 (AI 응답 텍스트)
 *   - 마크다운: .prose 컨테이너 내부 렌더링
 *
 * 주의: data-testid는 프로덕션 빌드에서 제거될 수 있으므로,
 *       클래스 기반 폴백을 반드시 포함.
 */

class ClaudeAdapter extends window.bupgogaeAdapters.SiteAdapter {
  get siteId() { return 'claude'; }
  get displayName() { return 'Claude'; }

  getResponseSelectors() {
    return [
      // 1순위: data-testid (가장 명확)
      '[data-testid="chat-message-content"]',
      // 2순위: Claude 전용 폰트 클래스
      '.font-claude-message',
      // 3순위: conversation-turn 내부 prose
      '[data-testid="conversation-turn"] .prose',
      // 4순위: 일반 prose (넓은 폴백)
      'div.prose',
    ];
  }
}

// 레지스트리에 등록
if (typeof window !== 'undefined') {
  window.bupgogaeAdapters = window.bupgogaeAdapters || {};
  window.bupgogaeAdapters.ClaudeAdapter = ClaudeAdapter;
}
