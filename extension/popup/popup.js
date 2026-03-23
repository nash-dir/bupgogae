/**
 * 법고개(Bupgogae) — Popup 토글 컨트롤러
 * ========================================
 * 주소표시줄 아이콘 클릭 시 표시되는 팝업.
 * 사이트별 / 전체 비활성화 토글 제공.
 *
 * [저장 구조] (chrome.storage.local)
 *   bupgogae_disabled_global : boolean  — 전체 비활성
 *   bupgogae_disabled_sites  : string[] — 비활성 호스트 목록
 */

// ============================================================
// 1. DOM 참조
// ============================================================

const $siteToggle = document.getElementById('siteToggle');
const $globalToggle = document.getElementById('globalToggle');
const $currentHost = document.getElementById('currentHost');
const $siteToggleDesc = document.getElementById('siteToggleDesc');
const $globalToggleDesc = document.getElementById('globalToggleDesc');
const $siteToggleRow = document.getElementById('siteToggleRow');
const $statusText = document.getElementById('statusText');
const $dbDate = document.getElementById('dbDate');
const $dbCount = document.getElementById('dbCount');

// DLC
const $dlcToggleBtn = document.getElementById('dlcToggleBtn');
const $dlcArrow = document.getElementById('dlcArrow');
const $dlcBody = document.getElementById('dlcBody');
const $taxDlcToggle = document.getElementById('taxDlcToggle');
const $taxDlcDesc = document.getElementById('taxDlcDesc');
const $patentDlcToggle = document.getElementById('patentDlcToggle');
const $patentDlcDesc = document.getElementById('patentDlcDesc');
const $courtFilterToggle = document.getElementById('courtFilterToggle');
const $courtFilterDesc = document.getElementById('courtFilterDesc');
const $constitutionalFilterToggle = document.getElementById('constitutionalFilterToggle');
const $constitutionalFilterDesc = document.getElementById('constitutionalFilterDesc');
const $dlcDeleteBtn = document.getElementById('dlcDeleteBtn');

// ============================================================
// 2. 상태
// ============================================================

let _currentHostname = null;     // 현재 탭의 hostname
let _currentTabId = null;        // 현재 탭 ID
let _disabledGlobal = false;     // 전체 비활성
let _disabledSites = [];         // 비활성 사이트 목록
let _isSupportedSite = false;    // 현재 사이트가 지원 대상인지
let _dlcTaxEnabled = false;      // 조세심판 DLC 활성 여부
let _dlcPatentEnabled = false;   // 특허심판 DLC 활성 여부
let _filterCourt = true;         // 법원 판례 필터 (기본 ON)
let _filterConstitutional = true; // 헌법재판소 필터 (기본 ON)

// 지원 대상 호스트 (manifest.json matches와 동기화)
const SUPPORTED_HOSTS = [
  'gemini.google.com',
  'chatgpt.com',
  'claude.ai',
  'copilot.microsoft.com',
  'www.perplexity.ai',
  'perplexity.ai',
  'grok.com',
];

// ============================================================
// 3. 초기화
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  await loadCurrentTab();
  await loadState();
  renderUI();
  bindEvents();
  await loadSyncDate();
});

/**
 * 현재 활성 탭 정보 로드.
 */
async function loadCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const url = new URL(tab.url);
      _currentHostname = url.hostname;
      _currentTabId = tab.id;
      _isSupportedSite = SUPPORTED_HOSTS.some(h => _currentHostname === h || _currentHostname.endsWith('.' + h));
    }
  } catch (err) {
    console.warn('[popup] 탭 정보 로드 실패:', err);
  }
}

/**
 * chrome.storage.local에서 비활성 상태 로드.
 */
async function loadState() {
  try {
    const data = await chrome.storage.local.get([
      'bupgogae_disabled_global',
      'bupgogae_disabled_sites',
      'bupgogae_dlc_tax',
      'bupgogae_dlc_patent',
      'bupgogae_filter_court',
      'bupgogae_filter_constitutional',
    ]);
    _disabledGlobal = data.bupgogae_disabled_global === true;
    _disabledSites = Array.isArray(data.bupgogae_disabled_sites) ? data.bupgogae_disabled_sites : [];
    _dlcTaxEnabled = data.bupgogae_dlc_tax === true;
    _dlcPatentEnabled = data.bupgogae_dlc_patent === true;
    // 법원/헌재 기본값은 true (undefined → true)
    _filterCourt = data.bupgogae_filter_court !== false;
    _filterConstitutional = data.bupgogae_filter_constitutional !== false;
  } catch (err) {
    console.warn('[popup] 상태 로드 실패:', err);
  }
}

/**
 * Service Worker에서 동기화 상태를 조회하여 DB 갱신일자 표시.
 */
