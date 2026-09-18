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

/**
 * 관심 지역 한 칸 (`user_setting.watch_regions` · FR-MO-059). 시군구 + 달이고, 세종은 시군구
 * 단계가 없어 `ldongSignguCd` 가 null 이다. 그 계정의 관심 키워드를 함께 싣는다.
 */
export interface WatchRegion {
  readonly accountId: number;
  readonly ldongRegnCd: string;
  readonly ldongSignguCd: string | null;
  /** `YYYY-MM` */
  readonly month: string;
  readonly keywords: readonly string[];
}

/** 신호 배치의 대상 상품. 그 상품 계정의 관심 키워드를 함께 싣는다 (FR-RU-112) */
export interface WatchedProduct extends ProductRegion {
  readonly keywords: readonly string[];
}

/** 오늘 할 일이 보는 상품 한 줄 (FR-AG-030) */
export interface BriefProduct extends ProductRegion {
  readonly released: boolean;
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
      WHERE p.account_id = $1 AND p.start_date + p.nights >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date
          AND n.dismissed_at IS NULL`,
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
        WHERE p.account_id = $1 AND p.start_date + p.nights >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date
          AND n.dismissed_at IS NULL AND n.kto_content_id IS NOT NULL`,
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
        WHERE p.account_id = $1 AND p.start_date + p.nights >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date
          AND n.dismissed_at IS NULL AND n.kto_content_id IS NOT NULL
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

  /**
   * 배치가 신호를 산출할 대상. 여행이 끝나지 않은 상품의 지역·일정과 그 계정의 관심 키워드다.
   *
   * 키워드는 배치가 창마다 합쳐서 한 번에 판정한다 — 저장은 지역 단위라 계정이 드러나지 않는다.
   */
  async watchedRegions(today: string): Promise<readonly WatchedProduct[]> {
    const { rows } = await this.pool.query<{
      id: string; name: string; ldong_regn_cd: string; ldong_signgu_cd: string | null;
      start_date: Date | string; nights: number; watch_keywords: string[] | null;
    }>(
      `SELECT p.id, p.name, p.ldong_regn_cd, p.ldong_signgu_cd, p.start_date, p.nights,
              s.watch_keywords
         FROM product p
         LEFT JOIN user_setting s ON s.account_id = p.account_id
        WHERE p.start_date + p.nights >= $1::date
        ORDER BY p.id`,
      [today],
    );
    return rows.map((r) => ({
      productId: Number(r.id),
      name: r.name,
      ldongRegnCd: r.ldong_regn_cd,
      ldongSignguCd: r.ldong_signgu_cd,
      startDate: isoDate(r.start_date),
      nights: Number(r.nights),
      keywords: r.watch_keywords ?? [],
    }));
  }

  /**
   * 오늘 할 일의 대상 상품 (FR-AG-030). **여행이 끝나지 않은 것만** — 다녀온 상품은 할 일이 아니다.
   *
   * 순서는 출발일이 가까운 것부터다. 에이전트가 이 순서를 바꾸지 못한다.
   */
  async upcomingProducts(accountId: number, today: string): Promise<readonly BriefProduct[]> {
    const { rows } = await this.pool.query<{
      id: string; name: string; ldong_regn_cd: string; ldong_signgu_cd: string | null;
      start_date: Date | string; nights: number; released_at: Date | null;
    }>(
      `SELECT id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights, released_at
         FROM product
        WHERE account_id = $1 AND start_date + nights >= $2::date
        ORDER BY start_date, id`,
      [accountId, today],
    );
    return rows.map((r) => ({
      productId: Number(r.id),
      name: r.name,
      ldongRegnCd: r.ldong_regn_cd,
      ldongSignguCd: r.ldong_signgu_cd,
      startDate: isoDate(r.start_date),
      nights: Number(r.nights),
      released: r.released_at !== null,
    }));
  }

  /**
   * 관심 지역 (FR-MO-059). `accountId` 를 주면 그 계정 것만, 안 주면 배치용으로 전 계정 것이다.
   *
   * 저장값은 설정 화면이 검증해 넣지만 JSONB 라 모양을 다시 본다. 코드 · 달 모양이 아닌 칸은
   * 조용히 기본값으로 바꾸지 않고 뺀다 — 엉뚱한 지역의 신호를 세면 안 된다.
   */
  async watchRegions(accountId?: number): Promise<readonly WatchRegion[]> {
    const { rows } = await this.pool.query<{ account_id: string; watch_regions: unknown; watch_keywords: string[] }>(
      `SELECT account_id, watch_regions, watch_keywords FROM user_setting
        WHERE jsonb_typeof(watch_regions) = 'array' AND jsonb_array_length(watch_regions) > 0
          AND ($1::bigint IS NULL OR account_id = $1)
        ORDER BY account_id`,
      [accountId ?? null],
    );
    return rows.flatMap((r) => {
      const entries = Array.isArray(r.watch_regions) ? r.watch_regions : [];
      return entries.flatMap((e: unknown): WatchRegion[] => {
        const region = readWatchRegion(e);
        return region === null
          ? []
          : [{ accountId: Number(r.account_id), ...region, keywords: r.watch_keywords ?? [] }];
      });
    });
  }

  /** 그 계정의 관심 키워드. 설정 행이 없으면 빈 목록이다 */
  async watchKeywords(accountId: number): Promise<readonly string[]> {
    const { rows } = await this.pool.query<{ watch_keywords: string[] }>(
      `SELECT watch_keywords FROM user_setting WHERE account_id = $1`,
      [accountId],
    );
    return rows[0]?.watch_keywords ?? [];
  }
}

/** 관심 지역 칸 하나를 읽는다. `{regnCd, signguCd, month}` 모양이 아니면 null */
function readWatchRegion(e: unknown): Omit<WatchRegion, 'accountId' | 'keywords'> | null {
  if (typeof e !== 'object' || e === null) return null;
  const { regnCd, signguCd, month } = e as Record<string, unknown>;
  if (typeof regnCd !== 'string' || !/^\d{2}(?:\d{3})?$/.test(regnCd)) return null;
  if (signguCd !== null && (typeof signguCd !== 'string' || !/^\d{3}$/.test(signguCd))) return null;
  if (typeof month !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) return null;
  return { ldongRegnCd: regnCd, ldongSignguCd: signguCd, month };
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
