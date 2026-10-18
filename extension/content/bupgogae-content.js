/**
 * 법고개(Bupgogae) — Content Script 통합 컨트롤러
 * ========================================================
 * LLM 채팅 응답에서 판례번호를 실시간으로 감지하고
 * 4상태(Green/Orange/Red/Gray) 배지를 렌더링하는 메인 모듈.
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
 *   ⑦ 결과 순회 → Green/Orange/Gray 렌더링
 *
 * [의존성]
 *   - adapters/*.js   (SiteAdapter 구현체 + 레지스트리)
 *   - case-regex.js   (extractCaseNumbers, validateCaseNumber, compressCaseKey)
 *   - precedent-badge.js (renderPrecedentBadge)
 *   - db-sync.js      (Service Worker — LOOKUP_BATCH, GET_META)
 */

// ============================================================
// 1. 상수
// ============================================================

const DEBOUNCE_MS = 500;
const PROCESSED_ATTR = 'data-bgae-processed';
const MAX_BATCH_SIZE = 50; // 한 번에 조회할 최대 키 수
const LOOKUP_TIMEOUT_MS = 8000; // 배치 조회 응답 대기 한도 (SW 컨텍스트 무효화 시 무한 대기 방지)
const LOOKUP_MAX_ATTEMPTS = 3;        // 타임아웃/에러 시 최대 재조회 횟수 (gray 유지, orange 오탐 방지)
const LOOKUP_RETRY_BACKOFF_MS = 1000; // 재조회 백오프 (시도 횟수 배수: 1s, 2s, ...)
const DOM_WORK_CHUNK_SIZE = 200;       // DOM/정규식 작업 후 메인 스레드 양보 기준
const DOM_WORK_SLICE_MS = 16;          // 한 동기 slice의 목표 상한(약 1 frame)

// ── Settle(정지 감지) 처리 게이트 ──
// Gemini/Grok/Copilot 등은 응답 생성 중 프레임워크가 응답 서브트리를 재렌더하며
// 외부에서 끼워넣은 우리 배지 노드를 지운다(churn). 스트리밍 중 렌더는 깜빡임만
// 유발하므로, "응답이 SETTLE_MS 동안 조용해진 뒤" 1회만 처리한다(정지 후 렌더).
const SETTLE_MS = 2000;             // 마지막 DOM 변경 후 처리까지 대기 (사용자 확정: 2초)
const SETTLE_MAX_DEFER_MS = 12000;  // 안전망: 페이지가 끝없이 변경돼도 이 시간 내 강제 처리(starvation 방지)
const ORANGE_TOAST_DISMISS_MS = 5000;     // 주황 토스트 자동 닫힘
const ORANGE_TOAST_AFTER_COPY_MS = 3000;  // '복사됨' 표시 후 자동 닫힘


// ============================================================
// 2. 초기화
// ============================================================

let _debounceTimer = null;
let _isProcessing = false;
let _processingPending = false;
let _processingPaused = false;
let _adapter = null; // 현재 사이트 어댑터
let _adapterFetchRequested = false; // Auto-Fetch 쓰로틀링 플래그 (세션당 1회)
let _hasShownOrangeToast = false; // Orange 배지 토스트 알림을 한 번만 띄우기 위한 플래그
let _showOrangeToast = true;     // 미확인 사건번호 팝업(토스트) 표시 여부 (팝업 토글)
let _categoryFilters = {         // 카테고리별 필터 (기본값)
  court: true,
  constitutional: true,
};

/**
 * Content Script 진입점.
 * 메타데이터 로드 후 MutationObserver 시작.
 */
