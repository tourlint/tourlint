import type { Pool } from 'pg';
import type { ItineraryItemRow } from '../audit/audit-runner';
import type { PatchRef } from '../audit/patch-conflict';
import { fromSnapshot, toSnapshot, type ItinerarySnapshot } from '../audit/patch-snapshot';
import { withTransaction, type Queryable } from './db';

/**
 * 패치 적용 이력 (DB 명세서 3-8 · F09).
 *
 * 일정 변경과 이력 기록은 **한 트랜잭션**이다. 나눠 쓰면 되돌릴 근거 없이 바뀐 일정이
 * 남거나, 반대로 반영되지 않은 변경의 이력이 남는다. 둘 다 EX-PA-003 이 금지하는
 * "부분 반영 상태" 다.
 */

export interface PatchApplicationToSave {
  readonly productId: number;
  readonly appliedBy: number;
  readonly appliedAt: Date;
  readonly selections: readonly PatchRef[];
  readonly before: ItinerarySnapshot;
  /** 반영 결과. 새 항목은 아직 임시 음수 id 를 갖고 있다 — 저장하면서 실제 id 로 바뀐다 */
  readonly afterItems: readonly ItineraryItemRow[];
  readonly beforeAuditRunId: number | null;
}

export interface StoredPatchApplication {
  readonly id: number;
  readonly productId: number;
  readonly appliedAt: Date;
  readonly appliedBy: number;
  readonly selections: readonly PatchRef[];
  readonly before: ItinerarySnapshot;
  readonly after: ItinerarySnapshot;
  readonly beforeAuditRunId: number | null;
  readonly afterAuditRunId: number | null;
  readonly revertedAt: Date | null;
}

