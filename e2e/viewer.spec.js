/**
 * 법고개(Bupgogae) — Intelligent Document Reader E2E 시나리오
 * ==============================================================
 * 확장프로그램 페이지(chrome-extension://<ID>/viewer/viewer.html)에 대한
 * 핵심 사용자 플로우 검증:
 *
 *   0. 확장 ID 동적 획득 (헬퍼 자체 검증)
 *   1. 3단 레이아웃 초기 렌더링
 *   2. 파일 업로드(setInputFiles) → 파싱 → 원문/목차/사건 칩 렌더링
 *   3. 파일 드래그 & 드롭 시뮬레이션 (.txt)
 *   4. 사건번호 칩 클릭 → 로딩 스피너 → 법제처 요청 감시 → 상세 패널 삽입
 *   5. 파일 초기화 버튼 → 드롭존 복귀
 *
 * 법제처(law.go.kr) 및 R2(api.bup.live) 트래픽은 fixtures.js에서 모킹되어
 * 네트워크 없이 결정적으로 실행된다.
 */

const {
  test,
  expect,
  buildSearchResultHtml,
  buildPrecDetailHtml,
} = require('./fixtures');

// ============================================================
// 테스트용 문서 콘텐츠
// ============================================================

/** Markdown 픽스쳐 — 제목 2개(→ TOC), 유효 사건번호 2건 포함 */
const SAMPLE_MD = [
  '# 사건 개요',
  '',
  '원고는 대법원 2015다6302 판결을 주된 근거로 인용하였다.',
  '',
  '## 쟁점 정리',
  '',
  '피고는 대법원 2022다266874 판결이 본건과 직접 관련된 선례라고 주장한다.',
].join('\n');

/** TXT 픽스쳐 — 제목 없음(→ TOC 미생성), 사건번호 1건 */
const SAMPLE_TXT = [
  '국가배상 사건 검토 메모',
  '대법원 2015다6302 판결의 법리를 참조할 것.',
  '이상.',
].join('\n');

/** SAMPLE_MD를 setInputFiles로 업로드하고 파싱 완료까지 대기하는 헬퍼 */
async function uploadMarkdown(viewerPage, name = 'sample.md') {
  await viewerPage.locator('#fileInput').setInputFiles({
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from(SAMPLE_MD, 'utf-8'),
  });
  // 파싱 완료 신호: 원문 영역에 본문 텍스트가 나타남
  await expect(viewerPage.locator('#contentRendered')).toContainText('원고는');
}

// ============================================================
// 0. 헬퍼 검증 — 확장 ID 동적 획득
// ============================================================

test('확장프로그램 ID를 Service Worker에서 동적으로 획득한다', async ({ extensionId, viewerPage }) => {
  // Chrome 확장 ID는 a-p 32자
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  expect(viewerPage.url()).toBe(`chrome-extension://${extensionId}/viewer/viewer.html`);
});

// ============================================================
// 1. 뷰어 초기 렌더링
// ============================================================

test('초기 진입 시 3단 패널과 placeholder가 올바르게 렌더링된다', async ({ viewerPage }) => {
  // 상단 툴바
  await expect(viewerPage.locator('.toolbar-title')).toHaveText('Intelligent Document Reader');
  await expect(viewerPage.locator('#toolbarFilename')).toHaveText('파일을 드래그하여 업로드하세요');

  // 좌측: 목차 패널
  await expect(viewerPage.locator('#panelToc')).toBeVisible();
  await expect(viewerPage.locator('#tocBody .panel-placeholder')).toContainText('문서를 업로드하면');

  // 중앙: 원문 패널 — 드롭존이 초기 상태로 노출
  await expect(viewerPage.locator('#panelContent')).toBeVisible();
  await expect(viewerPage.locator('#dropzone')).toBeVisible();
  await expect(viewerPage.locator('.dropzone-title')).toHaveText('파일을 여기에 드래그 & 드롭');
  await expect(viewerPage.locator('.dropzone-subtitle')).toContainText('PDF, DOCX, HWPX, MD, TXT');
  await expect(viewerPage.locator('#contentRendered')).toBeHidden();

  // 우측: 판례 상세 패널
  await expect(viewerPage.locator('#panelDetail')).toBeVisible();
  await expect(viewerPage.locator('#detailBody .panel-placeholder')).toContainText('사건번호를 클릭하면');

  // 좌-중 / 중-우 리사이저
  await expect(viewerPage.locator('#resizerLeft')).toBeVisible();
  await expect(viewerPage.locator('#resizerRight')).toBeVisible();
});

