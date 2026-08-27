#!/usr/bin/env node
/**
 * 마이그레이션 한 파일을 적용한다 (`db/migrations/*.sql`).
 *
 *   DATABASE_URL=... node scripts/apply_migration.mjs db/migrations/<파일>.sql --check
 *   DATABASE_URL=... node scripts/apply_migration.mjs db/migrations/<파일>.sql
 *
 * `psql` 을 안 쓴다 — 이 저장소에서 DB 를 만지는 다른 스크립트와 같은 방식이다.
 *
 * `schema.sql` 은 통째로 적용하는 정본이라 이미 만들어진 DB 에는 쓸 수 없다 (db/README.md).
 * 그 사이를 메우는 것이 이 파일들이고, **전부 여러 번 돌려도 안전하게** 쓴다.
 *
 * ⚠️ **한 트랜잭션으로 돈다.** 도중에 실패하면 통째로 롤백된다 — 절반만 적용된 스키마가
 *    남으면 그게 제일 고치기 어렵다.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const file = args.find((a) => !a.startsWith('--'));

if (file === undefined) {
  console.error('사용법: DATABASE_URL=... node scripts/apply_migration.mjs <파일.sql> [--check]');
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  console.error('DATABASE_URL 이 없다');
  process.exit(1);
}

const sql = readFileSync(file, 'utf8');
console.log(`파일: ${file} (${sql.split('\n').length}줄)`);

// `pg` 는 루트가 아니라 `apps/api` 에 있다 (pnpm 워크스페이스)
const { Pool } = createRequire(new URL('../apps/api/package.json', import.meta.url))('pg');
const pool = new Pool({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
});

/** 그 표의 컬럼 목록. 적용 전후를 눈으로 확인하는 용도다 */
async function columnsOf(table) {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

// 파일이 건드리는 표 이름을 뽑아 적용 전후를 보여준다
const tables = [...new Set([...sql.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1].toLowerCase()))];

try {
  for (const t of tables) {
    const cols = await columnsOf(t);
    console.log(`  ${t} 컬럼 ${cols.length}개: ${cols.join(', ')}`);
  }

  if (CHECK) {
    console.log('--check 라 적용하지 않았다.');
    process.exit(0);
  }

  await pool.query('BEGIN');
  try {
    await pool.query(sql);
    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    // 절반만 적용된 스키마를 남기지 않는다
    console.error(`적용하지 못했다. 아무것도 바뀌지 않았다.\n  ${e.message}`);
    process.exit(1);
  }

  console.log('적용했다.');
  for (const t of tables) {
    const cols = await columnsOf(t);
    console.log(`  ${t} 컬럼 ${cols.length}개: ${cols.join(', ')}`);
  }
} finally {
  await pool.end();
}
