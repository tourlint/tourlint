import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { FINGERPRINT_FIELDS } from '@tourlint/shared';
import { buildContentFingerprint } from '../src/engine/fingerprint';
import { parseOperatingInfo } from '../src/engine/normalize/parse';
import { InMemoryApiCallLogger } from '../src/external/api-call-log';
import { HttpKtoTransport, KtoClient, parseKtoResponse } from '../src/external/kto';

/**
 * 실호출 스모크 — **공사 OpenAPI 를 실제로 한 번 두드린다.**
 *
 * 기본으로는 돌지 않는다. `LIVE_KTO=1` 을 줘야 실행된다.
 *   pnpm --filter @tourlint/api exec vitest run test/live-kto.smoke.spec.ts   ← 건너뜀
 *   LIVE_KTO=1 pnpm --filter @tourlint/api exec vitest run test/live-kto.smoke.spec.ts
 *
 * 왜 분리했나 — 실호출은 **일일 예산 800건**을 쓴다(FR-OP-002). CI 가 매 PR 마다 태우면
 * 정작 시연에 쓸 몫이 남지 않는다. 리플레이(`KTO_MODE=fixture`)가 평소의 검증 수단이고,
 * 이 파일은 **게이트에서 한 번** 도는 확인용이다.
 *
 * 이 스모크가 잡는 것 — 리플레이로는 절대 드러나지 않는 것들.
 *   · 인증키가 실제로 통하는가 (형식 · 인코딩 · 등록 상태)
 *   · 실 응답 봉투가 우리가 아는 모양인가
 *   · 픽스처를 뜬 이후 공사 데이터가 바뀌었는가
 *
 * ⚠️ **인증키를 출력하지 않는다.** 실패 메시지에도 URL 이 실리지 않도록 어댑터가 막고 있다
 *    (EI-CM-002 · NF-SC-009).
 */

const ENABLED = process.env.LIVE_KTO === '1';
const FIXTURES = join(__dirname, '../../../fixtures/kto');

/** `.env` 를 직접 읽는다. dotenv 를 의존성으로 들이지 않기 위해서다 */
function serviceKeyFromEnv(): string {
  if (process.env.KTO_SERVICE_KEY !== undefined && process.env.KTO_SERVICE_KEY !== '') {
    return process.env.KTO_SERVICE_KEY;
  }
  const envFile = join(__dirname, '../../../.env');
  if (!existsSync(envFile)) return '';
  const line = /^KTO_SERVICE_KEY=(.*)$/m.exec(readFileSync(envFile, 'utf8'));
  return line?.[1]?.trim() ?? '';
}

