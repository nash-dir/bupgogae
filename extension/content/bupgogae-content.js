/**
 * 법고개(Bupgogae) — Content Script 통합 컨트롤러
 * ========================================================
 * LLM 채팅 응답에서 판례번호를 실시간으로 감지하고
 * 3단 신호등(Green/Orange/Red) 배지를 렌더링하는 메인 모듈.
 *
 * 멀티 플랫폼 지원: Gemini, ChatGPT, Claude, Copilot, Perplexity, Grok
 * 사이트별 DOM 차이는 어댑터(adapters/)에서 추상화.
 *
 * [파이프라인]
 *   ① 어댑터 자동 감지 → 사이트별 셀렉터 로드
 *   ② MutationObserver — debounce 500ms
 *   ③ extractCaseNumbers(text) → 사건번호 후보 배열
 *   ④ validateCaseNumber() → Red 즉시 렌더링
 *   ⑤ compressCaseKey() → 압축 키 배열
 *   ⑥ chrome.runtime.sendMessage({ type: 'LOOKUP_BATCH' })
 *   ⑦ 결과 순회 → Green/Orange 렌더링
 *
 * [의존성]
 *   - adapters/*.js   (SiteAdapter 구현체 + 레지스트리)
 *   - case-regex.js   (extractCaseNumbers, validateCaseNumber, compressCaseKey)
 *   - precedent-badge.js (renderPrecedentBadge, decodeCaseName)
 *   - db-sync.js      (Service Worker — LOOKUP_BATCH, GET_META)
 */

// ============================================================
// 1. 상수
// ============================================================

const DEBOUNCE_MS = 500;
const PROCESSED_ATTR = 'data-bgae-processed';
const MAX_BATCH_SIZE = 50; // 한 번에 조회할 최대 키 수


// ============================================================
// 2. 초기화
// ============================================================

let _debounceTimer = null;
let _isProcessing = false;
let _adapter = null; // 현재 사이트 어댑터
let _adapterFetchRequested = false; // Auto-Fetch 쓰로틀링 플래그 (세션당 1회)
let _categoryFilters = {         // 카테고리별 필터 (기본값)
  court: true,
  constitutional: true,
  tax: false,
};

/**
 * Content Script 진입점.
 * 메타데이터 로드 후 MutationObserver 시작.
 */
async function init() {
  console.log('[bupgogae] Content Script 초기화 시작');

  // ── 어댑터 자동 감지 (Remote Config 비동기 로드 포함) ──
  if (window.bupgogaeAdapters && window.bupgogaeAdapters.initAdapters) {
    _adapter = await window.bupgogaeAdapters.initAdapters();
  } else if (window.bupgogaeAdapters && window.bupgogaeAdapters.getAdapter) {
    // 하위 호환 폴백 (initAdapters 없는 경우)
    _adapter = window.bupgogaeAdapters.getAdapter();
  }
  if (!_adapter) {
    console.warn('[bupgogae] 현재 사이트에 대응하는 어댑터 없음 — 종료');
    return;
  }

  // ── 비활성 상태 확인 ──
  const enabledResult = await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'CHECK_ENABLED', hostname: location.hostname },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[bupgogae] 활성 상태 확인 실패:', chrome.runtime.lastError.message);
          resolve({ enabled: true }); // 실패 시 기본 활성
          return;
        }
        resolve(response || { enabled: true });
      }
    );
  });

  if (!enabledResult.enabled) {
    console.log(`[bupgogae] 비활성 상태 (${enabledResult.reason || 'unknown'}) — 처리 스킵`);
    return;
  }

  // case-regex.js의 initMeta() 호출
  if (window.bupgogaeCaseRegex) {
    await window.bupgogaeCaseRegex.initMeta();
    console.log('[bupgogae] 메타데이터 초기화 완료');
  } else {
    console.error('[bupgogae] case-regex.js 로드 실패');
    return;
  }

  // 카테고리 필터 로드
  try {
    const filterData = await chrome.storage.local.get([
      'bupgogae_filter_court',
      'bupgogae_filter_constitutional',
      'bupgogae_dlc_tax',
    ]);
    _categoryFilters = {
      court: filterData.bupgogae_filter_court !== false,         // 기본 ON
      constitutional: filterData.bupgogae_filter_constitutional !== false, // 기본 ON
      tax: filterData.bupgogae_dlc_tax === true,                 // 기본 OFF
    };
    console.log('[bupgogae] 카테고리 필터:', _categoryFilters);
  } catch (err) {
    console.warn('[bupgogae] 필터 로드 실패, 기본값 사용');
  }

  // precedent-badge.js 확인
  if (!window.bupgogae || !window.bupgogae.renderPrecedentBadge) {
    console.error('[bupgogae] precedent-badge.js 로드 실패');
    return;
  }

  // MutationObserver 시작
  startObserver();

  // 초기 스캔 (이미 로드된 응답이 있을 수 있으므로)
  scheduleProcessing();

  console.log(`[bupgogae] Content Script 초기화 완료 — ${_adapter.displayName} ✅`);
}


