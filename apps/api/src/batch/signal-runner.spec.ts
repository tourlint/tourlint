import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import { FixtureKtoTransport, KtoClient } from '../external/kto';
import { summarizeFestivals } from '../engine/signals';
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

/**
 * 건수만 보여 주던 화면에 「무엇인지」를 붙였다 (#644). 세는 조건과 같은 함수를 쓰므로
 * 목록과 건수가 갈라지지 않아야 한다.
 */
describe('SignalRunner.listT2 — 무엇인지 보기 (#644)', () => {
  const runner = new SignalRunner({
    kto: () => new KtoClient({ transport: new FixtureKtoTransport(FIXTURES), logger: new InMemoryApiCallLogger() }),
  });
  const window = { ldongRegnCd: '51', ldongSignguCd: '150', from: '2026-10-20', to: '2026-10-26' };

  it('🔴 그 기간에 열리는 행사를 이름과 기간으로 준다', async () => {
    const items = await runner.listT2(window, 10);
    expect(items).toEqual([{
      contentId: '825295', title: '강릉커피축제', contentTypeId: '15',
      createdTime: expect.any(String), eventStart: '2026-10-21', eventEnd: '2026-10-25',
    }]);
  });

  it('🔴 건수와 같은 조건으로 거른다 — 기간이 안 겹치면 목록도 비어 있다', async () => {
    const other = { ...window, from: '2026-11-01', to: '2026-11-07' };
    expect(await runner.listT2(other, 10)).toEqual([]);
    // 같은 창을 세면 0 이다. 목록과 건수가 같은 말을 한다
    expect(summarizeFestivals(
      [{ contentId: '825295', contentTypeId: '15', ldongRegnCd: '51', ldongSignguCd: '150',
         createdTime: '20260101000000', eventStart: '2026-10-21', eventEnd: '2026-10-25', matchedKeywords: [] }],
      other,
    ).count).toBe(0);
  });
});