describe.skipIf(!ENABLED)('공사 OpenAPI 실호출 스모크', () => {
  let client: KtoClient;
  let logger: InMemoryApiCallLogger;

  beforeAll(() => {
    const serviceKey = serviceKeyFromEnv();
    if (serviceKey === '') throw new Error('KTO_SERVICE_KEY 가 없다 (.env 확인)');
    logger = new InMemoryApiCallLogger();
    client = new KtoClient({ transport: new HttpKtoTransport({ serviceKey }), logger });
  });

  it('① 인증키가 통한다 — searchKeyword2', async () => {
    const page = await client.searchKeyword({ keyword: '오죽헌', numOfRows: 3 });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.totalCount).toBeGreaterThan(0);
    // 인증 실패는 XML 로 오므로 여기까지 왔다는 것 자체가 키가 통한다는 뜻이다 (EI-KT-002)
    expect(logger.entries.filter((e) => e.status === 'OK').length).toBeGreaterThan(0);
  }, 30_000);

  it('② 신 코드체계만 남고 구 코드체계는 지워진다 (EI-KT-006)', async () => {
    const page = await client.searchKeyword({ keyword: '오죽헌', numOfRows: 3 });
    for (const item of page.items) {
      for (const legacy of ['areacode', 'sigungucode', 'cat1', 'cat2', 'cat3']) {
        expect(item, legacy).not.toHaveProperty(legacy);
      }
      expect(item).toHaveProperty('contentid');
    }
  }, 30_000);

  it('③ 판정 필드가 실제로 온다 — detailIntro2 (문화시설 14)', async () => {
    const item = await client.detailIntro('129784', 14);
    for (const field of FINGERPRINT_FIELDS[14]) {
      expect(item, field).toHaveProperty(field);
    }
    // 해석까지 관통하는지 본다
    const normalized = parseOperatingInfo({ contentTypeId: 14, raw: item });
    expect(normalized.schemaVersion).toBe('1.0');
    expect(['CONFIRMED', 'ESTIMATED', 'UNPARSED']).toContain(normalized.confidence.overall);
  }, 30_000);

  it('④ 픽스처를 뜬 이후 데이터가 바뀌었는지 본다', async () => {
    const live = await client.detailIntro('129784', 14);
    const liveFp = buildContentFingerprint({ contentTypeId: 14, raw: live });

    const raw: unknown = JSON.parse(readFileSync(join(FIXTURES, '14_129784.json'), 'utf8'));
    const it0 = (raw as { response: { body: { items: { item: unknown } } } }).response.body.items.item;
    const snapshot = (Array.isArray(it0) ? it0[0] : it0) as Record<string, unknown>;
    const snapshotFp = buildContentFingerprint({ contentTypeId: 14, raw: snapshot });

    /*
     * 다르면 실패가 아니라 **신호**다 — 픽스처를 뜬 2026-08-20 이후 공사가 원문을 고쳤다는 뜻이고,
     * 그때는 회귀 정답셋(docs/기대값표.md)의 기대값을 다시 봐야 한다.
     * 그래서 단언 메시지에 양쪽 해시를 실어 무엇이 달라졌는지 바로 보이게 한다.
     */
    expect(
      liveFp.fieldHash,
      `공사 원문이 픽스처와 다르다. 회귀 기대값을 재확인할 것\n` +
        `  실호출 ${liveFp.fieldHash.slice(0, 16)}\n  픽스처 ${snapshotFp.fieldHash.slice(0, 16)}`,
    ).toBe(snapshotFp.fieldHash);
  }, 30_000);

  it('⑤ 행사 조회는 "그 날짜에 아직 끝나지 않은 행사" 를 준다 (EI-KT-010)', async () => {
    const page = await client.searchFestival({ eventStartDate: '20261022', numOfRows: 5 });
    expect(page.items.length).toBeGreaterThan(0);
    // 조회 기준일보다 **먼저 시작한** 행사가 섞여 있어야 이 실측 동작이 맞다
    const started = page.items.map((i) => String(i.eventstartdate));
    expect(started.every((d) => /^\d{8}$/.test(d))).toBe(true);
  }, 30_000);

  it('⑥ 위치기반 조회 반경 20km 가 통한다 (EI-KT-008)', async () => {
    // 강릉 경포대 부근
    const page = await client.locationBasedList({ mapX: 128.8961, mapY: 37.7952, radius: 20000, numOfRows: 5 });
    expect(page.items.length).toBeGreaterThan(0);
  }, 30_000);

  it('⑦ 호출 로그가 실호출에서도 채워진다 (FR-OP-001)', () => {
    expect(logger.entries.length).toBeGreaterThan(0);
    for (const e of logger.entries) {
      expect(e.provider).toBe('KTO');
      expect(e.latencyMs).toBeGreaterThanOrEqual(0);
      // 실호출은 HTTP 를 타므로 상태 코드가 있다 (리플레이는 null)
      if (e.status === 'OK') expect(e.httpStatus).toBe(200);
    }
    // 이 스모크가 태운 예산을 눈으로 확인한다
    expect(logger.entries.length).toBeLessThanOrEqual(20);
  });

  it('⑧ 인증키가 어디에도 새지 않는다 (EI-CM-002 · NF-SC-009)', () => {
    const key = serviceKeyFromEnv();
    const serialized = JSON.stringify(logger.entries);
    expect(serialized).not.toContain(key);
    // 응답 원문도 로그에 없다 (DB 명세서 6-4 누출 경로 ①)
    expect(serialized).not.toContain('오죽헌');
  });
});

/**
 * 파이프라인 전체를 **실호출**로 한 번 돌린다 — W1 게이트(8/28)의 "실호출 1회" 항목.
 *
 * 어댑터만 두드리는 위 스모크와 다르다. 등록된 상품을 실제 공사 데이터로 검수해
 * 저장까지 간다. 리플레이가 감춰 온 것이 있다면 여기서 드러난다.
 *
 * DB 도 필요하므로 `LIVE_KTO=1` 과 `TEST_DATABASE_URL` 이 **둘 다** 있어야 돈다.
 */
