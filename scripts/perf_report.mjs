#!/usr/bin/env node
/**
 * 성능 실측 (NF-PF-001 ~ 004 · 007).
 *
 *   DATABASE_URL=... node scripts/perf_report.mjs [--days 7]
 *
 * **공사를 부르지 않는다.** 이미 쌓인 `audit_job` · `api_call_log` 를 읽는다 — 검수 한 번이
 * 29~43콜이라 재려고 돌리면 그것만으로 하루 예산이 나간다.
 *
 * `audit_job.created_at → finished_at` 이 검수 1회 실행 시간이고 (NF-PF-001),
 * `api_call_log.latency_ms` 가 그 안의 외부 호출 몫이다.
 */
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const days = daysIdx === -1 ? 30 : Number(args[daysIdx + 1]);
if (!Number.isFinite(days) || days <= 0) {
  console.error('--days 는 양수다');
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

const since = `now() - interval '${days} days'`;
/**
 * 목표 대비 판정. 표본이 적으면 p95 라고 부르지 않는다.
 *
 * **숫자로 비교한다.** 문자열로 비교하면 `"100초" <= "20초"` 가 참이 되어(사전순 `'1' < '2'`)
 * 미달이 통과로 찍힌다. `pg` 가 `numeric` 을 문자열로 돌려주므로 조용히 섞이기 쉽다.
 * 단위는 표시할 때만 붙인다.
 */
const verdict = (value, target, n, unit = '초') => {
  if (value === null) return '표본 없음';
  const v = Number(value);
  // 숫자로 못 읽으면 통과로 넘기지 않는다. 판정 도구가 침묵하는 것이 제일 나쁘다
  if (!Number.isFinite(v)) return `${String(value)}${unit} (숫자로 못 읽었다 — 판정 불가)`;
  if (n < 20) return `${v}${unit} (표본 ${n}건 — p95 라고 부르기엔 적다)`;
  return `${v}${unit} ${v <= target ? '<=' : '>'} 목표 ${target}${unit}`;
};

try {
  console.log(`\n최근 ${days}일\n`);

  // ── NF-PF-001 검수 1회 실행 완료 시간 ──
  const { rows: byBucket } = await pool.query(`
    SELECT CASE WHEN progress_total <= 8 THEN '8곳 이하' ELSE '9곳 이상' END AS bucket,
           count(*)::int                                                    AS n,
           round(percentile_cont(0.50) WITHIN GROUP (
             ORDER BY extract(epoch FROM finished_at - created_at))::numeric, 1) AS p50,
           round(percentile_cont(0.95) WITHIN GROUP (
             ORDER BY extract(epoch FROM finished_at - created_at))::numeric, 1) AS p95,
           round(max(extract(epoch FROM finished_at - created_at))::numeric, 1)  AS worst
      FROM audit_job
     WHERE status = 'DONE' AND finished_at IS NOT NULL AND created_at > ${since}
     GROUP BY 1 ORDER BY 1`);

  console.log('[NF-PF-001] 검수 1회 실행 완료 시간 — 목표 8곳 이하 p95 15초 · 그 이상 20초');
  if (byBucket.length === 0) console.log('  완료된 검수가 없다');
  for (const r of byBucket) {
    const target = r.bucket === '8곳 이하' ? 15 : 20;
    console.log(`  ${r.bucket}: ${r.n}건 · p50 ${r.p50}초 · p95 ${verdict(r.p95, target, r.n)} · 최악 ${r.worst}초`);
  }

  // ── 검수 한 건이 실제로 몇 콜인가 (명세 추정 29~43) ──
  const { rows: perRun } = await pool.query(`
    SELECT round(avg(c)::numeric, 1) AS mean, min(c) AS lo, max(c) AS hi, count(*)::int AS runs
      FROM (SELECT audit_run_id, count(*)::int AS c
              FROM api_call_log
             WHERE audit_run_id IS NOT NULL AND called_at > ${since}
             GROUP BY audit_run_id) t`);
  const pr = perRun[0];
  console.log(`\n[호출 수] 검수 1건당 — 명세 추정 29~43콜`);
  console.log(pr?.runs > 0
    ? `  실측 ${pr.runs}회 · 평균 ${pr.mean}콜 · ${pr.lo}~${pr.hi}콜`
    : '  검수에 붙은 호출 기록이 없다');

  // ── 외부 호출 지연 ──
  const { rows: calls } = await pool.query(`
    SELECT provider, operation, count(*)::int AS n,
           round(percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)::numeric) AS p50,
           round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::numeric) AS p95,
           max(latency_ms) AS worst,
           count(*) FILTER (WHERE status <> 'OK')::int AS bad
      FROM api_call_log WHERE called_at > ${since}
     GROUP BY 1,2 ORDER BY n DESC LIMIT 20`);

  console.log('\n[외부 호출] 오퍼레이션별 지연 (ms)');
  if (calls.length === 0) console.log('  호출 기록이 없다');
  for (const c of calls) {
    console.log(
      `  ${c.provider.padEnd(15)} ${c.operation.padEnd(22)} ${String(c.n).padStart(5)}건`
      + ` · p50 ${String(c.p50).padStart(5)} · p95 ${String(c.p95).padStart(6)} · 최악 ${String(c.worst).padStart(6)}`
      + (c.bad > 0 ? `  실패 ${c.bad}건` : ''),
    );
  }
} finally {
  await pool.end();
}
