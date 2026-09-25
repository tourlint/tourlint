import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { hashPassword } from './password';
import type { SignupEmailSender } from './signup-email.sender';

/**
 * 공용 테스트 계정은 로그인할 때마다 알림 확인 처리를 되돌린다 (UI-CM-008 · #840).
 * 심사위원이 한 계정을 같이 써서, 처음 레이더를 연 사람만 「새로」 를 보던 것을 막는다.
 */

const URL = process.env.TEST_DATABASE_URL;
if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('공용 테스트 계정 로그인과 알림 확인 처리 — 실 DB', () => {
  let pool: Pool;
  let service: AuthService;
  // 이 테스트에서만 쓰는 임의 비밀번호다. 실제 계정의 자격 증명이 아니다
  const password = randomUUID();
  const stamp = Date.now();
  const demo = { email: `demo-notif-${stamp}@t.test`, id: 0, productId: 0 };
  const other = { email: `plain-notif-${stamp}@t.test`, id: 0, productId: 0 };

  const account = async (email: string, isDemo: boolean): Promise<{ id: number; productId: number }> => {
    const acc = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash, is_demo) VALUES ($1, $2, $3) RETURNING id`,
      [email, await hashPassword(password), isDemo],
    );
    const id = Number(acc.rows[0]?.id);
    const prod = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights, transport, planned_at)
       VALUES ($1, '강릉 1박 2일', '51', '150', '2099-10-01', 1, 'CAR', now()) RETURNING id`,
      [id],
    );
    return { id, productId: Number(prod.rows[0]?.id) };
  };

  /** 알림 한 건. read · dismissed 는 시각을 채운다 */
  const notify = async (productId: number, key: string, read: boolean, dismissed = false): Promise<number> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO notification (product_id, kind, match_condition, kto_content_id, change_key, body, read_at, dismissed_at)
       VALUES ($1, 'RISK', 1, '125790', $2, '{}'::jsonb, $3, $4) RETURNING id`,
      [productId, key, read ? new Date() : null, dismissed ? new Date() : null],
    );
    return Number(rows[0]?.id);
  };

  const readAt = async (id: number): Promise<Date | null> =>
    (await pool.query<{ read_at: Date | null }>(`SELECT read_at FROM notification WHERE id = $1`, [id])).rows[0]?.read_at ?? null;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    service = new AuthService(pool, {} as SignupEmailSender);
    Object.assign(demo, await account(demo.email, true));
    Object.assign(other, await account(other.email, false));
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM notification WHERE product_id = ANY($1::bigint[])`, [[demo.productId, other.productId]]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM account WHERE id = ANY($1::bigint[])`, [[demo.id, other.id]]);
    await pool.end();
  });

  it('🔴 공용 계정으로 들어오면 읽은 알림이 다시 「새로」 가 된다 — 무시한 알림은 그대로', async () => {
    const read = await notify(demo.productId, 'k1', true);
    const dismissed = await notify(demo.productId, 'k2', true, true);
    const unread = await notify(demo.productId, 'k3', false);

    await service.login(demo.email, password);

    expect(await readAt(read)).toBeNull();
    expect(await readAt(dismissed)).not.toBeNull();
    expect(await readAt(unread)).toBeNull();
  });

  it('다른 계정은 로그인해도 확인 처리가 그대로다 — 공용 계정 로그인도 남의 알림을 건드리지 않는다', async () => {
    const mine = await notify(other.productId, 'k4', true);

    await service.login(other.email, password);
    expect(await readAt(mine)).not.toBeNull();

    await service.login(demo.email, password);
    expect(await readAt(mine)).not.toBeNull();
  });

  it('비밀번호가 틀리면 되돌리지 않는다', async () => {
    const read = await notify(demo.productId, 'k5', true);
    await expect(service.login(demo.email, 'wrong')).rejects.toThrow();
    expect(await readAt(read)).not.toBeNull();
  });
});
