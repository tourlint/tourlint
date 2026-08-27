#!/usr/bin/env node
/**
 * 평년 강수일수 시드 (`climate_normal` · EI-WX-004 · 이슈 #7).
 *
 * 기상자료개방포털에서 받은 CSV 를 읽어 시도 × 12개월 행을 만든다. 포털 내려받기는
 * 화면 조작이 필요해 자동화하지 않는다 — 받아 두고 이 스크립트에 넘긴다. 받는 절차는
 * `fixtures/climate/README.md`.
 *
 *   node scripts/seed_climate_normal.mjs <csv...> --dry     파일만 확인. DB 를 안 본다
 *   DATABASE_URL=... node scripts/seed_climate_normal.mjs <csv...>
 *   DATABASE_URL=... node scripts/seed_climate_normal.mjs --check   지금 표에 무엇이 있는지
 *
 * **파일을 여럿 줄 수 있다.** 포털이 지점을 하나씩만 조회해 줘서 지점 수만큼 파일이
 * 생긴다. 디렉터리를 주면 그 안의 `.csv` 를 전부 읽는다.
 *
 *   node scripts/seed_climate_normal.mjs ~/Downloads/STCS_*.csv
 *   node scripts/seed_climate_normal.mjs ~/Downloads --dry
 *
 * 형식은 `scripts/climate-csv.mjs` 가 안다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CLIMATE_NORMAL_PERIOD, CLIMATE_SOURCE_NOTE, CLIMATE_STATION } from '../packages/shared/dist/index.js';
import { decodeCsv, parseClimateCsv } from './climate-csv.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const CHECK = args.includes('--check');
const inputs = args.filter((a) => !a.startsWith('--'));

if (!CHECK && inputs.length === 0) {
  console.error('사용법: node scripts/seed_climate_normal.mjs <csv경로...|디렉터리> [--dry]');
  console.error('        DATABASE_URL=... node scripts/seed_climate_normal.mjs --check');
  process.exit(1);
}

/*
 * `pg` 는 루트가 아니라 `apps/api` 에 설치돼 있다 (pnpm 워크스페이스). 그냥 import 하면
 * 스크립트를 루트에서 돌릴 때 ERR_MODULE_NOT_FOUND 로 떨어진다.
 */
async function connect() {
  const { createRequire } = await import('node:module');
  const { Pool } = createRequire(new URL('../apps/api/package.json', import.meta.url))('pg');
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    console.error('DATABASE_URL 이 없다');
    process.exit(1);
  }
  // Railway 같은 원격은 TLS 를 쓴다. 로컬 컨테이너는 안 쓴다
  return new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });
}

/** 지금 표에 무엇이 들어 있는지 본다. 쓰지 않는다 — 운영에 넣고 나서 확인하는 용도다 */
if (CHECK) {
  const pool = await connect();
  try {
    const { rows } = await pool.query(
      `SELECT ldong_regn_cd, count(*)::int AS months, min(normal_period) AS period,
              min(source_note) AS source, round(avg(rain_ratio), 3)::text AS avg_ratio
         FROM climate_normal GROUP BY ldong_regn_cd ORDER BY ldong_regn_cd`,
    );
    if (rows.length === 0) {
      console.log('climate_normal 이 비어 있다. R09 는 D+11 이상을 전부 확인 불가로 판정한다.');
    } else {
      console.log(`시도 ${rows.length}개 · 총 ${rows.reduce((n, r) => n + r.months, 0)}행`);
      for (const r of rows) {
        const full = r.months === 12 ? '' : `  ⚠ 12개월이 아니라 ${r.months}개월`;
        console.log(`  시도 ${r.ldong_regn_cd}  ${r.period}  평균비율 ${r.avg_ratio}  ${r.source}${full}`);
      }
      const expected = Object.keys(CLIMATE_STATION).length;
      if (rows.length < expected) {
        console.log(`빠진 시도 ${expected - rows.length}개는 R09 가 확인 불가로 남긴다.`);
      }
    }
  } finally {
    await pool.end();
  }
  process.exit(0);
}

/** 지점명 → 그 지점을 대표로 쓰는 시도들 */
const SIDO_BY_NAME = new Map();
for (const [sido, station] of Object.entries(CLIMATE_STATION)) {
  const list = SIDO_BY_NAME.get(station.name) ?? [];
  list.push(sido);
  SIDO_BY_NAME.set(station.name, list);
}

/** 디렉터리를 주면 그 안의 `.csv` 를 전부 읽는다 */
function expand(paths) {
  const out = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        if (f.toLowerCase().endsWith('.csv')) out.push(join(p, f));
      }
    } else out.push(p);
  }
  return out;
}

const files = expand(inputs);
if (files.length === 0) {
  console.error('읽을 CSV 가 없다');
  process.exit(1);
}

/*
 * 파일마다 따로 읽고 결과를 합친다. 지점이 겹치면 **먼저 읽은 파일이 이긴다** —
 * 같은 지점을 두 번 받았을 때 어느 쪽이 쓰였는지 출력으로 알 수 있어야 한다.
 */
const rows = [];
const seen = new Set();
const skippedStations = [];
let failed = 0;

for (const file of files) {
  try {
    const { text, encoding } = decodeCsv(readFileSync(file));
    const parsed = parseClimateCsv(text, SIDO_BY_NAME);
    for (const b of parsed.blocks) {
      console.log(`${b.stationName}: ${b.years.from}~${b.years.to} ${b.years.count}년 · 평년 강수일수 ${b.monthly.join(' ')}`
        + (encoding !== 'utf-8' ? ` [${encoding}]` : ''));
    }
    for (const r of parsed.rows) {
      const key = `${r.sido}-${r.month}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
    }
    skippedStations.push(...parsed.skippedStations);
  } catch (e) {
    // 한 파일이 이상해도 나머지는 넣는다. 무엇이 왜 빠졌는지는 말한다
    failed++;
    console.error(`  ✗ ${basename(file)} — ${e.message.split('\n')[0]}`);
  }
}
if (failed > 0) console.log(`읽지 못한 파일 ${failed}건은 건너뛰었다.`);

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
  console.log(`시도 대표가 아닌 지점은 건너뛰었다: ${skippedStations.join(', ')}`);
}
for (const r of rows.slice(0, 3)) console.log(`  예: 시도 ${r.sido} ${r.month}월 → ${r.rainDays}일 (${r.ratio})`);

if (DRY) { console.log('--dry 라 DB 에 쓰지 않았다.'); process.exit(0); }
if (rows.length === 0) { console.error('넣을 행이 없다. 중단한다.'); process.exit(1); }

const pool = await connect();

try {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO climate_normal (ldong_regn_cd, month, rain_days, rain_ratio, normal_period, source_note)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (ldong_regn_cd, month)
       DO UPDATE SET rain_days = EXCLUDED.rain_days, rain_ratio = EXCLUDED.rain_ratio,
                     normal_period = EXCLUDED.normal_period, source_note = EXCLUDED.source_note`,
      [r.sido, r.month, r.rainDays, r.ratio, CLIMATE_NORMAL_PERIOD, `${CLIMATE_SOURCE_NOTE} · 대표지점 ${r.stationName}`],
    );
  }
  console.log(`넣었다: ${rows.length}행`);
  console.log('확인: DATABASE_URL=... node scripts/seed_climate_normal.mjs --check');
} finally {
  await pool.end();
}
