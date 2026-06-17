/**
 * case-regex.js 단위 테스트
 * ─────────────────────────
 * 사건번호 추출(extractCaseNumbers), Red 필터(validateCaseNumber),
 * 압축 키 변환(compressCaseKey)의 순수 로직을 검증한다.
 *
 * 실제 메타데이터(case_code_map)는 Service Worker에서 오므로,
 * __setMetaForTest 헬퍼로 대표적인 사건부호 셋을 주입해 테스트한다.
 */
const caseRegex = require('../content/case-regex.js');

const SAMPLE_CASE_CODE_MAP = {
  '다': 'Da',
  '가합': 'Gah',
  '도': 'Do',
  '두': 'Du',
  '헌가': 'Hga',
  '헌마': 'Hma',
};

const SAMPLE_COURT_CODE_MAP = { '대법원': 1, '서울고등법원': 2 };

describe('extractCaseNumbers', () => {
  afterEach(() => caseRegex.__resetMetaForTest());

  test('빈/비문자열 입력은 빈 배열 반환', () => {
    expect(caseRegex.extractCaseNumbers('')).toEqual([]);
    expect(caseRegex.extractCaseNumbers(null)).toEqual([]);
    expect(caseRegex.extractCaseNumbers(undefined)).toEqual([]);
    expect(caseRegex.extractCaseNumbers(42)).toEqual([]);
  });

  test('화이트리스트 모드: 등록된 사건부호만 매칭', () => {
    caseRegex.__setMetaForTest(SAMPLE_CASE_CODE_MAP, SAMPLE_COURT_CODE_MAP);
    const found = caseRegex.extractCaseNumbers('대법원 2015다6302 판결을 참고');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      raw: '2015다6302', year: '2015', code: '다', serial: '6302', type: 'court',
    });
  });

  test('화이트리스트 모드: 미등록 부호는 매칭 안 됨', () => {
    caseRegex.__setMetaForTest(SAMPLE_CASE_CODE_MAP, SAMPLE_COURT_CODE_MAP);
    // '부해'는 맵에 없음 → 추출되지 않아야 함
    const found = caseRegex.extractCaseNumbers('2020부해123 사건');
    expect(found).toHaveLength(0);
  });

  test('긴 부호 우선 매칭 (가합 > 가)', () => {
    caseRegex.__setMetaForTest(SAMPLE_CASE_CODE_MAP, SAMPLE_COURT_CODE_MAP);
    const found = caseRegex.extractCaseNumbers('서울중앙지법 2019가합12345');
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe('가합');
  });

  test('헌법재판소 부호는 type=constitutional', () => {
    caseRegex.__setMetaForTest(SAMPLE_CASE_CODE_MAP, SAMPLE_COURT_CODE_MAP);
    const found = caseRegex.extractCaseNumbers('헌재 2018헌마123');
    expect(found).toHaveLength(1);
    expect(found[0].type).toBe('constitutional');
  });

  test('중복 사건번호는 한 번만 추출', () => {
    caseRegex.__setMetaForTest(SAMPLE_CASE_CODE_MAP, SAMPLE_COURT_CODE_MAP);
    const found = caseRegex.extractCaseNumbers('2015다6302 그리고 또 2015다6302');
    expect(found).toHaveLength(1);
  });

  test('조세(조심) 사건번호는 더 이상 탐지하지 않는다 (DLC 제거)', () => {
    caseRegex.__setMetaForTest(SAMPLE_CASE_CODE_MAP, SAMPLE_COURT_CODE_MAP);
    // "중"은 화이트리스트에 없고 조세 전용 정규식도 제거됨 → 어떤 항목도 추출되지 않음
    const found = caseRegex.extractCaseNumbers('조심 2025중2548 결정');
    expect(found).toHaveLength(0);
    expect(found.some(f => f.type === 'tax')).toBe(false);
  });

  test('폴백 모드(메타 미로드): 범용 정규식으로 추출', () => {
    const found = caseRegex.extractCaseNumbers('2015다6302');
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe('다');
  });

  // ── M4: 연도 좌측 경계 (숫자열에 붙은 사건번호 오탐 차단) ──
  describe('M4: 연도 앞이 숫자면 매칭하지 않는다', () => {
    test('전화번호 뒤 사건부호는 매칭 안 됨 (화이트리스트)', () => {
      caseRegex.__setMetaForTest(SAMPLE_CASE_CODE_MAP, SAMPLE_COURT_CODE_MAP);
      // 010-1234-5678도1 → 과거엔 "78도1"로 오탐
      expect(caseRegex.extractCaseNumbers('전화 010-1234-5678도1')).toEqual([]);
    });

    test('전화번호 뒤 사건부호는 매칭 안 됨 (폴백)', () => {
      expect(caseRegex.extractCaseNumbers('전화 010-1234-5678도1')).toEqual([]);
    });

    test('4자리 비현실 연도(3015)가 2자리로 잘려 매칭되지 않음', () => {
      caseRegex.__setMetaForTest(SAMPLE_CASE_CODE_MAP, SAMPLE_COURT_CODE_MAP);
      // 과거엔 "15다1234"로 잘려 미래연도 Red를 우회
      expect(caseRegex.extractCaseNumbers('대법원 3015다1234')).toEqual([]);
    });

    test('정상 사건번호는 앞 경계(공백/괄호/문장시작)에서 그대로 매칭', () => {
      caseRegex.__setMetaForTest(SAMPLE_CASE_CODE_MAP, SAMPLE_COURT_CODE_MAP);
      expect(caseRegex.extractCaseNumbers('(2015다6302)')).toHaveLength(1);
      expect(caseRegex.extractCaseNumbers('2015다6302 참조')[0].raw).toBe('2015다6302');
      expect(caseRegex.extractCaseNumbers('99다1234 사건')[0].raw).toBe('99다1234');
    });
  });
});

