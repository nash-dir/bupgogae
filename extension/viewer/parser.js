/**
 * 법고개(Bupgogae) — 오프라인 파일 파서 모듈 (Phase 2)
 * ========================================================
 * 각 포맷(DOCX, PDF, HWPX, MD, TXT)의 파일을 파싱하여
 * 1. HTML 형태의 원문(contentHtml)
 * 2. 계층형 목차(toc)
 * 3. 사건번호 추출 정보(cases)를 반환한다.
 */

// PDF.js 워커 설정
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
}

/**
 * HTML 문자열에서 목차(TOC) 배열을 추출.
 * <h1>, <h2>, <h3> 태그를 찾아 계층화한다.
 */
function extractTocFromHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const headings = doc.querySelectorAll('h1, h2, h3');
  const toc = [];
  
  headings.forEach((heading, index) => {
    const level = parseInt(heading.tagName.substring(1), 10);
    const id = `toc-heading-${index}`;
    heading.id = id; // HTML에 ID 부여 (치환을 위해 원본 HTML도 수정 필요하지만 여기서는 간소화)
    toc.push({ level, text: heading.textContent.trim() || '(제목 없음)', id });
  });

  return { toc, updatedHtml: doc.body.innerHTML };
}

/**
 * 텍스트 또는 HTML에서 사건번호를 찾아 하이라이트 치환하고 배열 반환.
 */
function highlightCasesInHtml(html) {
  if (!window.bupgogaeCaseRegex) {
    console.warn('[parser] case-regex 모듈이 로드되지 않았습니다.');
    return { finalHtml: html, cases: [] };
  }

  // 1. 순수 텍스트 추출 (정규식 매칭을 위함)
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const rawText = doc.body.textContent || '';

  // 2. 사건번호 추출
  const extracted = window.bupgogaeCaseRegex.extractCaseNumbers(rawText);
  
  // 3. 중복 제거 및 유효성 검사
  const uniqueCasesMap = new Map();
  extracted.forEach(item => {
    const validation = window.bupgogaeCaseRegex.validateCaseNumber(item);
    if (!validation.valid) return; // Red 필터 통과 실패
    
    const compressed = window.bupgogaeCaseRegex.compressCaseKey(item);
    if (compressed && !uniqueCasesMap.has(item.raw)) {
      uniqueCasesMap.set(item.raw, { ...item, compressed });
    }
  });

  const cases = Array.from(uniqueCasesMap.values());

  if (cases.length === 0) {
    return { finalHtml: html, cases };
  }

  // 4. 안전한 DOM 기반 하이라이트 치환 (TreeWalker 사용)
  // 긴 패턴이 복합 정규식에서 앞에 와야 하위 패턴이 먼저 매칭되는 것을 방지함
  const sortedRaw = cases.map(c => c.raw).sort((a, b) => b.length - a.length);
  const compositeRegex = new RegExp(sortedRaw.map(escapeRegExp).join('|'), 'g');

  const textNodes = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null, false);
  let node;
  while ((node = walker.nextNode())) {
    // 이미 하이라이트된 case-chip 내부 텍스트 노드는 제외
    let parent = node.parentElement;
    let isInsideChip = false;
    while (parent) {
      if (parent.classList && parent.classList.contains('case-chip')) {
        isInsideChip = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (!isInsideChip) {
      textNodes.push(node);
    }
  }

  // 역순으로 처리하는 것이 부모 인덱스 유지 관리에 유리할 수 있으나,
  // insertBefore 대체 형식이므로 정방향으로 수행해도 안전
  textNodes.forEach(tNode => {
    const text = tNode.nodeValue;
    compositeRegex.lastIndex = 0;
    
    let match;
    const fragments = [];
    let lastIdx = 0;

    while ((match = compositeRegex.exec(text)) !== null) {
      const rawMatch = match[0];
      const startIdx = match.index;

      if (startIdx > lastIdx) {
        fragments.push(doc.createTextNode(text.substring(lastIdx, startIdx)));
      }

      const caseObj = cases.find(c => c.raw === rawMatch);
      if (caseObj) {
        const mark = doc.createElement('mark');
        mark.className = 'case-chip unverified';
        mark.setAttribute('data-case', caseObj.compressed);
        mark.setAttribute('data-raw', caseObj.raw);
        mark.textContent = rawMatch;
        fragments.push(mark);
      } else {
        fragments.push(doc.createTextNode(rawMatch));
      }

      lastIdx = compositeRegex.lastIndex;
    }

    if (fragments.length > 0) {
      if (lastIdx < text.length) {
        fragments.push(doc.createTextNode(text.substring(lastIdx)));
      }

      const parent = tNode.parentNode;
      if (parent) {
        fragments.forEach(frag => {
          parent.insertBefore(frag, tNode);
        });
        parent.removeChild(tNode);
      }
    }
  });

  return { finalHtml: doc.body.innerHTML, cases };
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * DOCX 파싱
 */
async function parseDocx(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer });
  let html = result.value || '<p>(내용 없음)</p>';
  
  const { toc, updatedHtml } = extractTocFromHtml(html);
  const { finalHtml, cases } = highlightCasesInHtml(updatedHtml);
  
  return { toc, contentHtml: finalHtml, cases };
}

