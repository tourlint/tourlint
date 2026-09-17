import { describe, expect, it } from 'vitest';
import { FINGERPRINT_FIELDS, KTO_FIELD_LABEL, ktoFieldLabel } from './constants';

describe('판정 필드 이름표 (#475)', () => {
  it('🔴 판정 필드에 이름표가 빠진 것이 없다 — 빠지면 그 필드가 다시 코드로 찍힌다', () => {
    const missing = Object.values(FINGERPRINT_FIELDS)
      .flat()
      .filter((name) => !(name in KTO_FIELD_LABEL));
    expect(missing).toEqual([]);
  });

  it('🔴 리포트가 따로 넣는 modifiedtime 도 이름표가 있다', () => {
    // 근거 표는 `FINGERPRINT_FIELDS` 밖에서 이 한 줄을 더 붙인다 (report-render)
    expect(ktoFieldLabel('modifiedtime')).toBe('공사 최종 수정일');
  });

  it('모르는 필드는 이름 그대로 — 이름이 없다고 근거를 숨기지 않는다', () => {
    expect(ktoFieldLabel('spendtime')).toBe('spendtime');
  });

  it('유형이 갈려도 사람에게는 같은 것이다', () => {
    const rest = ['restdate', 'restdateculture', 'restdateleports', 'restdateshopping', 'restdatefood'];
    expect(new Set(rest.map(ktoFieldLabel))).toEqual(new Set(['휴무일']));
  });
});
