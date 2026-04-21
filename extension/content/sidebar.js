/**
 * 법고개(Bupgogae) — Sidebar Viewer
 * ===================================================
 * 법제처 원문을 현재 웹페이지를 이탈하지 않고 보여주는 사이드바 뷰어 컴포넌트.
 * Shadow DOM으로 캡슐화되어 호스트 페이지의 CSS/JS와 충돌하지 않음.
 */

// ============================================================
// 1. CSS (우아한 다크/글래스모피즘 테마)
// ============================================================
const SIDEBAR_CSS = `
  :host {
    all: initial; /* 호스트 스타일 차단 */
  }



  .bgae-sidebar-container {
    position: fixed;
    top: 0;
    right: 0;
    transform: translateX(100%);
    width: var(--bgae-sidebar-width, 420px);
    max-width: 90vw;
    min-width: 300px;
    height: 100vh;
    background: rgba(15, 23, 42, 0.95); /* slate-900 */
    backdrop-filter: blur(12px);
    border-left: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: -10px 0 30px rgba(0, 0, 0, 0.5);
    z-index: 2147483647;
    color: #f8fafc; /* slate-50 */
    font-family: 'Pretendard', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    display: flex;
    flex-direction: column;
    transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    -webkit-user-select: text;
    user-select: text;
  }
  .bgae-sidebar-container.open {
    transform: translateX(0);
  }

  /* 사이즈 조절 핸들러 */
  .bgae-resizer {
    position: absolute;
    left: -3px;
    top: 0;
    width: 6px;
    height: 100%;
    cursor: ew-resize;
    z-index: 2147483648;
    background: transparent;
    transition: background 0.2s;
  }
  .bgae-resizer:hover, .bgae-resizer.active {
    background: rgba(56, 189, 248, 0.8); /* sky-400 */
  }

  .bgae-sidebar-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 20px 24px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(0, 0, 0, 0.2);
  }

  .bgae-sidebar-title {
    font-size: 18px;
    font-weight: 700;
    margin: 0;
    line-height: 1.4;
    color: #e2e8f0; /* slate-200 */
  }

  .bgae-sidebar-close {
    background: none;
    border: none;
    color: #94a3b8; /* slate-400 */
    font-size: 24px;
    cursor: pointer;
    padding: 4px;
    line-height: 1;
    border-radius: 4px;
    transition: all 0.2s;
  }
  .bgae-sidebar-close:hover {
    color: #fff;
    background: rgba(255, 255, 255, 0.1);
  }

  .bgae-sidebar-content {
    flex: 1;
    overflow-y: auto;
    padding: 24px;
    scrollbar-width: thin;
    scrollbar-color: #475569 transparent;
  }
  
  .bgae-sidebar-content::-webkit-scrollbar {
    width: 6px;
  }
  .bgae-sidebar-content::-webkit-scrollbar-track {
    background: transparent;
  }
  .bgae-sidebar-content::-webkit-scrollbar-thumb {
    background: #475569;
    border-radius: 3px;
  }

  .bgae-section {
    margin-bottom: 28px;
    animation: fadeIn 0.5s ease forwards;
  }

  .bgae-section-title {
    font-size: 13px;
    font-weight: 700;
    color: #38bdf8; /* sky-400 */
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .bgae-section-title::before {
    content: '';
    display: inline-block;
    width: 4px;
    height: 12px;
    background: #38bdf8;
    border-radius: 2px;
  }

  .bgae-section-body {
    font-size: 15px;
    line-height: 1.7;
    color: #cbd5e1; /* slate-300 */
    white-space: pre-wrap;
    word-break: keep-all;
  }

  /* 로딩 스피너 */
  .bgae-loader-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #94a3b8;
    gap: 16px;
  }
  .bgae-spinner {
    width: 36px;
    height: 36px;
    border: 3px solid rgba(255,255,255,0.1);
    border-top-color: #38bdf8;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  
  .bgae-error-msg {
    color: #f87171; /* red-400 */
    text-align: center;
    padding: 20px;
    background: rgba(248, 113, 113, 0.1);
    border-radius: 8px;
    border: 1px solid rgba(248, 113, 113, 0.2);
  }

  .bgae-footer-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    padding: 12px;
    margin-top: 16px;
    background: rgba(255,255,255,0.05);
    color: #94a3b8;
    text-decoration: none;
    border-radius: 6px;
    font-size: 13px;
    transition: all 0.2s;
  }
  .bgae-footer-link:hover {
    background: rgba(255,255,255,0.1);
    color: #fff;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* 텍스트 목사 안내 툴팁 */
  .bgae-copy-tooltip {
    position: absolute;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%) translateY(20px);
    background: rgba(56, 189, 248, 0.9); /* sky-400 */
    color: #0f172a;
    padding: 8px 16px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 600;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s, transform 0.3s;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 9999;
  }
  .bgae-copy-tooltip.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
`;

// ============================================================
// 2. 클래스 정의
// ============================================================

