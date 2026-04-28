/**
 * 법고개(Bupgogae) — 3단 신호등 인라인 렌더링 모듈
 * =============================================
 * LLM 대화창 DOM에서 탐지된 판례번호 텍스트 자체를 색상 하이라이트로 감싼다.
 *
 * [3단 신호등]
 *   Green  : DB Hit — 연한 초록 하이라이트 + 밑줄 + hover/click 시 full citation 툴팁
 *   Red    : 형식 오류 — 붉은 배경 + 취소선 + hover/click 시 사유 툴팁
 *   Orange : DB Miss — 짙은 주황 하이라이트 + 하단 보더 + hover/click 시 경고 툴팁
 *
 * 인라인 <span> 렌더링. 이모지 없음.
 * 툴팁: hover 시 표시, 클릭 시 임시 고정(pinned), 다른 곳 클릭 또는 X 버튼으로 해제.
 */

// ============================================================
// 1. 스타일 주입 (1회만)
// ============================================================

let _styleInjected = false;

function injectBadgeStyles() {
  if (_styleInjected) return;
  _styleInjected = true;

  const style = document.createElement('style');
  style.id = 'bupgogae-badge-styles';
  style.textContent = BUPGOGAE_CSS;
  (document.head || document.documentElement).appendChild(style);
}

// ============================================================
// 2. CSS
// ============================================================

const BUPGOGAE_CSS = `
/* --- 공통 배지 --- */
.bgae-badge {
  position: relative;
  display: inline;
  border-radius: 2px;
  padding: 1px 3px;
  cursor: pointer;
  transition: filter 0.15s ease;
}

.bgae-badge:hover {
  filter: brightness(0.92);
}

/* --- Green --- */
.bgae-green {
  background-color: rgba(34, 197, 94, 0.18);
  color: inherit;
  text-decoration: underline;
  text-decoration-color: rgba(34, 197, 94, 0.5);
  text-underline-offset: 2px;
}

.bgae-green:hover {
  background-color: rgba(34, 197, 94, 0.30);
}

/* --- Red --- */
.bgae-red {
  background-color: rgba(239, 68, 68, 0.12);
  color: inherit;
  text-decoration: line-through;
  text-decoration-color: rgba(239, 68, 68, 0.7);
  text-decoration-thickness: 2px;
}

.bgae-red:hover {
  background-color: rgba(239, 68, 68, 0.20);
}

/* --- Orange --- */
.bgae-orange {
  background-color: rgba(234, 88, 12, 0.18);
  color: inherit;
  border-bottom: 2.5px solid rgba(234, 88, 12, 0.7);
}

.bgae-orange:hover {
  background-color: rgba(234, 88, 12, 0.30);
}

/* --- Gray (Pending) --- */
.bgae-gray {
  background-color: rgba(156, 163, 175, 0.20);
  color: inherit;
  border-bottom: 2.5px dotted rgba(156, 163, 175, 0.6);
  animation: bgae-pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  cursor: wait;
}

@keyframes bgae-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

/* --- 전역 툴팁 (Global Floating UI) --- */
.bgae-global-tooltip {
  visibility: hidden;
  opacity: 0;
  position: fixed;
  z-index: 2147483647;

  max-width: 400px;
  min-width: 200px;
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.55;
  white-space: normal;
  word-break: keep-all;
  pointer-events: none;
  box-shadow: 0 4px 14px rgba(0,0,0,0.3);
  user-select: none;

  transition: opacity 0.15s ease, visibility 0.15s ease;
  transform: translate(-50%, -100%); /* 왼쪽 중앙, 위쪽으로 올림 */
  margin-top: -8px; /* 배지와의 간격 */
}

/* 표시 상태 (JS에서 제어) */
.bgae-global-tooltip.bgae-show {
  visibility: visible;
  opacity: 1;
}

/* pinned 상태: 클릭 가능 */
.bgae-global-tooltip.bgae-pinned {
  visibility: visible;
  opacity: 1;
  pointer-events: auto;
}

/* 툴팁 색상 테마 */
.bgae-global-tooltip.bgae-tooltip-green {
  background: #14532d;
  color: #bbf7d0;
  border: 1px solid rgba(34, 197, 94, 0.3);
}

.bgae-global-tooltip.bgae-tooltip-red {
  background: #7f1d1d;
  color: #fecaca;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.bgae-global-tooltip.bgae-tooltip-orange {
  background: #7c2d12;
  color: #fed7aa;
  border: 1px solid rgba(234, 88, 12, 0.3);
}

/* 툴팁 화살표 */
.bgae-global-tooltip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
}
.bgae-global-tooltip.bgae-tooltip-green::after { border-top-color: #14532d; }
.bgae-global-tooltip.bgae-tooltip-red::after { border-top-color: #7f1d1d; }
.bgae-global-tooltip.bgae-tooltip-orange::after { border-top-color: #7c2d12; }

/* 닫기 버튼 */
.bgae-tooltip-close {
  position: absolute;
  top: 4px;
  right: 6px;
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 14px;
  line-height: 16px;
  text-align: center;
  cursor: pointer;
  opacity: 0.6;
  padding: 0;
  display: none;
}

.bgae-tooltip-close:hover {
  opacity: 1;
}

.bgae-pinned .bgae-tooltip-close {
  display: block;
}

/* 툴팁 내부 */
.bgae-tooltip-title {
  display: block;
  font-weight: 700;
  margin-bottom: 4px;
  font-size: 12.5px;
}

.bgae-tooltip-citation {
  display: block;
  margin-bottom: 3px;
  font-size: 12px;
  opacity: 0.95;
}

.bgae-tooltip-body {
  display: block;
}

.bgae-tooltip-link {
  display: inline-block;
  margin-top: 6px;
  padding: 3px 8px;
  background: rgba(255,255,255,0.12);
  border-radius: 3px;
  color: inherit;
  text-decoration: none;
  font-size: 11px;
  cursor: pointer;
}

.bgae-tooltip-link:hover {
  background: rgba(255,255,255,0.22);
}

/* --- Green 사건 목록 --- */
.bgae-tooltip-case-list {
  display: block;
  margin-top: 6px;
  padding: 0;
  list-style: none;
}

.bgae-tooltip-case-item {
  display: flex;
  align-items: stretch;
  gap: 4px;
  margin: 3px 0;
}

.bgae-tooltip-case-item a.bgae-main-link {
  flex: 1;
  display: block;
  padding: 4px 8px;
  background: #e6f4ea;
  border-radius: 3px;
  border-left: 2.5px solid rgba(34, 197, 94, 0.8);
  color: #1a73e8;
  text-decoration: none;
  font-size: 11.5px;
  line-height: 1.5;
  cursor: pointer;
  transition: background 0.12s ease;
}

.bgae-tooltip-case-item a.bgae-main-link:hover {
  background: #ceead6;
}

.bgae-tooltip-newtab-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  background: #e6f4ea;
  border-radius: 3px;
  color: #1a73e8;
  cursor: pointer;
  transition: all 0.2s;
}
.bgae-tooltip-newtab-btn:hover {
  background: #ceead6;
  color: #174ea6;
}
.bgae-tooltip-newtab-btn svg {
  width: 12px;
  height: 12px;
}

.bgae-tooltip-footer {
  display: block;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255,255,255,0.15);
  font-size: 11px;
  opacity: 0.75;
}
`;


