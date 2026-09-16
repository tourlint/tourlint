import type { Pool } from 'pg';

/**
 * 기획 화면이 읽는 일정 항목 (F17). **읽기만 한다** — 항목을 바꾸는 것은 기존 API 다
 * (FR-PL-013 · FR-AG-001).
 *
 * 모든 조회에 `account_id` 를 건다 (PM-DA-002 · EX-SY-003).
 */

export interface PlanItem {
  readonly id: number;
  readonly dayNo: number;
  readonly seq: number;
  readonly startTime: string;
  readonly endTime: string | null;
  /** 사용자가 입력한 장소명. 고른 곳은 비어 있을 수 있어 표시할 때 조회한다 (DR-PR-001) */
  readonly placeLabel: string | null;
  readonly itemType: string;
  readonly contentId: string | null;
  readonly contentTypeId: number | null;
  readonly lcls2: string | null;
  readonly mapx: number | null;
  readonly mapy: number | null;
  readonly matchStatus: 'CONFIRMED' | 'EXCLUDED' | 'PENDING';
  readonly matchedBy: string | null;
  readonly origin: string | null;
  readonly walkId: string | null;
}

export interface PlanProduct {
  readonly productId: number;
  readonly startDate: string;
  readonly transport: string;
  /** 상품 지역. 에이전트의 검색은 이 지역으로 고정된다 (FR-AG-010) */
  readonly regnCd: string | null;
  readonly signguCd: string | null;
  readonly items: readonly PlanItem[];
}

export class PlanItemRepository {
  constructor(private readonly pool: Pool) {}

  /** 그 계정의 상품과 일정 항목. 남의 상품이면 `null` 이다 */
  async product(accountId: number, productId: number): Promise<PlanProduct | null> {
    const { rows } = await this.pool.query<{
      start_date: Date | string; transport: string; ldong_regn_cd: string | null; ldong_signgu_cd: string | null;
    }>(
      `SELECT start_date, transport, ldong_regn_cd, ldong_signgu_cd
         FROM product WHERE id = $1 AND account_id = $2`,
      [productId, accountId],
    );
    const product = rows[0];
    if (product === undefined) return null;

    const items = await this.pool.query<ItemRow>(
      `SELECT id, day_no, seq, start_time, end_time, place_label, item_type, kto_content_id,
              content_type_id, lcls_systm2, mapx, mapy, match_status, matched_by, origin, walk_id
         FROM itinerary_item
        WHERE product_id = $1
        ORDER BY day_no, seq`,
      [productId],
    );

    return {
      productId,
      startDate: isoDate(product.start_date),
      transport: product.transport,
      regnCd: product.ldong_regn_cd,
      signguCd: product.ldong_signgu_cd,
      items: items.rows.map(toItem),
    };
  }
}

interface ItemRow {
  id: string;
  day_no: number;
  seq: number;
  start_time: string;
  end_time: string | null;
  place_label: string | null;
  item_type: string;
  kto_content_id: string | null;
  content_type_id: number | null;
  lcls_systm2: string | null;
  mapx: string | number | null;
  mapy: string | number | null;
  match_status: string;
  matched_by: string | null;
  origin: string | null;
  walk_id: string | null;
}

function toItem(row: ItemRow): PlanItem {
  return {
    id: Number(row.id),
    dayNo: Number(row.day_no),
    seq: Number(row.seq),
    startTime: String(row.start_time).slice(0, 5),
    endTime: row.end_time === null ? null : String(row.end_time).slice(0, 5),
    placeLabel: row.place_label,
    itemType: row.item_type,
    contentId: row.kto_content_id,
    contentTypeId: row.content_type_id === null ? null : Number(row.content_type_id),
    lcls2: row.lcls_systm2,
    // NUMERIC 은 드라이버가 문자열로 준다. 좌표는 숫자로 쓴다
    mapx: numberOrNull(row.mapx),
    mapy: numberOrNull(row.mapy),
    matchStatus: row.match_status as PlanItem['matchStatus'],
    matchedBy: row.matched_by,
    origin: row.origin,
    walkId: row.walk_id,
  };
}

function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10);
}
