/**
 * bupgogae-content.js — 주황 토스트 + 복사 버튼 단위 테스트
 * ========================================================
 * Alt+C 단축키가 일부 서비스에서 가로채일 수 있어, 주황(미확인) 토스트에 복사
 * 버튼과 닫기(×) 버튼을 둔다. 버튼 클릭은 user activation이라 클립보드가 안정적.
 */
require('../content/case-regex.js');
require('../content/precedent-badge.js');
const content = require('../content/bupgogae-content.js');

/** 주황 배지 DOM을 메시지 컨테이너 안에 심는다. */
function seedOrangeBadges(cases) {
  const article = document.createElement('article');
  for (const c of cases) {
    const span = document.createElement('span');
    span.className = 'bgae-badge bgae-orange';
    span.setAttribute('data-bgae-case', c);
    span.textContent = c;
    article.appendChild(span);
  }
  document.body.appendChild(article);
  return article;
}

beforeEach(() => {
  document.body.innerHTML = '';
  content.__resetForTest(); // _hasShownOrangeToast 초기화
  // 클립보드 모킹 (jsdom 기본 미제공)
  const writeText = jest.fn(() => Promise.resolve());
  global.navigator.clipboard = { writeText };
  global.__writeText = writeText;
});

describe('collectOrangeCases', () => {
  test('주황 배지를 중복 없이 수집', () => {
    seedOrangeBadges(['2015다6302', '2020두1234', '2015다6302']);
    expect(content.collectOrangeCases().sort()).toEqual(['2015다6302', '2020두1234']);
  });

  test('주황 배지가 없으면 빈 배열', () => {
    expect(content.collectOrangeCases()).toEqual([]);
  });
});

describe('copyOrangeCases', () => {
  test('수집된 사건번호를 클립보드 문구로 복사', async () => {
    seedOrangeBadges(['2015다6302', '2020두1234']);
    const res = await content.copyOrangeCases();
    expect(res.count).toBe(2);
    expect(global.__writeText).toHaveBeenCalledTimes(1);
    expect(global.__writeText.mock.calls[0][0]).toContain('2015다6302');
    expect(global.__writeText.mock.calls[0][0]).toContain('2020두1234');
  });

  test('주황이 없으면 count:0, 클립보드 미호출', async () => {
    const res = await content.copyOrangeCases();
    expect(res.count).toBe(0);
    expect(global.__writeText).not.toHaveBeenCalled();
  });
});

describe('showOrangeToast', () => {
  afterEach(() => jest.useRealTimers());

  test('메시지 + 복사 버튼 + 닫기 버튼을 렌더하고 클릭 가능하다', () => {
    const toast = () => document.querySelector('.bgae-orange-toast');
    content.showOrangeToast();

    const el = toast();
    expect(el).not.toBeNull();
    expect(el.style.pointerEvents).toBe('auto'); // 버튼 클릭 가능
    const buttons = el.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain('복사');
    expect(buttons[1].getAttribute('aria-label')).toBe('닫기');
    // Alt+C 안내 문구는 제거됨 (버튼으로 대체)
    expect(el.textContent).not.toContain('Alt+C');
  });

  test('복사 버튼 클릭 시 주황 사건번호를 복사한다', async () => {
    seedOrangeBadges(['2015다6302']);
    content.showOrangeToast();
    const copyBtn = document.querySelector('.bgae-orange-toast button');
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 0)); // 클립보드 .then 체인 flush
    expect(global.__writeText).toHaveBeenCalledTimes(1);
    expect(copyBtn.textContent).toContain('복사됨');
  });

  test('닫기 버튼 클릭 시 토스트를 제거한다', () => {
    jest.useFakeTimers();
    content.showOrangeToast();
    const el = document.querySelector('.bgae-orange-toast');
    const closeBtn = el.querySelectorAll('button')[1];
    closeBtn.click();
    jest.advanceTimersByTime(400); // 페이드아웃(300ms) 경과
    expect(document.querySelector('.bgae-orange-toast')).toBeNull();
  });

  test('세션당 1회만 노출', () => {
    content.showOrangeToast();
    content.showOrangeToast();
    expect(document.querySelectorAll('.bgae-orange-toast')).toHaveLength(1);
  });

  test('팝업 표시 설정이 OFF면 토스트를 만들지 않는다', () => {
    content.__setShowOrangeToastForTest(false);
    content.showOrangeToast();
    expect(document.querySelector('.bgae-orange-toast')).toBeNull();
  });

  test('자동 닫힘은 5초', () => {
    jest.useFakeTimers();
    content.showOrangeToast();
    jest.advanceTimersByTime(4000);
    expect(document.querySelector('.bgae-orange-toast')).not.toBeNull(); // 4초엔 살아있음
    jest.advanceTimersByTime(1000 + 300);                                // 5초 + 페이드
    expect(document.querySelector('.bgae-orange-toast')).toBeNull();
  });

  test('복사 성공 후 3초 뒤 스르륵 닫힌다', async () => {
    jest.useFakeTimers();
    seedOrangeBadges(['2015다6302']);
    content.showOrangeToast();
    const copyBtn = document.querySelector('.bgae-orange-toast button');
    copyBtn.click();
    await jest.advanceTimersByTimeAsync(0); // 클립보드 .then flush → '복사됨' + 3초 타이머 설정
    expect(copyBtn.textContent).toContain('복사됨');
    expect(document.querySelector('.bgae-orange-toast')).not.toBeNull();
    await jest.advanceTimersByTimeAsync(3000 + 300); // 3초 후 닫힘 + 페이드
    expect(document.querySelector('.bgae-orange-toast')).toBeNull();
  });
});
