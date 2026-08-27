#!/usr/bin/env node
/**
 * 경량 배치 스위치 (FR-MO-010).
 *
 *   DATABASE_URL=... node scripts/batch_switch.mjs              현재 상태만 본다
 *   DATABASE_URL=... node scripts/batch_switch.mjs --on
 *   DATABASE_URL=... node scripts/batch_switch.mjs --off
 *   DATABASE_URL=... node scripts/batch_switch.mjs --time 07:30
 *
 * `system_setting.batch_enabled` 는 기본이 `FALSE` 라 배포만으로는 배치가 안 돈다.
 * 스케줄러는 깨어나서 "배치가 꺼져 있다" 만 남긴다.
 *
 * **시연 전에 끄는 데도 쓴다.** 일일 800건 중 배치가 먼저 먹는 몫을 0 으로 만든다.
 */
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const timeIdx = args.indexOf('--time');
const time = timeIdx === -1 ? null : args[timeIdx + 1];
const on = args.includes('--on');
const off = args.includes('--off');

if (on && off) {
  console.error('--on 과 --off 를 같이 줄 수 없다');
  process.exit(1);
}
if (timeIdx !== -1 && !/^\d{2}:\d{2}$/.test(time ?? '')) {
  console.error('--time 은 HH:MM 이다 (예: 05:00)');
  process.exit(1);
}

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

async function show(label) {
  const setting = await pool.query(
    `SELECT batch_time, batch_enabled, daily_quota FROM system_setting WHERE key = 'global'`,
  );
  /*
   * 날짜 형식을 SQL 에서 만든다. `DATE` · `TIMESTAMPTZ` 를 드라이버가 주는 `Date` 로 받아
   * 여기서 찍으면 실행하는 사람 시간대에 따라 하루가 밀린다.
   */
  const state = await pool.query(
    `SELECT key,
            to_char(last_covered, 'YYYY-MM-DD')                             AS last_covered,
            to_char(last_run_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') AS last_run_at,
            last_status, last_item_count
       FROM batch_state`,
  );
  const notif = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS recent
       FROM notification`,
  );
  console.log(`\n[${label}]`);
  if (setting.rows.length === 0) {
    // 행이 없으면 앱이 기본값으로 돈다 — batch_enabled 가 false 라 배치는 안 돈다
    console.log('  system_setting: 행 없음 (앱이 기본값 05:00 · 꺼짐 · 800 으로 본다)');
  } else {
    const s = setting.rows[0];
    console.log(`  배치: ${s.batch_enabled ? '켜짐' : '꺼짐'} · 시각 ${String(s.batch_time).slice(0, 5)} KST · 예산 ${s.daily_quota}건/일`);
  }
  for (const r of state.rows) {
    console.log(
      `  기준일 ${r.last_covered ?? '없음'} · 마지막 실행 ${r.last_run_at ?? '없음'} KST`
      + ` · ${r.last_status ?? '-'} · 변경 ${r.last_item_count ?? '-'}건   [${r.key}]`,
    );
  }
  if (state.rows.length === 0) console.log('  batch_state: 행 없음');

  // 2단계가 실제로 뭔가 찾았는지. 변경 건수만 보면 알 수 없다
  const n = notif.rows[0];
  console.log(`  알림 누적 ${n.total}건 (최근 24시간 ${n.recent}건)`);
}

try {
  await show('지금');

  if (!on && !off && time === null) {
    console.log('\n바꾸려면 --on / --off / --time HH:MM 을 준다.');
    process.exit(0);
  }

  /*
   * 행이 없을 수도 있어 upsert 한다. `key` 가 UNIQUE 라 두 번 돌려도 하나다.
   * 안 준 항목은 COALESCE 로 기존 값을 지킨다 — --time 만 줬는데 켜지면 사고다.
   */
  await pool.query(
    `INSERT INTO system_setting (key, batch_time, batch_enabled)
     VALUES ('global', COALESCE($1::time, '05:00'), COALESCE($2::boolean, FALSE))
     ON CONFLICT (key) DO UPDATE SET
       batch_time    = COALESCE($1::time, system_setting.batch_time),
       batch_enabled = COALESCE($2::boolean, system_setting.batch_enabled)`,
    [time, on ? true : off ? false : null],
  );

  await show('바꾼 뒤');
} finally {
  await pool.end();
}