async function init() {
  console.log('[bupgogae] Content Script 초기화 시작');

  // ── DB 신선도 검사 발화 (fire-and-forget) ──
  // 지원 사이트 진입 = 사용자가 곧 판례 검증을 쓴다는 신호.
  // SW가 manifest 정답지와 대조해 뒤처진 DB를 자가치유한다 (응답 불요).
  try {
    chrome.runtime.sendMessage(
      { type: 'VERIFY_DB_FRESHNESS', trigger: 'content' },
      () => void chrome.runtime.lastError,
    );
  } catch { /* SW 컨텍스트 무효화 등 — 신선도 검사 실패가 본 기능을 막으면 안 됨 */ }

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

  // 카테고리 필터 + 토스트 표시 설정 로드
  try {
    const filterData = await chrome.storage.local.get([
      'bupgogae_filter_court',
      'bupgogae_filter_constitutional',
      'bupgogae_show_orange_toast',
    ]);
    _categoryFilters = {
      court: filterData.bupgogae_filter_court !== false,         // 기본 ON
      constitutional: filterData.bupgogae_filter_constitutional !== false, // 기본 ON
    };
    _showOrangeToast = filterData.bupgogae_show_orange_toast !== false; // 기본 ON
    console.log('[bupgogae] 카테고리 필터:', _categoryFilters);
  } catch (err) {
    console.warn('[bupgogae] 필터 로드 실패, 기본값 사용');
  }

  // 팝업의 '미확인 사건번호 팝업 표시' 토글을 새로고침 없이 즉시 반영
  try {
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.bupgogae_show_orange_toast) {
          _showOrangeToast = changes.bupgogae_show_orange_toast.newValue !== false;
        }
        if (area === 'local' && changes.bupgogae_meta_generation &&
            window.bupgogaeCaseRegex?.refreshMeta) {
          window.bupgogaeCaseRegex.refreshMeta()
            .then(() => scheduleProcessing())
            .catch((err) => console.warn('[bupgogae] snapshot 메타 갱신 실패:', err?.message));
        }
      });
    }
  } catch { /* storage.onChanged 미지원 환경 — 무시 */ }

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
    // 삭제만 있는 mutation도 고정 tooltip의 detached subtree 참조를 해제한다.
    window.bupgogae?.clearDetachedTooltip?.();
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
          // 배지 삽입 시 우리가 만든 분할 텍스트 노드는 무시 (자기유발 루프 방지)
          if (window.bupgogae && window.bupgogae._ownTextNodes &&
              window.bupgogae._ownTextNodes.has(node)) {
            continue;
          }
          return true;
        }
      }
      // characterData 변경도 감지
      if (m.type === 'characterData') return true;
      if (m.type === 'attributes') return true;
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
 * 처리 스케줄러 — Settle(정지 감지) 기반.
 * 마지막 관련 DOM 변경 후 SETTLE_MS 동안 추가 변경이 없으면(=응답 렌더 정지) 1회 처리.
 * 스트리밍/재렌더가 계속되는 동안에는 타이머가 매 변경마다 리셋되어 처리를 보류하므로,
 * 프레임워크가 우리 배지를 지우는 구간에 렌더하지 않는다(churn/깜빡임 제거).
 * 단, 페이지가 끝없이 변경되면 SETTLE_MAX_DEFER_MS에서 강제 처리한다(starvation 방지).
 */
let _rescheduleCount = 0;
let _settlePendingSince = 0; // 현재 보류 구간의 첫 변경 시각 (0 = 보류 없음)
const MAX_RESCHEDULE = 10;   // _isProcessing 중 stuck 방지: 최대 10회 재시도

// 테스트 주입 seam — 실제로는 processAllResponses를 호출.
let _runProcess = processAllResponses;

function _nowMs() {
  return Date.now();
}

function scheduleProcessing() {
  if (_processingPaused) return;
  _processingPending = true;
  const now = _nowMs();
  if (_settlePendingSince === 0) _settlePendingSince = now;
  if (_debounceTimer) clearTimeout(_debounceTimer);

  // settle 창과 강제 처리 데드라인 중 먼저 도래하는 시점에 발화
  const elapsed = now - _settlePendingSince;
  const wait = Math.max(0, Math.min(SETTLE_MS, SETTLE_MAX_DEFER_MS - elapsed));
  _debounceTimer = setTimeout(onSettleTimer, wait);
}

function onSettleTimer() {
  _debounceTimer = null;

  if (_isProcessing) {
    // 직전 처리(비동기 조회)가 아직 진행 중 — settle 구간은 유지한 채 짧게 재시도
    _rescheduleCount++;
    if (_rescheduleCount <= MAX_RESCHEDULE) {
      _debounceTimer = setTimeout(onSettleTimer, DEBOUNCE_MS);
    } else {
      console.warn(`[bupgogae] 재스케줄 상한 초과 (${MAX_RESCHEDULE}회) — 진행 중 처리 완료 후 재개`);
      _rescheduleCount = 0;
      // 타이머 polling만 멈춘다. pending 변경과 starvation 기준 시각은 보존한다.
    }
    return;
  }

  _rescheduleCount = 0;
  _settlePendingSince = 0;
  _processingPending = false;
  _runProcess();
}


// ============================================================
// 5. 핵심 처리 로직 — 4상태 파이프라인
// ============================================================

/**
 * 모든 LLM 응답 컨테이너를 스캔하고 판례번호를 처리.
 *
 * [Circuit Breaker 측정 범위]
 *   동기 처리 구간만 측정: 컨테이너 탐색 + TreeWalker/정규식/검증/렌더 비용.
 *   긴 DOM 작업은 chunk마다 이벤트 루프에 양보하고, 그 대기 및
 *   IndexedDB batchLookup 대기는 측정에서 제외한다.
 *   → 정상적인 DB 초기 로딩 지연이 Circuit Breaker를 오발동시키지 않음.
 */
