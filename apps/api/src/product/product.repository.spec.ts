import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateCreate } from './product.dto';
import { ProductRepository } from './product.repository';

/**
 * 상품 CRUD 리포지토리 — 실 DB. 스키마 CHECK·트리거(day_no ≤ nights+1)·CASCADE 가 걸려 있어
 * 가짜 커넥션으로는 검증되지 않는다. 계정 스코프(남의 상품은 안 보인다)도 여기서 본다.
 */

const URL = process.env.TEST_DATABASE_URL;
if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

const EMAIL_A = 'zz-product-spec-a@tourlint.test';
const EMAIL_B = 'zz-product-spec-b@tourlint.test';

function sample() {
  const { product } = validateCreate({
    name: '강릉 CRUD 스펙 2박 3일',
    ldongRegnCd: '51',
    ldongSignguCd: '150',
    startDate: '2026-10-22',
    nights: 2,
    transport: 'CAR',
    headCount: 10,
    days: [
      { day: 1, items: [{ start: '10:00', end: '11:30', place: '경포대', itemType: 'SIGHT' }] },
      { day: 2, items: [{ start: '09:00', end: '', place: '오죽헌', itemType: 'SIGHT' }] },
      { day: 3, items: [{ start: '12:00', end: '13:00', place: '초당순두부', itemType: 'MEAL' }] },
    ],
  });
  if (product === null) throw new Error('샘플 검증 실패');
  return product;
}

