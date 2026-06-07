/**
 * 법고개(Bupgogae) — Intelligent Document Reader
 * ================================================
 * Phase 1: 기반 아키텍처 — 드롭존, 리사이저, 상태 관리 골격
 *
 * [책임]
 *   1. 파일 Drag & Drop / 파일 선택 처리
 *   2. CSS Grid 3단 리사이저 (좌-중, 중-우 가변 분할)
 *   3. 전역 상태 객체 초기화 (Phase 2에서 파싱 결과로 채움)
 *   4. 패널 간 상태 동기화 컨트롤러 골격 (Phase 3에서 구현)
 */

// ============================================================
// 1. 전역 상태 (State)
// ============================================================

/**
 * 뷰어 전역 상태 객체.
 * Phase 2에서 파싱 완료 시 이 객체를 채운다.
 *
 * @type {{
 *   file: File|null,
 *   fileType: string|null,
 *   toc: Array<{level: number, text: string, id: string}>,
 *   contentHtml: string,
 *   cases: Array<{raw: string, year: string, code: string, serial: string, type: string}>,
 *   activeCaseId: string|null,
 *   activeTocId: string|null,
 * }}
 */
const viewerState = {
  file: null,
  fileType: null,
  toc: [],
  contentHtml: '',
  cases: [],
  activeCaseId: null,
  activeTocId: null,
};

// ============================================================
// 2. DOM 참조
// ============================================================

const $ = (sel) => document.getElementById(sel);

const DOM = {
  grid: $('viewerGrid'),
  toolbar: $('viewerToolbar'),
  toolbarFilename: $('toolbarFilename'),
  toolbarStats: $('toolbarStats'),
  btnResetFile: $('btnResetFile'),

  // Panels
  panelToc: $('panelToc'),
  panelContent: $('panelContent'),
  panelDetail: $('panelDetail'),
  tocBody: $('tocBody'),
  contentBody: $('contentBody'),
  detailBody: $('detailBody'),

  // Dropzone
  dropzone: $('dropzone'),
  fileInput: $('fileInput'),
  contentRendered: $('contentRendered'),

  // Resizers
  resizerLeft: $('resizerLeft'),
  resizerRight: $('resizerRight'),

  // Drag Overlay
  dragOverlay: $('dragOverlay'),
};

// ============================================================
// 3. 지원 파일 포맷
// ============================================================

const SUPPORTED_EXTENSIONS = new Set([
  'pdf', 'docx', 'hwpx', 'md', 'markdown', 'txt',
]);

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
]);

/**
 * 파일 확장자 추출.
 * @param {string} filename
 * @returns {string} lowercase extension
 */
function getFileExtension(filename) {
  return (filename || '').split('.').pop().toLowerCase();
}

/**
 * 파일이 지원 포맷인지 확인.
 * @param {File} file
 * @returns {boolean}
 */
function isSupportedFile(file) {
  const ext = getFileExtension(file.name);
  return SUPPORTED_EXTENSIONS.has(ext);
}

// ============================================================
// 4. 파일 Drag & Drop
// ============================================================

/**
 * 드래그 카운터 — dragenter/dragleave 중첩 문제 해결.
 * 자식 요소 진입/퇴장 시 이벤트 중복 발생하므로 카운터로 추적.
 */
let _dragCounter = 0;

/**
 * 전체 페이지 드래그 이벤트 바인딩.
 * 파일이 브라우저 위로 드래그되면 오버레이를 표시하고,
 * 드롭 시 파싱 파이프라인을 시작한다.
 */
function initDragAndDrop() {
  // === 전체 페이지 드래그 오버레이 ===
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    _dragCounter++;
    if (_dragCounter === 1) {
      DOM.dragOverlay.classList.add('visible');
    }
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    _dragCounter--;
    if (_dragCounter <= 0) {
      _dragCounter = 0;
      DOM.dragOverlay.classList.remove('visible');
    }
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    _dragCounter = 0;
    DOM.dragOverlay.classList.remove('visible');

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileSelection(files[0]);
    }
  });

  // === 중앙 패널 드롭존 (초기 화면) ===
  if (DOM.dropzone) {
    DOM.dropzone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      DOM.dropzone.classList.add('drag-hover');
    });

    DOM.dropzone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      DOM.dropzone.classList.remove('drag-hover');
    });

    DOM.dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    DOM.dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      DOM.dropzone.classList.remove('drag-hover');
      // 전체 페이지 drop 핸들러에서 처리
    });
  }

  // === 파일 선택 버튼 ===
  if (DOM.fileInput) {
    DOM.fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        handleFileSelection(file);
      }
    });
  }
}

