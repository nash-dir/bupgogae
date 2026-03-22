/**
 * 법고개(Bupgogae) — Site Adapter 기본 클래스
 * =============================================
 * 각 LLM 채팅 서비스(Gemini, ChatGPT, Claude, Copilot 등)의
 * DOM 구조 차이를 추상화하는 어댑터 패턴의 기본 인터페이스.
 *
 * 사이트별 구현체는 이 클래스를 상속하여 siteId/displayName만 정의.
 * 셀렉터는 adapters.json(Single Source of Truth)에서 로드.
 * 공통 로직(findResponseContainers, isStreaming 등)은 여기서 제공.
 */

class SiteAdapter {
  /**
   * 원격 설정 (Remote Config) 저장 필드.
   * registry.js에서 초기화 시 주입됨.
   * @type {Object|null}
   */
  _remoteConfig = null;

  /**
   * 번들 JSON에서 로드된 셀렉터.
   * initAdapters() 시 extension/data/adapters.json에서 주입됨.
   * @type {string[]|null}
   */
  _bundledSelectors = null;

  /**
   * 번들 JSON에서 로드된 streamingIndicator.
   * @type {string|null}
   */
  _bundledStreamingIndicator = null;

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
   * 원격 설정을 어댑터에 주입.
   * 전체 config 객체를 받아 siteId에 맞는 설정만 내부에 저장.
   * @param {Object|null} fullConfig - { version, adapters: { [siteId]: { responseSelectors, ... } } }
   */
  setRemoteConfig(fullConfig) {
    if (fullConfig && fullConfig.adapters && fullConfig.adapters[this.siteId]) {
      this._remoteConfig = fullConfig.adapters[this.siteId];
      console.log(`[bupgogae:${this.siteId}] Remote Config 적용 (ver=${fullConfig.version || '?'})`);
    } else {
      this._remoteConfig = null;
    }
  }

  /**
   * 번들 JSON의 셀렉터를 어댑터에 주입.
   * @param {Object} siteConfig - { responseSelectors: [...], streamingIndicator?: "..." }
   */
  setBundledConfig(siteConfig) {
    if (siteConfig && Array.isArray(siteConfig.responseSelectors)) {
      this._bundledSelectors = siteConfig.responseSelectors;
    }
    if (siteConfig && siteConfig.streamingIndicator) {
      this._bundledStreamingIndicator = siteConfig.streamingIndicator;
    }
  }

  /**
   * 해당 사이트의 AI 응답 컨테이너 CSS 셀렉터 목록 (하드코딩 폴백).
   * adapters.json 통합 후, 자식 클래스에서 오버라이드할 필요 없음.
   * 번들 JSON이 로드되지 못한 극단적 폴백 상황에서만 사용됨.
   * @returns {string[]}
   */
  getResponseSelectors() {
    return [];
  }

  /**
   * 셀렉터 해석 래퍼 — 3단 우선순위 체인.
   *
   * 우선순위:
   *   1. Remote Config (chrome.storage.local, 원격 갱신)
   *   2. 번들 JSON   (extension/data/adapters.json, 설치 시 포함)
   *   3. 하드코딩     (자식 getResponseSelectors(), 극단적 폴백)
   *
   * adapters.json이 Single Source of Truth.
   * Remote Config는 긴급 핫픽스용, 하드코딩은 최후 방어선.
   *
   * @returns {string[]}
   */
  resolveResponseSelectors() {
    // 1순위: Remote Config
    if (this._remoteConfig &&
        Array.isArray(this._remoteConfig.responseSelectors) &&
        this._remoteConfig.responseSelectors.length > 0) {
      return this._remoteConfig.responseSelectors;
    }

    // 2순위: 번들 JSON (adapters.json)
    if (this._bundledSelectors && this._bundledSelectors.length > 0) {
      return this._bundledSelectors;
    }

    // 3순위: 하드코딩 셀렉터 (극단적 폴백)
    return this.getResponseSelectors();
  }

  /**
   * 현재 DOM에서 AI 응답 컨테이너들을 탐색.
   * 기본 구현: resolveResponseSelectors()로 셀렉터를 순서대로 시도하여 첫 매치를 채택.
   * @returns {Element[]}
   */
  findResponseContainers() {
    for (const selector of this.resolveResponseSelectors()) {
      try {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          return Array.from(elements);
        }
      } catch (e) {
        // 잘못된 셀렉터 무시 (예: 원격 업데이트된 잘못된 셀렉터)
        console.warn(`[bupgogae:${this.siteId}] 셀렉터 오류: ${selector}`, e);
      }
    }
    return [];
  }

  /**
   * 컨테이너가 현재 스트리밍(응답 생성 중) 상태인지 판별.
   * 스트리밍 중에는 partial text → 완료 후 재스캔이 효율적일 수 있음.
   *
   * 기본: adapters.json의 streamingIndicator 셀렉터를 사용.
   * 자식 클래스에서 복잡한 로직이 필요하면 오버라이드 가능.
   *
   * @param {Element} container
   * @returns {boolean}
   */
  isStreaming(container) {
    // Remote Config → 번들 JSON 순으로 streamingIndicator 확인
    const indicator =
      (this._remoteConfig && this._remoteConfig.streamingIndicator) ||
      this._bundledStreamingIndicator;

    if (indicator) {
      return !!(
        container.classList.contains(indicator.replace(/^\./,'')) ||
        container.closest(indicator)
      );
    }
    return false;
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
    };
  }
}

// 외부 인터페이스
if (typeof window !== 'undefined') {
  window.bupgogaeAdapters = window.bupgogaeAdapters || {};
  window.bupgogaeAdapters.SiteAdapter = SiteAdapter;
}
