import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DomainException } from '../common/domain.exception';
import { NotificationService } from './notification.service';

/**
 * 알림 조회 관통 — **실 DB**.
 *
 * 계정 격리(PM-DA-002)와 비표출 무시 금지(FR-MO-037)가 여기서만 확인된다.
 * 문구는 DB 없이 도는 `notification-copy.spec` 이 본다.
 */

const URL = process.env.TEST_DATABASE_URL;
let counter = 0;
if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

const LIST = { unreadOnly: false, includeDismissed: false, page: 0, size: 20 };

describe.skipIf(URL === undefined)('NotificationService — 관통', () => {
  let pool: Pool;
  let service: NotificationService;
  let mine: number;
  let theirs: number;
  let productId: number;

  beforeAll(() => {
    pool = new Pool({ connectionString: URL, max: 4 });
    service = new NotificationService(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    const accounts = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1,'x'), ($2,'x') RETURNING id`,
      [`noti-${String(process.pid)}-${String(counter++)}@example.com`,
       `noti-${String(process.pid)}-${String(counter++)}@example.com`],
    );
    mine = Number(accounts.rows[0]?.id);
    theirs = Number(accounts.rows[1]?.id);

    const prod = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport)
       VALUES ($1,'강릉 1박 2일','51', DATE '2026-10-13', 1, 'CAR') RETURNING id`,
      [mine],
    );
    productId = Number(prod.rows[0]?.id);
  });

  afterEach(async () => {
    await pool.query('DELETE FROM account WHERE id = ANY($1::bigint[])', [[mine, theirs]]);
  });

  async function insert(over: {
    kind?: string; condition?: number; hidden?: boolean; contentId?: string;
  } = {}): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO notification
         (product_id, kind, match_condition, kto_content_id, change_hash_from, change_hash_to,
          change_key, body)
       VALUES ($1,$2,$3,$4,'a','b',$5,$6::jsonb) RETURNING id`,
      [productId, over.kind ?? 'RISK', over.condition ?? 1, over.contentId ?? '126508',
       `k-${String(counter++)}`,
       JSON.stringify({ condition: over.condition ?? 1, hidden: over.hidden ?? false })],
    );
    return Number(rows[0]?.id);
  }

  it('내 알림이 목록에 나온다 — 상품명과 출발일이 붙는다 (FR-MO-033)', async () => {
    await insert();
    const res = await service.list(mine, LIST);
    const first = (res.content as Record<string, unknown>[])[0];
    expect(res.totalElements).toBe(1);
    expect(first?.productName).toBe('강릉 1박 2일');
    expect(first?.startDate).toBe('2026-10-13');
    expect(first?.what).not.toBe('');
    expect(first?.action).not.toBe('');
  });

  it('🔴 남의 알림은 목록에 안 나온다 (PM-DA-002)', async () => {
    await insert();
    const res = await service.list(theirs, LIST);
    expect(res.totalElements).toBe(0);
    expect(res.content).toEqual([]);
  });

  it('🔴 남의 알림은 읽음 처리할 수 없다 — 404 로 존재를 숨긴다 (EX-SY-003)', async () => {
    const id = await insert();
    await expect(service.markRead(id, theirs)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainException && e.getStatus() === 404,
    );
    // 남의 시도로 내 알림이 읽음 처리되지 않았다
    const res = await service.list(mine, LIST);
    expect((res.content as Record<string, unknown>[])[0]?.readAt).toBeNull();
  });

  it('🔴 비표출 알림은 무시할 수 없다 — 403 (FR-MO-037 · PM-NG-010)', async () => {
    const id = await insert({ hidden: true });
    await expect(service.dismiss(id, mine)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainException
        && e.getStatus() === 403 && e.reasonCode === 'FORBIDDEN_ACTION',
    );
    const res = await service.list(mine, LIST);
    expect((res.content as Record<string, unknown>[])[0]?.dismissedAt).toBeNull();
  });

  it('보통 알림은 무시되고 목록에서 빠진다', async () => {
    const id = await insert();
    await service.dismiss(id, mine);
    expect((await service.list(mine, LIST)).totalElements).toBe(0);
    expect((await service.list(mine, { ...LIST, includeDismissed: true })).totalElements).toBe(1);
  });

  it('🔴 이미 읽은 알림은 읽은 시각을 덮어쓰지 않는다', async () => {
    const id = await insert();
    const first = await service.markRead(id, mine);
    const second = await service.markRead(id, mine);
    expect(second.readAt).toBe(first.readAt);
  });

  it('kind 와 unread 로 거른다 (FR-MO-035)', async () => {
    await insert({ kind: 'RISK', condition: 1 });
    const opp = await insert({ kind: 'OPPORTUNITY', condition: 4, contentId: '999' });
    expect((await service.list(mine, { ...LIST, kind: 'RISK' })).totalElements).toBe(1);
    expect((await service.list(mine, { ...LIST, kind: 'OPPORTUNITY' })).totalElements).toBe(1);

    await service.markRead(opp, mine);
    expect((await service.list(mine, { ...LIST, unreadOnly: true })).totalElements).toBe(1);
  });

  it('안 읽은 건수를 함께 준다 — 헤더 배지가 쓴다', async () => {
    await insert();
    await insert({ contentId: '777' });
    expect((await service.list(mine, LIST)).unreadCount).toBe(2);
  });

  it('지문 비교값을 함께 준다 (FR-MO-058)', async () => {
    await insert();
    const first = ((await service.list(mine, LIST)).content as Record<string, unknown>[])[0];
    expect(first?.fingerprint).toEqual({ from: 'a', to: 'b' });
  });
});
