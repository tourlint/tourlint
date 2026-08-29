import type { Pool } from 'pg';

/**
 * 관광지 확정(매칭) 쓰기 (F02 · FR-IN-020~030). 항목에 공사 contentid·좌표·분류를 붙여
 * 검수 대상으로 만든다.
 *
 * 저장하는 것은 **코드·좌표뿐**이다 — 명칭·운영시간 원문은 담지 않는다 (DR-PR-001). place_label
 * 은 사용자 입력 그대로 두고, 표시용 명칭은 확정 시점에 실시간 조회한 값을 응답으로만 돌려준다.
 *
 * 모든 쿼리는 항목의 소유 계정으로 스코프한다. 남의 항목 id 로는 아무것도 못 고친다.
 */
export interface ItemForMatch {
  readonly itemId: number;
  readonly productId: number;
  readonly ldongRegnCd: string;
  readonly ldongSignguCd: string | null;
  readonly placeLabel: string;
}

export interface ConfirmInput {
  readonly contentId: string;
  readonly contentTypeId: number;
  readonly lclsSystm1: string | null;
  readonly lclsSystm2: string | null;
  readonly lclsSystm3: string | null;
  readonly mapx: number | null;
  readonly mapy: number | null;
}

export class PlaceMatchRepository {
  constructor(private readonly pool: Pool) {}

  /** 항목과 그 상품의 지역을 함께 읽는다. 계정 밖이면 null (검색 지역 필터에도 이 지역을 쓴다) */
  async findItem(accountId: number, itemId: number): Promise<ItemForMatch | null> {
    const { rows } = await this.pool.query<{
      id: string;
      product_id: string;
      ldong_regn_cd: string;
      ldong_signgu_cd: string | null;
      place_label: string;
    }>(
      `SELECT it.id, it.product_id, p.ldong_regn_cd, p.ldong_signgu_cd, it.place_label
         FROM itinerary_item it
         JOIN product p ON p.id = it.product_id
        WHERE it.id = $1 AND p.account_id = $2`,
      [itemId, accountId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      itemId: Number(row.id),
      productId: Number(row.product_id),
      ldongRegnCd: row.ldong_regn_cd,
      ldongSignguCd: row.ldong_signgu_cd,
      placeLabel: row.place_label,
    };
  }

  /** contentid 확정 — CONFIRMED 로 바꾸고 좌표·분류를 채운다 (ck_item_match_content: contentid 필수) */
  async confirm(itemId: number, input: ConfirmInput): Promise<void> {
    await this.pool.query(
      `UPDATE itinerary_item
          SET kto_content_id = $2, content_type_id = $3,
              lcls_systm1 = $4, lcls_systm2 = $5, lcls_systm3 = $6,
              mapx = $7, mapy = $8,
              match_status = 'CONFIRMED', updated_at = now()
        WHERE id = $1`,
      [
        itemId, input.contentId, input.contentTypeId,
        input.lclsSystm1, input.lclsSystm2, input.lclsSystm3,
        input.mapx, input.mapy,
      ],
    );
  }

  /** 검수 제외 — EXCLUDED 는 contentid 가 NULL 이어야 한다. 붙어 있던 코드·좌표도 지운다 */
  async exclude(itemId: number): Promise<void> {
    await this.pool.query(
      `UPDATE itinerary_item
          SET kto_content_id = NULL, content_type_id = NULL,
              lcls_systm1 = NULL, lcls_systm2 = NULL, lcls_systm3 = NULL,
              mapx = NULL, mapy = NULL,
              match_status = 'EXCLUDED', updated_at = now()
        WHERE id = $1`,
      [itemId],
    );
  }
}
