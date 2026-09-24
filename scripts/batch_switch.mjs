#!/usr/bin/env node
/**
 * 운영 전역 설정 스위치 — 배치 두 값과 일일 예산 (FR-MO-010 · FR-OP-003).
 *
 *   DATABASE_URL=... node scripts/batch_switch.mjs              현재 상태만 본다
 *   DATABASE_URL=... node scripts/batch_switch.mjs --on
 *   DATABASE_URL=... node scripts/batch_switch.mjs --off
 *   DATABASE_URL=... node scripts/batch_switch.mjs --time 07:30
 *   DATABASE_URL=... node scripts/batch_switch.mjs --quota 8000
 *
 * `system_setting.batch_enabled` 는 기본이 `FALSE` 라 배포만으로는 배치가 안 돈다.
 * 스케줄러는 깨어나서 "배치가 꺼져 있다" 만 남긴다.
 *
 * **시연 전에 끄는 데도 쓴다.** 일일 예산 중 배치가 먼저 먹는 몫을 0 으로 만든다.
 *
 * `daily_quota` 는 **국문 관광정보 몫**이고 운영자만 바꾼다 — 설정 API 는 계정 설정만
 * 다루고 이 행을 쓰는 경로가 저장소에 여기뿐이다. 값은 공사 한도의 80% 로 둔다
 * (트래픽 증설로 10,000 이 되어 8,000 · 2026-09-17). 증설은 2026-10-11 까지라 10-12 부터는
 * 이 값이 800 을 넘어도 코드가 800 으로 누른다(`korDailyQuota` · #777) — 그날 여기서 낮추지 않아도
 * 된다. 새 서비스 5종은 `extraServiceDailyCap()` 으로 따로 센다 — 여기서 바꾸는 값과 무관하다.
 */
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const timeIdx = args.indexOf('--time');
const time = timeIdx === -1 ? null : args[timeIdx + 1];
const on = args.includes('--on');
const off = args.includes('--off');
const quotaIdx = args.indexOf('--quota');
const quota = quotaIdx === -1 ? null : Number(args[quotaIdx + 1]);

if (on && off) {
  console.error('--on 과 --off 를 같이 줄 수 없다');
  process.exit(1);
}
if (timeIdx !== -1 && !/^\d{2}:\d{2}$/.test(time ?? '')) {
  console.error('--time 은 HH:MM 이다 (예: 05:00)');
  process.exit(1);
}
// `ck_sys_quota` 가 1 – 100,000 이다. 여기서 먼저 걸러야 DB 오류 대신 뜻이 있는 말이 나온다
if (quotaIdx !== -1 && (!Number.isInteger(quota) || quota < 1 || quota > 100000)) {
  console.error('--quota 는 1 – 100000 의 정수다 (예: 8000)');
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  console.error('DATABASE_URL 이 없다');
  process.exit(1);
}

// `pg` 도 `@tourlint/shared` 도 루트가 아니라 `apps/api` 에 있다 (pnpm 워크스페이스)
const fromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool } = fromApi('pg');

/*
 * 기본값은 앱이 보는 상수를 그대로 읽는다. 여기 박아 두면 앱만 바뀌었을 때 이 도구가
 * 다른 숫자를 말한다 — 실제로 예산이 800 에서 8000 이 될 때 그랬다 (#450).
 * `packages/shared/dist` 가 있어야 하므로 없으면 조용히 기본값을 지어내지 않고 멈춘다.
 */
let DEFAULTS;
try {
  ({ SYSTEM_SETTING_DEFAULTS: DEFAULTS } = fromApi('@tourlint/shared'));
} catch {
  console.error('@tourlint/shared 를 못 읽었다 — pnpm build 를 먼저 돌린다');
  process.exit(1);
}
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
  /*
   * 감시 대상 상품 수. 이게 0 이면 알림 0건은 정상이다 — 변경이 몇 건이든 닿을 곳이 없다.
   * 출발일이 지난 상품은 감시에서 빠진다 (FR-MO-018).
   */
  const products = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (
              WHERE p.start_date + p.nights >= (now() AT TIME ZONE 'Asia/Seoul')::date
            )::int AS watched,
            count(*) FILTER (
              WHERE p.start_date + p.nights >= (now() AT TIME ZONE 'Asia/Seoul')::date
                AND EXISTS (SELECT 1 FROM itinerary_item i
                             WHERE i.product_id = p.id AND i.match_status = 'CONFIRMED')
            )::int AS with_items
       FROM product p`,
  );
  console.log(`\n[${label}]`);
  if (setting.rows.length === 0) {
    // 행이 없으면 앱이 기본값으로 돈다 — batch_enabled 가 false 라 배치는 안 돈다
    const d = `${DEFAULTS.batchTime} · ${DEFAULTS.batchEnabled ? '켜짐' : '꺼짐'} · ${DEFAULTS.dailyQuota}건/일`;
    console.log(`  system_setting: 행 없음 (앱이 기본값 ${d} 로 본다)`);
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
  const p = products.rows[0];
  console.log(`  알림 누적 ${n.total}건 (최근 24시간 ${n.recent}건)`);
  console.log(
    `  감시 상품 ${p.watched}개 / 전체 ${p.total}개 · 그중 확정 일정이 있는 것 ${p.with_items}개`
    + (p.watched === 0 ? '   <- 0 이면 알림이 안 생기는 게 정상이다' : ''),
  );
}

try {
  await show('지금');

  if (!on && !off && time === null && quota === null) {
    console.log('\n바꾸려면 --on / --off / --time HH:MM / --quota N 을 준다.');
    process.exit(0);
  }

  /*
   * 행이 없을 수도 있어 upsert 한다. `key` 가 UNIQUE 라 두 번 돌려도 하나다.
   * 안 준 항목은 COALESCE 로 기존 값을 지킨다 — --time 만 줬는데 켜지면 사고다.
   */
  await pool.query(
    `INSERT INTO system_setting (key, batch_time, batch_enabled, daily_quota)
     VALUES ('global', COALESCE($1::time, $4::time), COALESCE($2::boolean, $5::boolean), COALESCE($3::int, $6::int))
     ON CONFLICT (key) DO UPDATE SET
       batch_time    = COALESCE($1::time, system_setting.batch_time),
       batch_enabled = COALESCE($2::boolean, system_setting.batch_enabled),
       daily_quota   = COALESCE($3::int, system_setting.daily_quota)`,
    [time, on ? true : off ? false : null, quota, DEFAULTS.batchTime, DEFAULTS.batchEnabled, DEFAULTS.dailyQuota],
  );

  await show('바꾼 뒤');
} finally {
  await pool.end();
}