// ============================================================
// 3. 날짜·법원 디코딩 유틸리티
// ============================================================

/**
 * 6자리 날짜 정수를 한국 법률 인용 형식으로 변환.
 * 150115 → "2015. 1. 15."
 * 760428 → "1976. 4. 28."
 * @param {number} dateInt
 * @returns {string}
 */
function formatDecisionDate(dateInt) {
  if (!dateInt || typeof dateInt !== 'number') return '';
  const s = String(dateInt).padStart(6, '0');
  const yy = parseInt(s.slice(0, 2), 10);
  const mm = parseInt(s.slice(2, 4), 10);
  const dd = parseInt(s.slice(4, 6), 10);

  // 2자리 연도 → 4자리 (30 이상이면 1900년대)
  const fullYear = yy >= 30 ? 1900 + yy : 2000 + yy;

  // 한국 법률 인용 형식: 0 없이 기재
  return `${fullYear}. ${mm}. ${dd}.`;
}

/**
 * 법원 코드(정수)를 법원명으로 변환.
 * @param {number} courtCode
 * @param {Object} courtCodeMap - { "대법원": 1, ... }
 * @returns {string}
 */
function decodeCourtName(courtCode, courtCodeMap) {
  if (!courtCodeMap || courtCode == null) return '';
  // courtCodeMap은 name→code이므로 역변환
  for (const [name, code] of Object.entries(courtCodeMap)) {
    if (code === courtCode) return name;
  }
  return '';
}

