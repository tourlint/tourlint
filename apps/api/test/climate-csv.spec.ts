import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIMATE_STATION, RULE_CONSTANTS } from '@tourlint/shared';
// @ts-expect-error — 시드 스크립트는 타입 선언이 없는 순수 ESM 이다
import { DAYS_IN_MONTH, NORMAL_FROM, NORMAL_TO, decodeCsv, parseClimateCsv, splitCsvLine } from '../../../scripts/climate-csv.mjs';

/**
 * 평년 강수일수 CSV 해석 (EI-WX-004 · 이슈 #7).
 *
 * 형식은 2026.08.26 에 실제로 받은 파일(`STCS_강수일수_MNH_*.csv`)을 그대로 본떴다.
 * 지어낸 형식이 아니다 — 앞서 한 번 형식을 짐작해 썼다가 실제 파일과 달라 다시 썼다.
 */

/** 지점명 → 그 지점을 대표로 쓰는 시도들 */
function nameToSido(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [sido, station] of Object.entries(CLIMATE_STATION)) {
    const list = map.get(station.name) ?? [];
    list.push(sido);
    map.set(station.name, list);
  }
  return map;
}

/** 실제 파일과 같은 모양. 연도 행은 필요한 만큼만 만든다 */
function block(name: string, opts: { from?: number; to?: number; avg?: string } = {}): string {
  const from = opts.from ?? NORMAL_FROM;
  const to = opts.to ?? NORMAL_TO;
  const years = [];
  for (let y = from; y <= to; y++) years.push(`${y},8.0,5.0,11.0,6.0,10.0,4.0,22.0,15.0,12.0,2.0,2.0,10.0,107.0,22`);
  return [
    '', '강수일수', `지점/지역명 : ${name}`, '', '평균 강수일수',
    '연도,1월,2월,3월,4월,5월,6월,7월,8월,9월,10월,11월,12월,연합계,순위',
    ...years,
    opts.avg ?? '평균,6.2,5.7,8.8,8.9,9.1,10.8,16.0,16.4,11.8,7.8,7.3,4.6',
    '', '', '평균 계절별 강수일수',
    '연도,봄(3~5월),여름(6~8월),가을(9~11월),겨울(12~익년2월)',
    '1991,27.0,41.0,16.0,21.0', '평균,26.8,43.2,26.9,16.5',
  ].join('\r\n');
}

