#!/usr/bin/env node
/**
 * 데모 계정 정리 — 이메일을 `openapi@tourlint.kr` 로 옮기고 타깃 키를 코드로 바꾼다.
 *
 *   DATABASE_URL=... node scripts/fix_demo_account.mjs            무엇을 할지 보여주기만 한다
 *   DATABASE_URL=... node scripts/fix_demo_account.mjs --apply    실제로 고친다
 *
 * ## 왜 필요한가 (2026-09-03 일회성)
 *
 * `DEFAULT_DEMO_EMAIL` 이 `@tourlint.example` → `@tourlint.kr` 로 바뀐 작업본으로 시드를
 * 돌려 **데모 계정이 둘이 됐다.** 옛 계정에는 NF-PF-001 실측 이력 50건이 들어 있고 새
 * 계정은 비어 있다.
 *
 * **재시드로 고치면 안 된다** — `reseedDemoProducts` 가 상품을 지우고, `audit_run` 이
 * CASCADE 로 함께 지워져 실측 근거가 통째로 날아간다. 이력을 남기려면 자리에서 고쳐야 한다.
 *
 * ## 하는 일
 *
 *   1. 새(빈) 데모 계정을 지운다 — 이메일이 UNIQUE 라 자리를 비워야 옛 계정이 옮겨 간다
 *   2. 옛 계정의 이메일을 새 주소로 바꾼다 (이력 유지)
 *   3. 옛 계정 상품의 `target_key` · `concept_key` 를 한글 라벨에서 코드로 바꾼다 —
 *      `target_profile` 이 코드로 저장돼 있어 라벨로는 R10 이 어느 행도 못 찾는다 (이슈 #310)
 *
 * **빈 계정이 아니면 지우지 않는다.** 검수 이력이 하나라도 있으면 멈춘다 — 어느 쪽이
 * 진짜인지 사람이 정해야 한다.
 */
import { createRequire } from 'node:module';

const OLD_EMAIL = 'openapi@tourlint.example';
const NEW_EMAIL = 'openapi@tourlint.kr';
/** 시드가 한글 라벨을 담고 있던 것 → 픽스처와 같은 코드로 */
const KEY_FIX = [
  { from: '50~60대', target: 'SENIOR', concept: 'HERITAGE' },
  { from: '20대', target: 'YOUTH_20S', concept: 'EMOTIONAL' },
];

const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL;
if (url === undefined || url === '') { console.error('DATABASE_URL 이 없다'); process.exit(1); }

const { Pool } = createRequire(new URL('../apps/api/package.json', import.meta.url))('pg');
const pool = new Pool({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
});

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

try {
  const oldAcc = await one(`SELECT id FROM account WHERE email = $1`, [OLD_EMAIL]);
  const newAcc = await one(`SELECT id FROM account WHERE email = $1`, [NEW_EMAIL]);

  if (oldAcc === undefined) {
    console.log(`\n${OLD_EMAIL} 계정이 없다. 이미 옮겼거나 할 일이 없다.\n`);
    process.exit(0);
  }

  const runsOf = async (id) =>
    Number((await one(
      `SELECT count(*)::text n FROM audit_run r JOIN product p ON p.id = r.product_id WHERE p.account_id = $1`,
      [id])).n);

  const oldRuns = await runsOf(oldAcc.id);
  console.log(`\n계정 ${oldAcc.id} ${OLD_EMAIL} — 검수 이력 ${oldRuns}건  (남긴다)`);

  if (newAcc !== undefined) {
    const newRuns = await runsOf(newAcc.id);
    console.log(`계정 ${newAcc.id} ${NEW_EMAIL} — 검수 이력 ${newRuns}건  (지운다)`);
    if (newRuns > 0) {
      console.error(`\n중단한다 — ${NEW_EMAIL} 에 검수 이력이 ${newRuns}건 있다.`);
      console.error('어느 쪽이 진짜 데모인지 사람이 정해야 한다. 이 스크립트는 빈 계정만 지운다.\n');
      process.exit(1);
    }
  }

  const { rows: products } = await pool.query(
    `SELECT id, name, target_key, concept_key FROM product WHERE account_id = $1 ORDER BY id`, [oldAcc.id]);
  console.log('\n타깃 키를 고칠 상품');
  for (const p of products) {
    const fix = KEY_FIX.find((f) => f.from === p.target_key);
    console.log(`  ${String(p.id).padStart(3)}  ${p.name}`);
    console.log(`       ${p.target_key} · ${p.concept_key}` +
      (fix === undefined ? '   (이미 코드거나 대상 아님)' : `   →  ${fix.target} · ${fix.concept}`));
  }

  if (!APPLY) {
    console.log('\n--apply 를 붙이면 실제로 고친다.\n');
    process.exit(0);
  }

  await pool.query('BEGIN');
  if (newAcc !== undefined) {
    await pool.query(`DELETE FROM account WHERE id = $1`, [newAcc.id]);
    console.log(`\n계정 ${newAcc.id} 삭제`);
  }
  await pool.query(`UPDATE account SET email = $1 WHERE id = $2`, [NEW_EMAIL, oldAcc.id]);
  console.log(`계정 ${oldAcc.id} 이메일 → ${NEW_EMAIL}`);
  for (const f of KEY_FIX) {
    const r = await pool.query(
      `UPDATE product SET target_key = $1, concept_key = $2 WHERE account_id = $3 AND target_key = $4`,
      [f.target, f.concept, oldAcc.id, f.from]);
    if (r.rowCount > 0) console.log(`상품 ${r.rowCount}건  ${f.from} → ${f.target} · ${f.concept}`);
  }
  await pool.query('COMMIT');
  console.log(`\n끝. 검수 이력 ${oldRuns}건은 그대로다.\n`);
} catch (e) {
  await pool.query('ROLLBACK').catch(() => {});
  console.error('실패 — 되돌렸다:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