async function processAllResponses() {
  if (_isProcessing || _processingPaused) return;
  // 메타데이터 준비 완료 전에는 실행 건너뛰기
  if (window.bupgogaeCaseRegex && !window.bupgogaeCaseRegex.isMetaReady()) {
    console.debug('[bupgogae] 처리 스킵: 메타데이터 준비 안됨');
    return;
  }
  _isProcessing = true;
  // 동기 처리 시간만 측정 (비동기 IndexedDB 대기 제외)
  const syncStart = performance.now();
  let syncDuration = 0;
  let containerCount = 0;
  let detected = 0;
  let maxMeasuredSliceMs = 0;

  try {
    // 동기 구간: 컨테이너 탐색
    const containers = findResponseContainers();
    if (containers.length === 0) {
      return;
    }
    // 컨테이너 탐색 동기 비용
    syncDuration = performance.now() - syncStart;
    containerCount = containers.length;
    maxMeasuredSliceMs = syncDuration;

    for (const container of containers) {
      const metrics = await processContainer(container);
      syncDuration += metrics?.syncDuration || 0;
      detected += metrics?.detected || 0;
      maxMeasuredSliceMs = Math.max(maxMeasuredSliceMs, metrics?.maxSyncSliceMs || 0);
    }
  } catch (err) {
    console.error('[bupgogae] 처리 중 오류:', err);
  } finally {
    // Local console only; never log conversation text or extracted case strings.
    // This is measured synchronous work, not a browser Long Tasks/INP trace.
    if (detected > 0 || maxMeasuredSliceMs > 50) {
      console.debug('[bupgogae] scan ' + JSON.stringify({
        containers: containerCount, detected,
        syncMs: Number(syncDuration.toFixed(2)),
        maxMeasuredSliceMs: Number(maxMeasuredSliceMs.toFixed(2)),
        elapsedMs: Number((performance.now() - syncStart).toFixed(2)),
      }));
    }
    // 동기 처리 시간 기준으로 Circuit Breaker 판단
    await handleCircuitBreaker(syncDuration);
    _isProcessing = false;
    if (_processingPending && !_processingPaused) scheduleProcessing();
  }
}

/**
 * 서킷 브레이커 (Circuit Breaker): 누적 DOM 동기 처리 이상 감지 및 현재 탭 일시 정지.
 *
 * [설계 의도]
 *   실제 긴 작업의 메인 스레드 독점은 chunk yield가 줄인다. 이 브레이커는
 *   반복되는 비정상 비용을 사후 감지해 현재 탭의 observer만 중지하는 보조 장치다.
 *
 * [측정 대상]
 *   컨테이너 탐색과 TreeWalker·정규식·동기 검증·렌더링의 동기 slice 합계.
 *   IndexedDB 대기와 chunk yield 대기는 제외.
 *   → 정상적인 첫 로딩(DB cold start ~20초)에서 오발동 없음.
 *
 * [발동 조건]
 *   누적 5회 동기 처리 5초 초과 → 현재 탭 observer 일시 정지 + 복구 안내
 *   5회 연속 정상 처리(500ms 이하) → 스트라이크 리셋
 *
 * @param {number} syncDuration 동기 처리 시간 (ms) — batchLookup 제외
 */
const CIRCUIT_THRESHOLD_MS = 5000;  // 동기 처리 5초 초과 = 1 strike
const CIRCUIT_MAX_STRIKES = 5;     // 누적 5 strikes = 현재 탭 observer 일시 정지
const CIRCUIT_RECOVERY_STREAK = 5; // 5회 연속 정상 = 리셋
const CIRCUIT_FAST_MS = 500;       // 정상 판정 기준

function evaluateCircuitBreakerState(state, syncDuration) {
  let strikes = Number.isSafeInteger(state?.strikes) ? state.strikes : 0;
  let fastStreak = Number.isSafeInteger(state?.fastStreak) ? state.fastStreak : 0;

  if (syncDuration > CIRCUIT_THRESHOLD_MS) {
    strikes += 1;
    fastStreak = 0;
    if (strikes >= CIRCUIT_MAX_STRIKES) {
      return { strikes: 0, fastStreak: 0, action: 'pause' };
    }
    return { strikes, fastStreak, action: 'strike' };
  }

  if (syncDuration <= CIRCUIT_FAST_MS && (strikes > 0 || fastStreak > 0)) {
    fastStreak += 1;
    if (fastStreak >= CIRCUIT_RECOVERY_STREAK) {
      return { strikes: 0, fastStreak: 0, action: 'recovered' };
    }
    return { strikes, fastStreak, action: 'recovering' };
  }

  return { strikes, fastStreak, action: 'none' };
}

