/**
 * 법고개(Bupgogae) — Site Adapter Registry
 * ==========================================
 * 현재 호스트명에 맞는 어댑터를 자동 선택하는 팩토리.
 *
 * [사용법]
 *   // 비동기 초기화 — Remote Config 자동 로드 (★ 권장)
 *   const adapter = await window.bupgogaeAdapters.initAdapters();
 *
 *   // 동기 호출 — Remote Config 없이 (하위 호환)
 *   const adapter = window.bupgogaeAdapters.getAdapter();
 *
 * [등록 방식]
 *   각 어댑터 파일이 window.bupgogaeAdapters에 클래스를 등록하고,
 *   이 파일의 ADAPTER_MAP이 호스트명 → 클래스를 매핑.
 */

/**
 * 호스트명 → 어댑터 클래스 매핑.
 * 새 사이트 추가 시 여기에 한 줄 추가.
 */
const ADAPTER_MAP = {
  'gemini.google.com':     'GeminiAdapter',
  'chatgpt.com':           'ChatGPTAdapter',
  'claude.ai':             'ClaudeAdapter',
  'copilot.microsoft.com': 'CopilotAdapter',
  'www.perplexity.ai':     'PerplexityAdapter',
  'perplexity.ai':         'PerplexityAdapter',
  'grok.com':              'GrokAdapter',
};

/**
 * 캐시된 Remote Config (세션 중 재사용).
 * @type {Object|null}
 */
let _cachedRemoteConfig = null;

/**
 * chrome.storage.local에서 원격 어댑터 설정을 비동기 로드.
 * Service Worker(db-sync.js)가 저장한 bupgogae_remote_adapters 키를 읽음.
 *
 * @returns {Promise<Object|null>} Remote Config 객체 또는 null
 */
async function loadRemoteConfig() {
  try {
    const data = await chrome.storage.local.get('bupgogae_remote_adapters');
    const config = data.bupgogae_remote_adapters || null;

    if (config && config.adapters) {
      console.log(`[bupgogae] Remote Config 로드 완료 (ver=${config.version || '?'})`);
      _cachedRemoteConfig = config;
      return config;
    }

    console.log('[bupgogae] Remote Config 없음 — 하드코딩 셀렉터 사용');
    return null;
  } catch (err) {
    console.warn('[bupgogae] Remote Config 로드 실패:', err.message);
    return null;
  }
}

/**
 * 현재 호스트명에 맞는 어댑터 인스턴스를 반환.
 * remoteConfig가 제공되면 어댑터에 주입 (resolveResponseSelectors()에서 활용).
 *
 * @param {Object|null} [remoteConfig] - 원격 설정 객체 (없으면 캐시 사용)
 * @returns {SiteAdapter|null} 미지원 사이트이면 null
 */
function getAdapter(remoteConfig) {
  const hostname = location.hostname;
  const config = remoteConfig || _cachedRemoteConfig;

  /**
   * 어댑터 인스턴스 생성 + Remote Config 주입 헬퍼.
   * @param {Function} AdapterClass
   * @returns {SiteAdapter}
   */
  function createAndConfigure(AdapterClass) {
    const instance = new AdapterClass();
    // Remote Config 주입 (setRemoteConfig는 base-adapter.js에서 제공)
    if (config && typeof instance.setRemoteConfig === 'function') {
      instance.setRemoteConfig(config);
    }
    return instance;
  }

  // 정확 매치
  const adapterName = ADAPTER_MAP[hostname];
  if (adapterName && window.bupgogaeAdapters[adapterName]) {
    const AdapterClass = window.bupgogaeAdapters[adapterName];
    const instance = createAndConfigure(AdapterClass);
    console.log(`[bupgogae] 어댑터 감지: ${instance.displayName} (${hostname})`);
    return instance;
  }

  // 서브도메인 폴백 (예: www.chatgpt.com → chatgpt.com)
  for (const [host, name] of Object.entries(ADAPTER_MAP)) {
    if (hostname.endsWith('.' + host) || hostname === host) {
      if (window.bupgogaeAdapters[name]) {
        const AdapterClass = window.bupgogaeAdapters[name];
        const instance = createAndConfigure(AdapterClass);
        console.log(`[bupgogae] 어댑터 감지 (서브도메인): ${instance.displayName} (${hostname} → ${host})`);
        return instance;
      }
    }
  }

  console.warn(`[bupgogae] 미지원 사이트: ${hostname}`);
  return null;
}

/**
 * 비동기 어댑터 초기화 — Remote Config 로드 후 어댑터 반환.
 * Content Script 초기화(init())에서 사용하는 권장 진입점.
 *
 * @returns {Promise<SiteAdapter|null>}
 */
async function initAdapters() {
  const config = await loadRemoteConfig();
  return getAdapter(config);
}

/**
 * Remote Config를 다시 로드하여 기존 어댑터에 재주입.
 * Auto-Fetch 트리거 후 갱신된 설정을 적용할 때 사용.
 *
 * @param {SiteAdapter} adapter - 재주입 대상 어댑터 인스턴스
 * @returns {Promise<void>}
 */
async function reloadRemoteConfig(adapter) {
  const config = await loadRemoteConfig();
  if (adapter && typeof adapter.setRemoteConfig === 'function') {
    adapter.setRemoteConfig(config);
  }
}

/**
 * 지원 사이트 목록 반환 (팝업 UI 등에서 사용).
 * @returns {{ hostname: string, displayName: string }[]}
 */
function getSupportedSites() {
  return Object.entries(ADAPTER_MAP).map(([hostname, name]) => {
    const AdapterClass = window.bupgogaeAdapters[name];
    return {
      hostname,
      displayName: AdapterClass ? new AdapterClass().displayName : name,
      adapterName: name,
    };
  });
}

// 외부 인터페이스
if (typeof window !== 'undefined') {
  window.bupgogaeAdapters = window.bupgogaeAdapters || {};
  window.bupgogaeAdapters.getAdapter = getAdapter;
  window.bupgogaeAdapters.initAdapters = initAdapters;
  window.bupgogaeAdapters.reloadRemoteConfig = reloadRemoteConfig;
  window.bupgogaeAdapters.getSupportedSites = getSupportedSites;
  window.bupgogaeAdapters.ADAPTER_MAP = ADAPTER_MAP;
}
