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
      // 'mock' 을 고정으로 박아두면 실엔진으로 바뀐 뒤에도 목업처럼 보인다.
      // 공사 호출을 모의로 전면 대체했는지는 심사 항목이므로(NF-CO-002) 사실대로 보여준다
      mode: process.env.KTO_MODE === 'fixture' ? 'fixture' : 'live',
      latencyMs: Date.now() - started,
      timestamp: new Date().toISOString(),
    };
  }
}
