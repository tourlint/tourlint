import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DomainException } from '../common/domain.exception';
import { PlaceNameResolver } from '../audit/place-name';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import type { BudgetDecision } from '../external/budget-guard';
import { FixtureKakaoTransport, KakaoMobilityClient } from '../external/kakao';
import { FixtureKtoTransport, KtoClient } from '../external/kto';
import { PlaceFactsService, factFields, previousItem } from './place-facts.service';
import { PlanItemRepository, type PlanItem } from './plan-item.repository';

const KTO_FIXTURES = join(__dirname, '../../../../fixtures/kto');
const KAKAO_FIXTURES = join(__dirname, '../../../../fixtures/kakao');

const allowed: BudgetDecision = { allowed: true, ratio: 0.1, reasonCode: null, warn: false, remaining: 720 };
const blocked: BudgetDecision = { allowed: false, ratio: 1, reasonCode: 'BUDGET_EXHAUSTED', warn: true, remaining: 0 };

const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  id: 1, dayNo: 1, seq: 1, startTime: '10:00', endTime: '11:00', placeLabel: '곳', itemType: 'SIGHT',
  contentId: '125769', contentTypeId: 12, lcls2: 'HS01', mapx: 128.89, mapy: 37.79,
  matchStatus: 'CONFIRMED', matchedBy: 'USER', origin: 'MANUAL', walkId: null, ...over,
});

describe('소개정보 → 장소 정보 한 줄 (FR-PL-005)', () => {
  it('유형마다 필드 이름이 다르다 — 음식점은 영업시간, 숙박은 입실 · 퇴실이다', () => {
    expect(factFields(39, { opentimefood: '10:00~21:00', restdatefood: '매주 화요일', parkingfood: '가능' }))
      .toEqual({ hours: '10:00~21:00', restDays: '매주 화요일', fee: null, parking: '가능', eventPeriod: null });
    expect(factFields(32, { checkintime: '15:00', checkouttime: '11:00', parkinglodging: '가능' }).hours)
      .toBe('15:00 · 11:00');
  });

  it('🔴 축제는 기간과 요금이 함께 온다 — 기간을 모르면 적지 않는다', () => {
    const festival = factFields(15, { playtime: '10:00~18:00', usetimefestival: '무료', eventstartdate: '20261021', eventenddate: '20261025' });
    expect(festival).toMatchObject({ hours: '10:00~18:00', fee: '무료', eventPeriod: '2026-10-21 ~ 2026-10-25' });
    expect(factFields(15, { eventstartdate: '20261021' }).eventPeriod).toBeNull();
  });

  it('빈 값은 null 이다 — 화면이 「없음」과 「안 적혀 있음」을 구분한다', () => {
    expect(factFields(12, { usetime: '   ', restdate: '', parking: '가능' }))
      .toEqual({ hours: null, restDays: null, fee: null, parking: '가능', eventPeriod: null });
    expect(factFields(null, { usetime: '09:00' }).hours).toBeNull();
  });

  it('🔴 앞 줄은 같은 날 안에서만 찾는다 — 날이 바뀌면 앞 구간이 아니다', () => {
    const items = [item({ id: 1, dayNo: 1, seq: 1 }), item({ id: 2, dayNo: 1, seq: 2 }), item({ id: 3, dayNo: 2, seq: 1 })];
    expect(previousItem(items, items[1] as PlanItem)?.id).toBe(1);
    expect(previousItem(items, items[2] as PlanItem)).toBeNull();
  });
});

const URL = process.env.TEST_DATABASE_URL;

