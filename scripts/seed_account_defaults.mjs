#!/usr/bin/env node
/**
 * 계정 기본 데이터 채우기 (DR-CF-002).
 *
 * 회원가입 트랜잭션이 만드는 것과 같은 것을 **이미 있는 계정에** 넣는다.
 *
 *   DATABASE_URL=... node scripts/seed_account_defaults.mjs --check
 *   DATABASE_URL=... node scripts/seed_account_defaults.mjs
 *   DATABASE_URL=... node scripts/seed_account_defaults.mjs --account 3
 *
 * 왜 필요한가 — 기본 데이터를 넣는 코드가 회원가입 경로에만 있어서, 그 전에 만들어진
 * 계정(데모 포함)에는 없다. 없으면 이렇게 된다.
 *
 *   `target_profile` 없음      R10 이 타깃 · 콘셉트를 적은 상품을 전부 확인 불가로 판정
 *   `indoor_outdoor_map` 없음  R09 가 상수로 돌아감 — 설정 화면에서 고쳐도 안 바뀜
 *   `dwell_default` 없음       체류시간 보완이 상수로 돌아감
 *
 * 이미 있는 행은 건드리지 않는다(`ON CONFLICT DO NOTHING`). 사용자가 설정 화면에서 고친
 * 값을 시드가 덮으면 안 된다.
 */
import { createRequire } from 'node:module';
import {
  DWELL_MINUTES_SEED, INDOOR_OUTDOOR_SEED, TARGET_PROFILE_SEED,
} from '../packages/shared/dist/index.js';

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const onlyIdx = args.indexOf('--account');
const ONLY = onlyIdx >= 0 ? Number(args[onlyIdx + 1]) : null;

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  console.error('DATABASE_URL 이 없다');
  process.exit(1);
}
// `pg` 는 루트가 아니라 `apps/api` 에 있다 (pnpm 워크스페이스)
const { Pool } = createRequire(new URL('../apps/api/package.json', import.meta.url))('pg');
const pool = new Pool({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
});

const EXPECTED = {
  target_profile: TARGET_PROFILE_SEED.length,
  indoor_outdoor_map: Object.keys(INDOOR_OUTDOOR_SEED).length,
  dwell_default: Object.keys(DWELL_MINUTES_SEED).length,
  user_setting: 1,
};

try {
  const { rows: accounts } = await pool.query(
    ONLY === null
      ? `SELECT id, email, is_demo FROM account ORDER BY id`
      : `SELECT id, email, is_demo FROM account WHERE id = $1`,
    ONLY === null ? [] : [ONLY],
  );
  if (accounts.length === 0) {
    console.log(ONLY === null ? '계정이 없다.' : `계정 ${ONLY} 이 없다.`);
    process.exit(0);
  }

  for (const a of accounts) {
    const counts = {};
    for (const table of Object.keys(EXPECTED)) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE account_id = $1`, [a.id]);
      counts[table] = rows[0].n;
    }
    const short = Object.entries(EXPECTED).filter(([t, n]) => counts[t] < n);
    const mark = short.length === 0 ? 'ok' : short.map(([t, n]) => `${t} ${counts[t]}/${n}`).join(' · ');
    console.log(`  계정 ${a.id}${a.is_demo ? ' (데모)' : ''} ${a.email} — ${mark}`);

    if (CHECK || short.length === 0) continue;

    await pool.query('BEGIN');
    try {
      await pool.query(
        `INSERT INTO user_setting (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`, [a.id]);
      await pool.query(
        `INSERT INTO target_profile (account_id, target_key, concept_key, expected_lcls2, expects_night)
         SELECT $1, t.target_key, t.concept_key, string_to_array(t.codes, ','), t.expects_night
           FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[])
             AS t(target_key, concept_key, codes, expects_night)
         ON CONFLICT (account_id, target_key, concept_key) DO NOTHING`,
        [a.id,
         TARGET_PROFILE_SEED.map((p) => p.targetKey),
         TARGET_PROFILE_SEED.map((p) => p.conceptKey),
         TARGET_PROFILE_SEED.map((p) => p.expectedLcls2.join(',')),
         TARGET_PROFILE_SEED.map((p) => p.expectsNight)],
      );
      await pool.query(
        `INSERT INTO indoor_outdoor_map (account_id, lcls_systm2, space_type)
         SELECT $1, t.code, t.kind FROM unnest($2::text[], $3::text[]) AS t(code, kind)
         ON CONFLICT (account_id, lcls_systm2) DO NOTHING`,
        [a.id, Object.keys(INDOOR_OUTDOOR_SEED), Object.values(INDOOR_OUTDOOR_SEED)],
      );
      await pool.query(
        `INSERT INTO dwell_default (account_id, lcls_systm2, minutes)
         SELECT $1, t.code, t.minutes FROM unnest($2::text[], $3::int[]) AS t(code, minutes)
         ON CONFLICT (account_id, lcls_systm2) DO NOTHING`,
        [a.id, Object.keys(DWELL_MINUTES_SEED), Object.values(DWELL_MINUTES_SEED)],
      );
      await pool.query('COMMIT');
      console.log(`     → 채웠다`);
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }
  }
  if (CHECK) console.log('--check 라 쓰지 않았다.');
} finally {
  await pool.end();
}
