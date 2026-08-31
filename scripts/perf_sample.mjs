#!/usr/bin/env node
/**
 * NF-PF-001 표본 수집 — 배포된 API 에 검수를 반복 요청하고 실행 시간을 잰다.
 *
 *   API_BASE_URL=https://... PERF_EMAIL=... PERF_PASSWORD=... \
 *     node scripts/perf_sample.mjs --product 3 --product 1 --runs 3
 *
 * **공사를 부른다.** 회당 8곳 29콜 · 12곳 43콜이라 표본이 곧 예산이다. `--yes` 없이는
 * 예상 호출량만 계산하고 멈춘다.
 *
 * 왜 스크립트인가 — NF-PF-020 이 「정식 배포된 실제 환경」을 요구하고 측정 방법은 각 20회다.
 * 화면에서 스무 번 누를 수 없고, 로컬에서 잰 값은 근거로 쓰지 못한다.
 *
 * 여기서 찍는 시간은 **참고값**이다. 왕복 지연이 섞여 있다. 판정에 쓰는 값은
 * `audit_job.created_at → finished_at` 이며 `scripts/perf_report.mjs` 가 그것을 읽는다.
 *
 * 자격 증명은 환경변수로만 받는다. 파일에 적지 않는다 (PM-TA-008).
 */

const BASE = (process.env.API_BASE_URL ?? '').replace(/\/+$/, '');
const EMAIL = process.env.PERF_EMAIL ?? '';
const PASSWORD = process.env.PERF_PASSWORD ?? '';

const args = process.argv.slice(2);
const YES = args.includes('--yes');
const products = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--product') products.push(Number(args[i + 1]));
}
const runsIdx = args.indexOf('--runs');
const RUNS = runsIdx === -1 ? 3 : Number(args[runsIdx + 1]);

if (BASE === '') die('API_BASE_URL 이 없다');
if (EMAIL === '' || PASSWORD === '') die('PERF_EMAIL · PERF_PASSWORD 가 없다');
if (products.length === 0) die('--product <id> 를 하나 이상 줘라');
if (!Number.isInteger(RUNS) || RUNS <= 0) die('--runs 는 양의 정수다');
if (products.some((p) => !Number.isInteger(p) || p <= 0)) die('--product 는 양의 정수다');

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, q) => {
  if (sorted.length === 0) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

let cookie = '';

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cookie === '' ? {} : { cookie }),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    if (c.startsWith('tourlint_session=')) cookie = c.split(';')[0];
  }
  const text = await res.text();
  let body = null;
  try { body = text === '' ? null : JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/** 한 번 검수하고 DONE 까지 기다린다. 반환은 초. */
async function runOnce(productId) {
  const started = Date.now();
  const created = await call(`/api/v1/products/${productId}/audit-jobs`, {
    method: 'POST',
    body: JSON.stringify({ triggerType: 'MANUAL' }),
  });
  if (created.status === 429) return { error: 'BUDGET_EXHAUSTED', fatal: true };
  if (created.status !== 202) {
    return { error: `POST ${created.status} ${JSON.stringify(created.body)}`, fatal: created.status === 401 };
  }
  const jobId = created.body?.jobId;
  if (typeof jobId !== 'number') return { error: 'jobId 가 없다', fatal: true };

  // uq_job_active 때문에 진행 중이면 기존 job 을 돌려받는다. 끝날 때까지 다음 요청을 내지 않는다.
  for (;;) {
    await sleep(2000);
    const polled = await call(`/api/v1/audit-jobs/${jobId}`);
    if (polled.status !== 200) return { error: `GET ${polled.status}`, fatal: false };
    const { status, progress, auditRunId, errorCode } = polled.body ?? {};
    if (status === 'DONE') {
      return { jobId, auditRunId, total: progress?.total ?? null, seconds: (Date.now() - started) / 1000 };
    }
    if (status === 'FAILED') return { jobId, error: `FAILED ${errorCode ?? ''}`.trim(), fatal: false };
    if (Date.now() - started > 180_000) return { jobId, error: '180초 초과 — 폴링 중단', fatal: false };
  }
}

// ── 예산 예상 ──
// 8곳 29콜 · 12곳 43콜 (NF-PF 2-1 · EI-KM-006). 실제 곳 수는 첫 회차에 드러난다.
const worstPerRun = 43;
const estimate = products.length * RUNS * worstPerRun;
console.log(`\n대상 상품 ${products.join(' · ')} · 각 ${RUNS}회`);
console.log(`예상 호출량 최대 ${estimate}콜 (회당 최대 43콜 기준 · 일일 예산 800)\n`);
if (!YES) {
  console.log('실행하려면 --yes 를 붙여라. 붙이기 전에는 아무것도 부르지 않는다.\n');
  process.exit(0);
}

const login = await call('/api/v1/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (login.status !== 200) die(`로그인 실패 ${login.status}`);
// 200 인데 쿠키를 못 집으면 이후 호출이 전부 401 로 흐른다. 여기서 끊는 편이 낫다.
if (cookie === '') die('로그인은 200 인데 세션 쿠키를 받지 못했다 — Set-Cookie 를 확인해라');
console.log('로그인 완료\n');

const summary = [];
for (const productId of products) {
  console.log(`── 상품 ${productId} ──`);
  const seconds = [];
  let total = null;
  for (let i = 1; i <= RUNS; i += 1) {
    const r = await runOnce(productId);
    if (r.error !== undefined) {
      console.log(`  ${String(i).padStart(2)}회  실패 — ${r.error}`);
      if (r.fatal) { console.log('\n치명적이라 중단한다.'); break; }
      continue;
    }
    total = r.total;
    seconds.push(r.seconds);
    console.log(`  ${String(i).padStart(2)}회  ${r.seconds.toFixed(1)}초  (job ${r.jobId} · run ${r.auditRunId} · ${r.total}곳)`);
  }
  const sorted = [...seconds].sort((a, b) => a - b);
  summary.push({ productId, total, n: sorted.length, p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), max: sorted.at(-1) ?? null });
  console.log('');
}

console.log('── 요약 (왕복 지연 포함 · 참고값) ──');
for (const s of summary) {
  const target = s.total !== null && s.total <= 8 ? 15 : 20;
  const note = s.n < 20 ? `표본 ${s.n}건 — p95 라고 부르기엔 적다` : `목표 ${target}초`;
  const fmt = (v) => (v === null ? '—' : `${v.toFixed(1)}초`);
  console.log(`  상품 ${s.productId} (${s.total ?? '?'}곳)  n=${s.n}  p50 ${fmt(s.p50)}  p95 ${fmt(s.p95)}  최대 ${fmt(s.max)}  · ${note}`);
}
console.log('\n판정에 쓸 값은 서버 계측이다 — DATABASE_URL=... node scripts/perf_report.mjs --days 1\n');
