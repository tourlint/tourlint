import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service';

/**
 * 무저장 원칙 전수 검사 — DB 명세서 6-4 가 지정한 검증 ①·② (이슈 #360).
 *
 * > ① 시연 상품 검수 1회 실행 후 **DB 전체에서 관광지명·주소 문자열 검색 → 0건**
 * >   (`place_label`은 사용자 입력이므로 제외)
 * > ② 같은 조건에서 **로그 파일 전수 검색 → `restdate`·`overview` 문장 0건**
 *
 * ## needle 을 왜 이렇게 고르는가
 *
 * **관광지명으로는 판정할 수 없다.** 시연 상품의 `place_label` 이 실제 이름 그대로
 * 입력돼 있어서, 이름으로 훑으면 `finding.message` 처럼 사용자 입력을 담은 자리가 전부
 * 위반처럼 보인다. 사용자가 친 것과 공사가 준 것은 문자열로 구분되지 않는다.
 *
 * 그래서 두 갈래로 나눈다.
 *   - `addr1` · `restdate` · `overview` · `usetime` — **사용자가 입력할 일이 없다.** 그대로 쓴다
 *   - `title` — DB 의 `place_label` 에 없는 것만 쓴다
 *
 * ## 왜 10자 이상인가
 *
 * 우리가 정규화 결과로 **만든** 문구가 원문과 우연히 같아지는 경우가 있다. R01 은
 * `weeklyClosed: ['TUE']` 를 `매주 ${KOREAN_DAY[dow]}요일 휴무` 로 렌더하는데, 어떤
 * 콘텐츠의 `restdate` 가 마침 `매주 화요일` 이라 6자가 겹쳤다. 한국어로 그 뜻을 적는
 * 방법이 하나뿐이라 생기는 충돌이지 원문을 실은 것이 아니다.
 *
 * 6-4 가 찾으라는 것은 **문장**이다 (`restdate`·`overview` 문장 0건). 짧은 관용구는
 * 빼고 10자 이상만 본다. 이 선에서 `매주 화요일` 은 빠지고 `매주 화요일 / 설·추석 당일`
 * 같은 실제 원문 조각은 남는다.
 */

const URL = process.env.TEST_DATABASE_URL;
if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

const FIXTURES = join(__dirname, '../../../fixtures/kto');
/** 짧은 관용구는 우리 템플릿이 똑같이 만들어 낸다. 위 주석 참고 */
const MIN_NEEDLE = 10;
/** 사용자가 입력할 수 없는 공사 원문 필드 */
const SOURCE_ONLY = new Set([
  'addr1', 'addr2', 'restdate', 'restdatefood', 'overview', 'usetime', 'opentimefood',
]);

function collectFromFixtures(): { sourceOnly: string[]; titles: string[] } {
  const sourceOnly = new Set<string>();
  const titles = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v === null || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string' && val.trim().length >= MIN_NEEDLE) {
        if (SOURCE_ONLY.has(k)) sourceOnly.add(val.trim());
        if (k === 'title') titles.add(val.trim());
      }
      walk(val);
    }
  };
  for (const f of readdirSync(FIXTURES)) {
    if (!f.endsWith('.json')) continue;
    try {
      walk(JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')));
    } catch {
      // 픽스처가 아닌 파일은 건너뛴다
    }
  }
  return { sourceOnly: [...sourceOnly], titles: [...titles] };
}

/** `place_label` 은 사용자 입력이라 제외한다. 스냅샷 JSON 안의 것도 같다 (6-4 검증 ①) */
function stripUserLabels(raw: string): string {
  if (!raw.startsWith('{') && !raw.startsWith('[')) return raw;
  const drop = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(drop);
    if (v === null || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'placeLabel' || k === 'place_label') continue;
      out[k] = drop(val);
    }
    return out;
  };
  try {
    return JSON.stringify(drop(JSON.parse(raw)));
  } catch {
    return raw;
  }
}