/**
 * 사건부호로 판결/결정/심결 유형 판별.
 * 결정 사건부호: 마,모,후,브,스,즈,초,초기,비,인,그,르,슈,즈,카,타,파,하 등
 * @param {string} caseCode - 한글 사건부호 (예: "다", "마", "후", "당")
 * @param {string} [caseType] - 'court' | 'constitutional' | 'tax'
 * @returns {string} "판결", "결정", 또는 "심결"
 */
function getDecisionType(caseCode, caseType) {
  // 결정 유형 사건부호 (1글자 + 2글자)
  const decisionCodes = new Set([
    '마', '모', '후', '브', '스', '즈', '쿠', '터', '토',
    '비', '인', '그', '르', '슈',
    '초기', '보기', '카기',
    // 재심 결정
    '재마', '재모', '재후',
    // 헌법재판소 (모두 결정)
    '헌가', '헌나', '헌다', '헌라', '헌마', '헌바', '헌사', '헌아',
  ]);

  if (!caseCode) return '판결';
  if (decisionCodes.has(caseCode)) return '결정';
  return '판결';
}

/**
 * full citation 포맷 생성.
 * "대법원 2015. 1. 15. 선고 2015다6302 판결"
 * "대법원 1976. 4. 28.자 75모81 결정"
 * "대법원 1976. 4. 28.자 75모81 결정"
 *
 * @param {string} courtName
 * @param {string} dateStr - formatDecisionDate 결과
 * @param {string} caseNumber - 원본 사건번호 (예: "2015다6302")
 * @param {string} caseCode - 한글 사건부호 (예: "다", "마", "당")
 * @param {string} [caseType] - 'court' | 'constitutional' | 'tax'
 * @returns {string}
 */
function buildFullCitation(courtName, dateStr, caseNumber, caseCode, caseType) {
  const type = getDecisionType(caseCode, caseType);
  const connector = type === '결정' ? '자' : '선고';

  let parts = [];
  if (courtName) parts.push(courtName);
  if (dateStr && connector) parts.push(`${dateStr} ${connector}`);
  else if (dateStr) parts.push(dateStr);
  parts.push(caseNumber);
  parts.push(type);

  return parts.join(' ');
}


// ============================================================
// 4. 툴팁 메시지 (이모지 없음)
// ============================================================