class BupgogaeSidebar {
  constructor() {
    this.hostElement = null;
    this.shadow = null;
    this.container = null;
    this.contentArea = null;
    this.headerTitle = null;
    this.isOpen = false;
  }

  init() {
    if (this.hostElement) return;

    // 1. 호스트 엘리먼트 생성
    this.hostElement = document.createElement('div');
    this.hostElement.id = 'bupgogae-sidebar-host';
    document.body.appendChild(this.hostElement);

    // 2. Shadow DOM 연결
    this.shadow = this.hostElement.attachShadow({ mode: 'closed' });

    // 3. 스타일 주입
    const style = document.createElement('style');
    style.textContent = SIDEBAR_CSS;
    this.shadow.appendChild(style);

    // 4. UI 뼈대 생성
    this.container = document.createElement('div');
    this.container.className = 'bgae-sidebar-container';

    // Header
    const header = document.createElement('div');
    header.className = 'bgae-sidebar-header';
    this.headerTitle = document.createElement('h2');
    this.headerTitle.className = 'bgae-sidebar-title';
    this.headerTitle.textContent = '판례 원문 조회';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'bgae-sidebar-close';
    closeBtn.innerHTML = '&times;'; // safe: 정적인 맵핑
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(this.headerTitle);
    header.appendChild(closeBtn);

    // Content Area
    this.contentArea = document.createElement('div');
    this.contentArea.className = 'bgae-sidebar-content';

    // Resizer (사이드바 드래그 핸들러)
    this.resizer = document.createElement('div');
    this.resizer.className = 'bgae-resizer';
    this.container.appendChild(this.resizer);

    this.container.appendChild(header);
    this.container.appendChild(this.contentArea);

    this.shadow.appendChild(this.container);

    // 이벤트 리스너: 사이즈 조절
    this.initResizer();

    // 이벤트 리스너: 순수 텍스트 복사 인터셉터
    this.initCopyInterceptor();

    // 저장된 사이즈 폭 불러오기
    chrome.storage.local.get('bupgogae_sidebar_width', (data) => {
      if (data.bupgogae_sidebar_width && !isNaN(data.bupgogae_sidebar_width)) {
        this.container.style.setProperty('--bgae-sidebar-width', data.bupgogae_sidebar_width + 'px');
      }
    });
  }

  open(url) {
    this.init();
    this.isOpen = true;
    
    // 강제 리플로(Reflow) 발생으로 트랜지션 트리거 확인
    void this.container.offsetWidth; 
    
    this.container.classList.add('open');
    
    this.showLoading();
    this.fetchAndParse(url);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.container.classList.remove('open');
  }

  showLoading() {
    this.headerTitle.textContent = '원문 불러오는 중...';
    this.contentArea.innerHTML = ` // safe: 정적인 로딩 UI
      <div class="bgae-loader-container">
        <div class="bgae-spinner"></div>
        <span>국가법령정보센터 연결 중...</span>
      </div>
    `;
  }