// ============================================================
// 3. MutationObserver — Gemini 응답 변경 감지
// ============================================================

let _observer = null;

/**
 * MutationObserver 시작.
 * LLM 서비스가 응답을 렌더링할 때 DOM 변경을 감지하여 처리한다.
 * 관찰 대상과 옵션은 어댑터에서 제공.
 */
function startObserver() {
  if (_observer) return;

  _observer = new MutationObserver((mutations) => {
    // 배지 렌더링으로 인한 DOM 변경은 무시
    const hasRelevantChanges = mutations.some(m => {
      // addedNodes 중 배지가 아닌 실제 콘텐츠 변경이 있는지 확인
      for (const node of m.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // 우리가 삽입한 배지 요소는 스킵
          if (node.classList && node.classList.contains('bgae-badge')) continue;
          if (node.id === 'bupgogae-shadow-host') continue;
          return true;
        }
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
          return true;
        }
      }
      // characterData 변경도 감지
      if (m.type === 'characterData') return true;
      return false;
    });

    if (hasRelevantChanges) {
      scheduleProcessing();
    }
  });

  // 어댑터가 제공하는 관찰 대상 및 옵션 사용
  const target = _adapter ? _adapter.getObserverTarget() : document.body;
  const options = _adapter ? _adapter.getObserverOptions() : {
    childList: true, subtree: true, characterData: true,
  };
  _observer.observe(target, options);

  console.log(`[bupgogae] MutationObserver 시작 (${_adapter ? _adapter.siteId : 'fallback'})`);
}


// ============================================================
// 4. Debounce + 처리 스케줄러
// ============================================================

/**
 * 처리를 debounce하여 스케줄링.
 * 빠른 연속 DOM 변경에 대해 마지막 변경 후 500ms 뒤에 1회만 처리.
 */
function scheduleProcessing() {
  if (_debounceTimer) clearTimeout(_debounceTimer);

  _debounceTimer = setTimeout(() => {
    if (!_isProcessing) {
      processAllResponses();
    }
  }, DEBOUNCE_MS);
}


// ============================================================
// 5. 핵심 처리 로직 — 3단 파이프라인
// ============================================================

/**
 * 모든 Gemini 응답 컨테이너를 스캔하고 판례번호를 처리.
 */
async function processAllResponses() {
  if (_isProcessing) return;
  // 메타데이터 준비 완료 전에는 실행 건너뛰기
  if (window.bupgogaeCaseRegex && !window.bupgogaeCaseRegex.isMetaReady()) {
    console.debug('[bupgogae] 처리 스킵: 메타데이터 준비 안됨');
    return;
  }
  _isProcessing = true;
  const startTime = performance.now();

  try {
    // Gemini 응답 컨테이너 찾기
    const containers = findResponseContainers();
    if (containers.length === 0) {
      _isProcessing = false;
      return;
    }

    for (const container of containers) {
      await processContainer(container);
    }
  } catch (err) {
    console.error('[bupgogae] 처리 중 오류:', err);
  } finally {
    _isProcessing = false;
    const duration = performance.now() - startTime;
    await handleCircuitBreaker(duration);
  }
}

/**
 * 서킷 브레이커 (Circuit Breaker): 이상 현상(1500ms 초과) 감지 및 비상 정지
 * @param {number} duration 실행 시간 (ms)
 */
