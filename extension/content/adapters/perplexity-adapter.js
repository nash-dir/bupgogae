/**
 * 법고개(Bupgogae) — Perplexity Site Adapter
 * ============================================
 * Perplexity AI (perplexity.ai) 전용 DOM 셀렉터.
 *
 * DOM 특징:
 *   - React + Tailwind CSS
 *   - AI 응답: .prose 클래스 컨테이너 내 마크다운 렌더링
 *   - 인용 패널: 응답 옆에 소스 인용 블록 표시
 *   - 복수 응답: 대화 흐름에 여러 .prose 블록 존재
 */

class PerplexityAdapter extends window.bupgogaeAdapters.SiteAdapter {
  get siteId() { return 'perplexity'; }
  get displayName() { return 'Perplexity'; }

  getResponseSelectors() {
    return [
      // 1순위: prose 마크다운 컨테이너
      '.prose',
      // 2순위: 마지막 응답 블록
      '.prose:last-of-type',
    ];
  }
}

// 레지스트리에 등록
if (typeof window !== 'undefined') {
  window.bupgogaeAdapters = window.bupgogaeAdapters || {};
  window.bupgogaeAdapters.PerplexityAdapter = PerplexityAdapter;
}