/**
 * 파일 선택 처리 — 검증 후 파싱 파이프라인 시작.
 * @param {File} file
 */
function handleFileSelection(file) {
  if (!isSupportedFile(file)) {
    const ext = getFileExtension(file.name);
    showError(`지원하지 않는 파일 형식입니다: .${ext}\n지원 형식: PDF, DOCX, HWPX, MD, TXT`);
    return;
  }

  // 상태 초기화
  viewerState.file = file;
  viewerState.fileType = getFileExtension(file.name);

  // UI 전환: 드롭존 → 로딩
  transitionToLoading(file.name);

  // Phase 2: 실제 파싱 로직 호출
  window.parseDocument(file).then(result => {
    viewerState.toc = result.toc;
    viewerState.contentHtml = result.contentHtml;
    viewerState.cases = result.cases;

    transitionToContent(file.name);
    renderParsedDocument();
  }).catch(err => {
    showError(`파싱 중 오류가 발생했습니다: ${err.message}`);
    resetFile();
  });
}

// ============================================================
// 4-1. 파싱 결과 렌더링 & 동기화 (Phase 3)
// ============================================================

function renderParsedDocument() {
  DOM.contentRendered.style.display = 'block';
  DOM.toolbarStats.textContent = `추출된 사건: ${viewerState.cases.length}건`;

  renderToc();
  renderContent();
  bindCaseChips();
  
  if (viewerState.cases.length > 0) {
    setActiveCase(viewerState.cases[0].compressed);
  }
}

function renderToc() {
  if (viewerState.toc.length === 0) {
    DOM.tocBody.innerHTML = '<p class="panel-placeholder">추출된 목차가 없습니다.</p>';
    return;
  }

  let html = '';
  viewerState.toc.forEach(item => {
    html += `<div class="toc-item toc-item-level-${item.level}" data-target="${item.id}">
      <span class="toc-text">${escapeHtml(item.text)}</span>
    </div>`;
  });
  DOM.tocBody.innerHTML = html;

  // 목차 클릭 이벤트
  DOM.tocBody.querySelectorAll('.toc-item').forEach(el => {
    el.addEventListener('click', () => {
      const targetId = el.getAttribute('data-target');
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        
        DOM.tocBody.querySelectorAll('.toc-item').forEach(i => i.classList.remove('active'));
        el.classList.add('active');
      }
    });
  });
}

function renderContent() {
  DOM.contentRendered.innerHTML = viewerState.contentHtml;
}

function bindCaseChips() {
  const chips = DOM.contentRendered.querySelectorAll('.case-chip');
  chips.forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const caseId = chip.getAttribute('data-case');
      setActiveCase(caseId, chip);
    });
  });
}

/**
 * 3단 상태 동기화 컨트롤러 (Phase 3)
 */
