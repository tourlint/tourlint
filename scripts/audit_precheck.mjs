#!/usr/bin/env node
/**
 * 검수가 「확인 불가」를 내는 이유를 짚는다 (FR-AU-009 · R09).
 *
 *   DATABASE_URL=... node scripts/audit_precheck.mjs [상품id]
 *
 * **공사를 부르지 않는다.** DB 만 읽는다.
 *
 * 확인 불가는 오류가 아니라 「판정하지 못했다」는 사실이다. 그래서 화면만 봐서는 무엇이
 * 빠졌는지 알 수 없다 — 인증키인지, 좌표인지, 평년값인지. 그걸 여기서 가른다.
 */
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const { climateStationOf } = require('../../packages/shared/dist/index.js');

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  console.error('DATABASE_URL 이 없다');
  process.exit(1);
}
const wanted = process.argv.slice(2).find((a) => !a.startsWith('--'));

const pool = new Pool({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
});

const ok = (b) => (b ? 'ok  ' : 'NG  ');

try {
  const { rows: products } = await pool.query(
    `SELECT id, name, ldong_regn_cd, ldong_signgu_cd,
            to_char(start_date, 'YYYY-MM-DD') AS start_date, nights
       FROM product ${wanted === undefined ? '' : 'WHERE id = $1'}
      ORDER BY id DESC LIMIT ${wanted === undefined ? 5 : 1}`,
    wanted === undefined ? [] : [wanted],
  );
  if (products.length === 0) {
    console.log('상품이 없다');
    process.exit(0);
  }

  for (const p of products) {
    console.log(`\n[상품 ${p.id}] ${p.name} · 출발 ${p.start_date} · ${p.nights}박`);

    // ① 지역 코드 — 평년값과 중기 예보구역이 이걸로 찾는다
    const regn = p.ldong_regn_cd;
    const station = regn === null ? null : climateStationOf(regn);
    console.log(`  ${ok(regn !== null)}시도 코드 ${regn ?? '없음'} · 시군구 ${p.ldong_signgu_cd ?? '없음'}`);
    console.log(`  ${ok(station !== null)}대표 관측지점 ${station?.name ?? '매핑 없음 — climate-station 표에 그 코드가 없다'}`);

    // ② 좌표 — 없으면 기상청 격자를 못 만들고 R08·R09 가 통째로 확인 불가다
    const { rows: [coords] } = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE mapx IS NOT NULL AND mapy IS NOT NULL)::int AS located,
              count(*) FILTER (WHERE match_status = 'CONFIRMED')::int AS confirmed
         FROM itinerary_item WHERE product_id = $1`, [p.id]);
    console.log(`  ${ok(coords.located > 0)}일정 ${coords.total}개 · 확정 ${coords.confirmed} · 좌표 있는 것 ${coords.located}`);

    // ③ 평년값 — 여행 달 것이 있어야 D+11 이상을 판정한다
    const start = new Date(`${p.start_date}T00:00:00Z`);
    const months = [...new Set(Array.from({ length: p.nights + 1 }, (_, i) => {
      const d = new Date(start); d.setUTCDate(d.getUTCDate() + i); return d.getUTCMonth() + 1;
    }))];
    for (const month of months) {
      const { rows } = await pool.query(
        `SELECT rain_days, rain_ratio FROM climate_normal WHERE ldong_regn_cd = $1 AND month = $2`,
        [regn, month]);
      const row = rows[0];
      console.log(`  ${ok(row !== undefined)}평년값 (${regn ?? '?'}, ${month}월) ${
        row === undefined ? '없음 — 이 달은 D+11 이상이 전부 확인 불가다' : `강수일수 ${row.rain_days} · 비율 ${row.rain_ratio}`}`);
    }
  }

  // 표 전체 상태. 특정 시도만 빠졌는지 한눈에 본다
  const { rows: have } = await pool.query(
    `SELECT ldong_regn_cd, count(*)::int AS n FROM climate_normal GROUP BY 1 ORDER BY 1`);
  console.log(`\n[평년값 표] 시도 ${have.length}개 · 총 ${have.reduce((a, r) => a + r.n, 0)}행`);
  const short = have.filter((r) => r.n !== 12);
  if (short.length > 0) console.log(`  달이 12개가 아닌 시도: ${short.map((r) => `${r.ldong_regn_cd}(${r.n})`).join(' ')}`);
  console.log(`  들어 있는 시도: ${have.map((r) => r.ldong_regn_cd).join(' ')}`);
} finally {
  await pool.end();
}