/**
 * DOM 헬퍼: 안전한 요소 생성 (innerHTML 미사용 — XSS 방어 + 웹스토어 심사 통과).
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function _el(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

const TOOLTIP_BUILDERS = {
  /**
   * Green 툴팁 DOM 조립 — 동일 키에 매칭되는 사건 목록을 링크 리스트로 표시.
   *
   * @param {Array} entries - [{serialNumber, courtCode, dateInt, caseName, caseType, caseCode, trialType}]
   * @param {string} rawCaseNumber - 원본 사건번호 문자열 ("2015다6302")
   * @param {Object} courtCodeMap - 법원코드 매핑
   * @returns {DocumentFragment}
   */
  green(entries, rawCaseNumber, courtCodeMap) {
    const frag = document.createDocumentFragment();

    // 헤더 경고
    frag.appendChild(_el('span', 'bgae-tooltip-title',
      '법제처 DB에 존재하는 사건번호입니다.'));
    frag.appendChild(_el('span', 'bgae-tooltip-body',
      '인용 내용의 정확성은 보장되지 않으니, 원문 확인이 반드시 필요합니다.'));

    // 사건 목록 (각각 하이퍼링크)
    const list = _el('div', 'bgae-tooltip-case-list');

    for (const entry of entries) {
      const {
        serialNumber, courtCode, dateInt,
        caseName, caseType, caseCode, trialType,
      } = entry;

      // full citation 조립
      const courtName = decodeCourtName(courtCode, courtCodeMap);
      const dateStr = formatDecisionDate(dateInt);
      const fullCitation = buildFullCitation(
        courtName, dateStr, rawCaseNumber, caseCode, caseType,
      );

      // 링크 URL 결정
      const sn = String(serialNumber);
      let href;
      if (sn.startsWith('D')) {
        href = `https://www.law.go.kr/detcInfoP.do?mode=1&detcSeq=${sn.slice(1)}`;
      } else if (sn.startsWith('T')) {
        href = `https://www.law.go.kr/DRF/lawService.do?target=ttSpecialDecc&ID=${sn.slice(1)}&type=HTML`;
      } else {
        href = `https://www.law.go.kr/precInfoP.do?precSeq=${sn}`;
      }

      // 표시 텍스트: full citation (+ 사건명이 있으면 추가)
      let displayText = fullCitation;
      if (caseName) displayText += ` [${caseName}]`;

      // 리스트 아이템
      const item = _el('div', 'bgae-tooltip-case-item');
      
      const link = _el('a', 'bgae-main-link', displayText);
      link.href = href;
      link.title = "클릭 시 사이드바 원문 뷰어 열림 (Shift+클릭 시 새 탭)";
      
      link.addEventListener('click', (e) => {
        // Shift/Ctrl/Meta 누르고 클릭하면 기존 브라우저 기본 동작(새 탭 열림) 허용
        if (e.shiftKey || e.ctrlKey || e.metaKey) return;
        
        e.preventDefault();
        e.stopPropagation();
        if (window.bupgogae && window.bupgogae.openSidebar) {
           window.bupgogae.openSidebar(href);
        } else {
           window.open(href, '_blank', 'noopener');
        }
      });

      // 새 탭 아이콘 버튼 생성
      const newTabBtn = _el('a', 'bgae-tooltip-newtab-btn');
      newTabBtn.href = href;
      newTabBtn.target = '_blank';
      newTabBtn.rel = 'noopener noreferrer';
      newTabBtn.title = '새 탭에서 열기';
      newTabBtn.textContent = '↗️';
      // 새 탭 클릭시 사이드 패널/사이드바 등 기타 방해 요소를 막기 위해 기본동작만 타게 함
      newTabBtn.addEventListener('click', (e) => {
         e.stopPropagation(); // 툴팁 영역 전체 클릭 무력화
      });

      item.appendChild(link);
      item.appendChild(newTabBtn);
      list.appendChild(item);
    }

    frag.appendChild(list);
    return frag;
  },

  /**
   * Red 툴팁 DOM 조립.
   * @param {string} reason
   * @returns {DocumentFragment}
   */
  red(reason) {
    const frag = document.createDocumentFragment();
    frag.appendChild(_el('span', 'bgae-tooltip-title', '사건번호 형식 오류'));
    frag.appendChild(_el('span', 'bgae-tooltip-body',
      reason || '대한민국 사건번호 체계를 벗어난 형식입니다.'));
    frag.appendChild(_el('span', 'bgae-tooltip-footer',
      'AI 환각(Hallucination)일 가능성이 높습니다.'));
    return frag;
  },

  /**
   * Orange 툴팁 DOM 조립.
   * @returns {DocumentFragment}
   */
  orange() {
    const frag = document.createDocumentFragment();
    frag.appendChild(_el('span', 'bgae-tooltip-title', 'DB 미확인 사건번호'));
    frag.appendChild(_el('span', 'bgae-tooltip-body',
      '공개된 판례 데이터베이스에서 검증되지 않은 사건번호입니다.'));

    // 사법정보공개포털 링크가 포함된 본문
    const bodyWithLink = _el('span', 'bgae-tooltip-body');
    const portalLink = _el('a', 'bgae-tooltip-link', '사법정보공개포털(링크)');
    portalLink.href = 'https://portal.scourt.go.kr/pgp/index.on?m=PGP210M01&l=N&c=200';
    portalLink.target = '_blank';
    portalLink.rel = 'noopener';
    bodyWithLink.appendChild(portalLink);
    bodyWithLink.appendChild(document.createTextNode('에서 허위 사건번호 여부를 판별하십시오.'));
    frag.appendChild(bodyWithLink);

    frag.appendChild(_el('span', 'bgae-tooltip-footer',
      '법적 인용 전 반드시 원문을 확인하십시오.'));
    return frag;
  },
};


// ============================================================
// 5. 툴팁 핀(고정) 관리 및 전역 툴팁 (Global Floating UI)
// ============================================================

let _currentPinnedTooltip = false; // 전역 툴팁 고정 여부 플래그
let _activeBadge = null;           // 현재 툴팁이 가리키고 있는 배지 요소
let _globalTooltip = null;         // 전역 툴팁 DOM

/**
 * 전역 툴팁 DOM을 싱글톤으로 생성하여 반환.
 */