async function handleCircuitBreaker(syncDuration) {
  try {
    const data = await chrome.storage.local.get([
      'bupgogae_circuit_strikes',
      'bupgogae_circuit_fast_streak'
    ]);
    
    const next = evaluateCircuitBreakerState({
      strikes: data.bupgogae_circuit_strikes || 0,
      fastStreak: data.bupgogae_circuit_fast_streak || 0,
    }, syncDuration);

    if (next.action === 'strike') {
      console.warn(`[bupgogae] ⚠️ 서킷 브레이커: 동기 처리 지연 (${syncDuration.toFixed(0)}ms > ${CIRCUIT_THRESHOLD_MS}ms). 스트라이크: ${next.strikes}/${CIRCUIT_MAX_STRIKES}`);
    } else if (next.action === 'recovered') {
      console.log('[bupgogae] 🔄 서킷 브레이커 복구: 정상 처리 연속 확인. 스트라이크 리셋.');
    } else if (next.action === 'pause') {
      pauseProcessing();
      if (_observer) {
        _observer.disconnect();
        _observer = null;
      }
      alert('이 페이지의 DOM 처리가 반복해서 지연되어 현재 탭에서만 법고개 처리를 일시 중지했습니다. 페이지를 새로고침하면 다시 시도합니다.');
    }

    if (next.action !== 'none') {
      await chrome.storage.local.set({
        bupgogae_circuit_strikes: next.strikes,
        bupgogae_circuit_fast_streak: next.fastStreak,
        ...(next.action === 'pause' ? {
          bupgogae_circuit_last_pause: {
            at: Date.now(),
            durationMs: Math.round(syncDuration),
          },
        } : {}),
      });
    }
  } catch (err) {
    if (err.message && err.message.includes('Extension context invalidated')) {
      pauseProcessing();
      console.log('[bupgogae] 확장 프로그램이 업데이트되었습니다. 구버전 스크립트를 중지합니다. (새로고침 F5 필요)');
      if (_observer) {
        _observer.disconnect();
        _observer = null;
      }
    } else {
      console.error('[bupgogae] 서킷 브레이커 상태 처리 실패:', err);
    }
  }
}

function pauseProcessing() {
  _processingPaused = true;
  _processingPending = false;
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = null;
  _settlePendingSince = 0;
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

  // 폴백 제거: 빈 화면(채팅 시작 전)에서 body 전체를 스캔하면
  // 성능 저하 및 서킷 브레이커 오작동을 유발하므로 빈 배열 반환.
  // console.warn(`[bupgogae] ${_adapter ? _adapter.displayName : '(unknown)'} 응답 컨테이너를 찾지 못함.`);
  return [];
}

/**
 * 단일 컨테이너의 텍스트 노드를 순회하며 판례번호를 처리.
 *
 * [M2 수정] 한 텍스트노드에 여러 사건번호가 있어도(모델이 "한 줄에 하나씩"
 * 출력하면 마크다운 렌더러에 따라 한 노드에 \n으로 모이는 경우가 많다) 노드별로
 * 단 한 번의 분할 렌더(renderPrecedentBadges)로 전부 배지한다. 사건번호별로
 * renderBadge를 반복하면 첫 분할에서 노드가 detach되어 나머지가 누락됐다.
 *
 * [렌더 시점] 조회를 최대 3회 시도한 뒤 최종 상태를 한 번 렌더한다.
 * 조회 타임아웃/시스템 에러(L13)는 'DB 미확인(orange)'으로 단정하지 않고
 * gray(검증 미완료)로 구분한다.
 * @param {Element} container
 */
