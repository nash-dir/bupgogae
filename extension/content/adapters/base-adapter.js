/**
 * 법고개(Bupgogae) — Site Adapter 기본 클래스
 * =============================================
 * 각 LLM 채팅 서비스(Gemini, ChatGPT, Claude, Copilot 등)의
 * DOM 구조 차이를 추상화하는 어댑터 패턴의 기본 인터페이스.
 *
 * 사이트별 구현체는 이 클래스를 상속하여 siteId/displayName만 정의.
 * 셀렉터는 adapters.json(Single Source of Truth)에서 로드.
 * 공통 컨테이너 탐색과 DOM 관찰 옵션은 여기서 제공.
 */

class SiteAdapter {
  /**
   * 번들 JSON에서 로드된 셀렉터.
   * initAdapters() 시 extension/data/adapters.json에서 주입됨.
   * @type {string[]|null}
   */
  _bundledSelectors = null;

  /**
   * 사이트 식별자 (예: 'gemini', 'chatgpt', 'claude', 'copilot').
   * @returns {string}
   */
  get siteId() {
    throw new Error('[SiteAdapter] siteId not implemented');
  }

  /**
   * 사이트 표시명 (팝업 UI 등에서 사용).
   * @returns {string}
   */
  get displayName() {
    return this.siteId;
  }

  /**
   * 번들 JSON의 셀렉터를 어댑터에 주입.
   * @param {Object} siteConfig - { responseSelectors: [...] }
   */
  setBundledConfig(siteConfig) {
    if (siteConfig && Array.isArray(siteConfig.responseSelectors)) {
      this._bundledSelectors = siteConfig.responseSelectors;
    }
  }

  /** 번들 adapters.json의 응답 셀렉터만 사용한다. */
  resolveResponseSelectors() {
    return this._bundledSelectors || [];
  }

  /**
   * 현재 DOM에서 AI 응답 컨테이너들을 탐색.
   * 기본 구현: resolveResponseSelectors()로 셀렉터를 순서대로 시도하여 첫 매치를 채택.
   * @returns {Element[]}
   */
  findResponseContainers() {
    const selectors = [...new Set(this.resolveResponseSelectors())];
    for (const selector of selectors) {
      try {
        const elements = [...document.querySelectorAll(selector)].filter(element =>
          !element.closest('[data-message-role="user"], [data-message-author-role="user"], [data-chatgpt-search-unit-key$=":user"], [data-testid="user-message"], [role="article"][aria-labelledby^="user-message-"], user-query') &&
          !element.matches('main, body, html, form, textarea, input, [contenteditable="true"]'));
        if (elements.length > 0) {
          return elements;
        }
      } catch (e) {
        // 잘못된 셀렉터는 건너뛰고 다음 번들 셀렉터 시도
        console.warn(`[bupgogae:${this.siteId}] 셀렉터 오류: ${selector}`, e);
      }
    }
    return [];
  }

  /**
   * MutationObserver의 관찰 대상 노드를 반환.
   * 기본: document.body (SPA 전체 감시).
   * 사이트마다 특정 컨테이너로 범위를 좁힐 수 있음.
   * @returns {Node}
   */
  getObserverTarget() {
    return document.body;
  }

  /**
   * MutationObserver 옵션.
   * 기본: childList + subtree + characterData.
   * @returns {MutationObserverInit}
   */
  getObserverOptions() {
    return {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-message-role', 'data-message-author-role', 'data-message-complete', 'data-chatgpt-search-unit-key', 'data-talvt-turn-state'],
    };
  }
}

// 외부 인터페이스
if (typeof window !== 'undefined') {
  window.bupgogaeAdapters = window.bupgogaeAdapters || {};
  window.bupgogaeAdapters.SiteAdapter = SiteAdapter;
}
