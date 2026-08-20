import { Controller, Get } from '@nestjs/common';
import { Client } from 'pg';

/**
 * NF-AV-004: /health — 애플리케이션과 DB 연결 상태 확인
 * 인증 없이 접근 가능하되 내부 정보(연결 문자열 등)를 노출하지 않는다.
 * Railway 등의 Healthcheck Path로 사용한다.
 */
@Controller('health')
export class HealthController {
  @Get()
  async check() {
    const started = Date.now();
    let db: 'up' | 'down' = 'down';
    const url = process.env.DATABASE_URL;
    if (url) {
      const client = new Client({
        connectionString: url,
        ssl: url.includes('localhost') || url.includes('127.0.0.1') ? undefined : { rejectUnauthorized: false },
        connectionTimeoutMillis: 3000,
      });
      try {
        await client.connect();
        await client.query('SELECT 1');
        db = 'up';
      } catch {
        db = 'down';
      } finally {
        await client.end().catch(() => undefined);
      }
    }
    return {
      status: db === 'up' || !url ? 'ok' : 'degraded',
      db,
      mode: 'mock',
      latencyMs: Date.now() - started,
      timestamp: new Date().toISOString(),
    };
  }
}