async function handleCircuitBreaker(duration) {
  try {
    const data = await chrome.storage.local.get([
      'bupgogae_circuit_strikes',
      'bupgogae_circuit_fast_streak'
    ]);
    
    let strikes = data.bupgogae_circuit_strikes || 0;
    let fastStreak = data.bupgogae_circuit_fast_streak || 0;
    let updated = false;

    if (duration > 1500) {
      strikes += 1;
      fastStreak = 0;
      updated = true;
      console.warn(`[bupgogae] ⚠️ 서킷 브레이커: 처리 시간 지연 감지 (${duration.toFixed(2)}ms). 누적 스트라이크: ${strikes}/3`);

      if (strikes >= 3) {
        // 비상 정지 요건 충족
        if (_observer) {
          _observer.disconnect();
          _observer = null;
        }
        chrome.runtime.sendMessage({ type: 'EMERGENCY_DISABLE' });
        alert('원격 설정 오류가 지속 감지되어 보호를 위해 확장프로그램을 영구 비활성화합니다.');
        return; // 추가 업데이트 진행 안 함
      }
    } else if (duration <= 100) {
      // 100ms 이하이면 회복 카운트 증가 (과거 strike 기록이 있을 때만 측정)
      if (strikes > 0 || fastStreak > 0) {
        fastStreak += 1;
        updated = true;
        
        if (fastStreak >= 10) {
          console.log(`[bupgogae] 🔄 서킷 브레이커 상태 복구: 연속 ${fastStreak}회 정상 처리. 스트라이크 리셋.`);
          strikes = 0;
          fastStreak = 0;
        }
      }
    }

    if (updated) {
      await chrome.storage.local.set({
        bupgogae_circuit_strikes: strikes,
        bupgogae_circuit_fast_streak: fastStreak
      });
    }
  } catch (err) {
    console.error('[bupgogae] 서킷 브레이커 상태 처리 실패:', err);
  }
}

/**
 * AI 응답 컨테이너 요소들을 찾는다.
 * 어댑터의 셀렉터를 사용하여 사이트에 맞는 컨테이너 탐색.
 * @returns {Element[]}
 */
function findResponseContainers() {
  if (_adapter) {
    const containers = _adapter.findResponseContainers();
    if (containers.length > 0) return containers;

    // ── Auto-Fetch 트리거: 어댑터 셀렉터 매치 실패 시 원격 설정 재동기화 요청 ──
    // 세션(페이지 로드)당 1회만 실행하여 무한 루프 방지
    if (!_adapterFetchRequested) {
      _adapterFetchRequested = true;
      console.log(`[bupgogae] ${_adapter.displayName} 셀렉터 매치 실패 — FETCH_ADAPTERS 트리거`);

      // Background Script에 어댑터 설정 재동기화 요청 (fire-and-forget)
      chrome.runtime.sendMessage({ type: 'FETCH_ADAPTERS' }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[bupgogae] FETCH_ADAPTERS 요청 실패:', chrome.runtime.lastError.message);
          return;
        }
        if (response && response.success) {
          console.log('[bupgogae] FETCH_ADAPTERS 완료 — Remote Config 재로드');
          // 갱신된 설정을 어댑터에 재주입
          if (window.bupgogaeAdapters && window.bupgogaeAdapters.reloadRemoteConfig) {
            window.bupgogaeAdapters.reloadRemoteConfig(_adapter);
          }
        }
      });
    }
  }

  // 폴백: 어댑터가 실패하면 body 전체를 대상으로
  // (성능상 비효율적이지만 동작은 보장)
  console.warn(`[bupgogae] ${_adapter ? _adapter.displayName : '(unknown)'} 응답 컨테이너를 찾지 못함. body 전체 스캔.`);
  return [document.body];
}

/**
 * 단일 컨테이너의 텍스트 노드를 순회하며 판례번호를 처리.
 * @param {Element} container
 */