function getGlobalTooltip() {
  if (!_globalTooltip) {
    _globalTooltip = document.createElement('div');
    _globalTooltip.className = 'bgae-global-tooltip';
    
    // 닫기 버튼
    const closeBtn = document.createElement('button');
    closeBtn.className = 'bgae-tooltip-close';
    closeBtn.textContent = '\u00D7'; // ×
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      unpinCurrentTooltip();
      hideTooltip();
    });
    
    const contentBox = document.createElement('div');
    contentBox.className = 'bgae-tooltip-content-box';
    
    _globalTooltip.appendChild(closeBtn);
    _globalTooltip.appendChild(contentBox);
    document.body.appendChild(_globalTooltip);
    
    // 툴팁 내부 클릭 시 클릭 이벤트가 문서 전체로 퍼지지 않게 방어
    _globalTooltip.addEventListener('click', (e) => {
      // 툴팁 안의 링크(a 태그)를 클릭한 경우는 통과
      if (!e.target.closest('a')) {
        e.stopPropagation();
      }
    });
    
    // 스크롤 및 리사이즈 시 위치 업데이트
    window.addEventListener('scroll', () => {
      if (_activeBadge) {
        // 고정 상태가 아니면 화면이 스크롤될 때 즉시 툴팁을 숨김 (이질감 방지)
        if (!_currentPinnedTooltip) hideTooltip();
        // 고정 상태면 배지 위치를 따라감
        else updateTooltipPosition();
      }
    }, { passive: true, capture: true }); // capture: true로 내부 div 스크롤도 감지
    
    window.addEventListener('resize', () => {
      if (_activeBadge) updateTooltipPosition();
    }, { passive: true });
  }
  return _globalTooltip;
}

/**
 * 툴팁의 위치를 _activeBadge의 최신 화면 좌표로 동기화.
 */
function updateTooltipPosition() {
  if (!_activeBadge || !_globalTooltip) return;
  const rect = _activeBadge.getBoundingClientRect();
  // 위치: 배지의 가로 중앙, 세로 상단 (transform: translate(-50%, -100%)로 보정됨)
  _globalTooltip.style.left = (rect.left + rect.width / 2) + 'px';
  _globalTooltip.style.top = rect.top + 'px';
}

/**
 * 툴팁을 특정 배지에 띄움.
 */
function showTooltip(badge, level, options, precedentString) {
  // 이미 다른 배지에 핀 고정되어 있다면 무시
  if (_currentPinnedTooltip && _activeBadge !== badge) return;
  
  const tooltip = getGlobalTooltip();
  const contentBox = tooltip.querySelector('.bgae-tooltip-content-box');
  contentBox.innerHTML = ''; // safe: 빈 문자열 할당 (내용 초기화)
  
  // 툴팁 내용 조립
  switch (level) {
    case 'green': {
      const greenEntries = options.greenEntries || [{
        serialNumber: options.serialNumber || '',
        courtCode: options.courtCode,
        dateInt: options.dateInt,
        caseName: options.caseName || '',
        caseType: options.caseType || 'court',
        caseCode: options.caseCode || '',
        trialType: options.trialType || '',
      }];
      contentBox.appendChild(TOOLTIP_BUILDERS.green(
        greenEntries, precedentString, options.courtCodeMap,
      ));
      break;
    }
    case 'red':
      contentBox.appendChild(TOOLTIP_BUILDERS.red(options.redReason || ''));
      break;
    case 'orange':
      contentBox.appendChild(TOOLTIP_BUILDERS.orange());
      break;
    default:
      return; // gray 상태는 툴팁 표시 불가
  }

  // 클래스명 및 테마 업데이트
  tooltip.className = `bgae-global-tooltip bgae-show bgae-tooltip-${level}`;
  if (_currentPinnedTooltip) tooltip.classList.add('bgae-pinned');
  
  _activeBadge = badge;
  updateTooltipPosition();
}

/**
 * 툴팁 숨김.
 */
function hideTooltip() {
  if (_currentPinnedTooltip) return; // 고정된 상태면 숨기지 않음
  if (_globalTooltip) {
    _globalTooltip.classList.remove('bgae-show');
    _globalTooltip.classList.remove('bgae-pinned');
  }
  _activeBadge = null;
}

/**
 * 현재 고정된 툴팁 해제.
 */
function unpinCurrentTooltip() {
  _currentPinnedTooltip = false;
  if (_globalTooltip) {
    _globalTooltip.classList.remove('bgae-pinned');
  }
}

