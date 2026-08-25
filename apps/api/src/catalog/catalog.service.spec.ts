import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import { KtoClient } from '../external/kto';
import { FixtureKtoTransport } from '../external/kto';
import { CatalogService } from './catalog.service';

// fixtures/kto 의 실호출 스냅샷을 리플레이한다 (kto.factory 의 기본 경로와 동일).
const FIXTURE_DIR = resolve(process.cwd(), '../../fixtures/kto');

function factory(logger = new InMemoryApiCallLogger()): { make: () => KtoClient; logger: InMemoryApiCallLogger } {
  return {
    make: () => new KtoClient({ transport: new FixtureKtoTransport(FIXTURE_DIR), logger }),
    logger,
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
    const { make, logger } = factory();
    const svc = new CatalogService(make);
    await svc.regions();
    await svc.regions();
    const ldongCalls = logger.entries.filter((e) => e.operation === 'ldongCode2');
    expect(ldongCalls).toHaveLength(1);
  });
});
