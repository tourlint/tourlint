import type { Pool } from 'pg';
import type { ImpactCandidate, MatchCondition, NotificationKind } from '../batch/impact-finder';
import type { IsoDate } from '../engine/calendar/dates';

/**
 * 위험 · 기회 알림 (`notification` · F13 · FR-MO-030 ~ 037).
 *
 * ⚠️ **`body` 에 공사 원문을 담지 않는다.** 알림 문구는 우리가 만든 문장이고, 관광지명은
 *    사용자가 입력한 `place_label` 을 쓴다 (FR-MO-002 · DB 명세서 6-4).
 */

export interface NotificationToSave {
  readonly productId: number;
  readonly kind: NotificationKind;
  readonly condition: MatchCondition;
  readonly ktoContentId: string;
  readonly hashFrom: string | null;
  readonly hashTo: string | null;
  /** 재노출 판정 키 (FR-MO-036). 무엇이 「같은 변경」인지는 조건마다 다르다 */
  readonly changeKey: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export class NotificationRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * 알림을 넣는다. **같은 콘텐츠의 같은 변경은 다시 넣지 않는다** (FR-MO-036).
   *
   * `uq_notif_change (product_id, kto_content_id, change_key)` 가 DB 에서 막고, 여기서는
   * 그걸 조용히 넘긴다 — 배치가 같은 날짜를 다시 볼 수 있어서 (0건 재조회 · 실패 재시도)
   * 중복 시도는 정상이다.
   *
   * **새로운 변경이면 다시 노출된다.** `change_key` 가 달라지기 때문이다 — 무시한 알림이
   * 영영 안 뜨는 것이 아니라, 그 변경에 대해서만 안 뜬다.
   *
   * ⚠️ **지문 두 컬럼은 키가 아니다.** 조건 2·3 은 지문 이력이 없어 둘 다 NULL 이고,
   *    평범한 `UNIQUE` 는 NULL 이 든 행을 서로 다르게 봐서 아무것도 안 막는다
   *    (DB 명세서 v1.7).
   *
   * 넣은 건수를 돌려준다.
   */
  async insertMany(items: readonly NotificationToSave[]): Promise<number> {
    let inserted = 0;
    for (const n of items) {
      const { rowCount } = await this.pool.query(
        `INSERT INTO notification
           (product_id, kind, match_condition, kto_content_id,
            change_hash_from, change_hash_to, change_key, body)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (product_id, kto_content_id, change_key) DO NOTHING`,
        [n.productId, n.kind, n.condition, n.ktoContentId,
          n.hashFrom, n.hashTo, n.changeKey, JSON.stringify(n.body)],
      );
      inserted += rowCount ?? 0;
    }
    return inserted;
  }

  /**
   * 조건 1 후보 — 그 콘텐츠를 일정에 넣은 상품 (FR-MO-030 ①).
   *
   * **콘텐츠 여러 개를 한 번에 묻는다.** 하루 변경이 177건이라 하나씩 물으면 그만큼
   * 왕복한다. `kto_content_id` 로 묶어 돌려준다.
   *
   * **출발일이 지난 상품은 뺀다** (FR-MO-018). 이미 다녀온 일정에 알림을 보내도 할 수
   * 있는 게 없다. 수동 재검수는 계속 되므로 감시에서만 빠진다.
   */
  async productsWithContents(
    contentIds: readonly string[],
    today: IsoDate,
  ): Promise<ReadonlyMap<string, readonly ImpactCandidate[]>> {
    const out = new Map<string, ImpactCandidate[]>();
    if (contentIds.length === 0) return out;

    const { rows } = await this.pool.query<CandidateRow & { kto_content_id: string }>(
      `SELECT DISTINCT i.kto_content_id, p.id, p.start_date, p.nights, p.ldong_signgu_cd
         FROM product p
         JOIN itinerary_item i ON i.product_id = p.id
        WHERE i.kto_content_id = ANY($1::text[])
          AND i.match_status = 'CONFIRMED'
          AND p.start_date + p.nights >= $2::date
        ORDER BY i.kto_content_id, p.id`,
      [[...new Set(contentIds)], today],
    );
    for (const row of rows) {
      const list = out.get(row.kto_content_id) ?? [];
      list.push(toCandidate(row));
      out.set(row.kto_content_id, list);
    }
    return out;
  }

  /** 조건 2 · 3 후보 — 감시 대상인 상품 전부. 날짜 · 지역 판정은 `ImpactFinder` 가 한다 */
  async watchedProducts(today: IsoDate): Promise<readonly ImpactCandidate[]> {
    const { rows } = await this.pool.query<CandidateRow>(
      `SELECT p.id, p.start_date, p.nights, p.ldong_signgu_cd
         FROM product p
        WHERE p.start_date + p.nights >= $1::date
        ORDER BY p.id`,
      [today],
    );
    return rows.map(toCandidate);
  }
}

interface CandidateRow {
  id: string;
  start_date: Date | string;
  nights: number;
  ldong_signgu_cd: string | null;
}

function toCandidate(row: CandidateRow): ImpactCandidate {
  return {
    productId: Number(row.id),
    startDate: toIsoDate(row.start_date),
    nights: row.nights,
    ldongSignguCd: row.ldong_signgu_cd,
  };
}

/** `DATE` 는 드라이버 설정에 따라 `Date` 로도 문자열로도 온다. 한국 시간 기준이다 */
function toIsoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10);
}
