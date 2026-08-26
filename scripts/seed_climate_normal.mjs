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
 * 입력 형식은 **지점번호 · 월 · 강수일수** 세 값만 있으면 된다. 열 이름이나 순서는
 * 포털 내려받기마다 다르므로 머리글에서 찾는다. 못 찾으면 무엇이 없는지 말하고 멈춘다 —
 * 조용히 0 을 넣으면 R09 가 비 오는 날을 정상으로 판정한다.
 *
 * 강수일수 → 비율은 **그 달의 일수**로 나눈다. 2월은 평년(1991–2020)에 윤년이 7번 있어
 * 28.25 일로 본다. 28 로 나누면 2월만 비율이 커진다.
 */
import { readFileSync } from 'node:fs';
import { CLIMATE_NORMAL_PERIOD, CLIMATE_SOURCE_NOTE, CLIMATE_STATION } from '../packages/shared/dist/index.js';

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

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** 머리글에서 열 위치를 찾는다. 포털 내려받기마다 이름이 달라 후보를 여럿 본다 */
function findColumn(header, candidates, label) {
  for (let i = 0; i < header.length; i++) {
    const cell = header[i].replace(/\s|\(|\)/g, '');
    if (candidates.some((c) => cell.includes(c))) return i;
  }
  throw new Error(
    `CSV 에서 '${label}' 열을 못 찾았다. 머리글: ${header.join(' | ')}\n` +
    `  찾은 이름 후보: ${candidates.join(' · ')}\n` +
    `  scripts/seed_climate_normal.mjs 의 후보 목록에 실제 열 이름을 추가할 것`,
  );
}

const text = readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
// 포털 파일은 앞에 주석 줄이 붙기도 한다. 지점 열이 보이는 첫 줄을 머리글로 본다
const headerIndex = lines.findIndex((l) => /지점|stnId/i.test(l) && /월|month/i.test(l));
if (headerIndex < 0) throw new Error('머리글 줄을 못 찾았다 (지점 · 월 열이 있는 줄이 없다)');

const header = splitCsvLine(lines[headerIndex]);
const stnCol = findColumn(header, ['지점번호', '지점코드', 'stnId', '지점'], '지점번호');
const monthCol = findColumn(header, ['월', 'month'], '월');
const rainDayCol = findColumn(header, ['강수일수', '강수계속일수', 'rainDay'], '강수일수');

const rows = [];
const seen = new Set();
for (const line of lines.slice(headerIndex + 1)) {
  const cells = splitCsvLine(line);
  const stnId = Number(cells[stnCol]);
  const month = Number(String(cells[monthCol]).replace(/[^0-9]/g, ''));
  const rainDays = Number(cells[rainDayCol]);

  const sidos = SIDO_BY_STN.get(stnId);
  if (sidos === undefined) continue;                       // 대표로 쓰지 않는 지점
  if (!(month >= 1 && month <= 12)) continue;
  if (!Number.isFinite(rainDays)) {
    throw new Error(`강수일수를 못 읽었다: 지점 ${stnId} ${month}월 → ${JSON.stringify(cells[rainDayCol])}`);
  }

  const ratio = Math.min(1, rainDays / DAYS_IN_MONTH[month - 1]);
  for (const sido of sidos) {
    const key = `${sido}-${month}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ sido, month, rainDays, ratio: Number(ratio.toFixed(3)), stnId });
  }
}

const missing = [];
for (const sido of Object.keys(CLIMATE_STATION)) {
  for (let m = 1; m <= 12; m++) if (!seen.has(`${sido}-${m}`)) missing.push(`${sido}-${m}월`);
}

console.log(`읽은 행 ${rows.length} / 기대 ${Object.keys(CLIMATE_STATION).length * 12}`);
if (missing.length > 0) {
  console.log(`빠진 조합 ${missing.length}건: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' …' : ''}`);
  console.log('  빠진 시도는 R09 가 확인 불가로 남는다. 그대로 넣어도 되고 지점을 더 받아도 된다.');
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
