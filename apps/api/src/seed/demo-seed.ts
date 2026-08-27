import type { Pool, PoolClient } from 'pg';
import { hashPassword } from '../auth/password';
import { withTransaction } from '../persistence/db';
import { DEMO_PRODUCTS, type DemoProduct } from './demo-products';

/**
 * 데모 계정·시연 상품 시드 (PM-TA-001 · PM-TA-003 · FR-CM-004).
 *
 * 심사용 계정은 시드로 만든다 — 자격증명을 소스에 넣지 않는다 (PM-TA-008). 이메일·비밀번호는
 * 환경변수로 주입하고, 비밀번호는 회원가입과 같은 scrypt 해시로 저장한다.
 *
 * 복원은 데모 계정의 상품을 지우고 시드를 다시 넣는 것이다. 스냅샷 테이블은 두지 않는다
 * (DB 명세서 데모 시드 주석). 항목은 product ON DELETE CASCADE 로 함께 지워진다.
 */

export const DEFAULT_DEMO_EMAIL = 'openapi@tourlint.example';

export function demoEmail(): string {
  const value = process.env.DEMO_ACCOUNT_EMAIL;
  return value === undefined || value === '' ? DEFAULT_DEMO_EMAIL : value;
}

function demoPassword(): string {
  const value = process.env.DEMO_ACCOUNT_PASSWORD;
  if (value === undefined || value === '') {
    // 하드코딩 금지 (PM-TA-008). 비밀번호가 없으면 계정을 세우지 않고 멈춘다.
    throw new Error('DEMO_ACCOUNT_PASSWORD 가 비어 있다 — 데모 계정 비밀번호는 환경변수로 주입한다');
  }
  return value;
}

/**
 * 데모 계정을 보장한다. 없으면 만들고(user_setting 1행 포함), 있으면 그 id 를 돌려준다.
 *
 * 회원가입 경로(AccountRepository.create)를 쓰지 않는 이유는 두 가지다 — is_demo 를 TRUE 로
 * 강제해야 하고, 이미 있으면 "가입 불가" 예외가 아니라 기존 id 로 넘어가야 한다.
 */
export async function ensureDemoAccount(pool: Pool): Promise<number> {
  const email = demoEmail();
  const found = await pool.query<{ id: string }>(`SELECT id FROM account WHERE email = $1`, [email]);
  const existing = found.rows[0];
  if (existing !== undefined) return Number(existing.id);

  const passwordHash = await hashPassword(demoPassword());
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO account (email, password_hash, is_demo) VALUES ($1, $2, TRUE) RETURNING id`,
      [email, passwordHash],
    );
    const created = rows[0];
    if (created === undefined) throw new Error('데모 계정 생성 결과가 비어 있다');
    await client.query(`INSERT INTO user_setting (account_id) VALUES ($1)`, [created.id]);
    return Number(created.id);
  });
}

/** 데모 계정의 상품을 모두 지우고 시연 상품을 다시 넣는다 (PM-TA-003) */
export async function reseedDemoProducts(pool: Pool, accountId: number): Promise<number> {
  return withTransaction(pool, async (client) => {
    await client.query(`DELETE FROM product WHERE account_id = $1`, [accountId]);
    for (const product of DEMO_PRODUCTS) {
      await insertDemoProduct(client, accountId, product);
    }
    return DEMO_PRODUCTS.length;
  });
}

async function insertDemoProduct(client: PoolClient, accountId: number, product: DemoProduct): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO product
       (account_id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights,
        target_key, concept_key, head_count, transport)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      accountId, product.name, product.ldongRegnCd, product.ldongSignguCd, product.startDate,
      product.nights, product.targetKey, product.conceptKey, product.headCount, product.transport,
    ],
  );
  const created = rows[0];
  if (created === undefined) throw new Error('데모 상품 생성 결과가 비어 있다');
  const productId = Number(created.id);

  for (const item of product.items) {
    await client.query(
      `INSERT INTO itinerary_item
         (product_id, day_no, seq, start_time, end_time, end_time_source, place_label, item_type,
          kto_content_id, content_type_id, lcls_systm1, lcls_systm2, lcls_systm3, match_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'CONFIRMED')`,
      [
        productId, item.dayNo, item.seq, item.startTime, item.endTime, item.endTimeSource,
        item.placeLabel, item.itemType, item.ktoContentId, item.contentTypeId,
        item.lclsSystm1, item.lclsSystm2, item.lclsSystm3,
      ],
    );
  }
}

/** 전체 시드 — 계정 보장 후 시연 상품 재적재. CLI 진입점이 쓴다 */
export async function seedDemo(pool: Pool): Promise<{ accountId: number; products: number }> {
  const accountId = await ensureDemoAccount(pool);
  const products = await reseedDemoProducts(pool, accountId);
  return { accountId, products };
}
