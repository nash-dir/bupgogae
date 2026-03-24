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

/* --- 툴팁 (hover + pinned) --- */
.bgae-tooltip {
  visibility: hidden;
  opacity: 0;
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
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
}

/* hover 시 표시 */
.bgae-badge:hover .bgae-tooltip {
  visibility: visible;
  opacity: 1;
}

/* pinned 상태: 고정 표시 + 클릭 가능 */
.bgae-tooltip.bgae-pinned {
  visibility: visible;
  opacity: 1;
  pointer-events: auto;
}

/* 툴팁 색상 */
.bgae-green .bgae-tooltip {
  background: #14532d;
  color: #bbf7d0;
  border: 1px solid rgba(34, 197, 94, 0.3);
}

.bgae-red .bgae-tooltip {
  background: #7f1d1d;
  color: #fecaca;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.bgae-orange .bgae-tooltip {
  background: #7c2d12;
  color: #fed7aa;
  border: 1px solid rgba(234, 88, 12, 0.3);
}

/* 툴팁 화살표 */
.bgae-tooltip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
}
.bgae-green .bgae-tooltip::after { border-top-color: #14532d; }
.bgae-red .bgae-tooltip::after { border-top-color: #7f1d1d; }
.bgae-orange .bgae-tooltip::after { border-top-color: #7c2d12; }

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
  display: block;
  margin: 3px 0;
}

.bgae-tooltip-case-item a {
  display: block;
  padding: 4px 8px;
  background: rgba(255,255,255,0.08);
  border-radius: 3px;
  border-left: 2.5px solid rgba(34, 197, 94, 0.6);
  color: inherit;
  text-decoration: none;
  font-size: 11.5px;
  line-height: 1.5;
  cursor: pointer;
  transition: background 0.12s ease;
}

.bgae-tooltip-case-item a:hover {
  background: rgba(255,255,255,0.18);
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
 * @param {string} [caseType] - 'court' | 'constitutional' | 'tax' | 'patent'
 * @returns {string} "판결", "결정", 또는 "심결"
 */
function getDecisionType(caseCode, caseType) {
  // 특허심판원: 모두 "심결"
  if (caseType === 'patent') return '심결';

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
 * "특허심판원 2023. 9. 15. 2023당1234 심결"
 *
 * @param {string} courtName
 * @param {string} dateStr - formatDecisionDate 결과
 * @param {string} caseNumber - 원본 사건번호 (예: "2015다6302")
 * @param {string} caseCode - 한글 사건부호 (예: "다", "마", "당")
 * @param {string} [caseType] - 'court' | 'constitutional' | 'tax' | 'patent'
 * @returns {string}
 */
function buildFullCitation(courtName, dateStr, caseNumber, caseCode, caseType) {
  const type = getDecisionType(caseCode, caseType);
  // 심결(특허심판)은 '선고'/'자' 대신 날짜만 표시
  const connector = type === '심결' ? '' : (type === '결정' ? '자' : '선고');

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
      const courtName = caseType === 'patent'
        ? '특허심판원'
        : decodeCourtName(courtCode, courtCodeMap);
      const dateStr = formatDecisionDate(dateInt);
      const fullCitation = buildFullCitation(
        courtName, dateStr, rawCaseNumber, caseCode, caseType,
      );

      // 링크 URL 결정
      const sn = String(serialNumber);
      let href;
      if (caseType === 'patent') {
        href = 'https://www.kipris.or.kr/';
      } else if (sn.startsWith('D')) {
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
      const link = _el('a', '', displayText);
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener';
      item.appendChild(link);
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
// 5. 툴팁 핀(고정) 관리
// ============================================================

let _currentPinnedTooltip = null;

/**
 * 현재 고정된 툴팁 해제.
 */
function unpinCurrentTooltip() {
  if (_currentPinnedTooltip) {
    _currentPinnedTooltip.classList.remove('bgae-pinned');
    _currentPinnedTooltip = null;
  }
}

/**
 * 툴팁을 고정/해제 토글.
 * @param {HTMLElement} tooltip
 */
function togglePinTooltip(tooltip) {
  if (_currentPinnedTooltip === tooltip) {
    // 이미 고정된 것을 다시 클릭 → 해제
    unpinCurrentTooltip();
  } else {
    // 기존 고정 해제 후 새로 고정
    unpinCurrentTooltip();
    tooltip.classList.add('bgae-pinned');
    _currentPinnedTooltip = tooltip;
  }
}

// 문서 전체 클릭 시 고정 해제 (배지 외 영역 클릭)
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    if (_currentPinnedTooltip && !e.target.closest('.bgae-badge')) {
      unpinCurrentTooltip();
    }
  }, true);
}


// ============================================================
// 6. 핵심 렌더링 함수
// ============================================================

/**
 * 텍스트 노드 내 판례번호 문자열을 인라인 하이라이트 <span>으로 교체.
 *
 * @param {Text} textNode
 * @param {string} precedentString - "2015다6302"
 * @param {'green'|'orange'|'red'} level
 * @param {Object} [options]
 * @param {string} [options.caseName] - 디코딩된 사건명
 * @param {number} [options.serialNumber] - 법제처 일련번호
 * @param {string} [options.redReason] - Red 사유
 * @param {number} [options.courtCode] - 법원 코드 (1=대법원 등)
 * @param {number} [options.dateInt] - 선고일 정수 (150115 등)
 * @param {string} [options.caseCode] - 한글 사건부호 ("다", "마" 등)
 * @param {Object} [options.courtCodeMap] - 법원코드 매핑
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

  // ── 툴팁 생성 ──
  const tooltip = document.createElement('span');
  tooltip.className = 'bgae-tooltip';

  // 닫기 버튼 (pinned 상태에서만 보임)
  const closeBtn = document.createElement('button');
  closeBtn.className = 'bgae-tooltip-close';
  closeBtn.textContent = '\u00D7'; // ×
  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    unpinCurrentTooltip();
  });
  tooltip.appendChild(closeBtn);

  // 툴팁 내용 (DOM API로 조립 — innerHTML 미사용)
  switch (level) {
    case 'green': {
      // greenEntries 배열 → 사건 목록 리스트 렌더링
      const greenEntries = options.greenEntries || [{
        serialNumber: options.serialNumber || '',
        courtCode: options.courtCode,
        dateInt: options.dateInt,
        caseName: options.caseName || '',
        caseType: options.caseType || 'court',
        caseCode: options.caseCode || '',
        trialType: options.trialType || '',
      }];
      tooltip.appendChild(TOOLTIP_BUILDERS.green(
        greenEntries, precedentString, options.courtCodeMap,
      ));
      break;
    }

    case 'red':
      tooltip.appendChild(TOOLTIP_BUILDERS.red(options.redReason || ''));
      break;

    case 'orange':
      tooltip.appendChild(TOOLTIP_BUILDERS.orange());
      break;
  }

  badge.appendChild(tooltip);

  // ── 클릭 → 툴팁 고정 ──
  // 링크 클릭은 통과시키고, 배지 자체 클릭만 툴팁 고정
  badge.addEventListener('click', (e) => {
    // 툴팁 내 링크 클릭은 그대로 진행 (새 탭 열기)
    if (e.target.closest('a')) return;
    e.preventDefault();
    e.stopPropagation();
    togglePinTooltip(tooltip);
  });

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






// ============================================================
// 7. 외부 인터페이스
// ============================================================

if (typeof window !== 'undefined') {
  window.bupgogae = {
    renderPrecedentBadge,
    formatDecisionDate,
    decodeCourtName,
    buildFullCitation,
    getDecisionType,
  };
}