async function processContainer(container) {
  // 미처리 텍스트 노드 수집
  const textNodes = collectTextNodes(container);
  if (textNodes.length === 0) return;

  // 모든 텍스트에서 사건번호 추출
  const allCases = [];
  const nodeMap = new Map(); // raw → { textNode, parsed }[]

  for (const textNode of textNodes) {
    const text = textNode.textContent;
    if (!text || text.length < 5) continue; // 최소 "99다1" 정도는 되어야

    const cases = window.bupgogaeCaseRegex.extractCaseNumbers(text);
    for (const parsed of cases) {
      allCases.push({ textNode, parsed });

      if (!nodeMap.has(parsed.raw)) {
        nodeMap.set(parsed.raw, []);
      }
      nodeMap.get(parsed.raw).push({ textNode, parsed });
    }
  }

  if (allCases.length === 0) return;

  // 카테고리 필터 적용: 비활성 타입은 스킵
  const filteredCases = allCases.filter(({ parsed }) => _categoryFilters[parsed.type] !== false);

  if (filteredCases.length === 0) return;

  console.log(`[bupgogae] ${filteredCases.length}개 사건번호 감지 (${allCases.length}개 중 필터 통과)`);

  // ── Stage 1: Red 필터 ──
  const redCases = [];
  const lookupCases = [];

  for (const { textNode, parsed } of filteredCases) {
    const validation = window.bupgogaeCaseRegex.validateCaseNumber(parsed);

    if (!validation.valid) {
      redCases.push({ textNode, parsed, reason: validation.reason });
    } else {
      lookupCases.push({ textNode, parsed });
    }
  }

  // Red 즉시 렌더링
  for (const { textNode, parsed, reason } of redCases) {
    renderBadge(textNode, parsed.raw, 'red', { redReason: reason });
  }

  if (lookupCases.length === 0) return;

  // ── Stage 2: 키 압축 ──
  const keyToCases = new Map(); // compressedKey → { textNode, parsed }[]

  for (const { textNode, parsed } of lookupCases) {
    const key = window.bupgogaeCaseRegex.compressCaseKey(parsed);
    if (!key) {
      // case_code_map에 없는 부호 → Orange (안전 처리)
      renderBadge(textNode, parsed.raw, 'orange');
      continue;
    }

    if (!keyToCases.has(key)) {
      keyToCases.set(key, []);
    }
    keyToCases.get(key).push({ textNode, parsed });
  }

  if (keyToCases.size === 0) return;

  // ── Stage 2.5: Pending (Gray) 렌더링 ──
  const pendingBadges = new Map(); // key -> { badge, parsed }[]

  for (const [key, entries] of keyToCases) {
    const items = [];
    for (const { textNode, parsed } of entries) {
      // 타다닥 효과를 위한 회색 껍데기 렌더링
      const badge = renderBadge(textNode, parsed.raw, 'gray');
      items.push({ badge, parsed }); // badge가 null이어도(이미 렌더링됨) 안전하게 모아둠
    }
    pendingBadges.set(key, items);
  }

  // ── Stage 3: 배치 조회 ──
  const keys = Array.from(pendingBadges.keys());
  const results = await batchLookup(keys);

  // ── Stage 4: Green/Orange 렌더링 (결과 덮어쓰기) ──
  const courtCodeMap = window.bupgogaeCaseRegex.getCourtCodeMap();

  for (const [key, items] of pendingBadges) {
    const result = results[key];

    // 🚨 DB 조회 지연/시스템 에러: 원래 텍스트 노드로 원복 (다음 스캔을 위해)
    if (result && result.error) {
      for (const item of items) {
        if (item.badge) {
          window.bupgogae.revertPrecedentBadge(item.badge, item.parsed.raw);
        }
      }
      continue;
    }

    if (result && result.found) {
      // Green — data 배열의 모든 매칭 사건을 entries로 조립
      const data = result.data;
      const entryType = items[0]?.parsed?.type;
      const caseCode = items[0]?.parsed?.code;

      const greenEntries = [];

      if (data && data.length > 0) {
        for (const row of data) {
          if (!row || row.length < 1) continue;

          const entry = {
            serialNumber: row[0],
            courtCode: null,
            dateInt: null,
            caseName: '',
            caseType: entryType || 'court',
            caseCode: caseCode || '',
            trialType: '',
          };

          if (row.length >= 2) entry.courtCode = row[1];
          if (row.length >= 3 && typeof row[2] === 'number') entry.dateInt = row[2];
          const nameIdx = (typeof row[2] === 'string') ? 2 : 3;
          if (row.length > nameIdx && typeof row[nameIdx] === 'string') {
            entry.caseName = row[nameIdx] || '';
          }

          greenEntries.push(entry);
        }
      }

      // 매칭이 0건이면 안전 처리 (빈 entries 배열)
      if (greenEntries.length === 0) {
        greenEntries.push({
          serialNumber: '', courtCode: null, dateInt: null,
          caseName: '', caseType: entryType || 'court',
          caseCode: caseCode || '', trialType: '',
        });
      }

      for (const item of items) {
        if (item.badge) {
          window.bupgogae.updatePrecedentBadge(item.badge, item.parsed.raw, 'green', {
            greenEntries,
            caseCode: item.parsed.code,
            caseType: item.parsed.type,
            courtCodeMap,
          });
        }
      }
    } else {
      // Orange
      for (const item of items) {
        if (item.badge) {
          window.bupgogae.updatePrecedentBadge(item.badge, item.parsed.raw, 'orange');
        }
      }
    }
  }
}