async function processContainer(container) {
  // ── 텍스트노드별 매칭 수집 (같은 노드 매칭을 함께 모아 한 번에 렌더) ──
  // TreeWalker 수집과 탐지를 같은 slice에서 수행한다. 매칭 없는 Text 배열은 보관하지 않는다.
  const walker = createTextWalker(container);
  let syncDuration = 0;
  let maxSyncSliceMs = 0;
  const nodes = []; // [{ textNode, entries: [{ precedentString, startIdx, parsed, level, options, key }] }]
  let totalDetected = 0;
  let processed = 0;
  let sliceStart = performance.now();
  while (true) {
    const workStart = performance.now();
    const hasNext = walker.nextNode();
    if (!hasNext) {
      syncDuration += performance.now() - workStart;
      break;
    }
    const textNode = walker.currentNode;
    const text = textNode.textContent;
    if (text && text.length >= 4 &&
        (text.length !== 4 || window.bupgogaeCaseRegex.isCanonicalShortCaseText(text))) {
      // 고립된 4글자 노드는 활성 DB canonical 집합을 O(1)로 먼저 확인해
      // 일반 문장 오탐과 불필요한 정규식/IndexedDB 조회를 피한다.
      const cases = window.bupgogaeCaseRegex.extractCaseNumbers(text)
        .filter((p) => _categoryFilters[p.type] !== false);
      if (cases.length > 0) {
        const entries = cases.map((parsed) => ({
          precedentString: parsed.raw,
          startIdx: parsed.startIdx,
          parsed,
          level: null,
          options: {},
          key: null,
        }));
        nodes.push({ textNode, text, entries });
        totalDetected += entries.length;
      }
    }
    syncDuration += performance.now() - workStart;
    processed += 1;
    if (shouldYieldDomWork(processed, sliceStart)) {
      maxSyncSliceMs = Math.max(maxSyncSliceMs, performance.now() - sliceStart);
      await yieldToMainThread();
      sliceStart = performance.now();
    }
  }

  maxSyncSliceMs = Math.max(maxSyncSliceMs, performance.now() - sliceStart);
  if (totalDetected === 0) return { syncDuration, maxSyncSliceMs, detected: 0, unresolved: 0 };
  console.log(`[bupgogae] ${totalDetected}개 사건번호 감지`);

  // ── 검증(Red) + 키 압축(조회 대상 수집) ──
  const keyToEntries = new Map(); // compressedKey → entry[]
  let validationStart = performance.now();
  for (const node of nodes) {
    for (const e of node.entries) {
      const validation = window.bupgogaeCaseRegex.validateCaseNumber(e.parsed);
      if (!validation.valid) {
        e.level = 'red';
        e.options = { redReason: validation.reason };
        continue;
      }
      const key = window.bupgogaeCaseRegex.compressCaseKey(e.parsed);
      if (!key) {
        // case_code_map에 없는 부호 → Orange (안전 처리)
        e.level = 'orange';
        continue;
      }
      e.key = key;
      if (!keyToEntries.has(key)) keyToEntries.set(key, []);
      keyToEntries.get(key).push(e);
    }
  }
  syncDuration += performance.now() - validationStart;
  maxSyncSliceMs = Math.max(maxSyncSliceMs, performance.now() - validationStart);

  // ── 배치 조회 + L13 재시도 (타임아웃/에러 키만 재조회) ──
  let keysToLookup = Array.from(keyToEntries.keys());
  for (let attempt = 1; attempt <= LOOKUP_MAX_ATTEMPTS && keysToLookup.length > 0; attempt++) {
    if (!container.isConnected) {
      return { syncDuration, maxSyncSliceMs, detected: totalDetected, unresolved: keysToLookup.length, cancelled: true };
    }
    const lookup = await batchLookup(keysToLookup, container);
    if (!container.isConnected) {
      return { syncDuration, maxSyncSliceMs, detected: totalDetected, unresolved: keysToLookup.length, cancelled: true };
    }
    const applyStart = performance.now();
    const results = lookup.results;
    const unresolved = [];
    for (const key of keysToLookup) {
      const result = results[key];
      const entries = keyToEntries.get(key) || [];

      if (result && result.error) {
        unresolved.push(key); // L13: 타임아웃/에러 → 미정(평문 유지) → 재조회
        continue;
      }
      if (result && result.found) {
        const greenEntries = buildGreenEntries(result.data, entries[0]?.parsed);
        // key를 조회한 바로 그 readonly snapshot의 map을 사용한다. 여러 chunk 사이에
        // pointer가 전환되어도 records와 court code 해석이 섞이지 않는다.
        const courtCodeMap = lookup.courtMapByKey[key] ||
          window.bupgogaeCaseRegex.getCourtCodeMap();
        for (const e of entries) {
          e.level = 'green';
          e.options = { greenEntries, caseCode: e.parsed.code, caseType: e.parsed.type, courtCodeMap };
        }
      } else {
        for (const e of entries) e.level = 'orange';
      }
    }
    keysToLookup = unresolved;
    const applyDuration = performance.now() - applyStart;
    syncDuration += applyDuration;
    maxSyncSliceMs = Math.max(maxSyncSliceMs, applyDuration);
    if (keysToLookup.length > 0 && attempt < LOOKUP_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, LOOKUP_RETRY_BACKOFF_MS * attempt));
    }
  }
  // 끝까지 미정인 키는 gray(검증 미완료)로 표시해 DB miss와 구분한다.
  for (const key of keysToLookup) {
    for (const e of keyToEntries.get(key) || []) {
      e.level = 'gray';
      e.options = {
        grayReason: '로컬 DB 조회가 시간 초과 또는 시스템 오류로 완료되지 않았습니다.',
      };
    }
  }

  // ── 렌더: 노드별로 level이 확정된 매칭만 한 번에 분할 렌더 ──
  let anyOrange = false;
  sliceStart = performance.now();
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const node = nodes[nodeIndex];
    if (!node.textNode.isConnected || !container.contains(node.textNode)) continue;
    // 조회 중 스트리밍/재렌더된 Text에 과거 위치의 매칭을 삽입하지 않는다.
    if (node.textNode.textContent !== node.text) {
      if (_isProcessing) scheduleProcessing();
      continue;
    }
    const renderStart = performance.now();
    const ready = node.entries.filter((e) => e.level);
    if (ready.length === 0) continue;

    renderBadges(node.textNode, ready);
    if (ready.some((e) => e.level === 'orange')) anyOrange = true;
    syncDuration += performance.now() - renderStart;
    if (shouldYieldDomWork(nodeIndex + 1, sliceStart)) {
      maxSyncSliceMs = Math.max(maxSyncSliceMs, performance.now() - sliceStart);
      await yieldToMainThread();
      sliceStart = performance.now();
    }
  }
  maxSyncSliceMs = Math.max(maxSyncSliceMs, performance.now() - sliceStart);
  if (anyOrange) showOrangeToast();
  return { syncDuration, maxSyncSliceMs, detected: totalDetected, unresolved: keysToLookup.length };
}

/**
 * 조회 결과(data 배열)를 Green 툴팁용 entries로 조립.
 * @param {Array} data   batchLookup 결과의 data (행 배열)
 * @param {Object} parsed 대표 매칭(부호/타입 추출용)
 * @returns {Array}
 */
