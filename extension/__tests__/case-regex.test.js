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