/**
 * PDF 파싱
 */
async function parsePdf(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let html = '';
  const toc = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    
    let pageText = '';
    let lastY = null;

    content.items.forEach(item => {
      // 공백 노드 건너뛰기
      if (!item.str || item.str.trim() === '') return;
      
      const currentY = item.transform[5];
      
      if (lastY !== null) {
        // Y 좌표 변화량 절대값이 5보다 크면 행바꿈(개행) 적용
        if (Math.abs(currentY - lastY) > 5) {
          pageText += '\n';
        }
      }
      
      pageText += item.str;
      lastY = currentY;
    });

    const pageId = `pdf-page-${i}`;
    toc.push({ level: 1, text: `Page ${i}`, id: pageId });
    
    // 줄바꿈 기준으로 문단 구성
    const paragraphsHtml = pageText.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => `<p>${escapeHtmlParser(line)}</p>`)
      .join('');

    html += `<h2 id="${pageId}">Page ${i}</h2><div class="pdf-page-content">${paragraphsHtml}</div>`;
  }

  const { finalHtml, cases } = highlightCasesInHtml(html);
  return { toc, contentHtml: finalHtml, cases };
}

/**
 * HWPX 파싱 (JSZip 이용, section0.xml 등 파싱)
 */
async function parseHwpx(file) {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  
  let html = '';
  // HWPX는 Contents/section0.xml, section1.xml ... 에 본문이 있음
  // 단순화를 위해 모든 section*.xml을 찾아서 파싱
  const sectionFiles = Object.keys(zip.files).filter(name => name.match(/^Contents\/section\d+\.xml$/));
  
  for (const filename of sectionFiles.sort()) {
    const xmlText = await zip.file(filename).async('text');
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
    
    let paragraphs = [];
    if (typeof xmlDoc.getElementsByTagNameNS === 'function') {
      paragraphs = xmlDoc.getElementsByTagNameNS('*', 'p');
    } else {
      const rawPs = xmlDoc.getElementsByTagName('hp:p');
      paragraphs = rawPs.length > 0 ? rawPs : xmlDoc.getElementsByTagName('p');
    }

    for (let i = 0; i < paragraphs.length; i++) {
      const pNode = paragraphs[i];
      let texts = [];
      if (typeof pNode.getElementsByTagNameNS === 'function') {
        texts = pNode.getElementsByTagNameNS('*', 't');
      } else {
        const rawTs = pNode.getElementsByTagName('hp:t');
        texts = rawTs.length > 0 ? rawTs : pNode.getElementsByTagName('t');
      }
      
      let pText = '';
      for (let j = 0; j < texts.length; j++) {
        pText += texts[j].textContent;
      }
      if (pText.trim()) {
        html += `<p>${escapeHtmlParser(pText)}</p>`;
      }
    }
  }

  if (!html) html = '<p>(내용을 추출할 수 없습니다)</p>';
  
  const { finalHtml, cases } = highlightCasesInHtml(html);
  // HWPX TOC는 단순화
  return { toc: [], contentHtml: finalHtml, cases };
}

/**
 * Markdown 파싱
 */
async function parseMarkdown(file) {
  const text = await file.text();
  const html = marked.parse(text);
  
  const { toc, updatedHtml } = extractTocFromHtml(html);
  const { finalHtml, cases } = highlightCasesInHtml(updatedHtml);
  
  return { toc, contentHtml: finalHtml, cases };
}

/**
 * TXT 파싱
 */
async function parseTxt(file) {
  const text = await file.text();
  const html = text.split('\n').map(line => `<p>${escapeHtmlParser(line)}</p>`).join('');
  const { finalHtml, cases } = highlightCasesInHtml(html);
  return { toc: [], contentHtml: finalHtml, cases };
}

function escapeHtmlParser(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * 메인 엔트리포인트
 */
window.parseDocument = async function(file) {
  // 메타데이터 초기화 대기 (정규식 엔진 준비)
  if (window.bupgogaeCaseRegex && !window.bupgogaeCaseRegex.isMetaReady()) {
    await window.bupgogaeCaseRegex.initMeta();
  }

  const ext = file.name.split('.').pop().toLowerCase();
  
  try {
    switch (ext) {
      case 'docx': return await parseDocx(file);
      case 'pdf': return await parsePdf(file);
      case 'hwpx': return await parseHwpx(file);
      case 'md':
      case 'markdown': return await parseMarkdown(file);
      case 'txt': return await parseTxt(file);
      default:
        throw new Error('지원하지 않는 포맷입니다.');
    }
  } catch (err) {
    console.error('파싱 오류:', err);
    throw err;
  }
};