// ============================================================
// 2. 파일 업로드 → 파싱 → 원문/목차 렌더링
// ============================================================

test('MD 파일 업로드 시 원문이 표시되고 목차(TOC)가 자동 생성된다', async ({ viewerPage }) => {
  await uploadMarkdown(viewerPage, 'sample.md');

  // 로딩 인디케이터는 파싱 완료와 함께 사라짐
  await expect(viewerPage.locator('#contentRendered .loading-indicator')).toHaveCount(0);

  // 툴바: 파일명 + 추출 통계
  await expect(viewerPage.locator('#toolbarFilename')).toHaveText('sample.md');
  await expect(viewerPage.locator('#toolbarStats')).toHaveText('추출된 사건: 2건');

  // 중앙: 드롭존이 사라지고 원문이 렌더링됨
  await expect(viewerPage.locator('#dropzone')).toBeHidden();
  await expect(viewerPage.locator('#contentRendered')).toBeVisible();
  await expect(viewerPage.locator('#contentRendered h1')).toHaveText('사건 개요');

  // 좌측: 제목(h1/h2)으로부터 TOC 아이템 2개 자동 생성
  const tocItems = viewerPage.locator('#tocBody .toc-item');
  await expect(tocItems).toHaveCount(2);
  await expect(tocItems.nth(0)).toHaveText('사건 개요');
  await expect(tocItems.nth(1)).toHaveText('쟁점 정리');

  // 본문 내 사건번호가 칩(mark.case-chip)으로 하이라이트됨
  const chips = viewerPage.locator('#contentRendered .case-chip');
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toHaveText('2015다6302');
  await expect(chips.nth(0)).toHaveAttribute('data-case', '15Da6302');
  await expect(chips.nth(1)).toHaveAttribute('data-case', '22Da266874');

  // TOC 클릭 → 해당 제목으로 스크롤 + active 클래스 동기화
  await tocItems.nth(1).click();
  await expect(tocItems.nth(1)).toHaveClass(/active/);
});

// ============================================================
// 3. 파일 드래그 & 드롭 시뮬레이션
// ============================================================

test('TXT 파일 드래그 & 드롭 시 오버레이가 뜨고 본문이 파싱된다', async ({ viewerPage }) => {
  // 페이지 컨텍스트에서 File을 담은 DataTransfer 생성
  const dataTransfer = await viewerPage.evaluateHandle((content) => {
    const dt = new DataTransfer();
    dt.items.add(new File([content], 'memo.txt', { type: 'text/plain' }));
    return dt;
  }, SAMPLE_TXT);

  // 드래그 진입 → 전체 화면 오버레이 표시
  await viewerPage.dispatchEvent('body', 'dragenter', { dataTransfer });
  await expect(viewerPage.locator('#dragOverlay')).toHaveClass(/visible/);

  // 드롭 → 오버레이 해제 + 파싱 시작
  await viewerPage.dispatchEvent('#dropzone', 'drop', { dataTransfer });
  await expect(viewerPage.locator('#dragOverlay')).not.toHaveClass(/visible/);

  // 파싱 결과: 원문 텍스트 + 사건 1건 추출
  await expect(viewerPage.locator('#contentRendered')).toContainText('국가배상 사건 검토 메모');
  await expect(viewerPage.locator('#toolbarFilename')).toHaveText('memo.txt');
  await expect(viewerPage.locator('#toolbarStats')).toHaveText('추출된 사건: 1건');
  await expect(viewerPage.locator('#contentRendered .case-chip')).toHaveText('2015다6302');

  // TXT는 제목이 없으므로 TOC는 빈 상태 안내 노출
  await expect(viewerPage.locator('#tocBody .panel-placeholder')).toContainText('추출된 목차가 없습니다');
});

// ============================================================
// 4. 사건번호 칩 클릭 → 법제처 조회 → 우측 상세 패널
// ============================================================