if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('PlaceFactsService — 실 DB', () => {
  let pool: Pool;
  let accountId: number;
  let theirId: number;
  let productId: number;
  const logger = new InMemoryApiCallLogger();

  const service = (options: { budget?: BudgetDecision; withKakao?: boolean; transport?: string } = {}): PlaceFactsService => {
    const kto = (): KtoClient => new KtoClient({ transport: new FixtureKtoTransport(KTO_FIXTURES), logger, sleep: async () => undefined });
    return new PlaceFactsService({
      items: new PlanItemRepository(pool),
      kto,
      kakao: () => (options.withKakao === true
        ? new KakaoMobilityClient({ transport: new FixtureKakaoTransport(KAKAO_FIXTURES), logger })
        : null),
      budget: async () => options.budget ?? allowed,
      names: new PlaceNameResolver({ kto }),
    });
  };

  const addItem = (values: {
    dayNo: number; seq: number; contentId: string | null; contentTypeId: number | null;
    status?: string; label?: string | null; mapx?: number | null; mapy?: number | null; end?: string | null;
  }): Promise<{ rows: { id: string }[] }> =>
    pool.query<{ id: string }>(
      `INSERT INTO itinerary_item
         (product_id, day_no, seq, start_time, end_time, end_time_source, place_label, item_type,
          kto_content_id, content_type_id, lcls_systm2, mapx, mapy, match_status, matched_by, origin)
       VALUES ($1,$2,$3,'10:00'::time, $9::time, 'INPUT', $4, 'SIGHT', $5, $6, 'HS01', $7, $8,
               $10, 'USER', 'PICKER')
       RETURNING id`,
      [productId, values.dayNo, values.seq, values.label === undefined ? '곳' : values.label,
       values.contentId, values.contentTypeId,
       values.mapx === undefined ? 128.89 : values.mapx, values.mapy === undefined ? 37.79 : values.mapy,
       values.end ?? '11:00', values.status ?? 'CONFIRMED'],
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 4 });
    const accounts = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1,'x'), ($2,'x') RETURNING id`,
      [`facts-${String(process.pid)}@t.test`, `facts-other-${String(process.pid)}@t.test`],
    );
    accountId = Number(accounts.rows[0]?.id);
    theirId = Number(accounts.rows[1]?.id);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM account WHERE id = ANY($1::bigint[])', [[accountId, theirId]]);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query('DELETE FROM product WHERE account_id = $1', [accountId]);
  });

  const newProduct = async (transport = 'CAR'): Promise<void> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights, transport)
       VALUES ($1,'강릉 1박 2일','51','150', DATE '2026-10-23', 1, $2) RETURNING id`,
      [accountId, transport],
    );
    productId = Number(rows[0]?.id);
  };

  it('🔴 고른 항목만 값이 온다 — 고르지 않은 줄과 직접 정한 곳은 넣지 않는다 (UI-S2-035)', async () => {
    await newProduct();
    await addItem({ dayNo: 1, seq: 1, contentId: '125769', contentTypeId: 12 });
    await addItem({ dayNo: 1, seq: 2, contentId: null, contentTypeId: null, status: 'PENDING' });
    await addItem({ dayNo: 1, seq: 3, contentId: null, contentTypeId: null, status: 'EXCLUDED', label: '펜션' });

    const facts = await service().factsOf(accountId, productId, null);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ kindName: '역사유적지', matchedBy: 'USER', origin: 'PICKER' });
    expect(facts[0]?.hours).not.toBeNull();
  });

  it('🔴 실행해도 검수 실행 · 판정이 생기지 않는다 (FR-PL-021)', async () => {
    await newProduct();
    await addItem({ dayNo: 1, seq: 1, contentId: '125769', contentTypeId: 12 });
    const before = await counts(pool, productId);

    const facts = await service().factsOf(accountId, productId, null);

    expect(await counts(pool, productId)).toEqual(before);
    // 응답에 등급 · 규칙 번호 · 통과 여부가 없다
    expect(Object.keys(facts[0] ?? {}).sort()).toEqual([
      'eventPeriod', 'fee', 'hours', 'itemId', 'kindName', 'matchedBy', 'name', 'origin', 'parking',
      'restDays', 'travelFromPrevMinutes',
    ]);
  });

  it('🔴 앞 항목에서 차로 걸리는 시간은 양쪽 좌표가 있을 때만이다 (EX-PL-006)', async () => {
    await newProduct();
    await addItem({ dayNo: 1, seq: 1, contentId: '125769', contentTypeId: 12 });
    await addItem({ dayNo: 1, seq: 2, contentId: '125790', contentTypeId: 12 });
    await addItem({ dayNo: 1, seq: 3, contentId: '129784', contentTypeId: 14, mapx: null, mapy: null });

    const facts = await service({ withKakao: true }).factsOf(accountId, productId, null);
    // 미래 길찾기 픽스처 323초 → 검수와 같은 올림으로 6분.
    expect(facts.map((f) => f.travelFromPrevMinutes)).toEqual([null, 6, null]);
  });

  it('🔴 앞 항목이 직접 정한 곳이면 시간을 적지 않는다', async () => {
    await newProduct();
    await addItem({ dayNo: 1, seq: 1, contentId: null, contentTypeId: null, status: 'EXCLUDED', label: '펜션' });
    await addItem({ dayNo: 1, seq: 2, contentId: '125790', contentTypeId: 12 });

    const facts = await service({ withKakao: true }).factsOf(accountId, productId, null);
    expect(facts.map((f) => [f.itemId, f.travelFromPrevMinutes]).map(([, m]) => m)).toEqual([null]);
  });

  it('🔴 대중교통 상품은 차 시간으로 대신 적지 않는다 (TRANSIT_NOT_SUPPORTED 와 같은 원칙)', async () => {
    await newProduct('PUBLIC_TRANSIT');
    await addItem({ dayNo: 1, seq: 1, contentId: '125769', contentTypeId: 12 });
    await addItem({ dayNo: 1, seq: 2, contentId: '125790', contentTypeId: 12 });

    const facts = await service({ withKakao: true }).factsOf(accountId, productId, null);
    expect(facts[1]?.travelFromPrevMinutes).toBeNull();
  });

  it('길찾기를 못 쓰면 이동시간만 비고 장소 정보는 그대로다 (EI-KM-009)', async () => {
    await newProduct();
    await addItem({ dayNo: 1, seq: 1, contentId: '125769', contentTypeId: 12 });
    await addItem({ dayNo: 1, seq: 2, contentId: '125790', contentTypeId: 12 });

    const facts = await service().factsOf(accountId, productId, null);
    expect(facts[1]?.travelFromPrevMinutes).toBeNull();
    expect(facts[1]?.hours).not.toBeNull();
  });

  it('itemIds 를 주면 그 줄만 본다 — 고른 직후 한 줄', async () => {
    await newProduct();
    const first = await addItem({ dayNo: 1, seq: 1, contentId: '125769', contentTypeId: 12 });
    await addItem({ dayNo: 1, seq: 2, contentId: '125790', contentTypeId: 12 });

    const facts = await service().factsOf(accountId, productId, [Number(first.rows[0]?.id)]);
    expect(facts.map((f) => f.itemId)).toEqual([Number(first.rows[0]?.id)]);
  });

  it('🔴 이름을 저장하지 않은 줄은 표시할 때 찾는다 (DR-PR-001)', async () => {
    await newProduct();
    await addItem({ dayNo: 1, seq: 1, contentId: '125769', contentTypeId: 12, label: null });
    const facts = await service().factsOf(accountId, productId, null);
    expect(facts[0]?.name).not.toBe('');
  });

  it('🔴 남의 상품은 볼 수 없다 — 404 (PM-DA-002 · EX-SY-003)', async () => {
    await newProduct();
    await addItem({ dayNo: 1, seq: 1, contentId: '125769', contentTypeId: 12 });
    await expect(service().factsOf(theirId, productId, null)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainException && e.getStatus() === 404,
    );
  });

  it('🔴 예산 100% 면 부르기 전에 429 다', async () => {
    await newProduct();
    await addItem({ dayNo: 1, seq: 1, contentId: '125769', contentTypeId: 12 });
    await expect(service({ budget: blocked }).factsOf(accountId, productId, null)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainException && e.getStatus() === 429,
    );
  });

  it('소개정보를 못 받아도 그 줄은 온다 — 값만 빈다', async () => {
    await newProduct();
    // 픽스처에 없는 contentid 다
    await addItem({ dayNo: 1, seq: 1, contentId: '99999999', contentTypeId: 12 });
    const facts = await service().factsOf(accountId, productId, null);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ hours: null, restDays: null, parking: null });
  });
});

/**
 * 기획 조회가 만들면 안 되는 행들. **이 상품 것만 센다** — 다른 스펙이 같은 테스트 DB 에서
 * 검수를 돌리고 있어 전체 건수로 보면 남의 행에 흔들린다.
 */
async function counts(pool: Pool, productId: number): Promise<Record<string, string>> {
  const { rows } = await pool.query<Record<string, string>>(
    `SELECT (SELECT count(*)::text FROM audit_run WHERE product_id = $1) AS runs,
            (SELECT count(*)::text FROM finding f
               JOIN audit_run r ON r.id = f.audit_run_id WHERE r.product_id = $1) AS findings,
            (SELECT count(*)::text FROM content_fingerprint c
               JOIN audit_run r ON r.id = c.audit_run_id WHERE r.product_id = $1) AS fingerprints`,
    [productId],
  );
  return rows[0] ?? {};
}
