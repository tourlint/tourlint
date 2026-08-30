import type { Pool } from 'pg';
import type { MatchCondition } from '../batch/impact-finder';
import { BATCH_KEY } from '../persistence/batch-state.repository';

/**
 * 레이더 조회 (F12 ~ F14 · FR-MO-050 · 006 · 058).
 *
 * **모든 조회에 `account_id` 를 건다** (PM-DA-002 · EX-SY-003).
 */

export interface RadarCounts {
  readonly risk: number;
  readonly opportunity: number;
  readonly unread: number;
  readonly affectedProducts: number;
  readonly changedContents: number;
}

export interface BatchState {
  readonly lastRunAt: Date | null;
  readonly lastCovered: string | null;
  readonly lastStatus: string | null;
  readonly lastItemCount: number | null;
}

export interface ChangeRow {
  readonly notificationId: number;
  readonly productId: number;
  readonly productName: string;
  readonly ktoContentId: string | null;
  readonly condition: MatchCondition;
  readonly hashFrom: string | null;
  readonly hashTo: string | null;
  readonly modifiedTime: string | null;
  readonly hidden: boolean;
  readonly detectedAt: Date;
  /** 사용자가 입력한 장소명. 공사 원문이 아니다 (DR-PR-001) */
  readonly placeLabel: string | null;
  /** 판독 결과 전 · 후. 재검수가 돌아 지문이 두 번 이상 쌓인 경우에만 있다 */
  readonly normalizedBefore: unknown | null;
  readonly normalizedAfter: unknown | null;
}

export interface ProductRegion {
  readonly productId: number;
  readonly name: string;
  readonly ldongRegnCd: string;
  readonly ldongSignguCd: string | null;
  readonly startDate: string;
  readonly nights: number;
}

export class RadarRepository {
  constructor(private readonly pool: Pool) {}

  /** 요약 건수 (FR-MO-050). 무시한 알림은 세지 않는다 */
  async counts(accountId: number): Promise<RadarCounts> {
    const { rows } = await this.pool.query<{
      risk: string; opportunity: string; unread: string;
      products: string; contents: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE n.kind = 'RISK')        AS risk,
         count(*) FILTER (WHERE n.kind = 'OPPORTUNITY') AS opportunity,
         count(*) FILTER (WHERE n.read_at IS NULL)      AS unread,
         count(DISTINCT n.product_id)                   AS products,
         count(DISTINCT n.kto_content_id)               AS contents
       FROM notification n
       JOIN product p ON p.id = n.product_id
      WHERE p.account_id = $1 AND n.dismissed_at IS NULL`,
      [accountId],
    );
    const r = rows[0];
    return {
      risk: Number(r?.risk ?? 0),
      opportunity: Number(r?.opportunity ?? 0),
      unread: Number(r?.unread ?? 0),
      affectedProducts: Number(r?.products ?? 0),
      changedContents: Number(r?.contents ?? 0),
    };
  }

  /**
   * 마지막 배치 상태 (NF-OB-004). 전역 값이라 계정과 무관하다.
   *
   * ⚠️ **키를 여기서 지어내지 않는다.** `'sync'` 라고 박아 뒀다가 실제 키가 `'sync_list'`
   * 라서 `lastBatch` 가 영영 `null` 로 나갔다 (2026-08-30 운영에서 확인). 배치가 쓰는
   * 상수를 그대로 가져다 쓴다.
   */
  async batchState(key: string = BATCH_KEY): Promise<BatchState | null> {
    const { rows } = await this.pool.query<{
      last_run_at: Date | null; last_covered: Date | string | null;
      last_status: string | null; last_item_count: number | null;
    }>(
      `SELECT last_run_at, last_covered, last_status, last_item_count
         FROM batch_state WHERE key = $1`,
      [key],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      lastRunAt: r.last_run_at,
      lastCovered: r.last_covered === null ? null : isoDate(r.last_covered),
      lastStatus: r.last_status,
      lastItemCount: r.last_item_count === null ? null : Number(r.last_item_count),
    };
  }

  /**
   * 변경 감지 내역 (FR-MO-006 · 058).
   *
   * **출처는 배치가 만든 알림이다.** 레이더가 답하는 질문이 「지난번 이후 무엇이
   * 달라졌나」이고 그걸 아는 것은 배치뿐이다.
   *
   * 판독 결과 전 · 후(FR-MO-006)는 `content_fingerprint` 에서 붙인다. 그 값은 **검수
   * 실행에만 딸려 있어** 재검수가 돌아 지문이 두 번 이상 쌓인 콘텐츠에만 있다.
   * 없으면 `null` 로 두고 화면이 「판독 결과 비교 없음」으로 표시한다 — 없는 것을
   * 있는 것처럼 채우지 않는다 (FR-RU-051 과 같은 원칙).
   */
  async changes(accountId: number, page: number, size: number): Promise<{
    total: number; rows: readonly ChangeRow[];
  }> {
    const total = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM notification n
         JOIN product p ON p.id = n.product_id
        WHERE p.account_id = $1 AND n.dismissed_at IS NULL AND n.kto_content_id IS NOT NULL`,
      [accountId],
    );

