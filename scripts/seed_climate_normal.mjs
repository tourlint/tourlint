#!/usr/bin/env node
/**
 * 평년 강수일수 시드 (`climate_normal` · EI-WX-004 · 이슈 #7).
 *
 * 기상자료개방포털에서 받은 CSV 를 읽어 시도 × 12개월 행을 만든다. 포털 내려받기는
 * 로그인이 걸려 있어 자동화하지 않는다 — 파일을 받아 두고 이 스크립트에 넘긴다.
 *
 *   node scripts/seed_climate_normal.mjs <csv경로> [--dry]
 *   DATABASE_URL=... node scripts/seed_climate_normal.mjs data/평년값.csv
 *
 * 입력 형식은 **지점번호 · 월 · 강수일수** 세 값만 있으면 된다. 열 이름 · 순서 · 인코딩을
 * 가정하지 않는다 (`scripts/climate-csv.mjs`).
 */
import { readFileSync } from 'node:fs';
import { CLIMATE_NORMAL_PERIOD, CLIMATE_SOURCE_NOTE, CLIMATE_STATION } from '../packages/shared/dist/index.js';
import { decodeCsv, parseClimateCsv } from './climate-csv.mjs';

const [csvPath, ...flags] = process.argv.slice(2);
const DRY = flags.includes('--dry');
if (csvPath === undefined) {
  console.error('사용법: node scripts/seed_climate_normal.mjs <csv경로> [--dry]');
  process.exit(1);
}

/** 평년 30년(1991–2020)의 월 평균 일수. 2월은 윤년 7회를 반영한다 */
const DAYS_IN_MONTH = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 지점번호 → 그 지점을 대표로 쓰는 시도들 */
const SIDO_BY_STN = new Map();
for (const [sido, station] of Object.entries(CLIMATE_STATION)) {
  const list = SIDO_BY_STN.get(station.stnId) ?? [];
  list.push(sido);
  SIDO_BY_STN.set(station.stnId, list);
}

const { text, encoding } = decodeCsv(readFileSync(csvPath));
if (encoding !== 'utf-8') console.log(`UTF-8 이 아니라 ${encoding} 로 읽었다`);
const { rows, seen, skippedStations } = parseClimateCsv(text, SIDO_BY_STN);

const missing = [];
for (const sido of Object.keys(CLIMATE_STATION)) {
  for (let m = 1; m <= 12; m++) if (!seen.has(`${sido}-${m}`)) missing.push(`${sido}-${m}월`);
}

console.log(`읽은 행 ${rows.length} / 기대 ${Object.keys(CLIMATE_STATION).length * 12}`);
if (missing.length > 0) {
  console.log(`빠진 조합 ${missing.length}건: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' …' : ''}`);
  console.log('  빠진 시도는 R09 가 확인 불가로 남는다. 그대로 넣어도 되고 지점을 더 받아도 된다.');
}
if (skippedStations.length > 0) {
  console.log(`대표로 쓰지 않는 지점 ${skippedStations.length}종은 건너뛰었다: ${skippedStations.slice(0, 8).join(', ')}`);
}
for (const r of rows.slice(0, 3)) console.log(`  예: 시도 ${r.sido} ${r.month}월 → ${r.rainDays}일 (${r.ratio})`);

if (DRY) { console.log('--dry 라 DB 에 쓰지 않았다.'); process.exit(0); }
if (rows.length === 0) { console.error('넣을 행이 없다. 중단한다.'); process.exit(1); }

const { Pool } = await import('pg');
const url = process.env.DATABASE_URL;
if (url === undefined || url === '') { console.error('DATABASE_URL 이 없다'); process.exit(1); }
const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });

try {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO climate_normal (ldong_regn_cd, month, rain_days, rain_ratio, normal_period, source_note)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (ldong_regn_cd, month)
       DO UPDATE SET rain_days = EXCLUDED.rain_days, rain_ratio = EXCLUDED.rain_ratio,
                     normal_period = EXCLUDED.normal_period, source_note = EXCLUDED.source_note`,
      [r.sido, r.month, r.rainDays, r.ratio, CLIMATE_NORMAL_PERIOD, `${CLIMATE_SOURCE_NOTE} · 대표지점 ${r.stnId}`],
    );
  }
  console.log(`넣었다: ${rows.length}행`);
} finally {
  await pool.end();
}