function buildGreenEntries(data, parsed) {
  const entryType = parsed?.type;
  const caseCode = parsed?.code;
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
      };

      entry.courtCode = row[1];
      entry.dateInt = row[2];
      entry.caseName = row[3] || '';

      greenEntries.push(entry);
    }
  }

  // 매칭이 0건이면 안전 처리 (빈 entries)
  if (greenEntries.length === 0) {
    greenEntries.push({
      serialNumber: '', courtCode: null, dateInt: null,
      caseName: '', caseType: entryType || 'court',
      caseCode: caseCode || '',
    });
  }

  return greenEntries;
}


// ============================================================
// 6. 텍스트 노드 수집
// ============================================================

/**
 * 아직 처리되지 않은 텍스트 노드만 수집.
 * @param {Element} root
 * @returns {Text[]}
 */
function createTextWalker(root) {
  return document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('[data-message-role="user"], [data-message-author-role="user"], [data-chatgpt-search-unit-key$=":user"], [data-testid="user-message"], [role="article"][aria-labelledby^="user-message-"], user-query')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
        if (parent.closest('[contenteditable="true"], [contenteditable=""], textarea, [role="textbox"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest('.bgae-badge')) return NodeFilter.FILTER_REJECT;
        if (parent.closest('#bupgogae-shadow-host')) return NodeFilter.FILTER_REJECT;
        if (parent.hasAttribute(PROCESSED_ATTR)) return NodeFilter.FILTER_REJECT;
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );
}

function shouldYieldDomWork(processedCount, sliceStart) {
  return processedCount % DOM_WORK_CHUNK_SIZE === 0 ||
    performance.now() - sliceStart >= DOM_WORK_SLICE_MS;
}

function yieldToMainThread() {
  if (globalThis.scheduler && typeof globalThis.scheduler.yield === 'function') {
    return globalThis.scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ============================================================
// 7. 배치 조회 래퍼
// ============================================================

/**
 * Service Worker에 배치 조회 요청.
 * MAX_BATCH_SIZE 초과 시 분할 처리.
 * @param {string[]} keys
 * @returns {Promise<{results: Object, courtMapByKey: Object}>}
 */
async function batchLookup(keys, container = null) {
  if (keys.length === 0) return { results: {}, courtMapByKey: {} };

  // 분할 처리
  const allResults = {};
  const courtMapByKey = {};
  for (let i = 0; i < keys.length; i += MAX_BATCH_SIZE) {
    // 이미 보낸 runtime message는 취소할 수 없다. detach 후 새 chunk/재시도를 멈춘다.
    if (container && !container.isConnected) break;
    const chunk = keys.slice(i, i + MAX_BATCH_SIZE);

    const result = await new Promise((resolve) => {
      let settled = false;
      // 에러/타임아웃 시 error: true로 재시도 후 Gray 표시 (Orange 오탐 방지)
      const resolveFallback = () => {
        const fallback = {};
        for (const k of chunk) {
          fallback[k] = { found: false, data: null, error: true };
        }
        resolve({ results: fallback, snapshotMap: null });
      };

      // SW 컨텍스트 무효화 등으로 콜백이 끝내 호출되지 않는 경우를 대비한 타임아웃 가드
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.warn('[bupgogae] 배치 조회 타임아웃 — 응답 없음');
        resolveFallback();
      }, LOOKUP_TIMEOUT_MS);

      const handle = (response, err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          console.warn('[bupgogae] 배치 조회 실패:', err.message);
          resolveFallback();
          return;
        }
        // 신 SW는 결과와 같은 snapshot의 version/court map을 함께 보낸다.
        // 구 SW의 flat 응답도 계속 허용한다.
        if (response && response.results && typeof response.results === 'object') {
          const isV2Snapshot = response.snapshot?.storeName === 'cases_a' ||
            response.snapshot?.storeName === 'cases_b';
          // 검증된 v2 payload에는 map이 필수다. metadata 손상으로 누락된 경우에는
          // 기존 session map을 섞지 않고 빈 map으로 fail-closed한다.
          const snapshotMap = response.snapshot?.courtCodeMap ||
            (isV2Snapshot ? {} : null);
          if (snapshotMap && window.bupgogaeCaseRegex?.updateCourtCodeMap) {
            window.bupgogaeCaseRegex.updateCourtCodeMap(snapshotMap);
          }
          resolve({ results: response.results, snapshotMap: snapshotMap || null });
        } else {
          resolve({ results: response || {}, snapshotMap: null });
        }
      };

      try {
        chrome.runtime.sendMessage(
          { type: 'LOOKUP_BATCH', keys: chunk },
          (response) => handle(response, chrome.runtime.lastError)
        );
      } catch (e) {
        // sendMessage 자체가 throw하는 경우(컨텍스트 무효화 등)
        handle(null, e);
      }
    });

    Object.assign(allResults, result.results);
    const mapForChunk = result.snapshotMap || window.bupgogaeCaseRegex.getCourtCodeMap();
    for (const key of chunk) courtMapByKey[key] = mapForChunk;
  }

  return { results: allResults, courtMapByKey };
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
/**
 * renderPrecedentBadges(다중 매칭) 래퍼.
 * 한 텍스트노드의 매칭들을 1회 분할 렌더 (M2 수정).
 *
 * @param {Text} textNode
 * @param {Array<{precedentString, level, options, startIdx}>} entries
 * @returns {HTMLElement[]} 생성된 배지들
 */
function renderBadges(textNode, entries) {
  try {
    if (!textNode.parentNode) return [];
    if (textNode.parentNode.closest && textNode.parentNode.closest('.bgae-badge')) return [];

    const created = window.bupgogae.renderPrecedentBadges(textNode, entries);
    if (created && created.length) {
      console.debug(`[bupgogae] ${created.length}개 배지 렌더링`);
    }
    return created || [];
  } catch (err) {
    console.error('[bupgogae] 다중 렌더링 실패:', err);
    return [];
  }
}


// ============================================================
// 9. 메시지 수신 (팝업/단축키용)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXTRACT_ORANGE_CASES') {
    // Alt+C 단축키 경로 — 토스트 복사 버튼과 동일 로직 공용.
    copyOrangeCases().then((res) => sendResponse(res));
    return true; // 비동기 응답 대기
  }
});

