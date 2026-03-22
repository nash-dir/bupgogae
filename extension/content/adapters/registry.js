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
 * 캐시된 번들 Config (세션 중 재사용).
 * @type {Object|null}
 */
let _cachedBundledConfig = null;

/**
 * extension/data/adapters.json에서 번들 설정을 로드.
 * 확장 프로그램에 동봉된 셀렉터 정의 파일 — Single Source of Truth.
 *
 * @returns {Promise<Object|null>} 번들 Config 객체 또는 null
 */
async function loadBundledConfig() {
  if (_cachedBundledConfig) return _cachedBundledConfig;

  try {
    const url = chrome.runtime.getURL('data/adapters.json');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = await response.json();

    if (config && config.adapters) {
      console.log(`[bupgogae] 번들 adapters.json 로드 완료 (ver=${config.version || '?'})`);
      _cachedBundledConfig = config;
      return config;
    }

    console.warn('[bupgogae] 번들 adapters.json: adapters 필드 없음');
    return null;
  } catch (err) {
    console.warn('[bupgogae] 번들 adapters.json 로드 실패:', err.message);
    return null;
  }
}

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

    console.log('[bupgogae] Remote Config 없음 — 번들/하드코딩 셀렉터 사용');
    return null;
  } catch (err) {
    console.warn('[bupgogae] Remote Config 로드 실패:', err.message);
    return null;
  }
}

/**
 * 현재 호스트명에 맞는 어댑터 인스턴스를 반환.
 * remoteConfig와 bundledConfig를 어댑터에 주입.
 *
 * @param {Object|null} [remoteConfig] - 원격 설정 객체 (없으면 캐시 사용)
 * @param {Object|null} [bundledConfig] - 번들 설정 객체 (없으면 캐시 사용)
 * @returns {SiteAdapter|null} 미지원 사이트이면 null
 */
function getAdapter(remoteConfig, bundledConfig) {
  const hostname = location.hostname;
  const remote = remoteConfig || _cachedRemoteConfig;
  const bundled = bundledConfig || _cachedBundledConfig;

  /**
   * 어댑터 인스턴스 생성 + Config 주입 헬퍼.
   * @param {Function} AdapterClass
   * @returns {SiteAdapter}
   */
  function createAndConfigure(AdapterClass) {
    const instance = new AdapterClass();
    // 번들 Config 주입 (2순위)
    if (bundled && bundled.adapters && bundled.adapters[instance.siteId]) {
      instance.setBundledConfig(bundled.adapters[instance.siteId]);
    }
    // Remote Config 주입 (1순위, setBundledConfig 후 호출)
    if (remote && typeof instance.setRemoteConfig === 'function') {
      instance.setRemoteConfig(remote);
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
 * 비동기 어댑터 초기화 — 번들 JSON + Remote Config 로드 후 어댑터 반환.
 * Content Script 초기화(init())에서 사용하는 권장 진입점.
 *
 * @returns {Promise<SiteAdapter|null>}
 */
async function initAdapters() {
  // 번들 JSON과 Remote Config를 병렬 로드
  const [bundledConfig, remoteConfig] = await Promise.all([
    loadBundledConfig(),
    loadRemoteConfig(),
  ]);
  return getAdapter(remoteConfig, bundledConfig);
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