export class PatchApplicationRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * 일정을 바꾸고 이력을 남긴다 (FR-PA-020 · 021 · 028 · EX-PA-003).
   *
   * `after_snapshot` 은 **쓰고 난 뒤** 만든다. 새로 넣은 항목의 실제 id 는 INSERT 가
   * 돌려주기 전에는 없고, 임시 음수 id 를 그대로 저장하면 그 스냅샷으로는 아무것도
   * 복원하지 못한다.
   */
  async apply(save: PatchApplicationToSave): Promise<{ id: number; after: ItinerarySnapshot }> {
    return withTransaction(this.pool, async (client) => {
      const written = await writeItinerary(client, save.productId, save.afterItems);
      const after = toSnapshot(save.productId, written, save.appliedAt);

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO patch_application
           (product_id, applied_at, applied_by, selected_patches,
            before_snapshot, after_snapshot, before_audit_run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          save.productId, save.appliedAt, save.appliedBy,
          JSON.stringify(save.selections),
          JSON.stringify(save.before), JSON.stringify(after),
          save.beforeAuditRunId,
        ],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('patch_application 을 만들지 못했다');
      return { id: Number(id), after };
    });
  }

  /**
   * 되돌린다 (FR-PA-026).
   *
   * `before_snapshot` 을 그대로 다시 쓴다. **재검수를 돌리지 않는다** — 되돌린 일정은
   * `before_audit_run_id` 가 판정한 바로 그 일정이라, 이미 있는 결과가 곧 현재 결과다.
   * 여기서 한 번 더 돌리면 같은 답을 받으려고 공사 호출을 다시 쓰는 셈이다.
   */
  async revert(application: StoredPatchApplication, revertedAt: Date): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await writeItinerary(client, application.productId, fromSnapshot(application.before));
      await client.query(`UPDATE patch_application SET reverted_at = $2 WHERE id = $1`, [
        application.id, revertedAt,
      ]);
    });
  }

  async findById(id: number): Promise<StoredPatchApplication | null> {
    const { rows } = await this.pool.query<PatchApplicationRow>(
      `SELECT ${COLUMNS} FROM patch_application WHERE id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : toApplication(rows[0]);
  }

  /** 그 상품의 **직전 1건**. 되돌리기가 허용되는 대상은 이것뿐이다 (FR-PA-026) */
  async latestOf(productId: number): Promise<StoredPatchApplication | null> {
    const { rows } = await this.pool.query<PatchApplicationRow>(
      `SELECT ${COLUMNS} FROM patch_application WHERE product_id = $1 ORDER BY id DESC LIMIT 1`,
      [productId],
    );
    return rows[0] === undefined ? null : toApplication(rows[0]);
  }

  /**
   * 재검수 결과를 이력의 오른쪽에 붙인다 (FR-PA-025 · 전후 비교의 우측).
   *
   * 대상은 **오른쪽이 비어 있고 되돌리지 않은 가장 최근 1건**이다. 되돌린 이력을 빼는
   * 이유는 그 "적용 후 일정" 이 더는 존재하지 않기 때문이다 — 지금 검수한 것은 되돌아간
   * 일정이라 오른쪽에 놓으면 전후 비교가 있지도 않은 상태를 견준다.
   *
   * 붙일 곳이 없으면 아무 일도 하지 않는다.
   */
  /**
   * 저장된 `place_label` 이 더 이상 그 항목을 가리키지 않는 항목 id (FR-PA-003 · DR-PR-001).
   *
   * 두 가지다 — `REPLACE_CONTENT` 는 자리를 두고 콘텐츠만 바꾸므로 옛 이름이 남고,
   * `INSERT_ITEM` 은 빈 라벨로 들어온다. 대체 후보의 명칭은 공사 원문이라 저장할 수
   * 없어서 생긴 구조이고, 이름은 표시할 때 읽는다.
   *
   * 되돌린 이력은 세지 않는다 — 되돌리면 원래 콘텐츠로 복원되므로 라벨이 다시 맞는다.
   */
  async staleLabelItemIds(productId: number): Promise<ReadonlySet<number>> {
    const { rows } = await this.pool.query<Pick<PatchApplicationRow, 'before_snapshot' | 'after_snapshot'>>(
      `SELECT before_snapshot, after_snapshot FROM patch_application
        WHERE product_id = $1 AND reverted_at IS NULL
        ORDER BY applied_at`,
      [productId],
    );

    const out = new Set<number>();
    for (const row of rows) {
      const was = new Map(row.before_snapshot.items.map((i) => [i.id, i.ktoContentId]));
      for (const item of row.after_snapshot.items) {
        if (item.ktoContentId === null) continue;
        // 없던 id 면 추가된 항목이고, 있었는데 다르면 대체된 항목이다
        if (was.get(item.id) !== item.ktoContentId) out.add(item.id);
      }
    }
    return out;
  }

  async attachAfterRun(productId: number, auditRunId: number): Promise<void> {
    await this.pool.query(
      `UPDATE patch_application SET after_audit_run_id = $2
        WHERE id = (SELECT id FROM patch_application
                     WHERE product_id = $1 AND after_audit_run_id IS NULL AND reverted_at IS NULL
                     ORDER BY id DESC LIMIT 1)`,
      [productId, auditRunId],
    );
  }
}

/**
 * 일정표를 목표 상태로 맞춘다.
 *
 * ## 순서를 먼저 비워 두는 이유
 *
 * `uq_item_product_day_seq` 가 `(product_id, day_no, seq)` 를 유일하게 잡는다. 두 항목이
 * 자리를 맞바꾸면 첫 UPDATE 가 상대의 자리를 밟아 **중간 상태에서** 제약을 어긴다 —
 * 최종 상태는 멀쩡한데 도중에 터진다. 제약이 `DEFERRABLE` 이 아니라 커밋까지 미룰 수도
 * 없다.
 *
 * 그래서 이 상품의 모든 행을 `seq = -seq` 로 먼저 옮긴다. 부호만 뒤집는 것이라 원래
 * 유일했던 조합은 그대로 유일하고, 양수 자리는 전부 비어 최종 값을 아무 순서로나 쓸 수
 * 있다. `seq` 에는 양수 제약이 없어 음수가 잠시 머무를 수 있다.
 */
async function writeItinerary(
  client: Queryable,
  productId: number,
  items: readonly ItineraryItemRow[],
): Promise<readonly ItineraryItemRow[]> {
  await client.query(
    `UPDATE itinerary_item SET seq = -seq WHERE product_id = $1 AND seq > 0`,
    [productId],
  );

  const keep = items.filter((i) => i.id > 0).map((i) => i.id);
  await client.query(
    `DELETE FROM itinerary_item WHERE product_id = $1 AND NOT (id = ANY($2::bigint[]))`,
    [productId, keep],
  );

  const written: ItineraryItemRow[] = [];
  for (const item of items) {
    written.push(item.id > 0
      ? await upsertItem(client, productId, item)
      : await insertItem(client, productId, item));
  }
  return written;
}

/**
 * 남아 있는 항목을 제자리에 쓴다.
 *
 * `ON CONFLICT (id) DO UPDATE` 인 이유 — 되돌리기는 패치가 지웠던 항목을 **같은 id 로**
 * 되살려야 한다(`patch-snapshot.ts`). 그 항목에는 갱신할 행이 없으므로 UPDATE 만으로는
 * 조용히 아무 일도 일어나지 않고, 일정 하나가 사라진 채 "되돌렸다" 고 답하게 된다.
 *
 * `DO UPDATE` 에 상품 조건을 건다. id 를 명시해 쓰는 문장이라 남의 상품 행 번호가 섞여
 * 들어오면 그 행을 덮어쓴다 — 조건에 걸려 아무 행도 안 나오면 트랜잭션째로 세운다.
 */
async function upsertItem(
  client: Queryable,
  productId: number,
  item: ItineraryItemRow,
): Promise<ItineraryItemRow> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO itinerary_item
       (id, product_id, day_no, seq, start_time, end_time, end_time_source, place_label,
        item_type, kto_content_id, content_type_id, lcls_systm1, lcls_systm2, lcls_systm3,
        mapx, mapy, match_status)
     VALUES ($1,$2,$3,$4,$5::time,$6::time,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (id) DO UPDATE SET
       day_no = EXCLUDED.day_no, seq = EXCLUDED.seq,
       start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
       end_time_source = EXCLUDED.end_time_source, place_label = EXCLUDED.place_label,
       item_type = EXCLUDED.item_type, kto_content_id = EXCLUDED.kto_content_id,
       content_type_id = EXCLUDED.content_type_id,
       lcls_systm1 = EXCLUDED.lcls_systm1, lcls_systm2 = EXCLUDED.lcls_systm2,
       lcls_systm3 = EXCLUDED.lcls_systm3,
       mapx = EXCLUDED.mapx, mapy = EXCLUDED.mapy,
       match_status = EXCLUDED.match_status, updated_at = now()
     WHERE itinerary_item.product_id = EXCLUDED.product_id
     RETURNING id`,
    [item.id, productId, ...itemValues(item)],
  );
  if (rows[0] === undefined) throw new Error(`다른 상품의 일정 항목 id 다: ${String(item.id)}`);
  return item;
}