// ============================================================
// 10. 주황(미확인) 사건번호 수집/복사 + 토스트 알림
// ============================================================

/**
 * 현재 화면의 주황(DB 미확인) 사건번호를 수집.
 * 가장 최근 주황 배지가 속한 메시지 블록 범위에서 중복 없이 모은다.
 * @returns {string[]}
 */
function collectOrangeCases() {
  let badges = [];
  const allBadges = document.querySelectorAll('.bgae-badge.bgae-orange');

  if (allBadges.length > 0) {
    const lastBadge = allBadges[allBadges.length - 1];
    // 해당 배지가 속한 메시지 전체 블록을 탐색 (플랫폼별 최상위 컨테이너)
    const msgContainer = lastBadge.closest('article, [data-testid="conversation-turn"], [data-message-author-role], message-content, model-response, .response-container, .markdown-main-panel');
    badges = msgContainer
      ? msgContainer.querySelectorAll('.bgae-badge.bgae-orange')
      : allBadges; // 명확한 컨테이너가 없으면 전체 (안전 폴백)
  }

  return Array.from(new Set(Array.from(badges).map((b) => b.getAttribute('data-bgae-case')))).filter(Boolean);
}

/**
 * 주황 사건번호를 클립보드로 복사.
 * 클립보드 API 우선, 실패(권한/activation 상실) 시 execCommand 폴백.
 * @returns {Promise<{count: number, text?: string, copyFailed?: boolean}>}
 */
function copyOrangeCases() {
  const cases = collectOrangeCases();
  if (cases.length === 0) return Promise.resolve({ count: 0 });

  const text = `다음 사건번호의 출처를 확인하세요 : ${cases.join(', ')}`;

  const execFallback = () => {
    try {
      const input = document.createElement('textarea');
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      return { count: cases.length, text };
    } catch (e) {
      console.error('[bupgogae] execCommand 복사 실패:', e);
      return { count: cases.length, text, copyFailed: true };
    }
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text)
      .then(() => ({ count: cases.length, text }))
      .catch((err) => {
        console.warn('[bupgogae] Clipboard API 실패, execCommand 폴백:', err && err.message);
        return execFallback();
      });
  }
  return Promise.resolve(execFallback());
}

let _orangeToastTimer = null;

/**
 * 주황 토스트 닫기 (페이드아웃 후 제거). 닫기 버튼 / 자동 만료 공용.
 * @param {HTMLElement} toast
 */
function dismissOrangeToast(toast) {
  if (_orangeToastTimer) { clearTimeout(_orangeToastTimer); _orangeToastTimer = null; }
  if (!toast || !toast.parentNode) return;
  toast.style.opacity = '0';
  toast.style.bottom = '20px';
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 300);
}

/**
 * 주황(미확인) 사건번호 감지 안내 토스트.
 * 단축키(Alt+C)가 일부 서비스에서 가로채일 수 있어, 토스트에 '복사' 버튼을 둔다.
 * 버튼 클릭은 user activation 컨텍스트라 클립보드 복사가 안정적이다.
 * 우측 '×' 닫기 버튼 제공 + 10초 후 자동 닫힘. (세션당 1회 노출)
 */