describe.skipIf(URL === undefined)('무저장 원칙 전수 검사 (DB 명세서 6-4)', () => {
  let pool: Pool;
  let service: AuditService;
  let accountId: number;
  let productId: number;
  let logs: string[];
  /** 훑은 값의 개수. 0 이면 검사가 데이터를 못 읽은 것이므로 통과로 보면 안 된다 */
  let scanned = 0;
  let needles: string[] = [];

  beforeAll(async () => {
    process.env.KTO_MODE = 'fixture';
    process.env.KTO_FIXTURE_DIR = FIXTURES;
    process.env.KAKAO_MODE = 'fixture';
    process.env.KAKAO_FIXTURE_DIR = join(__dirname, '../../../fixtures/kakao');
    pool = new Pool({ connectionString: URL, max: 4 });
    service = new AuditService(pool);

    const acc = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1,'x') RETURNING id`,
      [`no-store-${String(process.pid)}@example.com`],
    );
    accountId = Number(acc.rows[0]?.id);
    const prod = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport)
       VALUES ($1,'무저장 검증 1박 2일','51', DATE '2026-10-13', 1, 'CAR') RETURNING id`,
      [accountId],
    );
    productId = Number(prod.rows[0]?.id);

    /*
     * 휴무일·운영시간 원문이 실려 오는 콘텐츠를 고른다. 원문이 없는 상품으로 돌리면
     * 검사가 찾을 것이 없어 무조건 초록이 된다.
     */
    const items: ReadonlyArray<[number, number, string, string, string, string, string, number, string]> = [
      [1, 1, '10:00', '11:30', 'SIGHT', '경복궁', '126508', 12, 'HS01'],
      [1, 2, '12:00', '13:00', 'MEAL', '가람집옹심이', '2868839', 39, 'FD01'],
      [2, 1, '09:00', '10:00', 'SIGHT', '오죽헌', '129784', 14, 'VE07'],
    ];
    for (const [day, seq, start, end, type, label, contentId, ctid, lcls] of items) {
      await pool.query(
        `INSERT INTO itinerary_item
           (product_id, day_no, seq, start_time, end_time, end_time_source, place_label,
            item_type, kto_content_id, content_type_id, lcls_systm2, mapx, mapy, match_status)
         VALUES ($1,$2,$3,$4::time,$5::time,'INPUT',$6,$7,$8,$9,$10,128.8961,37.7952,'CONFIRMED')`,
        [productId, day, seq, start, end, label, type, contentId, ctid, lcls],
      );
    }

    // ── 검수 1회. 그동안 나온 로그를 전부 모은다 (검증 ②) ──────────────────
    logs = [];
    /*
     * **`console` 을 직접 가로챈다.** `process.stdout.write` 만 감싸면 아무것도 못 잡는다 —
     * vitest 가 `console` 을 자기 리포터로 가로채기 때문에 그 호출은 stdout 으로 안 간다.
     * 처음에 stdout 만 감쌌다가, 어댑터에 `console.log("KTO response: " + body)` 를 일부러
     * 넣고 돌렸는데 초록으로 통과했다. Nest 의 `Logger` 도 결국 `console` 을 쓴다.
     */
    const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
    const real: Partial<Record<(typeof methods)[number], (...a: unknown[]) => void>> = {};
    const outWrite = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    const tapStream = (target: typeof outWrite): typeof outWrite =>
      ((chunk: unknown, ...rest: unknown[]) => {
        logs.push(typeof chunk === 'string' ? chunk : String(chunk));
        return (target as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof outWrite;

    for (const m of methods) {
      real[m] = console[m] as (...a: unknown[]) => void;
      console[m] = (...args: unknown[]): void => {
        logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' '));
      };
    }
    process.stdout.write = tapStream(outWrite);
    process.stderr.write = tapStream(errWrite);
    try {
      await service.requestAudit(productId, 'INITIAL');
      await service.waitForIdle();
    } finally {
      for (const m of methods) {
        const fn = real[m];
        if (fn !== undefined) console[m] = fn as typeof console.log;
      }
      process.stdout.write = outWrite;
      process.stderr.write = errWrite;
    }

    // ── needle 을 만든다 ────────────────────────────────────────────────
    const { sourceOnly, titles } = collectFromFixtures();
    const labels = await pool.query<{ place_label: string }>(`SELECT place_label FROM itinerary_item`);
    const typed = new Set(labels.rows.map((r) => r.place_label));
    needles = [...sourceOnly, ...titles.filter((t) => !typed.has(t))];
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM account WHERE id = $1', [accountId]);
    await pool.end();
  });

  it('needle 과 검수 결과가 실제로 있다 — 빈 검사를 통과로 보지 않는다', async () => {
    expect(needles.length).toBeGreaterThan(50);
    const runs = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM audit_run WHERE product_id = $1`, [productId],
    );
    expect(Number(runs.rows[0]?.n)).toBeGreaterThan(0);
  });

  it('① DB 전체에 공사 원문이 없다', async () => {
    const cols = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='public' AND data_type IN ('text','character varying','jsonb','json')
        ORDER BY table_name, ordinal_position`,
    );
    expect(cols.rowCount).toBeGreaterThan(0);

    const hits: string[] = [];
    scanned = 0;
    for (const { table_name: t, column_name: c } of cols.rows) {
      // 사용자 입력이라 제외한다 (6-4 검증 ①)
      if (t === 'itinerary_item' && c === 'place_label') continue;
      const { rows } = await pool.query<{ v: string | null }>(
        `SELECT "${c}"::text AS v FROM "${t}" WHERE "${c}" IS NOT NULL`,
      );
      for (const row of rows) {
        if (row.v === null) continue;
        scanned += 1;
        const value = stripUserLabels(row.v);
        for (const n of needles) {
          if (value.includes(n)) {
            hits.push(`${t}.${c} ← ${n.slice(0, 40)}`);
            break;
          }
        }
      }
    }

    // 검사가 아무것도 못 읽고 0건을 답하는 사고를 막는다
    expect(scanned).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  }, 60_000);

  it('② 검수 중 로그에 공사 원문이 없다', () => {
    const text = logs.join('');
    const hits = needles.filter((n) => text.includes(n));
    expect(hits).toEqual([]);
  });
});
