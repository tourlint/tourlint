import { describe, expect, it } from 'vitest';
import { CLIMATE_STATION } from '@tourlint/shared';
// @ts-expect-error — 시드 스크립트는 타입 선언이 없는 순수 ESM 이다
import { DAYS_IN_MONTH, decodeCsv, findColumn, parseClimateCsv, splitCsvLine } from '../../../scripts/climate-csv.mjs';

/**
 * 평년 강수일수 CSV 해석 (EI-WX-004 · 이슈 #7).
 *
 * 시드 스크립트 안에 두면 실행해 봐야만 검증되고, 그러면 되돌려서 빨간지 볼 수가 없다.
 * 순수 함수로 떼어 여기서 부른다.
 */

/** 지점번호 → 그 지점을 대표로 쓰는 시도들 */
function stationToSido(): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const [sido, station] of Object.entries(CLIMATE_STATION)) {
    const list = map.get(station.stnId) ?? [];
    list.push(sido);
    map.set(station.stnId, list);
  }
  return map;
}

const HEADER = '지점번호,지점명,월,강수일수(일)';
const csv = (...rows: string[]): string => [HEADER, ...rows].join('\n');

describe('인코딩', () => {
  it('UTF-8 을 그대로 읽는다', () => {
    expect(decodeCsv(Buffer.from('지점번호,강수일수', 'utf8'))).toEqual({
      text: '지점번호,강수일수', encoding: 'utf-8',
    });
  });

  it('🔴 EUC-KR 도 읽는다 — 포털 내려받기가 흔히 이렇게 온다', () => {
    // UTF-8 로 읽으면 「강수일수」를 못 찾아 「열이 없다」로 멈춘다. 원인이 인코딩인데
    // 형식 문제로 보인다
    const euckr = Buffer.from([0xc1, 0xf6, 0xc1, 0xa1, 0xb9, 0xf8, 0xc8, 0xa3]); // 지점번호
    expect(decodeCsv(euckr)).toEqual({ text: '지점번호', encoding: 'euc-kr' });
  });

  it('BOM 을 떼어낸다 — 안 떼면 첫 열 이름이 안 맞는다', () => {
    expect(decodeCsv(Buffer.from('﻿지점번호', 'utf8')).text).toBe('지점번호');
  });

  it('엑셀 파일이면 무엇인지 말해 준다', () => {
    // zip 이라 PK 로 시작한다. 깨진 글자를 보여 주면 원인을 못 찾는다
    expect(() => decodeCsv(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toThrow(/엑셀/);
  });
});

describe('열 찾기', () => {
  it('이름과 순서를 가정하지 않는다', () => {
    const header = ['월', '강수일수(일)', '지점코드'];
    expect(findColumn(header, ['지점번호', '지점코드'], '지점번호')).toBe(2);
    expect(findColumn(header, ['강수일수'], '강수일수')).toBe(1);
  });

  it('🔴 못 찾으면 던진다 — 0 으로 넣으면 비 오는 날이 정상 판정된다', () => {
    expect(() => findColumn(['지점번호', '강수량(mm)'], ['강수일수'], '강수일수'))
      .toThrow(/강수일수' 열을 못 찾았다/);
  });

  it('따옴표 안 쉼표를 구분자로 보지 않는다', () => {
    expect(splitCsvLine('105,"강릉, 강원",9,9.2')).toEqual(['105', '강릉, 강원', '9', '9.2']);
  });
});

describe('행 만들기', () => {
  it('한 지점이 여러 시도를 대표할 수 있다', () => {
    // 강릉(105)은 강원 두 코드(42 · 51)를 함께 맡는다
    const { rows } = parseClimateCsv(csv('105,강릉,9,9.2'), stationToSido());
    expect(rows.map((r: { sido: string }) => r.sido).sort()).toEqual(['42', '51']);
  });

  it('대표로 쓰지 않는 지점은 건너뛰고 무엇을 건너뛰었는지 남긴다', () => {
    const { rows, skippedStations } = parseClimateCsv(csv('999,없는곳,9,5.0'), stationToSido());
    expect(rows).toHaveLength(0);
    expect(skippedStations).toEqual(['999']);
  });

  it('🔴 값을 못 읽으면 0 을 넣지 않고 던진다', () => {
    expect(() => parseClimateCsv(csv('105,강릉,9,-'), stationToSido())).toThrow(/강수일수를 못 읽었다/);
    expect(() => parseClimateCsv(csv('105,강릉,9,45'), stationToSido())).toThrow(/강수일수를 못 읽었다/);
  });

  it('🔴 빈 칸을 0 일로 읽지 않는다', () => {
    // Number('') 은 0 이다. 그냥 두면 결측이 「그 달에 비 온 날이 하루도 없다」가 된다
    expect(Number('')).toBe(0);
    expect(() => parseClimateCsv(csv('105,강릉,9,'), stationToSido())).toThrow(/강수일수를 못 읽었다/);
  });

  it('🔴 0 과 음수도 결측으로 본다 — 국내에 평년 강수일수 0 인 달은 없다', () => {
    // 결측을 0 이나 -9 로 적는 판이 있다
    expect(() => parseClimateCsv(csv('105,강릉,9,0'), stationToSido())).toThrow(/강수일수를 못 읽었다/);
    expect(() => parseClimateCsv(csv('105,강릉,9,-9'), stationToSido())).toThrow(/강수일수를 못 읽었다/);
  });

  it('🔴 2월은 28 이 아니라 28.25 로 나눈다 — 평년 30년에 윤년이 7번 있다', () => {
    expect(DAYS_IN_MONTH[1]).toBe(28.25);
    const { rows } = parseClimateCsv(csv('105,강릉,2,7.9'), stationToSido());
    expect(rows[0].ratio).toBeCloseTo(7.9 / 28.25, 3);
    // 28 로 나누면 0.282 — 2월만 비율이 부풀어 오른다
    expect(rows[0].ratio).not.toBeCloseTo(7.9 / 28, 3);
  });

  it('비율은 1 을 넘지 않는다', () => {
    const { rows } = parseClimateCsv(csv('105,강릉,4,30'), stationToSido());
    expect(rows[0].ratio).toBe(1);
  });

  it('앞에 붙은 주석 줄을 건너뛴다', () => {
    const withNote = ['# 기후평년값(1991~2020)', '# 출처: 기상청', HEADER, '105,강릉,9,9.2'].join('\n');
    expect(parseClimateCsv(withNote, stationToSido()).rows).toHaveLength(2);
  });

  it('머리글이 없으면 던진다', () => {
    expect(() => parseClimateCsv('105,강릉,9,9.2', stationToSido())).toThrow(/머리글 줄을 못 찾았다/);
  });

  it('같은 시도가 두 번 나오면 먼저 나온 줄을 쓴다', () => {
    const { rows } = parseClimateCsv(csv('105,강릉,9,9.2', '105,강릉,9,1.0'), stationToSido());
    expect(rows.filter((r: { sido: string }) => r.sido === '51')).toHaveLength(1);
    expect(rows[0].rainDays).toBe(9.2);
  });
});