async function loadSyncDate() {
  try {
    const status = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_SYNC_STATUS' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response);
      });
    });

    if (status && status.localVer && status.localVer.length === 8) {
      const ver = status.localVer; // "20260321"
      const y = ver.slice(0, 4);
      const m = parseInt(ver.slice(4, 6), 10);
      const d = parseInt(ver.slice(6, 8), 10);
      const formatted = `${y}. ${m}. ${d}.`;

      // 어제 날짜와 비교 → "(최신)" 표시
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yStr = yesterday.getFullYear().toString()
        + String(yesterday.getMonth() + 1).padStart(2, '0')
        + String(yesterday.getDate()).padStart(2, '0');
      const freshLabel = (ver >= yStr) ? ' (최신)' : '';

      $dbDate.textContent = `DB 일자 : ${formatted}${freshLabel}`;
    }

    // 판례 수 표시
    if (status && status.totalCount) {
      $dbCount.textContent = `판례 수 : ${Number(status.totalCount).toLocaleString()}건`;
    } else if (!status || !status.localVer) {
      $dbCount.textContent = '동기화 대기 중...';
    }

  } catch (err) {
    console.warn('[popup] 동기화 상태 조회 실패:', err);
  }
}

// ============================================================
// 4. UI 렌더링
// ============================================================

/**
 * 현재 상태를 토글 UI에 반영.
 */
function renderUI() {
  // 현재 호스트 표시
  $currentHost.textContent = _currentHostname || '—';

  // 전체 토글
  $globalToggle.checked = !_disabledGlobal;
  updateGlobalDesc();

  // 사이트별 토글
  if (!_isSupportedSite) {
    // 지원 대상이 아닌 사이트
    $siteToggleRow.classList.add('disabled', 'unsupported');
    $siteToggle.checked = false;
    $siteToggle.disabled = true;
    $siteToggleDesc.textContent = '이 사이트는 적용 대상이 아닙니다';
  } else {
    const isSiteDisabled = _disabledSites.includes(_currentHostname);
    $siteToggle.checked = !isSiteDisabled;
    updateSiteDesc(!isSiteDisabled);

    // 전체 비활성 시 사이트 토글도 비활성 처리
    if (_disabledGlobal) {
      $siteToggleRow.classList.add('disabled');
    }
  }

  // 상태 텍스트
  updateStatusText();

  // DLC/필터 토글
  $courtFilterToggle.checked = _filterCourt;
  updateCourtFilterDesc();
  $constitutionalFilterToggle.checked = _filterConstitutional;
  updateConstitutionalFilterDesc();
  $taxDlcToggle.checked = _dlcTaxEnabled;
  updateTaxDlcDesc();
  $patentDlcToggle.checked = _dlcPatentEnabled;
  updatePatentDlcDesc();
}

function updateCourtFilterDesc() {
  $courtFilterDesc.textContent = _filterCourt
    ? '법원 판례 검증 활성'
    : '법원 판례 검증 비활성';
}

function updateConstitutionalFilterDesc() {
  $constitutionalFilterDesc.textContent = _filterConstitutional
    ? '헌재 결정 검증 활성'
    : '헌재 결정 검증 비활성';
}

function updateTaxDlcDesc() {
  $taxDlcDesc.textContent = _dlcTaxEnabled
    ? '조세심판 사건 검증 활성'
    : '조세심판 사건 검증 비활성';
}

function updatePatentDlcDesc() {
  $patentDlcDesc.textContent = _dlcPatentEnabled
    ? '특허심판 사건 검증 활성'
    : '특허심판 사건 검증 비활성';
}

function updateSiteDesc(enabled) {
  $siteToggleDesc.textContent = enabled
    ? '현재 사이트에서 판례 검증 활성'
    : '현재 사이트에서 판례 검증 해제됨';
}

function updateGlobalDesc() {
  $globalToggleDesc.textContent = _disabledGlobal
    ? '모든 사이트에서 판례 검증 해제됨'
    : '모든 사이트에서 판례 검증 활성';
}

function updateStatusText() {
  const isEnabled = !_disabledGlobal && (_isSupportedSite ? !_disabledSites.includes(_currentHostname) : true);

  if (_disabledGlobal) {
    $statusText.textContent = '전체 비활성 상태';
    $statusText.className = 'popup-status inactive';
  } else if (_isSupportedSite && _disabledSites.includes(_currentHostname)) {
    $statusText.textContent = '이 사이트에서 비활성';
    $statusText.className = 'popup-status inactive';
  } else {
    $statusText.textContent = '활성 상태';
    $statusText.className = 'popup-status active';
  }
}

// ============================================================
// 5. 이벤트 바인딩
// ============================================================

