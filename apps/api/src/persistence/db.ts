import { Pool, type PoolClient, type QueryResultRow } from 'pg';

/**
 * DB 연결 — 풀 하나를 프로세스가 공유한다.
 *
 * 요청마다 `new Client()` 로 붙으면 연결 수립 비용이 매 호출에 붙어 p95 목표
 * (8곳 15초 · 12곳 20초)를 갉아먹는다.
 *
 * ⚠️ **쿼리 파라미터를 로그에 남기지 않는다.** 파라미터에는 정규화 결과와 사용자 입력이
 * 들어 있고, 로깅은 그대로 누출 경로가 된다 (DB 명세서 6-4 누출 경로 ①·② · NF-OB-006).
 */

/**
 * DI 주입 토큰.
 *
 * `pg` 의 `Pool` 클래스를 토큰으로 쓰면 안 된다. 클래스를 타입으로만 import 하는 순간
 * (`import type { Pool }`) 런타임 값이 지워져 Nest 가 `Function` 을 받고 주입에 실패한다.
 * 빌드 · 린트 · 테스트는 전부 통과하고 **부팅만 죽는다.**
 */
export const DB_POOL = Symbol('DB_POOL');

let pool: Pool | null = null;

export function getPool(connectionString = process.env.DATABASE_URL): Pool {
  if (pool !== null) return pool;
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL 이 비어 있다');
  }
  pool = new Pool({
    connectionString,
    // 로컬이 아니면 Railway 등 관리형 DB 라 TLS 를 켠다
    ssl: isLocal(connectionString) ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 3000,
    max: 10,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool === null) return;
  const p = pool;
  pool = null;
  await p.end();
}

function isLocal(url: string): boolean {
  return url.includes('localhost') || url.includes('127.0.0.1');
}

/** 트랜잭션 하나를 열고 닫는다. 예외가 나면 되돌린다 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** `pg` 의 최소 실행 인터페이스. `Pool` 과 `PoolClient` 가 둘 다 만족한다 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}
