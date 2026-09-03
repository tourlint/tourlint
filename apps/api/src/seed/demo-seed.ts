import type { Pool, PoolClient } from 'pg';
import { seedAccountDefaults } from '../auth/account.repository';
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
 * 데모 계정을 보장한다. 없으면 만들고, 있으면 그 id 를 돌려준다.
 *
 * **기본 데이터는 `seedAccountDefaults` 하나로 넣는다** — 회원가입 경로가 쓰는 것과 같은
 * 함수다. 여기에 INSERT 를 따로 두었더니 실제로 갈렸다: `user_setting` 만 넣고 나머지 셋을
 * 빠뜨려 운영 데모 계정이 `target_profile 0/63` 인 채로 돌았고, R10 이 기대 프로파일을 못
 * 찾아 판정 대신 확인 불가를 냈다 — TP-03 이 명세 AC 의 29점이 아니라 27점이 됐다 (이슈 #310).
 *
 * **이미 있는 계정에도 다시 불러 채운다.** 조회 후 바로 반환하면 그때 빠진 계정은 영영
 * 비어 있다. `ON CONFLICT DO NOTHING` 이라 사용자가 고친 값을 덮지 않는다.
 */
export async function ensureDemoAccount(pool: Pool): Promise<number> {
  const email = demoEmail();
  const found = await pool.query<{ id: string }>(`SELECT id FROM account WHERE email = $1`, [email]);
  const existing = found.rows[0];
  if (existing !== undefined) {
    await seedAccountDefaults(pool, Number(existing.id));
    return Number(existing.id);
  }

  const passwordHash = await hashPassword(demoPassword());
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO account (email, password_hash, is_demo) VALUES ($1, $2, TRUE) RETURNING id`,
      [email, passwordHash],
    );
    const created = rows[0];
    if (created === undefined) throw new Error('데모 계정 생성 결과가 비어 있다');
    await seedAccountDefaults(client, Number(created.id));
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
      // 좌표를 함께 넣는다. 실사용 경로는 F02 매칭이 detailCommon2 의 mapx 를 저장하는데
      // (place-match.service.ts) 시드는 그 경로를 건너뛰므로 여기서 채우지 않으면 빈다.
      // 비면 R08 이 전 구간을 COORD_MISSING 으로 넘겨 길찾기를 한 번도 부르지 않는다.
      `INSERT INTO itinerary_item
         (product_id, day_no, seq, start_time, end_time, end_time_source, place_label, item_type,
          kto_content_id, content_type_id, lcls_systm1, lcls_systm2, lcls_systm3, mapx, mapy,
          match_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'CONFIRMED')`,
      [
        productId, item.dayNo, item.seq, item.startTime, item.endTime, item.endTimeSource,
        item.placeLabel, item.itemType, item.ktoContentId, item.contentTypeId,
        item.lclsSystm1, item.lclsSystm2, item.lclsSystm3, item.mapx, item.mapy,
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