  initResizer() {
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    const onMouseMove = (e) => {
      if (!isResizing) return;
      // 오른쪽에서 열리므로 왼쪽 모서리 드래그 시 마우스가 왼쪽(-)으로 갈수록 너비가 커짐
      let newWidth = startWidth + (startX - e.clientX);
      
      const maxW = window.innerWidth * 0.9; // 최대 90vw
      if (newWidth < 300) newWidth = 300;     // 최소 300px
      if (newWidth > maxW) newWidth = maxW;

      this.container.style.setProperty('--bgae-sidebar-width', newWidth + 'px');
    };

    const onMouseUp = () => {
      if (!isResizing) return;
      isResizing = false;
      this.resizer.classList.remove('active');
      
      // iframe, 문서 텍스트 드래그 방지 해제 
      document.body.style.userSelect = '';
      
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      // 브라우저 Storage 에 현재 너비 고정 저장 (같은 기기에서 기억)
      const currentWidth = this.container.offsetWidth;
      chrome.storage.local.set({ bupgogae_sidebar_width: currentWidth });
    };

    this.resizer.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = this.container.offsetWidth;

      this.resizer.classList.add('active');
      
      // 드래그 중 내부 텍스트 선택되는 증상 방지
      document.body.style.userSelect = 'none';

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  initCopyInterceptor() {
    this.contentArea.addEventListener('copy', (e) => {
      // Shadow DOM 내부 선택 영역 획득 처리
      const selection = this.shadow.getSelection ? this.shadow.getSelection() : window.getSelection();
      let textToCopy = selection ? selection.toString() : '';

      // Fallback
      if (!textToCopy) {
        textToCopy = window.getSelection().toString();
      }

      if (textToCopy && textToCopy.trim().length > 0) {
        e.preventDefault(); // 기본 HTML/Rich Text 복사 동작 차단
        e.clipboardData.setData('text/plain', textToCopy);
        this.showCopyTooltip();
      }
    });
  }

  showCopyTooltip() {
    let existing = this.shadow.querySelector('.bgae-copy-tooltip');
    if (existing) existing.remove();

    const tooltip = document.createElement('div');
    tooltip.className = 'bgae-copy-tooltip';
    tooltip.textContent = '서식 없이 복사되었습니다';
    this.container.appendChild(tooltip);

    // 애니메이션 렌더링 강제 트리거
    void tooltip.offsetWidth;
    tooltip.classList.add('show');

    setTimeout(() => {
      tooltip.classList.remove('show');
      setTimeout(() => tooltip.remove(), 300);
    }, 2000);
  }

  showError(msg, url) {
    this.headerTitle.textContent = '조회 실패';
    this.contentArea.innerHTML = ` // safe: msg는 파싱 내부에서 안전하게 정규화됨
      <div class="bgae-error-msg">
        ${msg}
      </div>
      <a href="${url}" target="_blank" class="bgae-footer-link">브라우저 새 창에서 직접 열기 ↗</a>
    `;
  }

  /**
   * Background에 FETCH 요청 후 DOMParser로 파싱
   */
  async fetchAndParse(url) {
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'FETCH_LAW_HTML', url }, (res) => {
          resolve(res);
        });
      });

      if (response && response.error) {
        throw new Error(response.error);
      }
      if (!response || !response.html) {
        throw new Error("서버로부터 데이터를 가져올 수 없습니다.");
      }

      // 1. 가상 DOM 파싱 (XSS 차단)
      const parser = new DOMParser();
      const doc = parser.parseFromString(response.html, 'text/html');

      // 2. 셀렉터 가져오기 (R2 원격 설정 우선, 실패 시 기본값)
      const data = await chrome.storage.local.get('bupgogae_remote_adapters');
      const remoteConfig = data.bupgogae_remote_adapters?.scraping_adapters?.law_go_kr || {};
      
      const selectors = {
        title: remoteConfig.title_selector || '#contentBody > h2', 
        container: remoteConfig.body_container || '#conScroll',
        section_title: remoteConfig.section_title || 'h4',
        section_body: remoteConfig.section_body || 'p.pty4, p.pty4_dep1, h5, div.subtit1'
      };

      // 3. 제목 추출 (서브타이틀이 있다면 괄호 형태로 추가)
      const titleNode = doc.querySelector(selectors.title);
      let titleStr = titleNode ? titleNode.textContent.trim() : '판례 원문';
      const subTitleNode = doc.querySelector('div.subtit1');
      if (subTitleNode) {
          const subText = subTitleNode.textContent.trim();
          if (subText) titleStr += ` \n${subText}`;
      }
      
      // 4. 본문 파싱 (하위 항목 순회)
      let detailsHtml = '';
      const detailWrap = doc.querySelector(selectors.container);
      
      if (detailWrap) {
        // detailWrap 내부의 태그들을 순서대로 추출
        const elements = detailWrap.querySelectorAll(`${selectors.section_title}, ${selectors.section_body}`);
        
        for (const el of elements) {
          if (el.matches(selectors.section_title)) {
            const sectTitle = el.textContent.trim();
            if (sectTitle) detailsHtml += `<div class="bgae-section"><div class="bgae-section-title">${this._escapeHtml(sectTitle)}</div>`;
          } else if (el.matches(selectors.section_body)) {
            const desc = el.textContent.trim();
            if (desc) detailsHtml += `<div class="bgae-section-body">${this._escapeHtml(desc)}</div></div>`;
          }
        }
        
        // 구조화된 추출이 잘 되지 않았을 경우 통으로 텍스트 처리
        if (!detailsHtml) {
           detailsHtml = `<div class="bgae-section-body">${this._escapeHtml(detailWrap.textContent.trim())}</div>`;
        }
      } else {
         detailsHtml = `<div class="bgae-error-msg">본문을 파싱할 수 없는 페이지 구조입니다. (법제처 사이트 개편 가능성)</div>`;
      }

      // 4. 렌더링
      this.headerTitle.textContent = titleStr.replace(/<[^>]+>/g, ''); // 혹시 모를 태그 제거
      
      this.contentArea.innerHTML = ` // safe: detailsHtml 내부 데이터는 _escapeHtml 처리를 보장함
        ${detailsHtml}
        <a href="${url}" target="_blank" class="bgae-footer-link">브라우저 새 창에서 더 넓게 보기 ↗</a>
      `;

    } catch (err) {
      console.error('[bupgogae sidebar] Fetch error:', err);
      this.showError(err.message, url);
    }
  }

  /**
   * XSS 방어를 위한 HTML Escape (textContent로 읽었더라도 한 번 더 보호)
   */
  _escapeHtml(text) {
    if (!text) return '';
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, function(m) { return map[m]; });
  }
}

// 싱글톤 인스턴스 전역 노출
if (typeof window !== 'undefined') {
  window.bupgogae = window.bupgogae || {};
  
  let _sidebarInstance = null;
  window.bupgogae.openSidebar = (url) => {
    if (!_sidebarInstance) {
      _sidebarInstance = new BupgogaeSidebar();
    }
    _sidebarInstance.open(url);
  };
}
