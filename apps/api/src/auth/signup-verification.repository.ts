import { BadRequestException } from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../persistence/db';
import { RateLimitException } from '../common/domain.exception';
import { hashPassword, verifyPassword } from './password';

export const VERIFICATION_ERROR = '인증코드가 올바르지 않거나 만료되었습니다. 새 코드를 받아 다시 시도해 주세요.';
const TTL_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;
export interface SignupChallenge {
  verificationId: string;
  expiresAt: string;
  resendAfterSeconds: number;
}
interface Row {
  verification_id: string;
  code_hash: string | null;
  expires_at: Date;
  attempts: number;
  delivered: boolean;
  last_sent_at: Date;
  window_started_at: Date;
  send_count: number;
}

export class SignupVerificationRepository {
  constructor(private readonly pool: Pool) {}

  async reserve(email: string): Promise<SignupChallenge & { code: string }> {
    const verificationId = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeHash = await hashPassword(code);
    return withTransaction(this.pool, async (client) => {
      // 복수 프로세스에서도 이메일·전역 발송 한도를 함께 예약한다. 네트워크는 잠금 밖이다.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('tourlint:signup-mail'))`);
      const now = new Date();
      const { rows } = await client.query<Row>(
        `SELECT * FROM signup_verification WHERE email = $1 FOR UPDATE`, [email],
      );
      const old = rows[0];
      const elapsed = old ? now.getTime() - old.last_sent_at.getTime() : Infinity;
      if (elapsed < 60_000) {
        throw new RateLimitException('인증코드는 60초 후 다시 받을 수 있습니다.', Math.ceil((60_000 - elapsed) / 1000));
      }
      const inWindow = old && now.getTime() - old.window_started_at.getTime() < HOUR_MS;
      if (inWindow && old.send_count >= 5) {
        throw new RateLimitException('인증메일 요청이 많습니다. 잠시 후 다시 시도해 주세요.',
          Math.ceil((old.window_started_at.getTime() + HOUR_MS - now.getTime()) / 1000));
      }
      const minute = Math.floor(now.getTime() / 60_000);
      const day = Math.floor(now.getTime() / 86_400_000);
      for (const [bucket, max, end] of [
        [`minute:${minute}`, 10, (minute + 1) * 60_000],
        [`day:${day}`, 100, (day + 1) * 86_400_000],
      ] as const) {
        const quota = await client.query(
          `INSERT INTO auth_email_rate_limit (bucket, count, expires_at) VALUES ($1, 1, $2)
           ON CONFLICT (bucket) DO UPDATE SET count = auth_email_rate_limit.count + 1
             WHERE auth_email_rate_limit.count < $3 RETURNING count`, [bucket, new Date(end), max],
        );
        if (quota.rowCount === 0) {
          throw new RateLimitException('인증메일 요청이 많습니다. 잠시 후 다시 시도해 주세요.', Math.ceil((end - now.getTime()) / 1000));
        }
      }
      const expiresAt = new Date(now.getTime() + TTL_MS);
      await client.query(
        `INSERT INTO signup_verification
           (email, verification_id, code_hash, expires_at, last_sent_at, window_started_at, send_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (email) DO UPDATE SET verification_id = EXCLUDED.verification_id,
           code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0,
           delivered = FALSE, last_sent_at = EXCLUDED.last_sent_at,
           window_started_at = EXCLUDED.window_started_at, send_count = EXCLUDED.send_count`,
        [email, verificationId, codeHash, expiresAt, now,
          inWindow ? old.window_started_at : now, inWindow ? old.send_count + 1 : 1],
      );
      return { verificationId, code, expiresAt: expiresAt.toISOString(), resendAfterSeconds: 60 };
    });
  }

  async markDelivered(id: string): Promise<void> {
    await this.pool.query(`UPDATE signup_verification SET delivered = TRUE WHERE verification_id = $1`, [id]);
  }

  async invalidate(id: string): Promise<void> {
    await this.pool.query(`UPDATE signup_verification SET code_hash = NULL, delivered = FALSE WHERE verification_id = $1`, [id]);
  }

  /** 실패 횟수는 커밋한다. 성공은 계정·기본 설정 생성과 코드 소비를 같은 트랜잭션으로 묶는다. */
  async consume<T>(email: string, id: string, code: string, create: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !/^\d{6}$/.test(code)) {
      throw new BadRequestException(VERIFICATION_ERROR);
    }
    const result = await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<Row>(
        `SELECT * FROM signup_verification WHERE email = $1 AND verification_id = $2 FOR UPDATE`, [email, id],
      );
      const row = rows[0];
      if (!row || !row.delivered || row.code_hash === null || row.expires_at.getTime() <= Date.now() || row.attempts >= 5) {
        return { ok: false } as const;
      }
      if (!(await verifyPassword(code, row.code_hash))) {
        await client.query(`UPDATE signup_verification SET attempts = attempts + 1 WHERE email = $1`, [email]);
        return { ok: false } as const;
      }
      const value = await create(client);
      await client.query(`UPDATE signup_verification SET code_hash = NULL, delivered = FALSE WHERE email = $1`, [email]);
      return { ok: true, value } as const;
    });
    if (!result.ok) throw new BadRequestException(VERIFICATION_ERROR);
    return result.value;
  }

  async cleanup(): Promise<void> {
    await this.pool.query(`DELETE FROM signup_verification WHERE last_sent_at < now() - interval '24 hours'`);
    await this.pool.query(`DELETE FROM auth_email_rate_limit WHERE expires_at < now()`);
  }
}