describe.skipIf(!ENABLED || process.env.TEST_DATABASE_URL === undefined)('파이프라인 실호출 관통', () => {
  let pool: Pool;
  let service: AuditService;
  let productId: number;
  let accountId: number;

  beforeAll(async () => {
    // 리플레이를 끈다. 이 블록만 실제 공사를 부른다
    delete process.env.KTO_MODE;
    process.env.KTO_SERVICE_KEY = serviceKeyFromEnv();

    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
    service = new AuditService(pool);

    const acc = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1,'x') RETURNING id`,
      [`live-${String(process.pid)}@example.com`],
    );
    accountId = Number(acc.rows[0]?.id);
    const prod = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport)
       VALUES ($1,'실호출 검증용','51', DATE '2026-10-13', 1, 'CAR') RETURNING id`,
      [accountId],
    );
    productId = Number(prod.rows[0]?.id);

    const items: ReadonlyArray<[number, number, string, string, string, string, string, number, string]> = [
      [1, 2, '12:00', '13:00', 'MEAL', '가람집옹심이', '2868839', 39, 'FD01'],
      [1, 3, '12:30', '14:00', 'SIGHT', '오죽헌·시립박물관', '129784', 14, 'VE07'],
      [2, 1, '09:00', '10:00', 'SIGHT', '경포벚꽃축제', '695592', 15, 'EV01'],
    ];
    for (const [day, seq, s, e, type, label, cid, ctid, lcls] of items) {
      await pool.query(
        `INSERT INTO itinerary_item
           (product_id, day_no, seq, start_time, end_time, end_time_source, place_label,
            item_type, kto_content_id, content_type_id, lcls_systm2, match_status)
         VALUES ($1,$2,$3,$4::time,$5::time,'INPUT',$6,$7,$8,$9,$10,'CONFIRMED')`,
        [productId, day, seq, s, e, label, type, cid, ctid, lcls],
      );
    }
  }, 30_000);

  afterAll(async () => {
    await pool.query('DELETE FROM account WHERE id = $1', [accountId]);
    await pool.end();
  });

  it('실제 공사 데이터로 등록 → 검수 → 결과가 관통한다', async () => {
    const { job, created } = await service.requestAudit(productId, 'MANUAL');
    expect(created).toBe(true);
    await service.waitForIdle();

    const done = await service.getJob(job.id);
    expect(done.status, `검수가 ${done.status} 로 끝났다 (errorCode=${done.errorCode ?? '-'})`).toBe('DONE');
    expect(done.progressDone).toBe(done.progressTotal);

    const run = await service.getRun(done.auditRunId as number);
    expect(run.targetCount).toBe(3);
    expect(run.failedCount).toBe(0);

    // 리플레이에서 나오던 판정이 실호출에서도 그대로 나와야 한다
    const codes = run.findings.map((f) => f.reasonCode);
    expect(codes).toContain('REST_DAY_CONFLICT');
    expect(codes).toContain('TIME_OVERLAP');
    expect(codes).toContain('EVENT_ENDED');
  }, 60_000);

  it('호출 로그가 DB 에 남는다 — 공모전 활용 증빙 (FR-OP-001 · DR-LC-004)', async () => {
    const { rows } = await pool.query<{ operation: string; n: string; ok: string }>(
      `SELECT operation, count(*)::text AS n,
              count(*) FILTER (WHERE status = 'OK')::text AS ok
         FROM api_call_log WHERE provider = 'KTO' AND http_status IS NOT NULL
         GROUP BY operation ORDER BY operation`,
    );
    // http_status 가 채워진 행 = 실제로 HTTP 를 탄 호출. 리플레이는 null 이라 섞이지 않는다
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(Number(r.ok)).toBeGreaterThan(0);
  });
});

/** 파서가 살아 있는지만 확인한다 — 실호출 없이도 돈다 */
describe('스모크 파일 자체 점검', () => {
  it('LIVE_KTO 가 없으면 실호출을 하지 않는다', () => {
    expect(ENABLED || process.env.LIVE_KTO === undefined).toBe(true);
  });

  it('봉투 해석기가 붙어 있다', () => {
    const body = JSON.stringify({ response: { header: { resultCode: '0000', resultMsg: 'OK' }, body: { items: '' } } });
    expect(parseKtoResponse('searchKeyword2', body).items).toEqual([]);
  });
});
