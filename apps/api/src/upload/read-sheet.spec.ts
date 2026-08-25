import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSchedule } from './schedule-parse';
import { readSheetRows } from './read-sheet';

// 실제 지정 양식 샘플로 exceljs 읽기 + 파싱을 함께 검증한다.
const DIR = resolve(process.cwd(), '../../fixtures/excel');
const read = (name: string) => readSheetRows(readFileSync(`${DIR}/${name}`), name);

describe('readSheetRows + parseSchedule (실제 xlsx 샘플)', () => {
  it('sample_3days_ok — 2박 3일로 파싱되고 관광·숙박 유형이 매핑된다', async () => {
    const r = parseSchedule(await read('sample_3days_ok.xlsx'));
    expect(r.rejected).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(r.nights).toBe(2); // 최대 3일차 → 2박
    expect(r.items.length).toBeGreaterThanOrEqual(15);
    expect(r.items.filter((i) => i.itemType === 'SIGHT').length).toBeGreaterThanOrEqual(10);
    expect(r.items.filter((i) => i.itemType === 'LODGING')).toHaveLength(2); // 2박 → 숙박 2회
  });

  it('sample_4days_reject — 4일차 포함이라 거부된다', async () => {
    const r = parseSchedule(await read('sample_4days_reject.xlsx'));
    expect(r.rejected?.code).toBe('DAY_COUNT_MISMATCH');
  });

  it('CSV 도 같은 스키마로 파싱한다', async () => {
    const csv = '일차,시작시간,종료시간,장소명,유형\n1,10:00,11:30,오죽헌,관광\n1,21:00,,호텔,숙박\n';
    const r = parseSchedule(await readSheetRows(Buffer.from(csv, 'utf8'), 'x.csv'));
    expect(r.rejected).toBeUndefined();
    expect(r.items).toHaveLength(2);
    expect(r.items.filter((i) => i.itemType === 'LODGING')).toHaveLength(1);
  });
});