function bindEvents() {
  $siteToggle.addEventListener('change', onSiteToggle);
  $globalToggle.addEventListener('change', onGlobalToggle);

  // DLC accordion
  $dlcToggleBtn.addEventListener('click', () => {
    $dlcBody.classList.toggle('open');
    $dlcArrow.classList.toggle('open');
  });

  // 법원 필터 토글
  $courtFilterToggle.addEventListener('change', async () => {
    _filterCourt = $courtFilterToggle.checked;
    await chrome.storage.local.set({ bupgogae_filter_court: _filterCourt });
    updateCourtFilterDesc();
  });

  // 헌법재판소 필터 토글
  $constitutionalFilterToggle.addEventListener('change', async () => {
    _filterConstitutional = $constitutionalFilterToggle.checked;
    await chrome.storage.local.set({ bupgogae_filter_constitutional: _filterConstitutional });
    updateConstitutionalFilterDesc();
  });

  // DLC 조세심판 토글
  $taxDlcToggle.addEventListener('change', async () => {
    _dlcTaxEnabled = $taxDlcToggle.checked;
    await chrome.storage.local.set({ bupgogae_dlc_tax: _dlcTaxEnabled });
    updateTaxDlcDesc();

    if (_dlcTaxEnabled) {
      // Service Worker에 DLC 다운로드 요청
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_DLC', dlc: 'tax' });
    }
  });

  // DLC 특허심판 토글
  $patentDlcToggle.addEventListener('change', async () => {
    _dlcPatentEnabled = $patentDlcToggle.checked;
    await chrome.storage.local.set({ bupgogae_dlc_patent: _dlcPatentEnabled });
    updatePatentDlcDesc();

    if (_dlcPatentEnabled) {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_DLC', dlc: 'patent' });
    }
  });

  // DLC DB 삭제
  $dlcDeleteBtn.addEventListener('click', async () => {
    if (!confirm('확장기능 DB를 삭제하시겠습니까?')) return;

    _dlcTaxEnabled = false;
    _dlcPatentEnabled = false;
    _filterCourt = true;
    _filterConstitutional = true;
    $taxDlcToggle.checked = false;
    $patentDlcToggle.checked = false;
    $courtFilterToggle.checked = true;
    $constitutionalFilterToggle.checked = true;
    await chrome.storage.local.set({
      bupgogae_dlc_tax: false,
      bupgogae_dlc_patent: false,
      bupgogae_filter_court: true,
      bupgogae_filter_constitutional: true,
    });
    updateCourtFilterDesc();
    updateConstitutionalFilterDesc();
    updateTaxDlcDesc();
    updatePatentDlcDesc();

    chrome.runtime.sendMessage({ type: 'DELETE_DLC_DB' });
    $dlcDeleteBtn.textContent = '삭제 완료 ✔';
    setTimeout(() => { $dlcDeleteBtn.textContent = '확장기능 DB 삭제'; }, 1500);
  });
}

/**
 * 사이트별 토글 변경.
 */
async function onSiteToggle() {
  const enabled = $siteToggle.checked;

  if (enabled) {
    // 목록에서 제거
    _disabledSites = _disabledSites.filter(h => h !== _currentHostname);
  } else {
    // 목록에 추가
    if (!_disabledSites.includes(_currentHostname)) {
      _disabledSites.push(_currentHostname);
    }
  }

  await saveState();
  updateSiteDesc(enabled);
  updateStatusText();
  await updateIconBadge();
  await notifyContentScript();
}

/**
 * 전체 토글 변경.
 */
async function onGlobalToggle() {
  _disabledGlobal = !$globalToggle.checked;

  // 전체 비활성 시 사이트 토글도 비활성 처리
  if (_disabledGlobal) {
    $siteToggleRow.classList.add('disabled');
  } else {
    if (_isSupportedSite) {
      $siteToggleRow.classList.remove('disabled');
    }
  }

  await saveState();
  updateGlobalDesc();
  updateStatusText();
  await updateIconBadge();
  await notifyContentScript();
}

// ============================================================
// 6. 상태 저장 & 반영
// ============================================================

/**
 * 현재 상태를 chrome.storage.local에 저장.
 */
async function saveState() {
  await chrome.storage.local.set({
    bupgogae_disabled_global: _disabledGlobal,
    bupgogae_disabled_sites: _disabledSites,
  });
}

/**
 * 아이콘 배지 업데이트 (비활성 시 OFF 표시).
 */
async function updateIconBadge() {
  const isDisabled = _disabledGlobal ||
    (_isSupportedSite && _disabledSites.includes(_currentHostname));

  try {
    if (isDisabled) {
      await chrome.action.setBadgeText({ text: 'OFF', tabId: _currentTabId });
      await chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId: _currentTabId });
    } else {
      await chrome.action.setBadgeText({ text: '', tabId: _currentTabId });
    }
  } catch (err) {
    console.warn('[popup] 배지 업데이트 실패:', err);
  }
}

/**
 * Content Script에 상태 변경 알림.
 * 탭 새로고침으로 즉시 반영.
 */
async function notifyContentScript() {
  if (!_currentTabId || !_isSupportedSite) return;

  try {
    await chrome.tabs.reload(_currentTabId);
  } catch (err) {
    console.warn('[popup] 탭 새로고침 실패:', err);
  }
}