    const { rows } = await this.pool.query<ChangeQueryRow>(
      `WITH fp AS (
         SELECT f.kto_content_id, r.product_id, f.normalized_json, f.fetched_at,
                row_number() OVER (PARTITION BY r.product_id, f.kto_content_id
                                   ORDER BY f.fetched_at DESC) AS rn
           FROM content_fingerprint f
           JOIN audit_run r ON r.id = f.audit_run_id
           JOIN product p2 ON p2.id = r.product_id
          WHERE p2.account_id = $1
       )
       SELECT n.id, n.product_id, p.name AS product_name, n.kto_content_id,
              n.match_condition, n.change_hash_from, n.change_hash_to,
              n.body, n.created_at,
              it.place_label,
              fa.normalized_json AS normalized_after,
              fb.normalized_json AS normalized_before
         FROM notification n
         JOIN product p ON p.id = n.product_id
         LEFT JOIN LATERAL (
           SELECT i.place_label FROM itinerary_item i
            WHERE i.product_id = n.product_id AND i.kto_content_id = n.kto_content_id
            LIMIT 1
         ) it ON TRUE
         LEFT JOIN fp fa ON fa.product_id = n.product_id
                        AND fa.kto_content_id = n.kto_content_id AND fa.rn = 1
         LEFT JOIN fp fb ON fb.product_id = n.product_id
                        AND fb.kto_content_id = n.kto_content_id AND fb.rn = 2
        WHERE p.account_id = $1 AND n.dismissed_at IS NULL AND n.kto_content_id IS NOT NULL
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT $2 OFFSET $3`,
      [accountId, size, page * size],
    );

    return { total: Number(total.rows[0]?.n ?? 0), rows: rows.map(toChange) };
  }

  /** 그 계정의 상품 하나. 신호 조회 창을 만들 때 쓴다 */
  async product(accountId: number, productId: number): Promise<ProductRegion | null> {
    const { rows } = await this.pool.query<{
      id: string; name: string; ldong_regn_cd: string; ldong_signgu_cd: string | null;
      start_date: Date | string; nights: number;
    }>(
      `SELECT id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights
         FROM product WHERE id = $1 AND account_id = $2`,
      [productId, accountId],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      productId: Number(r.id),
      name: r.name,
      ldongRegnCd: r.ldong_regn_cd,
      ldongSignguCd: r.ldong_signgu_cd,
      startDate: isoDate(r.start_date),
      nights: Number(r.nights),
    };
  }

  /** 배치가 신호를 산출할 대상. 여행이 끝나지 않은 상품의 지역·일정이다 */
  async watchedRegions(today: string): Promise<readonly ProductRegion[]> {
    const { rows } = await this.pool.query<{
      id: string; name: string; ldong_regn_cd: string; ldong_signgu_cd: string | null;
      start_date: Date | string; nights: number;
    }>(
      `SELECT id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights
         FROM product WHERE start_date + nights >= $1::date ORDER BY id`,
      [today],
    );
    return rows.map((r) => ({
      productId: Number(r.id),
      name: r.name,
      ldongRegnCd: r.ldong_regn_cd,
      ldongSignguCd: r.ldong_signgu_cd,
      startDate: isoDate(r.start_date),
      nights: Number(r.nights),
    }));
  }
}

interface ChangeQueryRow {
  id: string;
  product_id: string;
  product_name: string;
  kto_content_id: string | null;
  match_condition: number;
  change_hash_from: string | null;
  change_hash_to: string | null;
  body: Record<string, unknown>;
  created_at: Date;
  place_label: string | null;
  normalized_before: unknown | null;
  normalized_after: unknown | null;
}

function toChange(row: ChangeQueryRow): ChangeRow {
  const body = row.body;
  return {
    notificationId: Number(row.id),
    productId: Number(row.product_id),
    productName: row.product_name,
    ktoContentId: row.kto_content_id,
    condition: Number(row.match_condition) as MatchCondition,
    hashFrom: row.change_hash_from,
    hashTo: row.change_hash_to,
    modifiedTime: typeof body.modifiedTime === 'string' ? body.modifiedTime : null,
    hidden: body.hidden === true,
    detectedAt: row.created_at,
    placeLabel: row.place_label,
    normalizedBefore: row.normalized_before,
    normalizedAfter: row.normalized_after,
  };
}

function isoDate(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date(v.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10);
}
