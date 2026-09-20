import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import { KtoClient } from '../external/kto';
import { FixtureKtoTransport } from '../external/kto';
import type { KtoParams, KtoTransport, KtoTransportResult } from '../external/kto/transport';
import { CatalogService } from './catalog.service';

// fixtures/kto 의 실호출 스냅샷을 리플레이한다 (kto.factory 의 기본 경로와 동일).
const FIXTURE_DIR = resolve(process.cwd(), '../../fixtures/kto');

function factory(): { make: () => KtoClient; transport: FixtureKtoTransport } {
  // 리플레이는 호출 로그를 남기지 않으므로(FR-OP-007) 호출 수는 transport 가 센다
  const transport = new FixtureKtoTransport(FIXTURE_DIR);
  return {
    make: () => new KtoClient({ transport, logger: new InMemoryApiCallLogger() }),
    transport,
  };
}

describe('CatalogService', () => {
  it('시도 목록을 code·name 으로 정규화한다', async () => {
    const svc = new CatalogService(factory().make);
    const regions = await svc.regions();
    expect(regions.length).toBeGreaterThan(0);
    // 스냅샷에 담긴 실제 값 (01_ldongCode2_sido.json)
    expect(regions).toContainEqual({ code: '11', name: '서울특별시' });
    expect(regions.every((r) => r.code !== '' && r.name !== '')).toBe(true);
  });

  it('분류 대분류 목록을 반환한다', async () => {
    const svc = new CatalogService(factory().make);
    const cats = await svc.categories();
    expect(cats.length).toBeGreaterThan(0);
    expect(cats.every((c) => c.code !== '' && c.name !== '')).toBe(true);
  });

  it('fixture 에 없는 지역의 시군구는 빈 목록이다 — 시도를 시군구인 척 돌려주지 않는다', async () => {
    const svc = new CatalogService(factory().make);
    // 11(서울) 시군구 스냅샷은 없다. 실호출 모드면 실제로 채워지지만 fixture 는 빈 목록.
    const signgus = await svc.signgus('11');
    expect(signgus).toEqual([]);
  });

  it('두 번 불러도 공사 호출은 한 번뿐이다 — 캐시로 예산을 아낀다', async () => {
    const { make, transport } = factory();
    const svc = new CatalogService(make);
    await svc.regions();
    await svc.regions();
    expect(transport.replayCounts.get('ldongCode2')).toBe(1);
  });
});

/**
 * 앞에서 `failures` 번은 시간 초과로 끊고 그 뒤에는 스냅샷을 돌려주는 전송 계층.
 * 운영에서 본 모양 그대로다 — 공사가 응답을 안 줘서 10초에 끊긴다 (#662).
 */
class FlakyTransport implements KtoTransport {
  readonly kind = 'http' as const;
  calls = 0;
  private readonly inner = new FixtureKtoTransport(FIXTURE_DIR);
  constructor(private failures: number) {}
  async request(operation: Parameters<KtoTransport['request']>[0], params: KtoParams): Promise<KtoTransportResult> {
    this.calls += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error(`[${operation}] 응답 시간 초과 (10000ms)`);
    }
    return this.inner.request(operation, params);
  }
}

const flaky = (failures: number): { make: () => KtoClient; warm: () => KtoClient; transport: FlakyTransport } => {
  const transport = new FlakyTransport(failures);
  const logger = new InMemoryApiCallLogger();
  return {
    make: () => new KtoClient({ transport, logger }),
    // 예열 클라이언트는 운영과 같게 스스로 재시도하지 않는다 — 예열 고리가 시도를 센다
    warm: () => new KtoClient({ transport, logger, maxRetries: 0 }),
    transport,
  };
};

describe('공사가 답하지 않을 때 (#662)', () => {
  it('계속 끊기면 올린다 — 빈 목록으로 삼키지 않는다', async () => {
    // KtoClient 가 EI-CM-005 대로 두 번 다시 부른 뒤 포기한다
    await expect(new CatalogService(flaky(99).make).regions()).rejects.toThrow(/시간 초과/);
  });

  it('🔴 부팅 예열이 성공하면 사용자 요청은 공사를 부르지 않는다', async () => {
    const { make, warm, transport } = flaky(0);
    const svc = new CatalogService(make, warm);
    const lines: string[] = [];
    await svc.warm((line) => lines.push(line), 1);
    const before = transport.calls;
    await svc.regions();
    await svc.categories();
    expect(transport.calls).toBe(before);
    expect(lines.join(' ')).toMatch(/지역 코드 예열 \d+건/);
    expect(lines.join(' ')).toMatch(/분류 코드 예열 \d+건/);
  });

  it('예열이 끝내 실패해도 부팅을 막지 않는다 — 실패를 한 줄로 남긴다', async () => {
    const lines: string[] = [];
    const dead = flaky(99);
    await new CatalogService(dead.make, dead.warm).warm((line) => lines.push(line), 1);
    expect(lines.join(' ')).toMatch(/지역 코드 예열 3번째 실패/);
    expect(lines.join(' ')).toMatch(/시간 초과/);
  });
});