// ============================================================
// 6. 텍스트 노드 수집
// ============================================================

/**
 * 아직 처리되지 않은 텍스트 노드만 수집.
 * @param {Element} root
 * @returns {Text[]}
 */
function collectTextNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        // 이미 처리된 노드 스킵
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        // 편집 가능 영역 (프롬프트 입력창) 스킵
        if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
        if (parent.closest('[contenteditable="true"], [contenteditable=""], textarea, [role="textbox"]')) {
          return NodeFilter.FILTER_REJECT;
        }

        // 배지 내부 텍스트 스킵
        if (parent.closest('.bgae-badge')) return NodeFilter.FILTER_REJECT;
        if (parent.closest('#bupgogae-shadow-host')) return NodeFilter.FILTER_REJECT;

        // 처리 완료 마킹된 부모 스킵
        if (parent.hasAttribute(PROCESSED_ATTR)) return NodeFilter.FILTER_REJECT;

        // 빈 텍스트 스킵
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;

        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }

  return nodes;
}


// ============================================================
// 7. 배치 조회 래퍼
// ============================================================

/**
 * Service Worker에 배치 조회 요청.
 * MAX_BATCH_SIZE 초과 시 분할 처리.
 * @param {string[]} keys
 * @returns {Promise<Object>}
 */
async function batchLookup(keys) {
  if (keys.length === 0) return {};

  // 분할 처리
  const allResults = {};
  for (let i = 0; i < keys.length; i += MAX_BATCH_SIZE) {
    const chunk = keys.slice(i, i + MAX_BATCH_SIZE);

    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'LOOKUP_BATCH', keys: chunk },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[bupgogae] 배치 조회 실패:', chrome.runtime.lastError.message);
            // 에러 시 error: true 플래그 포함시켜서 렌더링 스킵 유도 (Orange 방지)
            const fallback = {};
            for (const k of chunk) {
              fallback[k] = { found: false, data: null, error: true };
            }
            resolve(fallback);
            return;
          }
          resolve(response || {});
        }
      );
    });

    Object.assign(allResults, result);
  }

  return allResults;
}


// ============================================================
// 8. 렌더링 래퍼
// ============================================================

/**
 * renderPrecedentBadge 래퍼.
 * 중복 렌더링 방지 및 오류 처리.
 *
 * @param {Text} textNode
 * @param {string} raw - 원본 사건번호 문자열
 * @param {'green'|'orange'|'red'|'gray'} level
 * @param {Object} [options]
 * @returns {HTMLElement|null} 생성된 배지 DOM 엘리먼트
 */
function renderBadge(textNode, raw, level, options = {}) {
  try {
    // 이미 처리된 텍스트 노드 확인
    if (!textNode.parentNode) return null;
    if (textNode.parentNode.closest && textNode.parentNode.closest('.bgae-badge')) return null;

    // 텍스트 노드 내에 해당 문자열이 여전히 있는지 확인
    if (!textNode.textContent.includes(raw)) return null;

    const badge = window.bupgogae.renderPrecedentBadge(textNode, raw, level, options);

    if (badge) {
      // 렌더링 성공 → 부모에 처리 완료 마킹
      // (정확히는 배지 자체가 마킹 역할)
      console.debug(`[bupgogae] ${level.toUpperCase()} 렌더링: ${raw}`);
      return badge;
    }
  } catch (err) {
    console.error(`[bupgogae] 렌더링 실패 (${raw}):`, err);
  }
  return null;
}


// ============================================================
// 9. 시작
// ============================================================

// Content Script 로드 시 즉시 초기화 시작
init();