/** 새로 넣은 항목. 임시 음수 id 대신 DB 가 매긴 id 를 돌려준다 */
async function insertItem(
  client: Queryable,
  productId: number,
  item: ItineraryItemRow,
): Promise<ItineraryItemRow> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO itinerary_item
       (product_id, day_no, seq, start_time, end_time, end_time_source, place_label,
        item_type, kto_content_id, content_type_id, lcls_systm1, lcls_systm2, lcls_systm3,
        mapx, mapy, match_status)
     VALUES ($1,$2,$3,$4::time,$5::time,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id`,
    [productId, ...itemValues(item)],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('itinerary_item 을 만들지 못했다');
  return { ...item, id: Number(id) };
}

function itemValues(item: ItineraryItemRow): readonly unknown[] {
  return [
    item.dayNo, item.seq, item.startTime, item.endTime, item.endTimeSource,
    item.placeLabel, item.itemType, item.ktoContentId, item.contentTypeId,
    item.lclsSystm1, item.lclsSystm2, item.lclsSystm3,
    item.mapX, item.mapY, item.matchStatus,
  ];
}

const COLUMNS = `id, product_id, applied_at, applied_by, selected_patches,
                 before_snapshot, after_snapshot, before_audit_run_id,
                 after_audit_run_id, reverted_at`;

interface PatchApplicationRow {
  id: string;
  product_id: string;
  applied_at: Date;
  applied_by: string;
  selected_patches: PatchRef[];
  before_snapshot: ItinerarySnapshot;
  after_snapshot: ItinerarySnapshot;
  before_audit_run_id: string | null;
  after_audit_run_id: string | null;
  reverted_at: Date | null;
}

function toApplication(row: PatchApplicationRow): StoredPatchApplication {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    appliedAt: row.applied_at,
    appliedBy: Number(row.applied_by),
    selections: row.selected_patches,
    before: row.before_snapshot,
    after: row.after_snapshot,
    beforeAuditRunId: row.before_audit_run_id === null ? null : Number(row.before_audit_run_id),
    afterAuditRunId: row.after_audit_run_id === null ? null : Number(row.after_audit_run_id),
    revertedAt: row.reverted_at,
  };
}
