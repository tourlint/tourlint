import type { Pool } from 'pg';
import type { EndTimeSource, ItemType, MatchStatus, Transport } from '@tourlint/shared';
import type { ItineraryItemRow, ProductRow } from './audit-runner';

/**
 * 검수 대상 읽기.
 *
 * `product` · `itinerary_item` 은 상품 등록(B 트랙)이 쓰는 테이블이다. 여기서는 **읽기만**
 * 한다 — 검수가 일정 자체를 고치는 일은 없다 (수정안은 사용자가 확정해야 반영된다, F09).
 */
export class ProductRepository {
  constructor(private readonly pool: Pool) {}

  async findProduct(productId: number): Promise<ProductRow | null> {
    const { rows } = await this.pool.query<{
      id: string; start_date: Date | string; nights: number; transport: Transport;
      ldong_regn_cd: string | null; ldong_signgu_cd: string | null;
      target_key: string | null; concept_key: string | null; account_id: string;
    }>(
      `SELECT id, start_date, nights, transport, ldong_regn_cd, ldong_signgu_cd,
              target_key, concept_key, account_id
         FROM product WHERE id = $1`,
      [productId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: Number(row.id), startDate: toIsoDate(row.start_date),
      nights: row.nights, transport: row.transport,
      // R09 중기 예보구역과 평년 테이블이 쓴다 (EI-WX-003 · 004)
      ldongRegnCd: row.ldong_regn_cd, ldongSignguCd: row.ldong_signgu_cd,
      // R10 기대 프로파일이 쓴다. 프로파일은 계정 설정이라 소유자가 필요하다 (FR-RU-100)
      targetKey: row.target_key, conceptKey: row.concept_key, accountId: Number(row.account_id),
    };
  }

  async findItems(productId: number): Promise<readonly ItineraryItemRow[]> {
    const { rows } = await this.pool.query<ItemRow>(
      `SELECT id, day_no, seq, start_time, end_time, end_time_source, place_label, item_type,
              kto_content_id, content_type_id, lcls_systm1, lcls_systm2, lcls_systm3, mapx, mapy, match_status
         FROM itinerary_item WHERE product_id = $1 ORDER BY day_no, seq`,
      [productId],
    );
    return rows.map(toItem);
  }

  /**
   * 상품 주인의 계정 id (`patch_application.applied_by`).
   *
   * 로그인 계층은 B 트랙이 붙인다. 그전까지 "누가 반영했는가" 에 답할 수 있는 것은 상품
   * 소유자뿐이다 — 이 값이 없으면 이력을 아예 남길 수 없어(`applied_by` NOT NULL)
   * FR-PA-028 을 못 지킨다. 로그인이 붙으면 요청자 계정으로 바꾼다.
   */
  async findOwner(productId: number): Promise<number | null> {
    const { rows } = await this.pool.query<{ account_id: string }>(
      `SELECT account_id FROM product WHERE id = $1`,
      [productId],
    );
    const row = rows[0];
    return row === undefined ? null : Number(row.account_id);
  }

  /** 미확정 매칭이 남아 있으면 검수를 시작하지 않는다 (EX-AU-001) */
  async findUnresolvedItems(productId: number): Promise<readonly { id: number; placeLabel: string }[]> {
    const { rows } = await this.pool.query<{ id: string; place_label: string }>(
      `SELECT id, place_label FROM itinerary_item
        WHERE product_id = $1 AND match_status = 'PENDING' ORDER BY day_no, seq`,
      [productId],
    );
    return rows.map((r) => ({ id: Number(r.id), placeLabel: r.place_label }));
  }
}

interface ItemRow {
  id: string;
  day_no: number;
  seq: number;
  start_time: string;
  end_time: string | null;
  end_time_source: EndTimeSource;
  place_label: string;
  item_type: ItemType;
  kto_content_id: string | null;
  content_type_id: number | null;
  lcls_systm1: string | null;
  lcls_systm2: string | null;
  lcls_systm3: string | null;
  mapx: string | null;
  mapy: string | null;
  match_status: MatchStatus;
}

function toItem(row: ItemRow): ItineraryItemRow {
  return {
    id: Number(row.id),
    dayNo: row.day_no,
    seq: row.seq,
    startTime: toHhMm(row.start_time),
    endTime: row.end_time === null ? null : toHhMm(row.end_time),
    endTimeSource: row.end_time_source,
    placeLabel: row.place_label,
    itemType: row.item_type,
    ktoContentId: row.kto_content_id,
    contentTypeId: row.content_type_id,
    lclsSystm1: row.lcls_systm1,
    lclsSystm2: row.lcls_systm2,
    lclsSystm3: row.lcls_systm3,
    // NUMERIC 은 pg 가 문자열로 준다. 정밀도 손실을 막으려는 기본 동작이라 여기서 옮긴다
    mapX: row.mapx === null ? null : Number(row.mapx),
    mapY: row.mapy === null ? null : Number(row.mapy),
    matchStatus: row.match_status,
  };
}

/** `pg` 는 TIME 을 `HH:MM:SS` 로 준다. 스키마 표기는 `HH:mm` 이다 (DR-NM-003) */
function toHhMm(value: string): string {
  return value.slice(0, 5);
}

function toIsoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  // DATE 컬럼은 시간대 없이 오지만 Date 로 변환되면서 UTC 로 밀릴 수 있다. 지역 필드로 읽는다
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
