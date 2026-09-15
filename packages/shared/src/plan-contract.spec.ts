import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CALL_PROVIDER,
  COMPANY_SETTING_LIMITS,
  EXCEPTION_REASON_CODE,
  KTO_OPERATIONS,
  KTO_OPERATION_PATH,
  KTO_PROVIDER_OF,
  KTO_SERVICE,
  KTO_SERVICE_OF,
  PLAN_BASE_LCLS2,
  PLAN_EXCLUDED_LCLS1,
  SETTING_DEFAULTS,
  matchesNearKind,
} from './constants';
import { LCLS_SYSTM2, isKnownLcls2 } from './lcls-systm';

const ROOT = join(__dirname, '../../..');

describe('근처 3km 칩 (FR-PL-010 · API 4-10)', () => {
  it('🔴 식당 칩은 주점(FD04)과 카페(FD05)를 빼고 나머지 음식은 넣는다', () => {
    expect(matchesNearKind('MEAL', 'FD', 'FD01')).toBe(true);
    expect(matchesNearKind('MEAL', 'FD', 'FD03')).toBe(true);
    expect(matchesNearKind('MEAL', 'FD', 'FD04')).toBe(false);
    expect(matchesNearKind('MEAL', 'FD', 'FD05')).toBe(false);
  });

  it('🔴 카페 칩은 FD05 만, 숙소 칩은 AC 전부', () => {
    expect(matchesNearKind('CAFE', 'FD', 'FD05')).toBe(true);
    expect(matchesNearKind('CAFE', 'FD', 'FD01')).toBe(false);
    expect(matchesNearKind('STAY', 'AC', 'AC04')).toBe(true);
    expect(matchesNearKind('STAY', 'FD', 'FD01')).toBe(false);
    expect(matchesNearKind('MEAL', 'AC', 'AC01')).toBe(false);
  });

  it('식당 · 카페 칩이 음식 중분류를 겹치지 않고 주점만 남긴다', () => {
    const fd = Object.keys(LCLS_SYSTM2).filter((c) => c.startsWith('FD'));
    const left = fd.filter((c) => !matchesNearKind('MEAL', 'FD', c) && !matchesNearKind('CAFE', 'FD', c));
    expect(left).toEqual(['FD04']);
    expect(fd.filter((c) => matchesNearKind('MEAL', 'FD', c) && matchesNearKind('CAFE', 'FD', c))).toEqual([]);
  });
});

describe('장소 담기 기본 칩', () => {
  it('기본 칩 4개는 기준표에 있는 중분류이고 빼는 대분류에 속하지 않는다', () => {
    for (const code of PLAN_BASE_LCLS2) {
      expect(isKnownLcls2(code), code).toBe(true);
      expect((PLAN_EXCLUDED_LCLS1 as readonly string[]).some((lcls1) => code.startsWith(lcls1)), code).toBe(false);
    }
  });
});

describe('회사 기준 한계 (FR-OP-022)', () => {
  it('엄격하게만 — 연속 일정은 표준 이하, 식사는 표준 이상', () => {
    expect(COMPANY_SETTING_LIMITS.r07SpanHoursMax).toBe(SETTING_DEFAULTS.r07SpanHours);
    expect(COMPANY_SETTING_LIMITS.r07MealMinutesMin).toBe(SETTING_DEFAULTS.r07MealMinutes);
  });
});

describe('공사 서비스와 호출 로그 제공자 (외부 연동 3-1 · 3-3)', () => {
  it('🔴 무장애 · 반려동물 지역 목록은 국문과 경로가 같고 서비스가 다르다', () => {
    expect(KTO_OPERATION_PATH.withAreaBasedList2).toBe('areaBasedList2');
    expect(KTO_OPERATION_PATH.petAreaBasedList2).toBe('areaBasedList2');
    expect(KTO_SERVICE_OF.areaBasedList2).toBe('KOR');
    expect(KTO_SERVICE_OF.withAreaBasedList2).toBe('WITH');
    expect(KTO_SERVICE_OF.petAreaBasedList2).toBe('PET');
  });

  it('🔴 한 서비스 안에서 경로가 겹치는 오퍼레이션이 없다 — 겹치면 호출 로그로 구분하지 못한다', () => {
    const seen = new Set<string>();
    for (const op of KTO_OPERATIONS) {
      const key = `${KTO_SERVICE_OF[op]}/${KTO_OPERATION_PATH[op]}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it('🔴 반려동물은 국문 관광정보와 다른 제공자로 센다', () => {
    expect(KTO_PROVIDER_OF.PET).toBe('KTO_PET');
    expect(KTO_PROVIDER_OF.PET).not.toBe(KTO_PROVIDER_OF.KOR);
  });

  it('서비스마다 제공자가 하나씩이고 모두 CALL_PROVIDER 9값 안에 있다', () => {
    expect(CALL_PROVIDER).toHaveLength(9);
    const providers = KTO_SERVICE.map((s) => KTO_PROVIDER_OF[s]);
    expect(new Set(providers).size).toBe(KTO_SERVICE.length);
    for (const p of providers) expect(CALL_PROVIDER).toContain(p);
  });

  it('폐기 예정 · 쓰지 않기로 한 오퍼레이션은 목록에 없다 (EI-KT-001)', () => {
    for (const banned of ['areaCode2', 'categoryCode2', 'detailInfo2', 'detailImage2', 'areaBasedList1']) {
      expect(KTO_OPERATIONS as readonly string[]).not.toContain(banned);
    }
  });
});

describe('예외 사유코드 (EX-CM-020)', () => {
  it('🔴 42종이 예외처리 요구사항 4장 표와 순서까지 같다', () => {
    const doc = readFileSync(join(ROOT, 'docs/notion/19_예외처리요구사항.md'), 'utf8');
    const start = doc.indexOf('## 4. 사유 코드 목록');
    const end = doc.indexOf('### 규칙 판정 사유코드 목록', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const codes = [...doc.slice(start, end).matchAll(/^<td>`([A-Z_]+)`<\/td>$/gm)].map((m) => m[1]);
    expect(codes).toHaveLength(42);
    expect([...EXCEPTION_REASON_CODE]).toEqual(codes);
  });
});