function showOrangeToast() {
  if (!_showOrangeToast) return;       // 팝업 토글로 비활성화됨
  if (_hasShownOrangeToast) return;
  _hasShownOrangeToast = true;

  const toast = document.createElement('div');
  toast.className = 'bgae-orange-toast';
  // M-5: all:initial + !important로 호스트 페이지 CSS 간섭 방지
  Object.assign(toast.style, {
    all: 'initial',
    position: 'fixed',
    bottom: '20px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    maxWidth: '90vw',
    backgroundColor: '#ea580c',
    color: '#fff',
    padding: '12px 14px 12px 20px',
    borderRadius: '8px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: '14px',
    fontWeight: 'bold',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    zIndex: '2147483647',
    opacity: '0',
    transition: 'opacity 0.3s ease, bottom 0.3s ease',
    pointerEvents: 'auto',
    lineHeight: '1.4',
    boxSizing: 'border-box',
  });
  toast.style.setProperty('position', 'fixed', 'important');
  toast.style.setProperty('z-index', '2147483647', 'important');
  toast.style.setProperty('display', 'flex', 'important');

  // ── 메시지 ──
  const msg = document.createElement('span');
  msg.textContent = '국가법령정보 DB에서 확인되지 않는 사건번호가 감지되었습니다';
  Object.assign(msg.style, {
    all: 'initial', color: '#fff', fontFamily: 'inherit',
    fontSize: '14px', fontWeight: 'bold', lineHeight: '1.4',
  });

  // ── 복사 버튼 (단축키 대체) ──
  const copyBtn = document.createElement('button');
  copyBtn.textContent = '사건번호 복사';
  Object.assign(copyBtn.style, {
    all: 'initial', cursor: 'pointer', whiteSpace: 'nowrap',
    display: 'inline-block', backgroundColor: '#fff', color: '#ea580c',
    fontFamily: 'inherit', fontSize: '13px', fontWeight: 'bold',
    padding: '6px 12px', borderRadius: '6px', boxSizing: 'border-box',
  });
  copyBtn.addEventListener('click', () => {
    copyOrangeCases().then((res) => {
      copyBtn.textContent = res.copyFailed
        ? '복사 실패'
        : (res.count > 0 ? `복사됨 (${res.count})` : '복사할 항목 없음');
      // 복사 성공 시 '복사됨' 잠시 보여준 뒤 스르륵 닫힘
      if (!res.copyFailed && res.count > 0) {
        if (_orangeToastTimer) clearTimeout(_orangeToastTimer);
        _orangeToastTimer = setTimeout(() => dismissOrangeToast(toast), ORANGE_TOAST_AFTER_COPY_MS);
      }
    });
  });

  // ── 닫기 버튼 ──
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×'; // ×
  closeBtn.setAttribute('aria-label', '닫기');
  Object.assign(closeBtn.style, {
    all: 'initial', cursor: 'pointer', display: 'inline-block', color: '#fff',
    fontFamily: 'inherit', fontSize: '18px', fontWeight: 'bold',
    lineHeight: '1', padding: '2px 6px', boxSizing: 'border-box',
  });
  closeBtn.addEventListener('click', () => dismissOrangeToast(toast));

  toast.appendChild(msg);
  toast.appendChild(copyBtn);
  toast.appendChild(closeBtn);
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.bottom = '30px';
  });

  // 5초 후 자동 닫힘 (닫기 버튼으로 조기 해제 가능)
  _orangeToastTimer = setTimeout(() => dismissOrangeToast(toast), ORANGE_TOAST_DISMISS_MS);
}

// ============================================================
// 11. 시작
// ============================================================

// Content Script 로드 시 즉시 초기화 시작.
// (CommonJS 단위 테스트 컨텍스트에서는 auto-init을 건너뛴다 — 함수만 require로 노출)
if (typeof module === 'undefined' || !module.exports) {
  init();
}

// ============================================================
// 12. CommonJS 노출 (단위 테스트용 — 런타임 동작에는 영향 없음)
// ============================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    processContainer,
    batchLookup,
    buildGreenEntries,
    scheduleProcessing,
    collectOrangeCases,
    copyOrangeCases,
    showOrangeToast,
    processAllResponses,
    evaluateCircuitBreakerState,
    yieldToMainThread,
    CIRCUIT_THRESHOLD_MS,
    CIRCUIT_MAX_STRIKES,
    CIRCUIT_RECOVERY_STREAK,
    CIRCUIT_FAST_MS,
    DOM_WORK_CHUNK_SIZE,
    SETTLE_MS,
    SETTLE_MAX_DEFER_MS,
    /** 테스트 전용: settle 스케줄러가 호출할 처리 함수를 스파이로 교체. */
    __setProcessFnForTest(fn) {
      _runProcess = fn;
    },
    /** 테스트 전용: settle 스케줄러 내부 상태 초기화. */
    __resetSchedulerForTest() {
      if (_debounceTimer) clearTimeout(_debounceTimer);
      _debounceTimer = null;
      _settlePendingSince = 0;
      _rescheduleCount = 0;
      _processingPending = false;
      _processingPaused = false;
    },
    /** 테스트 전용: 모듈 전역 상태(orange 토스트 1회 플래그 등) 초기화. */
    __resetForTest() {
      _hasShownOrangeToast = false;
      _showOrangeToast = true;
    },
    __setAdapterForTest(adapter) {
      _adapter = adapter;
      _runProcess = processAllResponses;
    },
    /** 테스트 전용: '미확인 사건번호 팝업 표시' 설정 주입. */
    __setShowOrangeToastForTest(v) {
      _showOrangeToast = v;
    },
    /** 테스트 전용: 카테고리 필터 주입. */
    __setCategoryFiltersForTest(filters) {
      _categoryFilters = { ...filters };
    },
  };
}
