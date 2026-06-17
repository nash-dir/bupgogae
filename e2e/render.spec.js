/**
 * 법고개(Bupgogae) — 인라인 배지 렌더링 E2E (M2: 다중 매칭/한 텍스트노드)
 * ====================================================================
 * 회귀 명세: 모델이 사건번호를 "한 줄에 하나씩" 출력하면 마크다운 렌더러에 따라
 * 여러 사건번호가 하나의 텍스트노드(개행 \n 구분) 안에 들어간다(예: Gemini).
 * 이때 첫 배지를 그리며 텍스트노드가 분할/detach되면 나머지 매칭의 노드 참조가
 * 무효화되어 한 처리 사이클에 1개만 배지된다(M2). settle(정지 후 처리)과 곱해져
 * 모든 배지가 뜨기까지 매우 오래 걸린다 → "엄청 늦게".
 *
 * 목표: 한 텍스트노드 안 N개 매칭이 단일 처리 사이클에 전부 배지되어야 한다.
 */
const { test, expect } = require('./fixtures');

// 법원/헌재 8종 (조세 제외). 일부는 Red(미래/헌재<1988/일련번호0), 일부는 조회 대상.
const CASES = [
  '2015다6302', '2020두1234', '99다1234', '2099다1',
  '2030다1', '1987헌마1', '1988헌마1', '2015다0',
];

/** Gemini형 응답 페이지. oneNode=true면 8종이 한 텍스트노드(개행 구분). */
function geminiPage(oneNode) {
  const inner = oneNode
    ? `<div class="resp">${CASES.join('\n')}</div>`            // 한 텍스트노드
    : CASES.map((c) => `<p class="resp">${c}</p>`).join('');    // 사건번호별 분리 노드
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>`
    + `<body><main><message-content>${inner}</message-content></main></body></html>`;
}

async function routeGemini(context, oneNode) {
  await context.route('https://gemini.google.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: geminiPage(oneNode) }));
}

test('R1: 한 텍스트노드 내 다중 사건번호가 단일 사이클에 전부 배지된다 (M2)', async ({ context }) => {
  await routeGemini(context, true);
  const page = await context.newPage();
  await page.goto('https://gemini.google.com/');

  // settle(2s) + 처리 여유. 현재 구현(M2): 1개만 배지되고 멈춤 → 타임아웃(Red).
  // 목표 구현: 한 사이클에 8개 전부 배지(Green).
  await expect
    .poll(() => page.locator('.bgae-badge').count(), { timeout: 20_000, intervals: [500] })
    .toBe(CASES.length);
});

test('R2: 사건번호별 분리 노드는 정상 배지된다 (M2 미해당 — 대조군)', async ({ context }) => {
  await routeGemini(context, false);
  const page = await context.newPage();
  await page.goto('https://gemini.google.com/');

  await expect
    .poll(() => page.locator('.bgae-badge').count(), { timeout: 20_000, intervals: [500] })
    .toBe(CASES.length);
});
