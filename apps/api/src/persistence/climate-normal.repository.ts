import type { Pool } from 'pg';
import { climateStationOf } from '@tourlint/shared';
import type { ClimateNormal, ClimateNormalLookup } from '../audit/audit-runner';

/**
 * 평년 강수일수 조회 (`climate_normal` · EI-WX-004 · FR-RU-091 D+11 이상).
 *
 * 파일로 배포되는 통계를 사전 구축한 고정 테이블이다. 실시간 호출 의무는 한국관광공사
 * 데이터에만 적용되므로(SC-DT-014) 여기에는 걸리지 않는다.
 *
 * **표가 비어 있으면 `null` 이고 그 날짜는 확인 불가가 된다** (FR-RU-051). 인접 시도 값으로
 * 대신 채우지 않는다 — 지어낸 값으로 「우천 위험 없음」을 말하는 것이 확인 불가보다 나쁘다.
 *
 * 실행 안에서 캐시한다. 2박 3일 상품이면 같은 시도 · 같은 달을 세 번 묻는다.
 */
export class ClimateNormalRepository implements ClimateNormalLookup {
  private readonly cache = new Map<string, ClimateNormal | null>();

  constructor(private readonly pool: Pool) {}

  async find(ldongRegnCd: string, month: number): Promise<ClimateNormal | null> {
    const key = `${ldongRegnCd}-${month}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const found = await this.query(ldongRegnCd, month);
    this.cache.set(key, found);
    return found;
  }

  private async query(ldongRegnCd: string, month: number): Promise<ClimateNormal | null> {
    // 지점명은 판정 문장에 들어간다. 표에는 열이 없고 시도 → 대표 지점 표가 정본이다
    const station = climateStationOf(ldongRegnCd);
    if (station === null) return null;


    const { rows } = await this.pool.query<{ rain_days: string; rain_ratio: string }>(
      `SELECT rain_days, rain_ratio FROM climate_normal WHERE ldong_regn_cd = $1 AND month = $2`,
      [ldongRegnCd, month],
    );
    const row = rows[0];
    if (row === undefined) return null;

    const rainDays = Number(row.rain_days);
    const rainRatio = Number(row.rain_ratio);
    // NUMERIC 은 문자열로 온다. 못 읽으면 0 으로 뭉개지 않고 없는 것으로 본다
    if (!Number.isFinite(rainDays) || !Number.isFinite(rainRatio)) return null;

    return { rainDays, rainRatio, regionName: station.name };
  }
}
