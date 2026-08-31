#!/usr/bin/env node
/**
 * 방금 뜬 표본이 「진짜 일을 한 검수」인지 본다 (읽기 전용).
 *
 *   DATABASE_URL=... node scripts/perf_verify.mjs [--days 1]
 *
 * 빠른 검수는 두 가지다 — 정말 빠른 것과, 외부 호출이 전부 실패해 격리된 것.
 * 실패 격리는 설계상 조용히 끝나므로(EX-CM-001) 시간만 보면 구분이 안 된다.
 * `failed_count` · `is_partial` · 실제 호출 수를 실행별로 나란히 놓는다.
 */
import { createRequire } from 'node:module';

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') { console.error('DATABASE_URL 이 없다'); process.exit(1); }
const i = process.argv.indexOf('--days');
const days = i === -1 ? 1 : Number(process.argv[i + 1]);

const { Pool } = createRequire(new URL('../apps/api/package.json', import.meta.url))('pg');
const pool = new Pool({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
});

try {
  const { rows } = await pool.query(`
    SELECT r.id, r.product_id, r.target_count, r.failed_count, r.is_partial,
           r.readiness_score, r.travel_seconds, r.travel_meters,
           j.id AS job_id,
           round(extract(epoch FROM j.finished_at - j.created_at)::numeric, 2) AS server_seconds,
           (SELECT count(*)::int FROM api_call_log l
             WHERE l.audit_run_id = r.id)                                        AS calls,
           (SELECT count(*)::int FROM api_call_log l
             WHERE l.audit_run_id = r.id AND l.status <> 'OK')                   AS call_errors,
           (SELECT count(*)::int FROM finding f WHERE f.audit_run_id = r.id)     AS findings
      FROM audit_run r
      JOIN audit_job j ON j.audit_run_id = r.id
     WHERE r.executed_at > now() - interval '${days} days'
     ORDER BY r.id`);

  console.log('\nrun  상품  대상  실패  부분  점수  이동(초/m)      서버시간  호출  오류  finding');
  for (const r of rows) {
    console.log(
      `${String(r.id).padStart(3)}  ${String(r.product_id).padStart(4)}  ` +
      `${String(r.target_count).padStart(4)}  ${String(r.failed_count).padStart(4)}  ` +
      `${r.is_partial ? ' 예 ' : ' 아뇨'}  ${String(r.readiness_score ?? '—').padStart(4)}  ` +
      `${String(r.travel_seconds ?? '—').padStart(6)}/${String(r.travel_meters ?? '—').padEnd(7)}  ` +
      `${String(r.server_seconds ?? '—').padStart(8)}  ${String(r.calls).padStart(4)}  ` +
      `${String(r.call_errors).padStart(4)}  ${String(r.findings).padStart(7)}`,
    );
  }
  if (rows.length === 0) console.log('  (실행 없음)');

  const { rows: byOp } = await pool.query(`
    SELECT provider, operation, count(*)::int AS n,
           round(avg(latency_ms)::numeric, 0) AS avg_ms,
           count(*) FILTER (WHERE status <> 'OK')::int AS errors
      FROM api_call_log
     WHERE called_at > now() - interval '${days} days'
     GROUP BY provider, operation ORDER BY n DESC`);
  console.log('\n오퍼레이션별 (최근 ' + days + '일)');
  for (const o of byOp) {
    console.log(`  ${String(o.provider).padEnd(6)} ${String(o.operation).padEnd(22)} ${String(o.n).padStart(4)}회  평균 ${String(o.avg_ms).padStart(5)}ms  오류 ${o.errors}`);
  }

  const { rows: [q] } = await pool.query(`
    SELECT count(*)::int AS today FROM api_call_log
     WHERE quota_date = (now() AT TIME ZONE 'Asia/Seoul')::date`);
  console.log(`\n오늘 사용한 호출: ${q.today} / 800\n`);
} finally {
  await pool.end();
}