test('사건 칩 클릭 시 스피너 후 법제처 응답이 상세 패널에 삽입된다', async ({ context, viewerPage }) => {
  await uploadMarkdown(viewerPage);

  // 파싱 직후 첫 번째 사건(15Da6302)이 자동 선택·조회되므로,
  // 클릭 시나리오는 "두 번째" 사건 칩으로 검증한다.
  // 자동 조회(기본 모킹)가 끝나 상세 패널이 안정화될 때까지 대기.
  await expect(viewerPage.locator('#detailBody')).toContainText('판시사항');

  // ── 법제처 요청 감시 + 지연 모킹 (fixtures의 기본 라우트를 오버라이드) ──
  // Service Worker(db-sync.js)가 보내는 fetch까지 가로채려면
  // page.route()가 아닌 context.route()를 써야 한다.
  const lawRequests = [];
  await context.route('https://www.law.go.kr/**', async (route) => {
    const url = route.request().url();
    lawRequests.push(url);

    if (url.includes('/precSc.do')) {
      // 스피너가 화면에 머무를 시간을 확보하기 위한 인위적 지연
      await new Promise((r) => setTimeout(r, 500));
      return route.fulfill({
        contentType: 'text/html',
        body: buildSearchResultHtml('235282', '대법원 2022다266874 판결'),
      });
    }
    if (url.includes('/precInfoP.do')) {
      return route.fulfill({
        contentType: 'text/html',
        body: buildPrecDetailHtml('피고의 손해배상 책임이 인정된다고 본 사례.'),
      });
    }
    return route.fulfill({ contentType: 'text/html', body: '<html></html>' });
  });

  // ── 두 번째 사건 칩 클릭 ──
  const secondChip = viewerPage.locator('.case-chip[data-case="22Da266874"]');
  await secondChip.click();

  // 1) 클릭된 칩이 포커스(focused) 상태가 됨
  await expect(secondChip).toHaveClass(/focused/);

  // 2) 우측 패널에 로딩 스피너 표시
  await expect(viewerPage.locator('#detailBody .loading-spinner')).toBeVisible();
  await expect(viewerPage.locator('#detailBody')).toContainText('판례 정보를 가져오는 중');

  // 3) 모의 법제처 응답 본문이 우측 패널에 최종 삽입됨
  await expect(viewerPage.locator('#detailBody')).toContainText(
    '피고의 손해배상 책임이 인정된다고 본 사례.',
  );
  await expect(viewerPage.locator('#detailBody .loading-spinner')).toHaveCount(0);

  // 4) 네트워크 감시: 검색(precSc.do, 사건번호 쿼리 포함) → 상세(precInfoP.do) 순서로 요청됨
  expect(lawRequests.some(
    (u) => u.includes('/precSc.do') && u.includes(encodeURIComponent('2022다266874')),
  )).toBe(true);
  expect(lawRequests.some(
    (u) => u.includes('/precInfoP.do') && u.includes('precSeq=235282'),
  )).toBe(true);
});

// ============================================================
// 5. 파일 초기화 — 드롭존 복귀
// ============================================================

test('초기화 버튼 클릭 시 드롭존과 placeholder 상태로 복귀한다', async ({ viewerPage }) => {
  await uploadMarkdown(viewerPage);

  const resetBtn = viewerPage.locator('#btnResetFile');
  await expect(resetBtn).toBeVisible();
  await resetBtn.click();

  // 중앙: 원문이 사라지고 드롭존 복귀
  await expect(viewerPage.locator('#contentRendered')).toBeHidden();
  await expect(viewerPage.locator('#dropzone')).toBeVisible();

  // 툴바/좌/우 패널 모두 초기 placeholder로 복원
  await expect(viewerPage.locator('#toolbarFilename')).toHaveText('파일을 드래그하여 업로드하세요');
  await expect(viewerPage.locator('#toolbarStats')).toHaveText('');
  await expect(viewerPage.locator('#tocBody .panel-placeholder')).toContainText('문서를 업로드하면');
  await expect(viewerPage.locator('#detailBody .panel-placeholder')).toContainText('사건번호를 클릭하면');
});
