import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotificationService } from './notification.service';
import { RadarService } from './radar.service';
import { ProductRepository } from '../product/product.repository';

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.REQUIRE_DB_TESTS === '1') throw new Error('TEST_DATABASE_URL required');
let sequence = 0;

describe.skipIf(!url)('종료된 여행의 현재 알림 제외 — 실 DB', () => {
  let pool: Pool;
  let account: number;
  let other: number;
  let notifications: NotificationService;
  let radar: RadarService;
  let products: ProductRepository;
  const filter = { unreadOnly: false, includeDismissed: false, page: 0, size: 1 };
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    notifications = new NotificationService(pool);
    radar = new RadarService(pool);
    products = new ProductRepository(pool);
  });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO account(email,password_hash) VALUES ($1,'x'),($2,'x') RETURNING id`,
      [`active-${process.pid}-${sequence++}@example.com`, `active-${process.pid}-${sequence++}@example.com`],
    );
    account = Number(r.rows[0]?.id); other = Number(r.rows[1]?.id);
  });
  afterEach(async () => { await pool.query('DELETE FROM account WHERE id=ANY($1::bigint[])', [[account, other]]); });
  async function add(offset: number, nights: number, owner = account): Promise<number> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO product(account_id,name,ldong_regn_cd,start_date,nights,transport,planned_at)
       VALUES ($1,'여행','51',(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date + $2::int,$3,'CAR',now()) RETURNING id`,
      [owner, offset, nights],
    );
    const id = Number(r.rows[0]?.id);
    await pool.query(`INSERT INTO notification(product_id,kind,match_condition,kto_content_id,change_key,body)
      VALUES ($1,'RISK',3,'test-content','change','{}')`, [id]);
    return id;
  }
  it('종료된 상품만 있으면 목록·총수·배지·요약·오늘 할 일용 변경 내역이 모두 0이다', async () => {
    const id = await add(-1, 0);
    const list = await notifications.list(account, filter);
    expect(list).toMatchObject({ content: [], totalElements: 0, unreadCount: 0 });
    expect(await radar.summary(account)).toMatchObject({ risk: 0, opportunity: 0, unread: 0, affectedProducts: 0, changedContents: 0 });
    expect(await radar.changes(account, 0, 20)).toMatchObject({ content: [], totalElements: 0 });
    expect(await products.detail(account, id)).not.toBeNull();
    expect((await pool.query('SELECT id FROM notification WHERE product_id=$1', [id])).rowCount).toBe(1);
    expect(await notifications.list(account, { ...filter, includeDismissed: true, productId: id })).toMatchObject({ content: [], totalElements: 0 });
  });
  it('종료 당일·진행 중인 1박 2일·미래 여행만 계정 범위 안에서 페이지와 총수에 포함한다', async () => {
    await add(-2, 1);
    const ongoing = await add(-1, 1);
    await add(0, 0);
    await add(1, 2);
    await add(0, 0, other);
    const list = await notifications.list(account, filter);
    expect(list.totalElements).toBe(3);
    expect(list.unreadCount).toBe(3);
    expect(list.content).toHaveLength(1);
    expect(await radar.summary(account)).toMatchObject({ risk: 3, affectedProducts: 3, unread: 3 });
    expect((await radar.changes(account, 0, 1)).totalElements).toBe(3);
    expect((await radar.changes(account, 2, 1)).content).toHaveLength(1);
    expect((await notifications.list(account, { ...filter, productId: ongoing })).totalElements).toBe(1);
    expect((await notifications.list(other, { ...filter, productId: ongoing })).totalElements).toBe(0);
  });
  it('상품을 실제 삭제하면 알림도 연쇄 삭제되어 모든 현재 조회에서 사라진다', async () => {
    const id = await add(0, 0);
    await pool.query('DELETE FROM product WHERE id=$1 AND account_id=$2', [id, account]);
    expect((await pool.query('SELECT id FROM notification WHERE product_id=$1', [id])).rowCount).toBe(0);
    expect(await notifications.list(account, filter)).toMatchObject({ totalElements: 0, unreadCount: 0 });
    expect((await radar.summary(account)).risk).toBe(0);
    expect((await radar.changes(account, 0, 20)).totalElements).toBe(0);
  });
});