/**
 * 툴팁 고정/해제 토글 (클릭 시).
 */
function togglePinTooltip(badge, level, options, precedentString) {
  if (_currentPinnedTooltip && _activeBadge === badge) {
    // 같은 배지를 다시 클릭하면 고정 해제 및 숨김
    unpinCurrentTooltip();
    hideTooltip();
  } else {
    // 새 배지를 클릭하면 즉시 고정
    _currentPinnedTooltip = false; // 강제 전환을 위해 일시 해제
    showTooltip(badge, level, options, precedentString);
    _currentPinnedTooltip = true;
    if (_globalTooltip) _globalTooltip.classList.add('bgae-pinned');
  }
}

// 문서 전체 클릭 시 고정 해제 (배지나 툴팁 외 영역 클릭 시)
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    if (_currentPinnedTooltip) {
      if (!e.target.closest('.bgae-badge') && !e.target.closest('.bgae-global-tooltip')) {
        unpinCurrentTooltip();
        hideTooltip();
      }
    }
  }, true); // 캡처 단계에서 처리하여 다른 요소의 클릭 차단 방지
}


// ============================================================
// 6. 핵심 렌더링 함수
// ============================================================

/**
 * 텍스트 노드 내 판례번호 문자열을 인라인 하이라이트 <span>으로 교체.
 *
 * @param {Text} textNode
 * @param {string} precedentString - "2015다6302"
 * @param {'green'|'orange'|'red'|'gray'} level
 * @param {Object} [options]
 * @returns {HTMLElement|null}
 */
function renderPrecedentBadge(textNode, precedentString, level, options = {}) {
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return null;

  const text = textNode.textContent;
  const idx = text.indexOf(precedentString);
  if (idx === -1) return null;

  injectBadgeStyles();

  const parent = textNode.parentNode;
  if (!parent) return null;

  const beforeText = text.slice(0, idx);
  const afterText = text.slice(idx + precedentString.length);

  // ── 배지 <span> 생성 ──
  const badge = document.createElement('span');
  badge.className = `bgae-badge bgae-${level}`;
  badge.setAttribute('data-bgae-level', level);
  badge.setAttribute('data-bgae-case', precedentString);
  badge.textContent = precedentString;

  // ── 툴팁 이벤트 연결 ──
  if (level !== 'gray') {
    badge.addEventListener('mouseenter', () => {
      showTooltip(badge, level, options, precedentString);
    });
    
    badge.addEventListener('mouseleave', () => {
      hideTooltip();
    });
    
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePinTooltip(badge, level, options, precedentString);
    });
  }

  // ── DOM 교체 ──
  if (beforeText) {
    parent.insertBefore(document.createTextNode(beforeText), textNode);
  }
  parent.insertBefore(badge, textNode);
  if (afterText) {
    parent.insertBefore(document.createTextNode(afterText), textNode);
  }
  parent.removeChild(textNode);

  return badge;
}

/**
 * 기존 배지를 해제하고 일반 텍스트 노드로 원복 (실패 시 복구용)
 * @param {HTMLElement} badge
 * @param {string} precedentString
 * @returns {Text|null} 새로 삽입된 텍스트 노드
 */
function revertPrecedentBadge(badge, precedentString) {
  if (!badge || !badge.parentNode) return null;
  const textNode = document.createTextNode(precedentString);
  badge.parentNode.insertBefore(textNode, badge);
  badge.parentNode.removeChild(badge);
  return textNode;
}

/**
 * 렌더링된 배지(주로 gray)를 파괴하고 새로운 색상으로 재렌더링
 * @param {HTMLElement} badge 
 * @param {string} precedentString 
 * @param {'green'|'orange'|'red'} level 
 * @param {Object} options 
 * @returns {HTMLElement|null} 새로 생성된 배지
 */
function updatePrecedentBadge(badge, precedentString, level, options = {}) {
  const textNode = revertPrecedentBadge(badge, precedentString);
  if (!textNode) return null;
  return renderPrecedentBadge(textNode, precedentString, level, options);
}

// ============================================================
// 7. 외부 인터페이스
// ============================================================

if (typeof window !== 'undefined') {
  window.bupgogae = window.bupgogae || {};
  Object.assign(window.bupgogae, {
    renderPrecedentBadge,
    updatePrecedentBadge,
    revertPrecedentBadge,
    formatDecisionDate,
    decodeCourtName,
    buildFullCitation,
    getDecisionType,
  });
}