describe('인코딩', () => {
  it('🔴 EUC-KR 을 읽는다 — 실제 받은 파일이 그랬다', () => {
    // UTF-8 로 읽으면 지점명이 깨져 시도를 못 찾고, 「대표가 아닌 지점」으로 조용히 건너뛴다
    const euckr = Buffer.from([0xb0, 0xad, 0xb8, 0xaa]); // 강릉
    expect(decodeCsv(euckr)).toEqual({ text: '강릉', encoding: 'euc-kr' });
  });

  it('UTF-8 도 그대로 읽고 BOM 은 떼어낸다', () => {
    expect(decodeCsv(Buffer.from('강릉', 'utf8')).encoding).toBe('utf-8');
    expect(decodeCsv(Buffer.from('﻿강릉', 'utf8')).text).toBe('강릉');
  });

  it('엑셀 파일이면 무엇인지 말해 준다', () => {
    expect(() => decodeCsv(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toThrow(/엑셀/);
  });

  it('따옴표 안 쉼표를 구분자로 보지 않는다', () => {
    expect(splitCsvLine('평균,"6,2",5.7')).toEqual(['평균', '6,2', '5.7']);
  });
});

describe('평년값 뽑기', () => {
  it('「평균」 행이 평년값이다', () => {
    const { rows, blocks } = parseClimateCsv(block('강릉'), nameToSido());
    expect(blocks[0].monthly).toEqual([6.2, 5.7, 8.8, 8.9, 9.1, 10.8, 16.0, 16.4, 11.8, 7.8, 7.3, 4.6]);
    // 강릉은 강원 두 코드를 함께 맡는다 → 2 × 12개월
    expect(rows).toHaveLength(24);
  });

  it('🔴 조회 기간이 1991~2020 이 아니면 던진다', () => {
    // 「평균」은 조회 기간의 평균일 뿐이다. 다른 기간 평균을 평년값으로 저장하면
    // 출처(기상청)와 기준 평년 표기가 거짓이 된다
    expect(() => parseClimateCsv(block('강릉', { from: 1996, to: 2025 }), nameToSido()))
      .toThrow(/1991~2020 이어야 한다/);
    expect(() => parseClimateCsv(block('강릉', { from: 2016, to: 2020 }), nameToSido()))
      .toThrow(/1991~2020 이어야 한다/);
  });

  it('🔴 「평균」 행이 없으면 던진다 — 연도 값으로 대신 계산하지 않는다', () => {
    const noAvg = block('강릉').replace(/^평균,6\.2.*$/m, '');
    expect(() => parseClimateCsv(noAvg, nameToSido())).toThrow(/「평균」 행이 없다/);
  });

  it('🔴 빈 칸·0 을 강수일수로 받지 않는다', () => {
    expect(() => parseClimateCsv(block('강릉', { avg: '평균,6.2,,8.8,8.9,9.1,10.8,16.0,16.4,11.8,7.8,7.3,4.6' }), nameToSido()))
      .toThrow(/2월 평균 강수일수를 못 읽었다/);
    expect(() => parseClimateCsv(block('강릉', { avg: '평균,6.2,0,8.8,8.9,9.1,10.8,16.0,16.4,11.8,7.8,7.3,4.6' }), nameToSido()))
      .toThrow(/2월 평균 강수일수를 못 읽었다/);
    expect(Number('')).toBe(0); // 그냥 두면 결측이 「비 온 날 0일」이 된다
  });

  it('머리글이 없으면 자료구분을 짚어 준다', () => {
    const noHeader = block('강릉').replace(/^연도,1월.*$/m, '연도,봄,여름');
    expect(() => parseClimateCsv(noHeader, nameToSido())).toThrow(/자료구분이 「월」인지/);
  });

  it('지점 줄이 없으면 다른 화면의 CSV 다', () => {
    expect(() => parseClimateCsv('연도,1월\n1991,8.0', nameToSido())).toThrow(/지점\/지역명/);
  });
});

describe('시드 행', () => {
  it('비율은 그 달의 일수로 나눈다', () => {
    const { rows } = parseClimateCsv(block('강릉'), nameToSido());
    const sep = rows.find((r: { sido: string; month: number }) => r.sido === '51' && r.month === 9);
    expect(sep.rainDays).toBe(11.8);
    expect(sep.ratio).toBeCloseTo(11.8 / 30, 3);
  });

  it('🔴 2월은 28 이 아니라 28.25 로 나눈다 — 평년 30년에 윤년이 7번 있다', () => {
    expect(DAYS_IN_MONTH[1]).toBe(28.25);
    const { rows } = parseClimateCsv(block('강릉'), nameToSido());
    const feb = rows.find((r: { sido: string; month: number }) => r.sido === '51' && r.month === 2);
    expect(feb.ratio).toBeCloseTo(5.7 / 28.25, 3);
    expect(feb.ratio).not.toBeCloseTo(5.7 / 28, 3);
  });

  it('대표가 아닌 지점은 건너뛰고 무엇을 건너뛰었는지 남긴다', () => {
    const { rows, skippedStations } = parseClimateCsv(block('대관령'), nameToSido());
    expect(rows).toHaveLength(0);
    expect(skippedStations).toEqual(['대관령']);
  });

  it('지점이 여럿 담긴 파일도 읽는다', () => {
    const { rows, blocks } = parseClimateCsv(`${block('강릉')}\r\n${block('서울')}`, nameToSido());
    expect(blocks.map((b: { stationName: string }) => b.stationName)).toEqual(['강릉', '서울']);
    // 강원 2 + 서울 1 = 3개 시도 × 12개월
    expect(rows).toHaveLength(36);
  });
});

describe('시드 원본 전부 (2026.08.27)', () => {
  const DIR = join(__dirname, '../../../fixtures/climate');

  it('🔴 시도 20개 × 12개월이 빠짐없이 찬다', () => {
    /*
     * 한 시도라도 비면 그 지역 상품이 D+11 이상에서 확인 불가로 남는다. 지점 하나가
     * 시도 둘을 맡기도 해서(강릉이 42·51, 대전이 대전·세종) 파일 수와 시도 수가 다르다.
     */
    const map = nameToSido();
    const rows: { sido: string; month: number }[] = [];
    for (const f of readdirSync(DIR).filter((x) => x.endsWith('.csv'))) {
      rows.push(...parseClimateCsv(decodeCsv(readFileSync(join(DIR, f))).text, map).rows);
    }

    const sidos = new Set(rows.map((r) => r.sido));
    expect(sidos.size).toBe(Object.keys(CLIMATE_STATION).length);
    for (const sido of Object.keys(CLIMATE_STATION)) {
      const months = rows.filter((r) => r.sido === sido).map((r) => r.month).sort((a, b) => a - b);
      expect(months, `시도 ${sido}`).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    }
  });

  it('평년 강수일수가 그럴듯한 범위 안이다', () => {
    // 국내 어느 지점·달도 0일이거나 31일이 될 수 없다
    const map = nameToSido();
    for (const f of readdirSync(DIR).filter((x) => x.endsWith('.csv'))) {
      const { blocks } = parseClimateCsv(decodeCsv(readFileSync(join(DIR, f))).text, map);
      for (const b of blocks) {
        for (const [i, d] of b.monthly.entries()) {
          expect(d, `${b.stationName} ${i + 1}월`).toBeGreaterThan(0);
          expect(d, `${b.stationName} ${i + 1}월`).toBeLessThan(25);
        }
      }
    }
  });
});

describe('실제로 받은 파일 (2026.08.26)', () => {
  /** 시드 원본 그대로다. 지어낸 형식이 아니라는 것을 여기서 못 박는다 */
  const FILE = join(__dirname, '../../../fixtures/climate/STCS_강수일수_MNH_강릉_1991-2020.csv');

  it('EUC-KR 로 오고, 강릉 평년값이 그대로 나온다', () => {
    const { text, encoding } = decodeCsv(readFileSync(FILE));
    expect(encoding).toBe('euc-kr');

    const { rows, blocks } = parseClimateCsv(text, nameToSido());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].stationName).toBe('강릉');
    expect(blocks[0].years).toEqual({ from: 1991, to: 2020, count: 30 });
    expect(blocks[0].monthly).toEqual([6.2, 5.7, 8.8, 8.9, 9.1, 10.8, 16.0, 16.4, 11.8, 7.8, 7.3, 4.6]);
    // 강원 두 코드 × 12개월
    expect(rows).toHaveLength(24);
  });

  it('여름 넉 달이 R09 평년 임계를 넘는다 — 강릉 장마철', () => {
    const { rows } = parseClimateCsv(decodeCsv(readFileSync(FILE)).text, nameToSido());
    const gangwon = rows.filter((r: { sido: string }) => r.sido === '51');
    const over = gangwon.filter((r: { ratio: number }) => r.ratio >= RULE_CONSTANTS.R09_CLIMATE_RAIN_THRESHOLD);
    expect(over.map((r: { month: number }) => r.month)).toEqual([6, 7, 8, 9]);
    // 9월 11.8일 / 30일 = 0.393
    expect(gangwon.find((r: { month: number }) => r.month === 9)?.ratio).toBeCloseTo(0.393, 3);
  });
});
