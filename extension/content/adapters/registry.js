/**
 * 법고개(Bupgogae) — Site Adapter Registry
 * ==========================================
 * 현재 호스트명에 맞는 어댑터를 자동 선택하는 팩토리.
 *
 * [사용법]
 *   // 비동기 초기화 — 번들 adapters.json 로드 (★ 권장)
 *   const adapter = await window.bupgogaeAdapters.initAdapters();
 *
 *   // 동기 호출 — 이미 로드된 번들 설정 사용
 *   const adapter = window.bupgogaeAdapters.getAdapter();
 *
 * [등록 방식]
 *   L-7: 셀렉터가 adapters.json으로 통합된 결과, 각 어댑터 클래스는
 *   siteId/displayName getter만 정의하는 빈 껍데기이므로 이 파일에 인라인 정의.
 */

// ============================================================
// 사이트 정의 — 단일 소스(SSOT)
//   adapterName/siteId/displayName/hosts를 여기서 한 번만 정의하고,
//   어댑터 클래스 / ADAPTER_MAP(host→class) / ADAPTER_DISPLAY_NAMES를
//   모두 이 배열에서 파생한다. (L-7: 6개 클래스 인라인 → 1개 테이블)
//
//   새 사이트 추가: 이 배열에 한 줄 + adapters.json hosts/adapters에 셀렉터 추가.
//   (manifest.json matches/host_permissions는 Chrome 요구상 별도 정적 선언)
// ============================================================

const SITE_DEFS = [
  { adapterName: 'GeminiAdapter',     siteId: 'gemini',     displayName: 'Google Gemini',    hosts: ['gemini.google.com'] },
  { adapterName: 'ChatGPTAdapter',    siteId: 'chatgpt',    displayName: 'ChatGPT',          hosts: ['chatgpt.com'] },
  { adapterName: 'ClaudeAdapter',     siteId: 'claude',     displayName: 'Claude',           hosts: ['claude.ai'] },
  { adapterName: 'CopilotAdapter',    siteId: 'copilot',    displayName: 'Copilot (실험적)', hosts: ['copilot.microsoft.com', 'copilot.com', 'copilot.cloud.microsoft'] },
  { adapterName: 'PerplexityAdapter', siteId: 'perplexity', displayName: 'Perplexity',       hosts: ['www.perplexity.ai', 'perplexity.ai'] },
  { adapterName: 'GrokAdapter',       siteId: 'grok',       displayName: 'Grok (실험적)',    hosts: ['grok.com'] },
];

// 호스트명 → 어댑터 클래스명. SITE_DEFS에서 파생.
const ADAPTER_MAP = {};
// 어댑터 클래스명 → 표시명. SITE_DEFS에서 파생 (불필요한 인스턴스 생성 회피용).
const ADAPTER_DISPLAY_NAMES = {};

for (const def of SITE_DEFS) {
  // 각 어댑터는 siteId/displayName getter만 다른 빈 껍데기이므로 동적 생성.
  const AdapterClass = class extends window.bupgogaeAdapters.SiteAdapter {
    get siteId() { return def.siteId; }
    get displayName() { return def.displayName; }
  };
  window.bupgogaeAdapters[def.adapterName] = AdapterClass;
  ADAPTER_DISPLAY_NAMES[def.adapterName] = def.displayName;
  for (const host of def.hosts) {
    ADAPTER_MAP[host] = def.adapterName;
  }
}

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
 * 현재 호스트명에 맞는 어댑터 인스턴스를 반환.
 * 번들 설정을 어댑터에 주입.
 *
 * @param {Object|null} [bundledConfig] - 번들 설정 객체 (없으면 캐시 사용)
 * @returns {SiteAdapter|null} 미지원 사이트이면 null
 */
function getAdapter(bundledConfig) {
  const hostname = location.hostname;
  const bundled = bundledConfig || _cachedBundledConfig;

  /**
   * 어댑터 인스턴스 생성 + Config 주입 헬퍼.
   * @param {Function} AdapterClass
   * @returns {SiteAdapter}
   */
  function createAndConfigure(AdapterClass) {
    const instance = new AdapterClass();
    // 패키지에 포함된 번들 Config만 사용
    if (bundled && bundled.adapters && bundled.adapters[instance.siteId]) {
      instance.setBundledConfig(bundled.adapters[instance.siteId]);
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

/** 번들 설정 로드 후 현재 사이트 어댑터를 반환한다. */
async function initAdapters() {
  return getAdapter(await loadBundledConfig());
}

/**
 * 지원 사이트 목록 반환 (팝업 UI 등에서 사용).
 * @returns {{ hostname: string, displayName: string }[]}
 */
function getSupportedSites() {
  const seen = new Set();
  const result = [];
  for (const [hostname, name] of Object.entries(ADAPTER_MAP)) {
    if (seen.has(name)) continue;  // 동일 어댑터의 두 번째 호스트 항목 스킵
    seen.add(name);
    result.push({ hostname, displayName: ADAPTER_DISPLAY_NAMES[name] || name, adapterName: name });
  }
  return result;
}

// 외부 인터페이스
if (typeof window !== 'undefined') {
  window.bupgogaeAdapters = window.bupgogaeAdapters || {};
  window.bupgogaeAdapters.getAdapter = getAdapter;
  window.bupgogaeAdapters.initAdapters = initAdapters;
  window.bupgogaeAdapters.loadBundledConfig = loadBundledConfig;
  window.bupgogaeAdapters.getSupportedSites = getSupportedSites;
  window.bupgogaeAdapters.ADAPTER_MAP = ADAPTER_MAP;
}
