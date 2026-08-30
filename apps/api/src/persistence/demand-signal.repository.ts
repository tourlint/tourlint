import type { Pool } from 'pg';
import type { Signal, SignalWindow, TypeBreakdown } from '../engine/signals';

/**
 * 수요 신호 T1 · T2 저장소 (`demand_signal` · F14 · DB 명세서 v1.9).
 *
 * 배치가 미리 산출해 두고 조회는 읽기만 한다 (2026-08-30 결정). 요청마다 공사를 부르면
 * 레이더 화면을 열 때마다 예산이 나간다.
 *
 * ⚠️ **공사 원문을 담지 않는다.** `by_type` 은 `contentTypeId` → 건수 분포일 뿐이고
 *    관광지명 · 주소는 어디에도 없다 (DR-PR-001).
 */

export type SignalType = 'T1' | 'T2';

export interface StoredSignal {
  readonly type: SignalType;
  readonly count: number;
  readonly byType: TypeBreakdown;
  readonly window: SignalWindow;
  readonly computedAt: Date;
}

/** 시군구가 NULL 인 행이 UNIQUE 를 무력화하는 것을 피한다 (`notification.change_key` 와 같은 함정) */
export function regionKey(regnCd: string, signguCd: string | null): string {
  return signguCd === null || signguCd === '' ? regnCd : `${regnCd}:${signguCd}`;
}

export class DemandSignalRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * 산출값을 넣거나 갱신한다.
   *
   * 같은 구간을 다시 산출하면 덮어쓴다 — 배치가 하루에 두 번 돌 수도 있고, 그때는
   * 나중 값이 맞다. `computed_at` 이 언제 것인지 말해 준다.
   */
  async upsert(type: SignalType, signal: Signal, computedAt: Date): Promise<void> {
    const { ldongRegnCd, ldongSignguCd } = signal.window;
    if (ldongRegnCd === null) return; // 지역 없는 신호는 저장하지 않는다 — 조회할 방법이 없다
    await this.pool.query(
      `INSERT INTO demand_signal
         (signal_type, region_key, ldong_regn_cd, ldong_signgu_cd,
          window_from, window_to, total_count, by_type, computed_at)
       VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8::jsonb,$9)
       ON CONFLICT (signal_type, region_key, window_from, window_to) DO UPDATE
         SET total_count = EXCLUDED.total_count,
             by_type     = EXCLUDED.by_type,
             computed_at = EXCLUDED.computed_at`,
      [type, regionKey(ldongRegnCd, ldongSignguCd), ldongRegnCd, ldongSignguCd,
       signal.window.from, signal.window.to, signal.count,
       JSON.stringify(signal.byType), computedAt],
    );
  }

  /**
   * 그 구간의 산출값. 없으면 `null` 이다.
   *
   * **없는 것을 0 으로 돌려주지 않는다.** 0 은 「세어 보니 없었다」이고 `null` 은
   * 「아직 안 세어 봤다」다 — 둘을 섞으면 배치가 안 돈 것을 신호 없음으로 읽는다.
   */
  async find(type: SignalType, window: SignalWindow): Promise<StoredSignal | null> {
    if (window.ldongRegnCd === null) return null;
    const { rows } = await this.pool.query<SignalRow>(
      `SELECT signal_type, ldong_regn_cd, ldong_signgu_cd, window_from, window_to,
              total_count, by_type, computed_at
         FROM demand_signal
        WHERE signal_type = $1 AND region_key = $2
          AND window_from = $3::date AND window_to = $4::date`,
      [type, regionKey(window.ldongRegnCd, window.ldongSignguCd), window.from, window.to],
    );
    const row = rows[0];
    return row === undefined ? null : toStored(row);
  }

  /** 오래된 산출값을 지운다. 배치가 매일 새 구간을 만들어 무한히 쌓이는 것을 막는다 */
  async pruneBefore(cutoff: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM demand_signal WHERE window_to < $1::date`, [cutoff],
    );
    return rowCount ?? 0;
  }
}

interface SignalRow {
  signal_type: string;
  ldong_regn_cd: string;
  ldong_signgu_cd: string | null;
  window_from: Date | string;
  window_to: Date | string;
  total_count: number;
  by_type: TypeBreakdown;
  computed_at: Date;
}

function toStored(row: SignalRow): StoredSignal {
  return {
    type: row.signal_type as SignalType,
    count: Number(row.total_count),
    byType: row.by_type,
    window: {
      ldongRegnCd: row.ldong_regn_cd,
      ldongSignguCd: row.ldong_signgu_cd,
      from: isoDate(row.window_from),
      to: isoDate(row.window_to),
    },
    computedAt: row.computed_at,
  };
}

/** `DATE` 는 드라이버 설정에 따라 `Date` 로도 문자열로도 온다. 한국 시간 기준이다 */
function isoDate(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date(v.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10);
}
