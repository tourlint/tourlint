import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import { FixtureKtoTransport, KtoClient } from '../external/kto';
import { SignalRunner } from './signal-runner';

const FIXTURES = join(__dirname, '../../../../fixtures/kto');

describe('SignalRunner.t3 — 방문자수 픽스처 (EI-KT-026)', () => {
  const runner = new SignalRunner({
    kto: () => new KtoClient({ transport: new FixtureKtoTransport(FIXTURES), logger: new InMemoryApiCallLogger() }),
  });
  // 픽스처는 2025-09-01 하루치 전국이다
  const day = { from: '2025-09-01', to: '2025-09-01' };

  it('🔴 전국 한 번 받은 것을 지역마다 거른다 — 강릉 · 세종은 값, 지난해 코드에 없는 지역은 null', async () => {
    const results = await runner.t3([
      { ldongRegnCd: '51', ldongSignguCd: '150', ...day },
      { ldongRegnCd: '36110', ldongSignguCd: null, ...day },
      // 전남광주통합특별시(12)는 2026년 코드라 2025년 자료에 없다
      { ldongRegnCd: '12', ldongSignguCd: '110', ...day },
    ]);
    // 강릉 51150 = 202688.5 + 69744.5 + 821.66, 세종 36110 = 239151.5 + 70441 + 1275.75
    expect(results?.map((s) => s?.count ?? null)).toEqual([273255, 310868, null]);
  });

  it('조회에 실패하면 전체가 null 이다 — 0 으로 저장하지 않는다', async () => {
    // 픽스처에 없는 기간은 FixtureMissingError 다
    expect(await runner.t3([{ ldongRegnCd: '51', ldongSignguCd: '150', from: '2025-10-01', to: '2025-10-31' }])).toBeNull();
  });

  it('기간이 다른 창을 한 번에 부르지 않는다 — 방문자수는 기간 하나에 1콜이다', async () => {
    await expect(runner.t3([
      { ldongRegnCd: '51', ldongSignguCd: '150', ...day },
      { ldongRegnCd: '51', ldongSignguCd: '210', from: '2025-09-02', to: '2025-09-02' },
    ])).rejects.toThrow(/같은 기간/);
  });
});