function setActiveCase(caseId, targetChip = null) {
  if (viewerState.activeCaseId === caseId) return;
  viewerState.activeCaseId = caseId;

  // 1. 중앙 뷰 칩 포커스
  const chips = DOM.contentRendered.querySelectorAll('.case-chip');
  let firstMatch = null;
  chips.forEach(chip => {
    if (chip.getAttribute('data-case') === caseId) {
      chip.classList.add('focused');
      if (!firstMatch) firstMatch = chip;
    } else {
      chip.classList.remove('focused');
    }
  });

  const chipToScroll = targetChip || firstMatch;
  if (chipToScroll) {
    chipToScroll.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // 2. 우측 뷰 판례 페치 (Phase 4)
  fetchCaseDetail(caseId);
}

// ============================================================
// 4-2. 법제처 판례 연동 (Phase 4)
// ============================================================

let _currentFetchId = 0;

async function fetchCaseDetail(caseId) {
  const fetchId = ++_currentFetchId;

  DOM.detailBody.innerHTML = `
    <div class="loading-indicator">
      <div class="loading-spinner"></div>
      <span class="loading-text">판례 정보를 가져오는 중...</span>
    </div>
  `;

  const caseObj = viewerState.cases.find(c => c.compressed === caseId);
  if (!caseObj) return;

  // 1. Local DB에서 확인 (옵션, 하이라이트 색상용)
  chrome.runtime.sendMessage({ type: 'LOOKUP_BATCH', keys: [caseId] }, (res) => {
    if (fetchId !== _currentFetchId) return; // Stale fetch 무시
    const chips = DOM.contentRendered.querySelectorAll(`.case-chip[data-case="${caseId}"]`);
    if (res && res[caseId] && res[caseId].found) {
      chips.forEach(c => { c.classList.remove('unverified'); c.classList.add('verified'); });
    } else {
      chips.forEach(c => { c.classList.remove('verified'); c.classList.add('unverified'); });
    }
  });

  // 2. 법제처 크롤링
  try {
    // caseObj.raw 를 이용해 법제처 검색 URL 구성
    const searchUrl = `https://www.law.go.kr/precSc.do?menuId=1&query=${encodeURIComponent(caseObj.raw)}`;
    
    chrome.runtime.sendMessage({ type: 'FETCH_LAW_HTML', url: searchUrl }, (response) => {
      if (fetchId !== _currentFetchId) return; // Stale fetch 무시

      if (chrome.runtime.lastError || !response || response.error) {
        DOM.detailBody.innerHTML = `<p class="panel-placeholder" style="color:var(--accent-red)">판례 정보를 가져오지 못했습니다.</p>`;
        return;
      }

      // 간단한 파싱 (보안을 위해 iframe 샌드박싱이나 DOMParser 사용)
      const parser = new DOMParser();
      const doc = parser.parseFromString(response.html, 'text/html');
      
      // 검색 결과에서 첫번째 판례 링크 추출
      const firstLink = doc.querySelector('.contsList .conts_list_title a');
      if (!firstLink) {
        DOM.detailBody.innerHTML = `<p class="panel-placeholder">검색 결과가 없습니다.</p>`;
        return;
      }

      const rawHref = firstLink.getAttribute('href');
      // href="javascript:showPrec('235282')"
      const match = rawHref.match(/'(\d+)'/);
      if (match && match[1]) {
        fetchRealCaseDetail(match[1], fetchId);
      } else {
        DOM.detailBody.innerHTML = `<p class="panel-placeholder">판례 링크를 해석할 수 없습니다.</p>`;
      }
    });
  } catch (err) {
    if (fetchId === _currentFetchId) {
      DOM.detailBody.innerHTML = `<p class="panel-placeholder" style="color:var(--accent-red)">오류: ${err.message}</p>`;
    }
  }
}

function fetchRealCaseDetail(precSeq, fetchId) {
  const detailUrl = `https://www.law.go.kr/precInfoP.do?precSeq=${precSeq}&mode=0`;
  chrome.runtime.sendMessage({ type: 'FETCH_LAW_HTML', url: detailUrl }, (response) => {
    if (fetchId !== _currentFetchId) return; // Stale fetch 무시

    if (chrome.runtime.lastError || !response || response.error) {
      DOM.detailBody.innerHTML = `<p class="panel-placeholder" style="color:var(--accent-red)">상세 정보를 가져오지 못했습니다.</p>`;
      return;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(response.html, 'text/html');
    
    // 법제처 판례 본문 추출
    const content = doc.querySelector('#conScroll');
    if (content) {
      // 불필요한 스크립트/버튼 제거
      content.querySelectorAll('script, .btn, button, iframe').forEach(el => el.remove());
      
      // 아코디언 UI 등 스타일링을 위해 구조화 가능하나, 
      // 1차적으로 안전한 HTML만 삽입
      DOM.detailBody.innerHTML = `<div class="detail-section-body" style="padding-top:16px;">${escapeHtmlParser(content.innerHTML)}</div>`;
    } else {
      DOM.detailBody.innerHTML = `<p class="panel-placeholder">본문 내용을 파싱할 수 없습니다.</p>`;
    }
  });
}

function escapeHtmlParser(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  
  // 보안 및 안전을 위해 위험 태그 제거
  div.querySelectorAll('script, iframe, object, embed, link, style').forEach(s => s.remove());
  
  // 다크 모드 깨짐을 유방하는 인라인 스타일 및 이벤트 핸들러 제거
  div.querySelectorAll('*').forEach(el => {
    el.removeAttribute('style');
    for (let i = el.attributes.length - 1; i >= 0; i--) {
      const attr = el.attributes[i];
      if (attr.name.startsWith('on')) {
        el.removeAttribute(attr.name);
      }
    }
  });
  
  return div.innerHTML;
}

// ============================================================
// 4-3. 키보드 생산성 강화 (Phase 5)
// ============================================================

function initKeyboardNav() {
  document.addEventListener('keydown', (e) => {
    if (!viewerState.activeCaseId || viewerState.cases.length === 0) return;

    // Ctrl + 방향키 좌우 또는 [ ] 로 순차 탐색
    if ((e.ctrlKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) || e.key === '[' || e.key === ']') {
      e.preventDefault();
      
      const chips = Array.from(DOM.contentRendered.querySelectorAll('.case-chip'));
      if (chips.length === 0) return;

      const activeChips = chips.filter(c => c.getAttribute('data-case') === viewerState.activeCaseId);
      const currentActive = activeChips[0]; // 포커스된 첫번째 칩
      
      let currentIndex = chips.indexOf(currentActive);
      if (currentIndex === -1) currentIndex = 0;

      let nextIndex = currentIndex;
      if (e.key === 'ArrowRight' || e.key === ']') {
        nextIndex = (currentIndex + 1) % chips.length;
      } else {
        nextIndex = (currentIndex - 1 + chips.length) % chips.length;
      }

      const nextChip = chips[nextIndex];
      const nextCaseId = nextChip.getAttribute('data-case');
      setActiveCase(nextCaseId, nextChip);
    }
  });
}


// ============================================================
// 5. UI 상태 전환
// ============================================================

/**
 * 드롭존 → 로딩 상태 전환.
 * @param {string} filename
 */
function transitionToLoading(filename) {
  // 드롭존 숨기기
  if (DOM.dropzone) DOM.dropzone.style.display = 'none';

  // 로딩 표시
  DOM.contentRendered.style.display = 'block';
  DOM.contentRendered.innerHTML = `
    <div class="loading-indicator">
      <div class="loading-spinner"></div>
      <span class="loading-text">${escapeHtml(filename)} 파싱 중...</span>
    </div>
  `;

  // 툴바 업데이트
  DOM.toolbarFilename.textContent = filename;
  DOM.toolbarFilename.classList.add('active');
}

/**
 * 로딩 → 문서 콘텐츠 표시 전환.
 * @param {string} filename
 */
function transitionToContent(filename) {
  DOM.btnResetFile.style.display = 'flex';
}

/**
 * 파일 초기화 — 드롭존으로 복귀.
 */
function resetFile() {
  // 상태 초기화
  viewerState.file = null;
  viewerState.fileType = null;
  viewerState.toc = [];
  viewerState.contentHtml = '';
  viewerState.cases = [];
  viewerState.activeCaseId = null;
  viewerState.activeTocId = null;

  // UI 복귀
  if (DOM.dropzone) DOM.dropzone.style.display = 'flex';
  DOM.contentRendered.style.display = 'none';
  DOM.contentRendered.innerHTML = '';

  DOM.toolbarFilename.textContent = '파일을 드래그하여 업로드하세요';
  DOM.toolbarFilename.classList.remove('active');
  DOM.toolbarStats.textContent = '';
  DOM.btnResetFile.style.display = 'none';

  // 파일 입력 초기화
  if (DOM.fileInput) DOM.fileInput.value = '';

  // 좌/우 패널 초기화
  DOM.tocBody.innerHTML = '<p class="panel-placeholder">문서를 업로드하면<br>목차가 표시됩니다.</p>';
  DOM.detailBody.innerHTML = '<p class="panel-placeholder">사건번호를 클릭하면<br>판례 내용이 표시됩니다.</p>';
}

/**
 * 에러 메시지 표시.
 * @param {string} message
 */
function showError(message) {
  // 임시 알림 (추후 토스트 UI로 교체 가능)
  alert(message);
}

// ============================================================
// 6. 리사이저 (CSS Grid 열 크기 조정)
// ============================================================

/**
 * 드래그로 CSS Grid 열 크기를 조정하는 리사이저 초기화.
 * 좌-중, 중-우 두 개의 리사이저를 지원.
 */
function initResizers() {
  /**
   * 리사이저 드래그 핸들러 팩토리.
   * @param {'left'|'right'} side - 리사이저 위치
   * @returns {{onMouseDown: function}}
   */
  function createResizerHandler(side) {
    const resizerEl = side === 'left' ? DOM.resizerLeft : DOM.resizerRight;
    if (!resizerEl) return;

    let startX = 0;
    let startWidth = 0;

    function onMouseDown(e) {
      e.preventDefault();
      startX = e.clientX;

      const gridStyle = getComputedStyle(DOM.grid);
      const columns = gridStyle.gridTemplateColumns.split(/\s+/);

      if (side === 'left') {
        startWidth = parseFloat(columns[0]); // TOC 패널 너비
      } else {
        startWidth = parseFloat(columns[4]); // Detail 패널 너비
      }

      document.body.classList.add('resizing');
      resizerEl.classList.add('active');

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    }

    function onMouseMove(e) {
      const dx = e.clientX - startX;
      let newWidth;

      if (side === 'left') {
        newWidth = Math.max(150, Math.min(500, startWidth + dx));
        DOM.grid.style.gridTemplateColumns =
          `${newWidth}px var(--resizer-width) 1fr var(--resizer-width) var(--detail-width)`;
        document.documentElement.style.setProperty('--toc-width', `${newWidth}px`);
      } else {
        // 우측은 반대 방향: dx가 음수일 때 패널이 넓어짐
        newWidth = Math.max(200, Math.min(700, startWidth - dx));
        DOM.grid.style.gridTemplateColumns =
          `var(--toc-width) var(--resizer-width) 1fr var(--resizer-width) ${newWidth}px`;
        document.documentElement.style.setProperty('--detail-width', `${newWidth}px`);
      }
    }

    function onMouseUp() {
      document.body.classList.remove('resizing');
      resizerEl.classList.remove('active');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    resizerEl.addEventListener('mousedown', onMouseDown);
  }

  createResizerHandler('left');
  createResizerHandler('right');
}

// ============================================================
// 7. 유틸리티
// ============================================================

/**
 * HTML 이스케이프 — XSS 방지.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// 8. 이벤트 바인딩 & 초기화
// ============================================================

/**
 * 스크롤 스파이 스로틀 함수
 */
function throttle(fn, wait) {
  let time = Date.now();
  return function() {
    if ((time + wait - Date.now()) < 0) {
      fn();
      time = Date.now();
    }
  };
}

/**
 * 중앙 원문 스크롤 위치에 따라 좌측 TOC 아이템 활성화
 */
function handleContentScroll() {
  if (!viewerState.toc || viewerState.toc.length === 0) return;

  const headings = Array.from(DOM.contentRendered.querySelectorAll('h1, h2, h3'));
  if (headings.length === 0) return;

  const containerRect = DOM.contentBody.getBoundingClientRect();
  const triggerOffset = containerRect.top + 80; // 상단 오프셋 기준선

  let activeHeadingId = null;

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const rect = heading.getBoundingClientRect();
    if (rect.top <= triggerOffset) {
      activeHeadingId = heading.id;
    } else {
      break;
    }
  }

  if (!activeHeadingId && headings.length > 0) {
    activeHeadingId = headings[0].id;
  }

  if (activeHeadingId && viewerState.activeTocId !== activeHeadingId) {
    viewerState.activeTocId = activeHeadingId;
    
    DOM.tocBody.querySelectorAll('.toc-item').forEach(item => {
      if (item.getAttribute('data-target') === activeHeadingId) {
        item.classList.add('active');
        item.scrollIntoView({ behavior: 'auto', block: 'nearest' });
      } else {
        item.classList.remove('active');
      }
    });
  }
}

function initEvents() {
  // 파일 초기화 버튼
  if (DOM.btnResetFile) {
    DOM.btnResetFile.addEventListener('click', resetFile);
  }
  
  // 중앙 원문 스크롤 감시 (Scroll Spy)
  if (DOM.contentBody) {
    DOM.contentBody.addEventListener('scroll', throttle(handleContentScroll, 100));
  }

  initKeyboardNav();
}

/**
 * 뷰어 초기화.
 */
function initViewer() {
  initDragAndDrop();
  initResizers();
  initEvents();
  console.log('[viewer] Intelligent Document Reader 초기화 완료');
}

// DOM 로드 후 초기화
document.addEventListener('DOMContentLoaded', initViewer);