describe('validateCaseNumber', () => {
  const currentYear = new Date().getFullYear();

  test('미래 연도는 invalid', () => {
    const r = caseRegex.validateCaseNumber({
      year: String(currentYear + 1), code: '다', serial: '1', type: 'court',
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/미래 연도/);
  });

  test('정상 연도는 valid', () => {
    const r = caseRegex.validateCaseNumber({
      year: '2015', code: '다', serial: '6302', type: 'court',
    });
    expect(r.valid).toBe(true);
    expect(r.reason).toBeNull();
  });

  test('법원: 1945년 미만은 invalid', () => {
    const r = caseRegex.validateCaseNumber({
      year: '1944', code: '다', serial: '1', type: 'court',
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/비현실적/);
  });

  test('일련번호 0은 invalid', () => {
    const r = caseRegex.validateCaseNumber({
      year: '2015', code: '다', serial: '0', type: 'court',
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/일련번호/);
  });

  test('2자리 연도 정규화: 99 → 1999 (valid)', () => {
    const r = caseRegex.validateCaseNumber({
      year: '99', code: '다', serial: '1', type: 'court',
    });
    expect(r.valid).toBe(true);
  });

  test('2자리 연도 정규화: 00 → 2000 (valid)', () => {
    const r = caseRegex.validateCaseNumber({
      year: '00', code: '다', serial: '1', type: 'court',
    });
    expect(r.valid).toBe(true);
  });
});

describe('validateCaseNumber — 연도 피벗 상대화(M3) + 헌재 floor(L2)', () => {
  afterEach(() => jest.useRealTimers());

  test('M3: 2030년에 "30다1"은 1930이 아니라 2030으로 해석되어 valid', () => {
    // 하드코딩 피벗(30)은 "30"을 영구히 1930(< 1945 court floor)으로 오인 → invalid.
    // 현재연도 기준 슬라이딩 윈도우는 2030 <= 2031 → 2030 → valid 여야 한다.
    jest.useFakeTimers().setSystemTime(new Date('2031-06-01T00:00:00Z'));
    const r = caseRegex.validateCaseNumber({
      year: '30', code: '다', serial: '1', type: 'court',
    });
    expect(r.valid).toBe(true);
  });

  test('M3: 2자리 연도는 현재연도를 넘기지 않도록 직전 세기로 해석 (미래 방지)', () => {
    // 2026년에 "27" → 2027(미래)이 아니라 1927로 해석. 1927 < 1945 → court invalid.
    jest.useFakeTimers().setSystemTime(new Date('2026-06-01T00:00:00Z'));
    const r = caseRegex.validateCaseNumber({
      year: '27', code: '다', serial: '1', type: 'court',
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/비현실적/);
  });

  test('M3: 현재연도 2자리(예: 2026의 "26")는 현 세기로 해석되어 valid', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-01T00:00:00Z'));
    const r = caseRegex.validateCaseNumber({
      year: '26', code: '다', serial: '1', type: 'court',
    });
    expect(r.valid).toBe(true);
  });

  test('L2: 헌재 사건은 1988년 미만이면 invalid (헌법재판소 1988 설립)', () => {
    const r = caseRegex.validateCaseNumber({
      year: '1987', code: '헌마', serial: '1', type: 'constitutional',
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/비현실적/);
  });

  test('L2: 헌재 1988년은 valid (경계)', () => {
    const r = caseRegex.validateCaseNumber({
      year: '1988', code: '헌마', serial: '1', type: 'constitutional',
    });
    expect(r.valid).toBe(true);
  });

  test('L2: 법원 사건은 헌재 floor의 영향을 받지 않는다 (1945~1987 valid)', () => {
    const r = caseRegex.validateCaseNumber({
      year: '1987', code: '다', serial: '1', type: 'court',
    });
    expect(r.valid).toBe(true);
  });
});

describe('compressCaseKey', () => {
  afterEach(() => caseRegex.__resetMetaForTest());

  test('메타 미로드 시 null', () => {
    expect(caseRegex.compressCaseKey({
      year: '2015', code: '다', serial: '6302', type: 'court',
    })).toBeNull();
  });

  test('법원 사건: 로마자 압축', () => {
    caseRegex.__setMetaForTest(SAMPLE_CASE_CODE_MAP, SAMPLE_COURT_CODE_MAP);
    expect(caseRegex.compressCaseKey({
      year: '2015', code: '다', serial: '6302', type: 'court',
    })).toBe('15Da6302');
  });

  test('4자리/2자리 연도 모두 뒤 2자리로 압축', () => {
    caseRegex.__setMetaForTest(SAMPLE_CASE_CODE_MAP, SAMPLE_COURT_CODE_MAP);
    expect(caseRegex.compressCaseKey({
      year: '99', code: '다', serial: '1', type: 'court',
    })).toBe('99Da1');
  });

  test('맵에 없는 부호는 null', () => {
    caseRegex.__setMetaForTest(SAMPLE_CASE_CODE_MAP, SAMPLE_COURT_CODE_MAP);
    expect(caseRegex.compressCaseKey({
      year: '2015', code: '없는부호', serial: '1', type: 'court',
    })).toBeNull();
  });
});
