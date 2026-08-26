import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryApiCallLogger } from '../src/external/api-call-log';
import {
  HttpKmaTransport, KmaClient, MID_OFFSET_RANGE, chooseMidPublication, chooseShortPublication,
  kstToday, midLandRegionOf, toGrid,
} from '../src/external/kma';
import { ForecastMissingError } from '../src/external/kma/kma.errors';
import { addDays, formatIsoDate, parseIsoDate } from '../src/engine/calendar/dates';

/**
 * 실호출 스모크 — **기상청 예보를 실제로 두드린다.**
 *
 * 기본으로는 돌지 않는다. `LIVE_KMA=1` 을 줘야 실행된다.
 *   LIVE_KMA=1 pnpm --filter @tourlint/api exec vitest run test/live-kma.smoke.spec.ts
 *
 * 리플레이가 드러내지 못하는 것만 본다.
 *   · 인증키가 실제로 통하는가 (기상청은 공사와 **별개의 활용신청**이 필요하다 — EI-WX-001)
 *   · 06시 발표분에 `rnSt4*` 가 아직 있는가 (이슈 #92 의 근거)
 *   · 단기예보가 여전히 D+3 을 덮는가
 *
 * ⚠️ **인증키를 출력하지 않는다.** 어댑터가 URL 을 오류에 싣지 않는다 (EI-CM-002).
 */

const ENABLED = process.env.LIVE_KMA === '1';

/** `.env` 를 직접 읽는다. dotenv 를 의존성으로 들이지 않기 위해서다 */
function serviceKeyFromEnv(): string {
  if (process.env.KMA_SERVICE_KEY !== undefined && process.env.KMA_SERVICE_KEY !== '') {
    return process.env.KMA_SERVICE_KEY;
  }
  const envFile = join(__dirname, '../../../.env');
  if (!existsSync(envFile)) return '';
  return /^KMA_SERVICE_KEY=(.*)$/m.exec(readFileSync(envFile, 'utf8'))?.[1]?.trim() ?? '';
}

/** 강릉 대표 좌표 */
const GANGNEUNG = { lon: 128.8761, lat: 37.7519 };

function plusDays(days: number, now: Date): string {
  const today = parseIsoDate(kstToday(now));
  return today === null ? '' : formatIsoDate(addDays(today, days));
}

describe.skipIf(!ENABLED)('기상청 예보 실호출 스모크', () => {
  const now = new Date();
  const logger = new InMemoryApiCallLogger();
  const client = (): KmaClient => {
    const serviceKey = serviceKeyFromEnv();
    if (serviceKey === '') throw new Error('KMA_SERVICE_KEY 가 없다 (.env 확인)');
    return new KmaClient({ transport: new HttpKmaTransport(serviceKey), logger });
  };

  it('① 인증키가 통하고 단기예보가 D+3 을 덮는다', async () => {
    const grid = toGrid(GANGNEUNG.lon, GANGNEUNG.lat);
    expect(grid).not.toBeNull();

    const forecast = await client().shortTermPop(grid!, chooseShortPublication(now));

    // 발표분 확인은 어댑터가 한다 — 여기까지 왔으면 요청한 발표분이 온 것이다
    expect(forecast.pop.size).toBeGreaterThan(0);
    const d3 = forecast.pop.get(plusDays(3, now));
    expect(d3, 'D+3 예보가 없다 — 단기 커버리지가 줄었는지 확인할 것').toBeDefined();
    expect(d3!.size).toBeGreaterThan(0);
  });

  it('② 06시 발표분이 D+4 를 덮는다 (이슈 #92)', async () => {
    const target = plusDays(4, now);
    const publication = chooseMidPublication(now, target);
    expect(publication, 'D+4 를 덮는 발표분이 없다').not.toBeNull();

    const forecast = await client().midLandRain(midLandRegionOf('51', '150')!, publication!);

    expect(forecast.byDate.has(target), `${target} 강수확률이 없다 — 중기 시작점이 또 바뀌었는지 확인할 것`).toBe(true);
    expect(forecast.byDate.get(target)).toBeGreaterThanOrEqual(0);
  });

  it('③ 18시 발표분에는 rnSt4 가 없다 — 시작점이 발표 시각에 따라 다르다', async (ctx) => {
    const today = kstToday(now);
    const at1800 = { tmFc: `${today.replace(/-/g, '')}1800`, baseDate: today, hour: 18 } as const;

    // 18시 발표 전이면 이 조회 자체가 의미 없다 (EI-WX-008 — 이전 발표분이 조용히 온다).
    // 조용히 통과시키지 않고 건너뛴 것을 출력에 남긴다
    const published = chooseMidPublication(now, plusDays(5, now));
    if (published?.hour !== 18) ctx.skip();

    const forecast = await client().midLandRain('11D20000', at1800);
    expect(forecast.byDate.has(plusDays(4, now))).toBe(false);
    expect(MID_OFFSET_RANGE[18].from).toBe(5);
  });

  it('④ 발표되지 않은 단기 발표분은 NO_DATA 다', async () => {
    const tomorrow = plusDays(1, now).replace(/-/g, '');
    await expect(
      client().shortTermPop({ nx: 92, ny: 131 }, { baseDate: tomorrow, baseTime: '0500' }),
    ).rejects.toThrow(ForecastMissingError);
  });

  it('⑤ 호출이 전부 로그에 남는다 (FR-OP-001)', () => {
    expect(logger.entries.length).toBeGreaterThan(0);
    for (const entry of logger.entries) {
      expect(entry.provider).toBe('KMA');
      expect(['getVilageFcst', 'getMidLandFcst']).toContain(entry.operation);
      expect(entry.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });
});
