#!/usr/bin/env node
/**
 * 운영에 어떤 상품이 있는지 본다 (읽기 전용).
 *
 *   DATABASE_URL=... node scripts/list_products.mjs
 *
 * **공사를 부르지 않고 아무것도 쓰지 않는다.** SELECT 뿐이다.
 * 성능 실측(NF-PF-001) 전에 8곳 · 12곳 상품이 이미 있는지, 검수 이력이 붙어 있는지를
 * 확인하는 용도다 — 데모 시드를 다시 돌리면 그 계정의 상품과 검수 이력이 지워진다.
 */
import { createRequire } from 'node:module';

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  console.error('DATABASE_URL 이 없다');
  process.exit(1);
}

const { Pool } = createRequire(new URL('../apps/api/package.json', import.meta.url))('pg');
const pool = new Pool({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
});

try {
  const { rows } = await pool.query(`
    SELECT p.id, p.name, p.nights, p.account_id,
           count(DISTINCT i.kto_content_id)::int AS contents,
           count(DISTINCT r.id)::int             AS runs
      FROM product p
      LEFT JOIN itinerary_item i ON i.product_id = p.id
      LEFT JOIN audit_run r      ON r.product_id = p.id
     GROUP BY p.id, p.name, p.nights, p.account_id
     ORDER BY p.id`);

  console.log('\nid  계정  박  콘텐츠  검수이력  이름');
  for (const r of rows) {
    const bucket = r.contents <= 8 ? '' : '  <= 9곳 이상';
    console.log(
      `${String(r.id).padStart(2)}  ${String(r.account_id).padStart(4)}  ${r.nights}박  ` +
      `${String(r.contents).padStart(4)}곳  ${String(r.runs).padStart(6)}건  ${r.name}${bucket}`,
    );
  }
  if (rows.length === 0) console.log('  (상품 없음)');

  /*
   * 시드는 상품을 지우고 다시 넣으므로(reseedDemoProducts) 돌릴 때마다 id 가 새로 붙는다.
   * 전에 쓰던 id 로 검수를 걸면 404 다. 그래서 다음 명령을 여기서 만들어 준다.
   */
  const big = rows.find((r) => r.contents >= 9);
  const small = rows.find((r) => r.contents >= 6 && r.contents <= 8);
  if (big !== undefined && small !== undefined) {
    console.log('\n성능 표본 명령 (NF-PF-001 두 버킷)');
    console.log(
      `  API_BASE_URL='https://api-production-1e7c2.up.railway.app' \\\n` +
      `    PERF_EMAIL='openapi@tourlint.example' PERF_PASSWORD='<암호>' \\\n` +
      `    node scripts/perf_sample.mjs --product ${String(big.id)} --product ${String(small.id)} --runs 3 --yes`,
    );
  }

  const { rows: acc } = await pool.query(`SELECT id, email, is_demo FROM account ORDER BY id`);
  console.log('\n계정');
  for (const a of acc) console.log(`  ${a.id}  demo=${a.is_demo}  ${a.email}`);
  console.log('');
} finally {
  await pool.end();
}
