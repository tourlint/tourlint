import { closePool, getPool } from '../persistence/db';
import { demoEmail, seedDemo } from './demo-seed';

/**
 * 데모 계정·시연 상품 시드 CLI — `pnpm --filter api seed`.
 *
 * DATABASE_URL 과 DEMO_ACCOUNT_PASSWORD 가 필요하다. 자격증명은 출력하지 않는다 — 이메일까지만.
 */
async function main(): Promise<void> {
  const pool = getPool();
  try {
    const { accountId, products } = await seedDemo(pool);
    // eslint-disable-next-line no-console
    console.log(`데모 시드 완료 · account=${accountId} (${demoEmail()}) · 상품 ${products}건`);
  } finally {
    await closePool();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('데모 시드 실패:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
