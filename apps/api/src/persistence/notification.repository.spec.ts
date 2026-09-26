import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ImpactCandidate } from '../batch/impact-finder';
import { NotificationRepository } from './notification.repository';

const URL = process.env.TEST_DATABASE_URL;

if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('NotificationRepository — 실 DB', () => {
  let pool: Pool;
  let repo: NotificationRepository;
  let accountId: number;
  let productId: number;
  let itemId: number;

  const CONTENT = '125790';
  /** 상품 출발일. 감시 대상에서 빠지지 않게 넉넉히 미래로 둔다 */
  const START = '2099-09-10';

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    repo = new NotificationRepository(pool);

    const acc = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1, 'h') RETURNING id`,
      [`notif-${Date.now()}@t.test`],
    );
    accountId = Number(acc.rows[0]?.id);

    const prod = await pool.query<{ id: string }>(
      // 검수 시작을 누른 상품이라 planned_at 을 채운다 — 기획 중(NULL)이면 후보에서 빠진다 (#492)
      `INSERT INTO product (account_id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights, transport, planned_at)
       VALUES ($1, '강릉 2박3일', '51', '150', $2, 2, 'CHARTER_BUS', now()) RETURNING id`,
      [accountId, START],
    );
    productId = Number(prod.rows[0]?.id);

    const it = await pool.query<{ id: string }>(
      `INSERT INTO itinerary_item
         (product_id, day_no, seq, start_time, end_time_source, place_label, item_type, kto_content_id, match_status)
       VALUES ($1, 1, 1, '10:00', 'INPUT', '경포대', 'SIGHT', $2, 'CONFIRMED') RETURNING id`,
      [productId, CONTENT],
    );
    itemId = Number(it.rows[0]?.id);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM account WHERE id = $1`, [accountId]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM notification WHERE product_id = $1`, [productId]);
  });

  const save = (over: Record<string, unknown> = {}): Parameters<typeof repo.insertMany>[0][number] => ({
    productId, kind: 'RISK', condition: 1, ktoContentId: CONTENT,
    hashFrom: 'a'.repeat(64), hashTo: 'b'.repeat(64),
    changeKey: `FP:${'a'.repeat(64)}:${'b'.repeat(64)}`, body: { condition: 1 },
    ...over,
  } as never);

  describe('표출 중단으로 기록된 콘텐츠 (#745 · EI-KT-012)', () => {
    const hiddenBody = (hidden: boolean): Record<string, unknown> =>
      ({ condition: 1, contentTypeId: '12', modifiedTime: '20260828090000', hidden });

    it('🔴 가장 최근 기록이 표출 중단인 곳만 준다 — 다시 표출된 곳과 남의 상품 것은 아니다', async () => {
      await repo.insertMany([
        save({ ktoContentId: '700001', changeKey: 'MT:1', body: hiddenBody(true) }),
        save({ ktoContentId: '700002', changeKey: 'MT:1', body: hiddenBody(true) }),
        save({ ktoContentId: '700003', changeKey: 'MT:1', body: hiddenBody(false) }),
      ]);
      // 700002 는 그 뒤 다시 표출됐다
      await pool.query(`UPDATE notification SET created_at = now() - interval '1 day' WHERE product_id = $1`, [productId]);
      await repo.insertMany([save({ ktoContentId: '700002', changeKey: 'MT:2', body: hiddenBody(false) })]);

      expect([...(await repo.hiddenContentIds(productId))]).toEqual(['700001']);
    });

    it('무시한 알림이어도 센다 — 표출 중단은 무시해도 차단이다', async () => {
      await repo.insertMany([save({ ktoContentId: '700001', changeKey: 'MT:1', body: hiddenBody(true) })]);
      await pool.query(`UPDATE notification SET dismissed_at = now() WHERE product_id = $1`, [productId]);
      expect((await repo.hiddenContentIds(productId)).has('700001')).toBe(true);
    });

    it('기록이 없으면 빈 집합이다', async () => {
      expect((await repo.hiddenContentIds(productId)).size).toBe(0);
    });
  });

  describe('중복 방지 (FR-MO-036)', () => {
    it('🔴 지문이 없는 알림도 막힌다 — 조건 2 · 3 (DB 명세서 v1.7)', async () => {
      /*
       * 조건 2 · 3 은 그 콘텐츠가 어느 일정에도 없어 지문 이력이 없다. 지문 두 컬럼을
       * 유니크 키로 쓰던 때는 이 행들이 아무것도 안 막혔다 — 평범한 `UNIQUE` 가 NULL 이
       * 든 행을 서로 다르게 보기 때문이다. 제약은 걸려 있는데 놀고 있었다.
       */
      const near = (over: Record<string, unknown> = {}): Parameters<typeof repo.insertMany>[0][number] =>
        save({ condition: 2, hashFrom: null, hashTo: null, changeKey: 'MT:20260827120000', ...over });

      expect(await repo.insertMany([near()])).toBe(1);
      expect(await repo.insertMany([near()])).toBe(0);
      // 그 콘텐츠가 다시 갱신되면 키가 달라져 새로 뜬다 (FR-MO-036 뒷 문장)
      expect(await repo.insertMany([near({ changeKey: 'MT:20260828090000' })])).toBe(1);
    });

    it('🔴 같은 콘텐츠라도 조건이 다르면 각각 남는다', async () => {
      // 조건 1 은 FP:, 조건 2 는 MT: 라 서로 뭉개지지 않는다
      expect(await repo.insertMany([save()])).toBe(1);
      expect(await repo.insertMany([
        save({ condition: 2, hashFrom: null, hashTo: null, changeKey: 'MT:20260827120000' }),
      ])).toBe(1);
    });

    it('🔴 같은 콘텐츠의 같은 변경은 다시 넣지 않는다', async () => {
      // 배치가 같은 날짜를 다시 볼 수 있다 (0건 재조회 · 실패 재시도). 중복 시도는 정상이다
      expect(await repo.insertMany([save()])).toBe(1);
      expect(await repo.insertMany([save()])).toBe(0);

      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM notification WHERE product_id = $1`, [productId]);
      expect(Number(rows[0]?.n)).toBe(1);
    });

    it('🔴 새로운 변경이면 다시 노출된다', async () => {
      // 무시한 알림이 영영 안 뜨는 것이 아니라, 그 변경에 대해서만 안 뜬다
      const B = 'b'.repeat(64);
      const C = 'c'.repeat(64);
      await repo.insertMany([save()]);
      expect(await repo.insertMany([
        save({ hashFrom: B, hashTo: C, changeKey: `FP:${B}:${C}` }),
      ])).toBe(1);
    });

    it('🔴 판정하는 것은 키다 — 지문 컬럼이 아니다 (DB 명세서 v1.7)', async () => {
      /*
       * 지문 두 컬럼은 근거 표시용으로 남았다. 키가 같으면 지문이 달라도 같은 변경이고,
       * 키가 다르면 지문이 같아도 다른 변경이다. 둘을 같이 두면 어느 쪽이 판정하는지가
       * 흐려져서, 조건 2 · 3 처럼 지문이 없는 알림이 조용히 안 막힌다.
       */
      await repo.insertMany([save()]);
      // 지문만 바꾸고 키는 그대로 — 같은 변경이다
      expect(await repo.insertMany([save({ hashFrom: null, hashTo: null })])).toBe(0);
      // 키만 바꾸고 지문은 그대로 — 다른 변경이다
      expect(await repo.insertMany([save({ changeKey: 'MT:20260828090000' })])).toBe(1);
    });

    it('다른 상품은 각각 들어간다', async () => {
      const other = await pool.query<{ id: string }>(
        `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport)
         VALUES ($1, '다른 상품', '51', $2, 0, 'CAR') RETURNING id`, [accountId, START]);
      const otherId = Number(other.rows[0]?.id);
      expect(await repo.insertMany([save(), save({ productId: otherId })])).toBe(2);
    });
  });

  describe('새 소식 후보 (FR-MO-030 ④⑤⑥ · #616)', () => {
    const watched = (): ImpactCandidate => ({
      productId, startDate: START, nights: 2, ldongRegnCd: '51', ldongSignguCd: '150',
    });
    /** 지금 일정의 검수 실행에 R10 판정을 하나 남긴다 */
    const auditWithR10 = async (missing: string[], dismissed = false): Promise<void> => {
      const run = await pool.query<{ id: string }>(
        `INSERT INTO audit_run (product_id, executed_at, ruleset_version, target_count, weight_snapshot)
         VALUES ($1, clock_timestamp(), '1.2.4', 1, '{}'::jsonb) RETURNING id`, [productId]);
      await pool.query(
        `INSERT INTO finding (audit_run_id, rule_code, rule_version, severity, reason_code, message, evidence,
                              dismissed_at, dismiss_reason)
         VALUES ($1, 'R10', '1.0.0', 'WARNING', 'TARGET_MISMATCH', '상품 구성', $2::jsonb, $3, $4)`,
        [run.rows[0]?.id, JSON.stringify({ missingLcls2: missing }), dismissed ? new Date() : null, dismissed ? '고객 요청 사항' : null]);
    };

    it('지금 일정의 검수에서 R10 결손 유형과 일정 항목을 붙인다', async () => {
      await auditWithR10(['VE01', 'EX02']);
      const [found] = await repo.opportunityCandidates([watched()]);
      // 이동수단도 붙인다 — 넣을 자리의 사전 확인이 대중교통이면 길찾기를 부르지 않는다 (UI-S7-008)
      expect(found).toMatchObject({ productId, ldongRegnCd: '51', missingLcls2: ['VE01', 'EX02'], transport: 'CHARTER_BUS', accountId });
      expect(found?.items).toEqual([{ dayNo: 1, seq: 1, startTime: '10:00', endTime: null, mapX: null, mapY: null }]);
    });

    it('🔴 무시한 R10 판정의 결손 유형은 권하지 않는다 — 채우지 않겠다고 한 것이다', async () => {
      await auditWithR10(['HS01'], true);
      const [found] = await repo.opportunityCandidates([watched()]);
      expect(found?.missingLcls2).toEqual([]);
    });

    it('감시 상품이 없으면 묻지 않는다', async () => {
      expect(await repo.opportunityCandidates([])).toEqual([]);
    });
  });

  describe('후보 탐색 (FR-MO-018 · 030)', () => {
    /*
     * **여기서 보는 두 메서드는 계정을 걸지 않는다.** `watchedProducts` 와
     * `productsWithContents` 는 배치가 쓰는 것이라 `product` 전체를 읽는다(설계). 그래서
     * 단정은 **이 스펙이 넣은 상품에 대해서만** 해야 한다 — 전체 개수나 빈 배열에 기대면
     * 같은 테스트 DB 를 쓰는 다른 스펙이 상품을 넣고 지우는 사이에 간헐적으로 빨개진다.
     * `125790`(경포대)은 시연 시드와 다른 스펙 여러 곳이 같이 쓰는 contentid 다 (이슈 #431).
     */

    /** 한 콘텐츠 몫만 꺼낸다. 저장소는 여러 개를 한 번에 받는다 */
    const forContent = async (contentId: string, today: string): Promise<readonly ImpactCandidate[]> =>
      (await repo.productsWithContents([contentId], today)).get(contentId) ?? [];

    it('조건 1 — 그 콘텐츠를 넣은 상품을 찾는다', async () => {
      const found = await forContent(CONTENT, '2026-08-27');
      expect(found.map((f) => f.productId)).toContain(productId);
      // 첫 번째가 내 상품이라고 가정하지 않는다 — 남의 상품이 앞에 올 수 있다
      expect(found.find((f) => f.productId === productId)).toMatchObject({ nights: 2, ldongSignguCd: '150' });
    });

    it('🔴 콘텐츠 여러 개를 한 번에 묻고 콘텐츠별로 묶어 준다', async () => {
      /*
       * 하루 변경이 177건이라 하나씩 물으면 그만큼 왕복한다. 묶는 키가 어긋나면 A 의
       * 변경이 B 를 넣은 상품에 붙는다 — 오류 없이 엉뚱한 상품에 알림이 간다.
       *
       * **콘텐츠 둘이 서로 다른 상품에 붙어 있어야** 잘못 묶은 것이 드러난다. 하나만
       * 두면 전부 한 덩어리로 넣어도 결과가 같다.
       */
      const second = '888888888';
      const other = await pool.query<{ id: string }>(
        `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport, planned_at)
         VALUES ($1, '둘째 상품', '51', '2099-09-10', 2, 'CAR', now()) RETURNING id`, [accountId]);
      const otherId = Number(other.rows[0]?.id);
      await pool.query(
        `INSERT INTO itinerary_item (product_id, day_no, seq, start_time, end_time_source, place_label, item_type, kto_content_id, match_status)
         VALUES ($1, 1, 1, '10:00', 'INPUT', '오죽헌', 'SIGHT', $2, 'CONFIRMED')`, [otherId, second]);

      const missing = '999999999';
      const found = await repo.productsWithContents([CONTENT, second, missing, CONTENT], '2026-08-27');

      expect([...found.keys()].sort()).toEqual([second, CONTENT].sort());
      /*
       * 잘못 묶였는지는 **서로 건너가 있는지**로 본다. `125790` 쪽 목록에 남의 상품이 섞일 수
       * 있어 개수로는 볼 수 없다. `888888888` 은 이 스펙만 쓰는 값이라 단정형으로 둔다.
       */
      expect(found.get(CONTENT)?.map((f) => f.productId)).toContain(productId);
      expect(found.get(CONTENT)?.map((f) => f.productId)).not.toContain(otherId);
      expect(found.get(second)?.map((f) => f.productId)).toEqual([otherId]);
      expect(found.get(missing)).toBeUndefined();
    });

    it('미확정 항목은 세지 않는다', async () => {
      await pool.query(`UPDATE itinerary_item SET match_status = 'PENDING' WHERE id = $1`, [itemId]);
      try {
        expect((await forContent(CONTENT, '2026-08-27')).map((f) => f.productId))
          .not.toContain(productId);
      } finally {
        await pool.query(`UPDATE itinerary_item SET match_status = 'CONFIRMED' WHERE id = $1`, [itemId]);
      }
    });

    it('🔴 출발일이 지난 상품은 감시하지 않는다 (FR-MO-018)', async () => {
      // 이미 다녀온 일정에 알림을 보내도 할 수 있는 게 없다. 수동 재검수는 계속 된다
      const past = await pool.query<{ id: string }>(
        `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport)
         VALUES ($1, '지난 상품', '51', '2020-01-01', 1, 'CAR') RETURNING id`, [accountId]);
      const pastId = Number(past.rows[0]?.id);
      await pool.query(
        `INSERT INTO itinerary_item (product_id, day_no, seq, start_time, end_time_source, place_label, item_type, kto_content_id, match_status)
         VALUES ($1, 1, 1, '10:00', 'INPUT', '경포대', 'SIGHT', $2, 'CONFIRMED')`, [pastId, CONTENT]);

      const found = await forContent(CONTENT, '2026-08-27');
      expect(found.map((f) => f.productId)).not.toContain(pastId);
      expect(await repo.watchedProducts('2026-08-27')).not.toContainEqual(
        expect.objectContaining({ productId: pastId }),
      );
    });

    it('🔴 상한을 주면 출발일이 임박한 것부터 그만큼만 준다 (FR-MO-020)', async () => {
      // 상한에 걸려 잘려나가는 것은 가장 덜 급한 상품이어야 한다
      const far = await pool.query<{ id: string }>(
        `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport, planned_at)
         VALUES ($1, '먼 미래 상품', '51', '2099-12-31', 1, 'CAR', now()) RETURNING id`, [accountId]);
      const farId = Number(far.rows[0]?.id);

      /*
       * **상한을 전체 개수에서 끌어오지 않는다.** 종전에는 전체를 센 뒤 `all.length - 1` 로
       * 걸었는데, 두 조회 사이에 다른 스펙이 자기 계정을 지우면 남은 행이 상한보다 적어져
       * 아무것도 잘리지 않는다 — 먼 미래 상품이 그대로 나와 빨개졌다 (이슈 #431).
       * `1` 은 테이블이 몇 행이든 결정적이고, 2099-12-31 출발이 거기 남을 수 없다.
       */
      /*
       * 상한은 계정별이다(#690). 공용 테스트 DB 에는 다른 계정의 상품도 있어 전체 길이는 볼 수
       * 없다 — 내 계정에서 남은 것이 임박한 하나뿐인지를 본다.
       */
      const capped = (await repo.watchedProducts('2026-08-27', 1)).map((c) => c.productId);
      expect(capped).toContain(productId);
      expect(capped).not.toContain(farId);

      // 상한이 없으면 먼 미래 상품도 나오고, 순서는 출발일 오름차순이다 (한 번의 조회 안에서 본다)
      const all = await repo.watchedProducts('2026-08-27');
      expect(all.map((c) => c.productId)).toContain(farId);
      const dates = all.map((c) => c.startDate);
      expect(dates, '출발일 오름차순').toEqual([...dates].sort());
    });

    it('🔴 다른 계정의 이른 출발 상품이 내 자리를 빼앗지 않는다 — 상한은 계정별 (#690)', async () => {
      const other = await pool.query<{ id: string }>(
        `INSERT INTO account (email, password_hash) VALUES ($1, 'h') RETURNING id`,
        [`notif-other-${Date.now()}@t.test`],
      );
      const otherId = Number(other.rows[0]?.id);
      try {
        // 내 상품(START)보다 먼저 떠나는 남의 상품 둘. 전체 상위 2개를 뽑던 때는 이 둘이 자리를 다 가졌다
        const theirs = await pool.query<{ id: string }>(
          `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport, planned_at)
           VALUES ($1, '남의 상품 1', '51', '2026-08-28', 0, 'CAR', now()),
                  ($1, '남의 상품 2', '51', '2026-08-29', 0, 'CAR', now()),
                  ($1, '남의 상품 3', '51', '2026-08-30', 0, 'CAR', now())
           RETURNING id`, [otherId]);
        const theirIds = theirs.rows.map((r) => Number(r.id));

        const watched = (await repo.watchedProducts('2026-08-27', 2)).map((c) => c.productId);
        expect(watched, '내 상품은 남의 상품 수와 무관하게 남는다').toContain(productId);
        // 남의 계정도 자기 상한만큼만 — 셋 중 임박한 둘
        expect(watched).toContain(theirIds[0]);
        expect(watched).toContain(theirIds[1]);
        expect(watched).not.toContain(theirIds[2]);
      } finally {
        await pool.query(`DELETE FROM account WHERE id = $1`, [otherId]);
      }
    });

    it('출발일 당일과 마지막 날은 아직 감시 대상이다', async () => {
      // 2박 3일이면 출발 + 2일까지다. 그날 아침에도 변경은 의미가 있다
      const found = await forContent(CONTENT, '2099-09-12');
      expect(found.map((f) => f.productId)).toContain(productId);
      expect((await forContent(CONTENT, '2099-09-13')).map((f) => f.productId))
        .not.toContain(productId);
    });

    it('🔴 넘친 날 개별 확인 대상은 조건 1 후보와 같은 범위다 — 콘텐츠마다 한 번 (FR-MO-016 · #866)', async () => {
      /*
       * 이 스펙만 쓰는 contentid 로 본다. 공용 테스트 DB 라 전체 목록의 길이는 볼 수 없다.
       * 잡혀야 하는 것: 검수 시작을 지났고 여행이 안 끝난 상품의 고른 곳. 두 상품이 같이 넣었어도 한 줄.
       */
      const [keep, planning, past, pending, untyped] = ['777000001', '777000002', '777000003', '777000004', '777000005'];
      const products = await pool.query<{ id: string }>(
        `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport, planned_at)
         VALUES ($1, '감시 상품 A', '51', '2099-09-10', 1, 'CAR', now()),
                ($1, '감시 상품 B', '51', '2099-09-11', 0, 'CAR', now()),
                ($1, '기획 중', '51', '2099-09-10', 1, 'CAR', NULL),
                ($1, '지난 여행', '51', '2020-01-01', 1, 'CAR', now())
         RETURNING id`, [accountId]);
      const [a, b, planningId, pastId] = products.rows.map((r) => Number(r.id));
      await pool.query(
        `INSERT INTO itinerary_item
           (product_id, day_no, seq, start_time, end_time_source, place_label, item_type, kto_content_id, content_type_id, match_status)
         VALUES ($1, 1, 1, '10:00', 'INPUT', 'x', 'SIGHT', $5, 12, 'CONFIRMED'),
                ($2, 1, 1, '10:00', 'INPUT', 'x', 'SIGHT', $5, 12, 'CONFIRMED'),
                ($3, 1, 1, '10:00', 'INPUT', 'x', 'SIGHT', $6, 12, 'CONFIRMED'),
                ($4, 1, 1, '10:00', 'INPUT', 'x', 'SIGHT', $7, 12, 'CONFIRMED'),
                ($1, 1, 2, '12:00', 'INPUT', 'x', 'SIGHT', $8, 12, 'PENDING'),
                ($2, 1, 2, '12:00', 'INPUT', 'x', 'SIGHT', $9, NULL, 'CONFIRMED')`,
        [a, b, planningId, pastId, keep, planning, past, pending, untyped],
      );

      const mine = (await repo.registeredContents('2026-08-27')).filter((r) => r.contentId.startsWith('777'));
      expect(mine).toEqual([{ contentId: keep, contentTypeId: 12 }]);
    });

    it('🔴 기획 중 상품(planned_at NULL)은 조건 1 · 2 · 3 후보에서 빠진다 (#492 · B6 함정)', async () => {
      // 아직 검수 시작을 안 누른 상품은 F13 영향 탐색·알림 대상이 아니다
      const planning = await pool.query<{ id: string }>(
        `INSERT INTO product (account_id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights, transport)
         VALUES ($1, '기획 중 상품', '51', '150', '2099-09-10', 2, 'CAR') RETURNING id`, [accountId]);
      const planningId = Number(planning.rows[0]?.id);
      await pool.query(
        `INSERT INTO itinerary_item (product_id, day_no, seq, start_time, end_time_source, place_label, item_type, kto_content_id, match_status)
         VALUES ($1, 1, 1, '10:00', 'INPUT', '경포대', 'SIGHT', $2, 'CONFIRMED')`, [planningId, CONTENT]);

      // 조건 1(그 콘텐츠를 넣은 상품)에도, 조건 2·3(감시 대상)에도 안 잡힌다
      expect((await forContent(CONTENT, '2026-08-27')).map((f) => f.productId)).not.toContain(planningId);
      expect((await repo.watchedProducts('2026-08-27')).map((c) => c.productId)).not.toContain(planningId);

      // 검수 시작을 누르면(planned_at 채우면) 다시 잡힌다 — 가드가 planned_at 만 본다는 확인
      await pool.query(`UPDATE product SET planned_at = now() WHERE id = $1`, [planningId]);
      expect((await forContent(CONTENT, '2026-08-27')).map((f) => f.productId)).toContain(planningId);
    });
  });
});