describe.skipIf(URL === undefined)('ProductRepository', () => {
  let pool: Pool;
  let repo: ProductRepository;
  let accountA: number;
  let accountB: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 4 });
    repo = new ProductRepository(pool);
    accountA = await makeAccount(pool, EMAIL_A);
    accountB = await makeAccount(pool, EMAIL_B);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM account WHERE email = ANY($1)`, [[EMAIL_A, EMAIL_B]]);
    await pool.end();
  });

  it('상품과 일정을 만들고 상세로 되읽는다', async () => {
    const created = await repo.create(accountA, sample());
    expect(created.dayCount).toBe(3);

    const detail = await repo.detail(accountA, created.productId);
    expect(detail).not.toBeNull();
    const itemCount = detail?.items.length ?? 0;
    expect(itemCount).toBe(3);
    // 등록 시점 항목은 관광지 미확정이라 PENDING 이다
    expect(detail?.items.every((i) => i.matchStatus === 'PENDING')).toBe(true);
  });

  it('목록은 자기 계정 상품만 보여준다 (계정 격리)', async () => {
    const listA = await repo.list(accountA, 0, 20);
    const listB = await repo.list(accountB, 0, 20);
    expect(listA.total).toBeGreaterThan(0);
    expect(listB.total).toBe(0);
    // 아직 검수 전이라 latestAudit 은 null, 항목은 전부 PENDING
    expect(listA.rows[0]?.latestAudit).toBeNull();
    expect(listA.rows[0]?.pendingMatches).toBe(3);
  });

  it('🔴 목록에 기획을 시작한 방법을 싣는다 — 기록이 없는 상품은 null (UI-S1-010)', async () => {
    const { product } = validateCreate({
      name: '강릉 메모로 시작 스펙', ldongRegnCd: '51', ldongSignguCd: '150',
      startDate: '2026-10-23', nights: 0, transport: 'CAR', planOrigin: { startedBy: 'TEXT' },
    });
    if (product === null) throw new Error('샘플 검증 실패');
    const fromText = await repo.create(accountA, product);
    const plain = await repo.create(accountA, sample());

    const { rows } = await repo.list(accountA, 0, 100);
    expect(rows.find((r) => r.id === fromText.productId)?.startedBy).toBe('TEXT');
    expect(rows.find((r) => r.id === plain.productId)?.startedBy).toBeNull();
  });

  it('남의 상품은 상세·수정·삭제가 안 된다', async () => {
    const created = await repo.create(accountA, sample());
    expect(await repo.detail(accountB, created.productId)).toBeNull();
    expect(await repo.updateBasic(accountB, created.productId, { name: '탈취' })).toBe(false);
    expect(await repo.remove(accountB, created.productId)).toBe(false);
    // 주인은 된다
    expect(await repo.updateBasic(accountA, created.productId, { name: '수정됨' })).toBe(true);
    expect((await repo.detail(accountA, created.productId))?.name).toBe('수정됨');
  });

  it('🔴 입력하는 순간 고른 관광지는 CONFIRMED 로 저장한다 — 안 고른 줄은 PENDING (UI-S2-020)', async () => {
    const { product } = validateCreate({
      name: '강릉 인라인 매칭 스펙', ldongRegnCd: '51', ldongSignguCd: '150',
      startDate: '2026-10-22', nights: 0, transport: 'CAR',
      days: [{ day: 1, items: [
        { start: '10:00', end: '11:30', place: '경포대', itemType: 'SIGHT',
          content: { contentId: '125790', contentTypeId: 12, mapx: 128.9, mapy: 37.79, lcls1: 'HS', lcls2: 'HS01', lcls3: 'HS011200' } },
        { start: '12:00', end: '13:00', place: '초당순두부', itemType: 'MEAL' },
      ] }],
    });
    if (product === null) throw new Error('샘플 검증 실패');
    const { productId } = await repo.create(accountA, product);

    const detail = await repo.detail(accountA, productId);
    const [matched, typed] = detail?.items ?? [];
    expect(matched?.matchStatus).toBe('CONFIRMED');
    expect(matched?.ktoContentId).toBe('125790');
    expect(matched?.contentTypeId).toBe(12);
    // 안 고른 줄은 그대로 PENDING 으로 남아 /plan 에서 이어 고른다
    expect([typed?.place, typed?.matchStatus]).toEqual(['초당순두부', 'PENDING']);

    // matched_by 는 사용자가 고른 것이라 USER 다 (D8)
    const row = await pool.query<{ matched_by: string | null }>(
      `SELECT matched_by FROM itinerary_item WHERE product_id = $1 AND kto_content_id = '125790'`, [productId]);
    expect(row.rows[0]?.matched_by).toBe('USER');
  });

  it('🔴 등록 화면 줄마다 들어온 경로를 남긴다 — 장소 담기 줄은 고른 방식을 비운다 (FR-PL-020 · FR-PL-005)', async () => {
    const content = { contentId: '125790', contentTypeId: 12, mapx: 128.9, mapy: 37.79, lcls1: 'HS', lcls2: 'HS01', lcls3: null };
    const { product } = validateCreate({
      name: '강릉 출처 스펙', ldongRegnCd: '51', ldongSignguCd: '150',
      startDate: '2026-10-22', nights: 0, transport: 'CAR',
      days: [{ day: 1, items: [
        { start: '09:00', end: '10:00', place: '경포해변', itemType: 'SIGHT', origin: 'TEXT' },
        { start: '10:30', end: '11:30', place: '안목해변', itemType: 'SIGHT', origin: 'UPLOAD' },
        { start: '12:00', end: '13:00', place: '경포대', itemType: 'SIGHT', origin: 'MANUAL', content },
        { start: '14:30', end: '', place: '주문진 등대', itemType: 'SIGHT', origin: 'PICKER', content: { ...content, contentId: '126175' } },
        // 경로를 안 보내거나 모르는 값이면 직접 입력이다
        { start: '16:00', end: '17:00', place: '초당순두부', itemType: 'MEAL' },
        { start: '18:00', end: '', place: '숙소', itemType: 'LODGING', origin: 'PATCH' },
      ] }],
    });
    if (product === null) throw new Error('샘플 검증 실패');
    const { productId } = await repo.create(accountA, product);

    const { rows } = await pool.query<{ place_label: string | null; origin: string | null; matched_by: string | null }>(
      `SELECT place_label, origin, matched_by FROM itinerary_item WHERE product_id = $1 ORDER BY seq`, [productId]);
    // 관광지를 고른 줄은 이름을 저장하지 않는다 — 화면이 보낸 것은 공식 명칭이다 (DR-PR-001 · DR-IN-013)
    expect(rows.map((r) => [r.place_label, r.origin, r.matched_by])).toEqual([
      ['경포해변', 'TEXT', null],
      ['안목해변', 'UPLOAD', null],
      [null, 'MANUAL', 'USER'],
      [null, 'PICKER', null],
      ['초당순두부', 'MANUAL', null],
      ['숙소', 'MANUAL', null],
    ]);
  });

  it('🔴 「직접 정한 곳으로 두기」를 고른 줄은 직접 정한 곳(EXCLUDED)으로 저장한다 (UI-S2-021)', async () => {
    const { product } = validateCreate({
      name: '강릉 직접 정한 곳 스펙', ldongRegnCd: '51', ldongSignguCd: '150',
      startDate: '2026-10-22', nights: 0, transport: 'CAR',
      days: [{ day: 1, items: [
        { start: '09:00', end: '09:30', place: '강릉역', itemType: 'MOVE', excluded: true },
        { start: '10:00', end: '', place: '경포해변', itemType: 'SIGHT' },
      ] }],
    });
    if (product === null) throw new Error('샘플 검증 실패');
    const { productId } = await repo.create(accountA, product);
    const byLabel = new Map((await repo.detail(accountA, productId))?.items.map((i) => [i.place, i.matchStatus]));
    expect(byLabel.get('강릉역')).toBe('EXCLUDED');
    expect(byLabel.get('경포해변')).toBe('PENDING');

    // 편집 화면에서 새로 넣은 줄도 같다
    const added = await repo.addItem(productId, {
      dayNo: 1, startTime: '18:00', endTime: null, endTimeSource: 'DWELL_DEFAULT',
      placeLabel: '협력 공방', itemType: 'SIGHT', origin: 'MANUAL', excluded: true,
    });
    expect(added.matchStatus).toBe('EXCLUDED');
  });

  it('🔴 등록 화면에서 담은 걷기 길은 직접 정한 곳으로 코스 식별자만 남긴다 (UI-S2-048 · DR-MD-005)', async () => {
    const { product } = validateCreate({
      name: '강릉 걷기 길 스펙', ldongRegnCd: '51', ldongSignguCd: '150',
      startDate: '2026-10-22', nights: 0, transport: 'CAR',
      days: [{ day: 1, items: [
        { start: '09:30', end: '12:00', place: '해파랑길 35코스', itemType: 'SIGHT', excluded: { walkId: 'T_CRS_MNG0000000402' }, origin: 'PICKER' },
      ] }],
    });
    if (product === null) throw new Error('샘플 검증 실패');
    const { productId } = await repo.create(accountA, product);
    const { rows } = await pool.query<{ match_status: string; walk_id: string | null; place_label: string | null; origin: string | null; start_time: string; end_time: string | null }>(
      `SELECT match_status, walk_id, place_label, origin, start_time::text, end_time::text FROM itinerary_item WHERE product_id = $1`, [productId]);
    expect(rows[0]).toEqual({ match_status: 'EXCLUDED', walk_id: 'T_CRS_MNG0000000402', place_label: null, origin: 'PICKER', start_time: '09:30:00', end_time: '12:00:00' });
  });

  it('🔴 편집 화면이 시각을 정해 보낸 걷기 길은 그 시각으로 넣는다', async () => {
    const p = (await repo.create(accountA, sample())).productId;
    const timed = await repo.addWalkItem(p, { dayNo: 1, itemType: 'SIGHT', origin: 'PICKER', walkId: 'W-1', startTime: '14:00', endTime: '16:30' });
    expect([timed.start, timed.end, timed.endTimeSource]).toEqual(['14:00', '16:30', 'INPUT']);
    // 시각이 없으면 전처럼 그 날 끝 · 표준 체류시간이다
    const auto = await repo.addWalkItem(p, { dayNo: 1, itemType: 'SIGHT', origin: 'PICKER', walkId: 'W-2', startTime: null, endTime: null });
    expect([auto.start, auto.end, auto.endTimeSource]).toEqual(['16:30', '18:00', 'DWELL_DEFAULT']);
  });

  it('삭제하면 일정 항목도 CASCADE 로 함께 지워진다', async () => {
    const created = await repo.create(accountA, sample());
    expect(await repo.remove(accountA, created.productId)).toBe(true);
    const items = await pool.query(`SELECT 1 FROM itinerary_item WHERE product_id = $1`, [created.productId]);
    expect(items.rowCount).toBe(0);
  });

  it('항목을 추가·수정·삭제한다 (FR-IN-013)', async () => {
    const p = (await repo.create(accountA, sample())).productId;
    const added = await repo.addItem(p, {
      dayNo: 1,
      startTime: '22:00',
      endTime: '22:30',
      endTimeSource: 'INPUT',
      placeLabel: '야식',
      itemType: 'MEAL',
      origin: 'TEXT',
      excluded: false,
    });
    expect(added.matchStatus).toBe('PENDING');
    // 편집 화면에서 메모로 채운 줄이다 (FR-PL-020)
    const origin = await pool.query<{ origin: string | null }>(`SELECT origin FROM itinerary_item WHERE id = $1`, [added.itemId]);
    expect(origin.rows[0]?.origin).toBe('TEXT');
    const patched = await repo.patchItem(accountA, added.itemId, {
      placeLabel: '야식2',
      endTime: '23:00',
      endTimeSource: 'INPUT',
    });
    expect(patched?.place).toBe('야식2');
    expect(patched?.end).toBe('23:00');
    expect(await repo.deleteItem(accountA, added.itemId)).toBe(true);
    expect(await repo.deleteItem(accountA, added.itemId)).toBe(false);
  });

  it('남의 상품·항목은 못 건드린다 (item → product → account · PM-DA-003)', async () => {
    const p = (await repo.create(accountA, sample())).productId;
    const detail = await repo.detail(accountA, p);
    const first = detail?.items[0];
    expect(first).toBeDefined();
    const itemId = first?.itemId ?? -1;
    expect(await repo.ownedNights(accountB, p)).toBeNull();
    expect(await repo.patchItem(accountB, itemId, { placeLabel: '침입' })).toBeNull();
    expect(await repo.deleteItem(accountB, itemId)).toBe(false);
  });

  it('순서변경 — 전체를 보내야 하고 남의 상품은 못 바꾼다 (FR-IN-014)', async () => {
    const p = (await repo.create(accountA, sample())).productId;
    const detail = await repo.detail(accountA, p);
    const order = (detail?.items ?? []).map((it) => ({ itemId: it.itemId, dayNo: it.dayNo, seq: it.seq }));
    expect(await repo.reorderItems(accountA, p, order)).toBe(order.length);
    // 일부만 보내면 거부한다 (전체가 필요하다)
    expect(await repo.reorderItems(accountA, p, order.slice(0, 1))).toBeNull();
    // 남의 상품은 못 바꾼다
    expect(await repo.reorderItems(accountB, p, order)).toBeNull();
  });

  describe('목록 점수 — 무시를 반영해 다시 계산한다 (FR-AU-046 · #684)', () => {
    async function auditedWithTwoWarnings(): Promise<{ productId: number; findingId: number }> {
      const { productId } = await repo.create(accountA, sample());
      // 저장값 92 는 주의 2건(각 4점)을 뺀 실행 시점 점수다
      const run = await pool.query<{ id: string }>(
        `INSERT INTO audit_run (product_id, executed_at, ruleset_version, readiness_score, warn_cnt, target_count, weight_snapshot)
         VALUES ($1, now(), '1.2.4', 92, 2, 3, '{"BLOCKER":25,"ERROR":10,"WARNING":4,"UNVERIFIED":3}'::jsonb)
         RETURNING id`,
        [productId],
      );
      const found = await pool.query<{ id: string }>(
        `INSERT INTO finding (audit_run_id, rule_code, rule_version, severity, reason_code, message, evidence)
         VALUES ($1, 'R04', '1.0.0', 'WARNING', 'CONTENT_IMBALANCE', '관광지 방문이 몰려 있어요', '{}'::jsonb),
                ($1, 'R10', '1.0.0', 'WARNING', 'TARGET_MISMATCH', '어울리는 방문이 아직 없어요', '{}'::jsonb)
         RETURNING id`,
        [run.rows[0]?.id],
      );
      return { productId, findingId: Number(found.rows[0]?.id) };
    }

    async function listedScore(productId: number): Promise<number | null | undefined> {
      const { rows } = await repo.list(accountA, 0, 100);
      return rows.find((r) => r.id === productId)?.latestAudit?.readinessScore;
    }

    it('무시한 것이 없으면 저장값과 같다', async () => {
      const { productId } = await auditedWithTwoWarnings();
      expect(await listedScore(productId)).toBe(92);
    });

    it('🔴 주의 1건을 무시하면 목록도 96점이다 — 결과 화면과 같은 값', async () => {
      const { productId, findingId } = await auditedWithTwoWarnings();
      await pool.query(`UPDATE finding SET dismissed_at = now(), dismiss_reason = '기획 의도' WHERE id = $1`, [findingId]);
      expect(await listedScore(productId)).toBe(96);

      // 건수도 무시한 것을 뺀다 — 96점 옆에 주의 2건이면 계산이 안 맞는다 (#819)
      const { rows } = await repo.list(accountA, 0, 100);
      expect(rows.find((r) => r.id === productId)?.latestAudit?.counts.warning).toBe(1);
    });

    it('무시를 풀면 92점으로 돌아온다', async () => {
      const { productId, findingId } = await auditedWithTwoWarnings();
      await pool.query(`UPDATE finding SET dismissed_at = now(), dismiss_reason = '기획 의도' WHERE id = $1`, [findingId]);
      await pool.query(`UPDATE finding SET dismissed_at = NULL, dismiss_reason = NULL WHERE id = $1`, [findingId]);
      expect(await listedScore(productId)).toBe(92);
    });
  });

  describe('출시 승인 (PM-NG-002 · EX-AU-008 · DR-IN-007)', () => {
    it('검수한 적 없는 상품은 판정할 실행이 없다 — 차단 0건과 다르다', async () => {
      const { productId } = await repo.create(accountA, sample());
      expect(await repo.releaseBasis(accountA, productId)).toEqual({
        current: { kind: 'NONE', runId: null, latestRunId: null }, currentBlockers: null, latestBlockers: null,
        itemCount: 3,
      });
    });

    it('🔴 검수 뒤에 항목을 전부 지우면 편집 흔적은 없지만 항목 수가 0 이다 (#738)', async () => {
      const { productId } = await repo.create(accountA, sample());
      await pool.query(
        `INSERT INTO audit_run (product_id, executed_at, created_at, ruleset_version, readiness_score, target_count, blocker_cnt, weight_snapshot)
         VALUES ($1, now() - interval '1 hour', now() - interval '1 hour', '1.2.4', 100, 3, 0, '{}'::jsonb)`,
        [productId],
      );
      const detail = await repo.detail(accountA, productId);
      for (const item of detail?.items ?? []) await repo.deleteItem(accountA, item.itemId);

      const basis = await repo.releaseBasis(accountA, productId);
      // 남은 행이 없어 #710 의 비교는 「바뀌지 않음」 이다 — 그래서 항목 수를 따로 본다
      expect(basis?.current.kind).toBe('LATEST');
      expect(basis?.currentBlockers).toBe(0);
      expect(basis?.itemCount).toBe(0);
    });

    it('남의 상품은 undefined 다 — 없는 상품과 구분하지 않는다', async () => {
      const { productId } = await repo.create(accountA, sample());
      expect(await repo.releaseBasis(accountB, productId)).toBeUndefined();
    });

    it('🔴 검수 이력이 없으면 DB 가 출시를 막는다', async () => {
      const { productId } = await repo.create(accountA, sample());
      await expect(repo.markReleased(accountA, productId)).rejects.toThrow(/FORBIDDEN_ACTION/);
    });
  });

});

async function makeAccount(pool: Pool, email: string): Promise<number> {
  await pool.query(`DELETE FROM account WHERE email = $1`, [email]);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO account (email, password_hash, is_demo) VALUES ($1, 'x', FALSE) RETURNING id`,
    [email],
  );
  const id = rows[0];
  if (id === undefined) throw new Error('계정 생성 실패');
  await pool.query(`INSERT INTO user_setting (account_id) VALUES ($1)`, [id.id]);
  return Number(id.id);
}
