import type { Pool } from 'pg';
import { SETTING_DEFAULTS, type EndTimeSource, type ItemType, type MatchStatus, type Severity, type Transport, kstIso } from '@tourlint/shared';
import { calculateReadiness, type ScorableFinding, type ScoreResult } from '../engine/score';
import { CURRENT_RUN_LATERAL, currentRunOf, toCurrentRun, type CurrentRun } from '../persistence/current-run';
import { withTransaction } from '../persistence/db';
import type { ItemOrder, ItemPatch, PickedItemInput, ValidItem, ValidItemInput, ValidProduct, WalkItemInput } from './product.dto';

/** HH:MM 에 분을 더한다 (하루를 넘지 않게 23:59 로 막는다). 장소 담기 끝 시각 계산용. */
export function addMinutes(hhmm: string, minutes: number): string {
  const [h = 9, m = 0] = hhmm.split(':').map(Number);
  const total = Math.min(h * 60 + m + minutes, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * 상품·일정 쓰기·읽기 (B 트랙 CRUD). 검수 읽기 전용인 audit/product.repository 와 별개다 —
 * 이쪽은 등록·편집·삭제를 담당한다.
 *
 * 모든 쿼리는 `account_id` 로 스코프한다. 남의 상품 id 로 조회·수정하면 행이 0건이라
 * 서비스가 NOT_FOUND 로 바꾼다 — 존재 여부를 노출하지 않는다 (계정 격리의 최소선).
 */

export interface ProductListRow {
  readonly id: number;
  readonly name: string;
  readonly startDate: string;
  readonly nights: number;
  readonly ldongRegnCd: string;
  readonly ldongSignguCd: string | null;
  readonly pendingMatches: number;
  /*
   * 알림 수 셋은 여행이 끝나지 않은 상품만 센다 — 끝난 상품은 0 이다 (FR-MO-018 · #804).
   * 무시한 알림은 세지 않는다.
   */
  readonly unreadNotifications: number;
  readonly activeNotifications: number;
  /** 알림 뒤에 다시 검수하지 않은 바뀐 정보. 레이더 카드가 「다시 검수」 로 보이는 것과 같다 (#703) */
  readonly risksSinceAudit: number;
  readonly latestAudit: {
    readonly auditRunId: number;
    readonly executedAt: string;
    readonly readinessScore: number | null;
    readonly isPartial: boolean;
    readonly counts: { readonly blocker: number; readonly error: number; readonly warning: number; readonly unverified: number };
    readonly releasable: boolean;
  } | null;
  /** 검수 시작을 누른 시각. null 이면 기획 중 (DR-IN-014) */
  readonly plannedAt: string | null;
  readonly releasedAt: string | null;
  /** 기획을 시작한 방법(`plan_origin.startedBy`). 기록이 없는 상품은 null — 보드의 기획 중 카드가 쓴다 (UI-S1-010) */
  readonly startedBy: string | null;
}

export interface ProductDetailRow {
  readonly id: number;
  readonly name: string;
  readonly ldongRegnCd: string;
  readonly ldongSignguCd: string | null;
  readonly startDate: string;
  readonly nights: number;
  readonly targetKey: string | null;
  readonly conceptKey: string | null;
  readonly headCount: number | null;
  readonly transport: Transport;
  readonly releasedAt: string | null;
  readonly plannedAt: string | null;
  readonly planOrigin: unknown | null;
  /** 항목 구성 — 직접 입력 · 장소 담기로 넣음 · 직접 정한 곳(검수 제외) (UI-S1-011) */
  readonly composition: { readonly manual: number; readonly picker: number; readonly excluded: number };
  readonly createdAt: string;
  readonly items: readonly ItemDetail[];
}

export interface ItemDetail {
  readonly itemId: number;
  readonly dayNo: number;
  readonly seq: number;
  readonly start: string;
  readonly end: string | null;
  readonly place: string;
  readonly itemType: ItemType;
  readonly ktoContentId: string | null;
  readonly matchStatus: MatchStatus;
  /** 좌표 — 근처 3km 담기의 앵커로 쓴다. 확정 전이면 null */
  readonly mapx: number | null;
  readonly mapy: number | null;
  /** 걷기 길 식별자 (D9). 이름은 표시할 때 두루누비에서 찾는다 */
  readonly walkId: string | null;
  /**
   * 중분류 · 끝 시각 출처 (FR-IN-011). 화면이 끝 시간을 비운 줄에 채워질 시각을, 기본 체류시간으로
   * 채운 줄에 「기본값 적용 · N분」 을 엔진과 같은 표로 보인다 — 판정에는 쓰지 않는다
   */
  readonly lcls2: string | null;
  readonly endTimeSource: EndTimeSource;
}

export interface CreatedProduct {
  readonly productId: number;
  readonly name: string;
  readonly startDate: string;
  readonly nights: number;
  readonly dayCount: number;
  readonly releasedAt: string | null;
  readonly createdAt: string;
}

export interface UpdateProductInput {
  readonly name?: string;
  readonly targetKey?: string | null;
  readonly conceptKey?: string | null;
  readonly headCount?: number | null;
  readonly transport?: Transport;
  readonly startDate?: string;
}

function isoDate(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

function isoStamp(v: Date | string | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : kstIso(v);
}

export class ProductRepository {
  constructor(private readonly pool: Pool) {}

  async create(accountId: number, product: ValidProduct): Promise<CreatedProduct> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO product
           (account_id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights,
            target_key, concept_key, head_count, transport, plan_origin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         RETURNING id, created_at`,
        [
          accountId, product.name, product.ldongRegnCd, product.ldongSignguCd, product.startDate,
          product.nights, product.targetKey, product.conceptKey, product.headCount, product.transport,
          product.planOrigin === null ? null : JSON.stringify(product.planOrigin),
        ],
      );
      const created = rows[0];
      if (created === undefined) throw new Error('상품 생성 결과가 비어 있다');
      const productId = Number(created.id);
      for (const item of product.items) {
        await insertItem(client, productId, item);
      }
      return {
        productId,
        name: product.name,
        startDate: product.startDate,
        nights: product.nights,
        dayCount: product.nights + 1,
        releasedAt: null,
        createdAt: kstIso(created.created_at),
      };
    });
  }

  async list(accountId: number, page: number, size: number): Promise<{ rows: ProductListRow[]; total: number }> {
    const totalRes = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM product WHERE account_id = $1`,
      [accountId],
    );
    const total = Number(totalRes.rows[0]?.n ?? 0);

    const { rows } = await this.pool.query<ListRaw>(
      `SELECT p.id, p.name, p.start_date, p.nights, p.ldong_regn_cd, p.ldong_signgu_cd,
              p.planned_at, p.released_at, p.plan_origin ->> 'startedBy' AS started_by,
              (SELECT count(*) FROM itinerary_item it
                 WHERE it.product_id = p.id AND it.match_status = 'PENDING')::int AS pending,
              nt.unread, nt.active, nt.risks,
              ar.id AS run_id, ar.executed_at, ar.readiness_score, ar.is_partial,
              ar.blocker_cnt, ar.error_cnt, ar.warn_cnt, ar.unverified_cnt,
              ar.weight_snapshot, ar.target_count, ar.failed_count,
              cur.kind AS current_kind, lr.blocker_cnt AS latest_blocker_cnt
         FROM product p
         ${CURRENT_RUN_LATERAL}
         -- 보여 줄 실행은 지금 일정의 실행이다. 반영 뒤 재검수 전(STALE)이면 가장 최근 실행을 보이되 출시는 막는다
         LEFT JOIN audit_run ar ON ar.id = COALESCE(cur.run_id, cur.latest_id)
         LEFT JOIN audit_run lr ON lr.id = cur.latest_id
         -- 알림은 여행이 끝나지 않은 상품만 센다 (FR-MO-018). 「알림 뒤에 다시 검수」 는 보여 줄 실행과 견준다 —
         -- 레이더 카드도 이 목록의 latestAudit 으로 「다시 검수」 · 「검수 결과 보기」 를 가른다 (#703 · #804)
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE n.read_at IS NULL)::int AS unread,
                  count(*)::int AS active,
                  count(*) FILTER (WHERE n.kind = 'RISK'
                                     AND (ar.executed_at IS NULL OR n.created_at > ar.executed_at))::int AS risks
             FROM notification n
            WHERE n.product_id = p.id AND n.dismissed_at IS NULL
              AND p.start_date + p.nights >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date
         ) nt ON true
        WHERE p.account_id = $1
        ORDER BY p.start_date DESC, p.id DESC
        LIMIT $2 OFFSET $3`,
      [accountId, size, page * size],
    );

    const scores = await this.currentScores(rows);
    return { rows: rows.map((r) => toListRow(r, scores)), total };
  }

  /**
   * 목록에 보일 점수와 등급별 건수를 **조회 시점에 다시 계산한다** (FR-AU-046).
   *
   * `audit_run` 의 점수 · 건수는 실행 시점 기록이라 무시 · 무시 해제가 반영되지 않는다.
   * 그 값을 그대로 보이면 결과 화면(`AuditResultRepository.findById`)과 갈린다 —
   * 주의 1건을 무시한 상품이 결과 화면에서는 83점, 목록에서는 79점이었고(#684),
   * 점수만 고친 뒤에는 89점 옆에 주의 3건이 남았다(#819).
   *
   * 실행마다 묻지 않고 한 번에 읽는다. 목록은 홈 · 검수 · 레이더가 열릴 때마다 불린다.
   */
  private async currentScores(rows: readonly ListRaw[]): Promise<ReadonlyMap<string, ScoreResult>> {
    const out = new Map<string, ScoreResult>();
    const runs = rows.filter((r): r is ListRaw & { run_id: string } => r.run_id !== null);
    if (runs.length === 0) return out;

    const found = await this.pool.query<{ audit_run_id: string; severity: Severity; reason_code: string; dismissed_at: Date | null }>(
      `SELECT audit_run_id, severity, reason_code, dismissed_at
         FROM finding WHERE audit_run_id = ANY($1::bigint[])`,
      [runs.map((r) => r.run_id)],
    );
    const byRun = new Map<string, ScorableFinding[]>();
    for (const f of found.rows) {
      const list = byRun.get(f.audit_run_id) ?? [];
      list.push({
        severity: f.severity,
        reasonCode: f.reason_code as ScorableFinding['reasonCode'],
        dismissed: f.dismissed_at !== null,
        // 확인 필요 건수는 점수에 들어가지 않는다. 목록은 그 값을 쓰지 않는다
        needsConfirmation: false,
      });
      byRun.set(f.audit_run_id, list);
    }

    for (const r of runs) {
      out.set(r.run_id, calculateReadiness({
        findings: byRun.get(r.run_id) ?? [],
        weights: r.weight_snapshot ?? undefined,
        targetCount: r.target_count ?? 0,
        failedCount: r.failed_count ?? 0,
      }));
    }
    return out;
  }

  async detail(accountId: number, productId: number): Promise<ProductDetailRow | null> {
    const { rows } = await this.pool.query<DetailRaw>(
      `SELECT id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights,
              target_key, concept_key, head_count, transport, released_at, planned_at, plan_origin, created_at
         FROM product WHERE id = $1 AND account_id = $2`,
      [productId, accountId],
    );
    const row = rows[0];
    if (row === undefined) return null;

    const items = await this.pool.query<ItemRaw>(
      `SELECT id, day_no, seq, start_time, end_time, place_label, item_type, kto_content_id, match_status, origin, mapx, mapy, walk_id,
              lcls_systm2, end_time_source
         FROM itinerary_item WHERE product_id = $1 ORDER BY day_no, seq`,
      [productId],
    );

    let manual = 0;
    let picker = 0;
    let excluded = 0;
    for (const it of items.rows) {
      if (it.match_status === 'EXCLUDED') excluded += 1;
      else if (it.origin === 'PICKER') picker += 1;
      else manual += 1;
    }

    return {
      id: Number(row.id),
      name: row.name,
      ldongRegnCd: row.ldong_regn_cd,
      ldongSignguCd: row.ldong_signgu_cd,
      startDate: isoDate(row.start_date),
      nights: row.nights,
      targetKey: row.target_key,
      conceptKey: row.concept_key,
      headCount: row.head_count,
      transport: row.transport,
      releasedAt: isoStamp(row.released_at),
      plannedAt: isoStamp(row.planned_at),
      planOrigin: row.plan_origin ?? null,
      composition: { manual, picker, excluded },
      createdAt: isoStamp(row.created_at) ?? '',
      items: items.rows.map(toItemDetail),
    };
  }

  /** 기본정보만 고친다. 박수·일정 구조 변경은 다루지 않는다(빈 일차·트리거 정합 때문) */
  async updateBasic(accountId: number, productId: number, input: UpdateProductInput): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, value: unknown): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (input.name !== undefined) set('name', input.name);
    if (input.targetKey !== undefined) set('target_key', input.targetKey);
    if (input.conceptKey !== undefined) set('concept_key', input.conceptKey);
    if (input.headCount !== undefined) set('head_count', input.headCount);
    if (input.transport !== undefined) set('transport', input.transport);
    if (input.startDate !== undefined) set('start_date', input.startDate);
    if (sets.length === 0) {
      // 바꿀 게 없으면 존재 여부만 확인한다
      const { rowCount } = await this.pool.query(`SELECT 1 FROM product WHERE id = $1 AND account_id = $2`, [productId, accountId]);
      return (rowCount ?? 0) > 0;
    }
    params.push(productId, accountId);
    const { rowCount } = await this.pool.query(
      `UPDATE product SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length - 1} AND account_id = $${params.length}`,
      params,
    );
    const updated = (rowCount ?? 0) > 0;
    /*
     * 출발일 · 이동수단 · 타깃 · 콘셉트는 판정을 바꾼다 — 요일(휴무) · 이동시간 · 상품 구성이 달라진다.
     * 검수한 그 일정이 아니게 되므로 항목을 건드려 「검수 뒤에 바뀌었다」 로 읽히게 한다 (#710).
     * 이름 · 인원은 판정과 무관하다. `product.updated_at` 은 이름만 바꿔도 올라가 기준으로 못 쓴다.
     */
    const judged = input.startDate !== undefined || input.transport !== undefined
      || input.targetKey !== undefined || input.conceptKey !== undefined;
    if (updated && judged) await this.touchItems(productId);
    return updated;
  }

  /** 일정이 바뀌었다는 흔적을 남긴다. 「지금 일정의 검수 실행」 판정이 이 시각을 본다 (#710 · `current-run`) */
  private async touchItems(productId: number): Promise<void> {
    await this.pool.query(`UPDATE itinerary_item SET updated_at = now() WHERE product_id = $1`, [productId]);
  }

  async remove(accountId: number, productId: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM product WHERE id = $1 AND account_id = $2`,
      [productId, accountId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** 최신 검수의 차단 건수. 검수한 적이 없으면 `null` — 0 과 다르다 (DR-IN-007) */
  /**
   * 출시 판정 재료 (#551). 상품이 없거나 남의 것이면 `undefined`.
   *
   * 지금 일정에 대응하는 실행의 차단 수와, 트리거(`trg_check_release`)가 보는 가장 최근 실행의
   * 차단 수를 함께 준다. 되돌린 일정은 반영 전 실행으로 판정하지만 트리거는 가장 최근 실행을
   * 보므로, 둘이 다르면 다시 검수해야 트리거가 통과시킨다.
   */
  async releaseBasis(accountId: number, productId: number): Promise<{
    current: CurrentRun;
    currentBlockers: number | null;
    latestBlockers: number | null;
    /** 지금 일정의 항목 수. 0 이면 검수할 대상이 없다 (#738) */
    itemCount: number;
  } | undefined> {
    const { rows } = await this.pool.query<{
      kind: 'LATEST' | 'RESTORED' | 'STALE' | null;
      run_id: string | null;
      latest_id: string | null;
      stale_reason: 'PATCH' | 'EDIT' | null;
      current_blockers: number | null;
      latest_blockers: number | null;
      item_count: string;
    }>(
      `SELECT cur.kind, cur.run_id, cur.latest_id, cur.stale_reason,
              ar.blocker_cnt AS current_blockers, lr.blocker_cnt AS latest_blockers,
              (SELECT count(*) FROM itinerary_item i WHERE i.product_id = p.id) AS item_count
         FROM product p
         ${CURRENT_RUN_LATERAL}
         LEFT JOIN audit_run ar ON ar.id = cur.run_id
         LEFT JOIN audit_run lr ON lr.id = cur.latest_id
        WHERE p.id = $1 AND p.account_id = $2`,
      [productId, accountId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      current: toCurrentRun(row),
      currentBlockers: row.current_blockers,
      latestBlockers: row.latest_blockers,
      itemCount: Number(row.item_count),
    };
  }

  /** 지금 일정에 대응하는 검수 실행. 상품 상세가 화면에 알려 준다 (#710) */
  async currentRun(productId: number): Promise<CurrentRun | null> {
    return currentRunOf(this.pool, productId);
  }

  /** 출시 승인 시각을 기록한다. `trg_check_release` 가 마지막으로 한 번 더 막는다 */
  async markReleased(accountId: number, productId: number): Promise<string | null> {
    const { rows } = await this.pool.query<{ released_at: Date }>(
      `UPDATE product SET released_at = now(), updated_at = now()
        WHERE id = $1 AND account_id = $2
        RETURNING released_at`,
      [productId, accountId],
    );
    return rows.length === 0 ? null : isoStamp(rows[0]?.released_at ?? null);
  }

  // ── 검수 시작(handoff) — 기획 중 → 검수 중 (FR-PL-020 · D7) ────────────────

  /** 검수 시작에 필요한 정보. 남의 상품이면 null. */
  async handoffState(
    accountId: number,
    productId: number,
  ): Promise<{ plannedAt: string | null; pendingIds: number[]; nights: number; daysWithItems: number[] } | null> {
    const { rows } = await this.pool.query<{ planned_at: Date | string | null; nights: number }>(
      `SELECT planned_at, nights FROM product WHERE id = $1 AND account_id = $2`,
      [productId, accountId],
    );
    if (rows.length === 0) return null;
    const pending = await this.pool.query<{ id: string }>(
      `SELECT id FROM itinerary_item WHERE product_id = $1 AND match_status = 'PENDING' ORDER BY id`,
      [productId],
    );
    // 완성도 검사용: 항목이 있는 일차들 (빈 일차 판정 · EX-IN-005 개정 — 검수 시작 관문)
    const days = await this.pool.query<{ day_no: number }>(
      `SELECT DISTINCT day_no FROM itinerary_item WHERE product_id = $1 ORDER BY day_no`,
      [productId],
    );
    return {
      plannedAt: isoStamp(rows[0]?.planned_at ?? null),
      pendingIds: pending.rows.map((r) => Number(r.id)),
      nights: Number(rows[0]?.nights ?? 0),
      daysWithItems: days.rows.map((r) => Number(r.day_no)),
    };
  }

  /**
   * 남은 미확정을 검수 제외로 넘기고 검수 시작 시각을 한 트랜잭션으로 기록한다 (D7).
   * `planned_at` 은 아직 없을 때만 채운다(재요청해도 처음 시각 유지). 기록한 시각을 돌려준다.
   */
  async applyHandoff(productId: number, excludeIds: readonly number[]): Promise<string> {
    return withTransaction(this.pool, async (client) => {
      if (excludeIds.length > 0) {
        await client.query(
          `UPDATE itinerary_item SET match_status = 'EXCLUDED'
            WHERE product_id = $1 AND id = ANY($2::bigint[]) AND match_status = 'PENDING'`,
          [productId, excludeIds],
        );
      }
      const { rows } = await client.query<{ planned_at: Date }>(
        `UPDATE product SET planned_at = COALESCE(planned_at, now()), updated_at = now()
          WHERE id = $1 RETURNING planned_at`,
        [productId],
      );
      return isoStamp(rows[0]?.planned_at ?? null) ?? '';
    });
  }

  /**
   * 검수 요청이 거절돼(예산 100% 등) 되돌린다 — 넘겼던 항목을 미확정으로, 이번에 처음 찍은
   * `planned_at` 이면 다시 비운다. 상품이 기획 중 상태 그대로 남는다.
   */
  async revertHandoff(productId: number, excludeIds: readonly number[], clearPlanned: boolean): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      if (excludeIds.length > 0) {
        await client.query(
          `UPDATE itinerary_item SET match_status = 'PENDING'
            WHERE product_id = $1 AND id = ANY($2::bigint[]) AND match_status = 'EXCLUDED'`,
          [productId, excludeIds],
        );
      }
      if (clearPlanned) {
        await client.query(`UPDATE product SET planned_at = NULL, updated_at = now() WHERE id = $1`, [productId]);
      }
    });
  }

  // ── 일정 항목 개별 CRUD (FR-IN-013/014) ──────────────────────────────────
  // 소유권은 item -> product -> account 로 스코프한다. 남의 항목은 0건이라 NOT_FOUND 가 된다.

  /** 상품이 그 계정 것이면 박수(nights)를, 아니면 null. dayNo 범위 검증용. */
  async ownedNights(accountId: number, productId: number): Promise<number | null> {
    const { rows } = await this.pool.query<{ nights: number }>(
      `SELECT nights FROM product WHERE id = $1 AND account_id = $2`,
      [productId, accountId],
    );
    return rows[0]?.nights ?? null;
  }

  /** 상품의 일정 항목 수. 상한(NF-CP-003) 검사용 — 소유권은 호출 전 ownedNights 로 확인한다 */
  async countItems(productId: number): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM itinerary_item WHERE product_id = $1`,
      [productId],
    );
    return rows[0]?.n ?? 0;
  }

  /** 항목 추가. seq 는 그 일차 끝에 붙인다. 소유권은 호출 전 ownedNights 로 확인한다. */
  /**
   * 넣을 위치를 잡는다 (4-3). `afterItemId` 를 주면 그 항목(같은 날)을, 없으면 그 날 마지막
   * 항목을 기준으로 삼는다. `afterItemId` 가 그 날에 없으면(다른 날 앵커 등) 끝에 붙이는 것으로
   * 되돌린다. 앵커가 없으면(빈 날) `null` — 서비스가 09:00 부터 시작한다.
   *
   * 이동시간 계산에 쓰도록 좌표와 "이 항목 다음에 갈 수 있는 시각"(끝, 없으면 시작)을 준다.
   * 상품의 이동수단도 함께 주어 대중교통이면 이동시간을 짓지 않게 한다.
   */
  async pickPlacement(
    productId: number,
    dayNo: number,
    afterItemId: number | null,
  ): Promise<{ transport: Transport; anchor: { availableFrom: string; seq: number; mapx: number | null; mapy: number | null } | null }> {
    const prod = await this.pool.query<{ transport: Transport }>(
      `SELECT transport FROM product WHERE id = $1`, [productId],
    );
    const transport = prod.rows[0]?.transport ?? 'CAR';

    const anchorRow = afterItemId === null
      ? await this.pool.query<{ available_from: string; seq: number; mapx: number | null; mapy: number | null }>(
        `SELECT COALESCE(end_time, start_time) AS available_from, seq, mapx, mapy FROM itinerary_item
          WHERE product_id = $1 AND day_no = $2 ORDER BY seq DESC LIMIT 1`,
        [productId, dayNo],
      )
      : await this.pool.query<{ available_from: string; seq: number; mapx: number | null; mapy: number | null }>(
        `SELECT COALESCE(end_time, start_time) AS available_from, seq, mapx, mapy FROM itinerary_item
          WHERE id = $1 AND product_id = $2 AND day_no = $3`,
        [afterItemId, productId, dayNo],
      );
    // afterItemId 가 그 날에 없으면 끝에 붙인다 — 앵커를 마지막 항목으로 다시 잡는다
    const found = anchorRow.rows[0];
    if (afterItemId !== null && found === undefined) {
      return this.pickPlacement(productId, dayNo, null);
    }
    return {
      transport,
      anchor: found === undefined ? null : {
        availableFrom: String(found.available_from).slice(0, 5),
        seq: Number(found.seq),
        mapx: found.mapx === null ? null : Number(found.mapx),
        mapy: found.mapy === null ? null : Number(found.mapy),
      },
    };
  }

  /**
   * 장소 담기로 넣는 항목 (FR-PL-013 · 4-3). 고른 공사 콘텐츠라 CONFIRMED 로 넣는다.
   * 시각(start · end)과 끝 시각 출처는 서비스가 정해 넘긴다(이동시간 · 체류시간 계산이거나 편집 화면이
   * 정한 시각). `afterSeq` 가 있으면
   * 그 순번 **다음**에 끼우고 뒤 항목을 한 칸씩 민다(없으면 그 날 끝에 붙인다). 좌표 · 분류는
   * 응답으로 온 값을 저장하고 제목 · 주소(공사 원문)는 저장하지 않는다.
   */
  async insertPickedItem(
    productId: number,
    picked: PickedItemInput,
    placement: { start: string; end: string | null; endTimeSource: 'INPUT' | 'DWELL_DEFAULT'; afterSeq: number | null },
  ): Promise<ItemDetail> {
    return withTransaction(this.pool, async (client) => {
      let seq: number;
      if (placement.afterSeq === null) {
        const max = await client.query<{ seq: number }>(
          `SELECT COALESCE(MAX(seq), 0) AS seq FROM itinerary_item WHERE product_id = $1 AND day_no = $2`,
          [productId, picked.dayNo],
        );
        seq = Number(max.rows[0]?.seq ?? 0) + 1;
      } else {
        // 유니크(product, day, seq) 충돌을 피해 뒤 항목을 크게 비켜 두고 net +1 로 되돌린다 (reorder 와 같은 수법)
        await client.query(
          `UPDATE itinerary_item SET seq = seq + 10000 WHERE product_id = $1 AND day_no = $2 AND seq > $3`,
          [productId, picked.dayNo, placement.afterSeq],
        );
        seq = placement.afterSeq + 1;
      }

      const { rows } = await client.query<ItemRaw>(
        `INSERT INTO itinerary_item
           (product_id, day_no, seq, start_time, end_time, end_time_source, place_label, item_type,
            match_status, origin, kto_content_id, content_type_id, lcls_systm1, lcls_systm2, lcls_systm3, mapx, mapy)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, 'CONFIRMED', $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id, day_no, seq, start_time, end_time, place_label, item_type, kto_content_id, match_status, origin,
                   lcls_systm2, end_time_source`,
        [
          productId, picked.dayNo, seq, placement.start, placement.end,
          placement.endTimeSource, picked.itemType, picked.origin,
          picked.content.contentId, picked.content.contentTypeId,
          picked.content.lcls1, picked.content.lcls2, picked.content.lcls3, picked.content.mapx, picked.content.mapy,
        ],
      );

      if (placement.afterSeq !== null) {
        await client.query(
          `UPDATE itinerary_item SET seq = seq - 9999 WHERE product_id = $1 AND day_no = $2 AND seq > 10000`,
          [productId, picked.dayNo],
        );
      }

      const row = rows[0];
      if (row === undefined) throw new Error('장소 담기 결과가 비어 있다');
      return toItemDetail(row);
    });
  }

  /**
   * 걷기 길로 넣는 항목 (D9 · FR-PL-015). 직접 정한 곳(EXCLUDED)으로 그 날 끝에 붙인다.
   * 코스 식별자(walk_id)만 저장하고 코스 이름은 저장하지 않는다 — 표시할 때 두루누비에서 찾는다.
   * `ck_item_walk` 가 walk_id 를 EXCLUDED 에만 허용한다.
   */
  async addWalkItem(productId: number, walk: WalkItemInput): Promise<ItemDetail> {
    // 편집 화면이 시각을 정해 보냈으면 그대로 쓴다 (UI-S2-048). 아니면 그 날 끝 · 표준 체류시간이다
    let start: string;
    let end: string | null;
    if (walk.startTime !== null) {
      start = walk.startTime;
      end = walk.endTime;
    } else {
      const prev = await this.pool.query<{ start_time: string; end_time: string | null }>(
        `SELECT start_time, end_time FROM itinerary_item
          WHERE product_id = $1 AND day_no = $2 ORDER BY seq DESC LIMIT 1`,
        [productId, walk.dayNo],
      );
      start = (prev.rows[0]?.end_time ?? prev.rows[0]?.start_time ?? '09:00').slice(0, 5);
      end = addMinutes(start, SETTING_DEFAULTS.dwellFallbackMinutes);
    }
    const { rows } = await this.pool.query<ItemRaw>(
      `INSERT INTO itinerary_item
         (product_id, day_no, seq, start_time, end_time, end_time_source, place_label, item_type,
          match_status, origin, walk_id)
       VALUES ($1, $2,
               (SELECT COALESCE(MAX(seq), 0) + 1 FROM itinerary_item WHERE product_id = $1 AND day_no = $2),
               $3, $4, $8, NULL, $5, 'EXCLUDED', $6, $7)
       RETURNING id, day_no, seq, start_time, end_time, place_label, item_type, kto_content_id, match_status, origin,
                   lcls_systm2, end_time_source`,
      [productId, walk.dayNo, start, end, walk.itemType, walk.origin, walk.walkId,
        // 사람이 정한 끝 시각만 입력값이다
        walk.startTime !== null && end !== null ? 'INPUT' : 'DWELL_DEFAULT'],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('걷기 길 담기 결과가 비어 있다');
    return toItemDetail(row);
  }

  async addItem(productId: number, item: ValidItemInput): Promise<ItemDetail> {
    const { rows } = await this.pool.query<ItemRaw>(
      `INSERT INTO itinerary_item
         (product_id, day_no, seq, start_time, end_time, end_time_source, place_label, item_type, match_status, origin)
       VALUES ($1, $2,
               (SELECT COALESCE(MAX(seq), 0) + 1 FROM itinerary_item WHERE product_id = $1 AND day_no = $2),
               $3, $4, $5, $6, $7, $9, $8)
       RETURNING id, day_no, seq, start_time, end_time, place_label, item_type, kto_content_id, match_status,
                 lcls_systm2, end_time_source`,
      [productId, item.dayNo, item.startTime, item.endTime, item.endTimeSource, item.placeLabel, item.itemType, item.origin,
        // 「직접 정한 곳으로 두기」를 고른 새 줄은 직접 정한 곳이다 (UI-S2-021)
        item.excluded ? 'EXCLUDED' : 'PENDING'],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('항목 추가 결과가 비어 있다');
    return toItemDetail(row);
  }

  /** 항목 수정(부분). 준 필드만 바꾼다. 남의 항목이면 null. */
  async patchItem(accountId: number, itemId: number, patch: ItemPatch): Promise<ItemDetail | null> {
    const col: Record<string, string> = {
      startTime: 'start_time',
      endTime: 'end_time',
      endTimeSource: 'end_time_source',
      placeLabel: 'place_label',
      itemType: 'item_type',
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      params.push(v);
      sets.push(`${col[k]} = $${params.length}`);
    }
    params.push(itemId, accountId);
    const { rows } = await this.pool.query<ItemRaw>(
      // updated_at — 검수한 뒤에 고쳤는지를 이 시각으로 가린다 (#710)
      `UPDATE itinerary_item i SET ${sets.join(', ')}, updated_at = now()
         FROM product p
        WHERE i.id = $${params.length - 1} AND i.product_id = p.id AND p.account_id = $${params.length}
       RETURNING i.id, i.day_no, i.seq, i.start_time, i.end_time, i.place_label, i.item_type, i.kto_content_id, i.match_status,
                 i.lcls_systm2, i.end_time_source`,
      params,
    );
    const row = rows[0];
    return row === undefined ? null : toItemDetail(row);
  }

  /** 항목 삭제. 남의 항목이면 false. */
  async deleteItem(accountId: number, itemId: number): Promise<boolean> {
    const { rows } = await this.pool.query<{ product_id: string }>(
      `DELETE FROM itinerary_item i USING product p
        WHERE i.id = $1 AND i.product_id = p.id AND p.account_id = $2
        RETURNING i.product_id`,
      [itemId, accountId],
    );
    const deleted = rows[0];
    if (deleted === undefined) return false;
    // 지운 줄은 흔적이 안 남는다. 남은 줄을 건드려 일정이 바뀌었음을 남긴다 (#710)
    await this.touchItems(Number(deleted.product_id));
    return true;
  }

  /**
   * 순서변경. 상품 항목 전체의 새 (일차 · 순서)를 받는다. 유니크(product, day, seq) 때문에
   * 한 번에 못 옮긴다 — 전부 큰 seq 로 비켜 두고 최종값을 박는다(트랜잭션).
   *
   * 반환: 소유·정합성 실패(남의 상품 · 항목 누락/외부 항목)면 null, 성공이면 옮긴 항목 수.
   */
  async reorderItems(accountId: number, productId: number, order: ItemOrder[]): Promise<number | null> {
    return withTransaction(this.pool, async (client) => {
      const owned = await client.query<{ id: string }>(
        `SELECT i.id FROM itinerary_item i JOIN product p ON i.product_id = p.id
          WHERE p.id = $1 AND p.account_id = $2`,
        [productId, accountId],
      );
      const ids = new Set(owned.rows.map((r) => Number(r.id)));
      const given = new Set(order.map((o) => o.itemId));
      // 상품의 전체 항목을 빠짐없이·남의 것 없이 보내야 한다
      if (ids.size !== given.size || [...given].some((id) => !ids.has(id))) return null;

      await client.query(`UPDATE itinerary_item SET seq = seq + 10000 WHERE product_id = $1`, [productId]);
      for (const o of order) {
        // 바로 위에서 seq 를 10000 만큼 비켜 두었다. 실제로 자리가 바뀐 줄만 updated_at 을 올린다 —
        // 편집 화면은 순서가 그대로여도 전체를 보낸다 (#710)
        await client.query(
          `UPDATE itinerary_item
              SET updated_at = CASE WHEN day_no IS DISTINCT FROM $1 OR seq - 10000 IS DISTINCT FROM $2
                                    THEN now() ELSE updated_at END,
                  day_no = $1, seq = $2
            WHERE id = $3 AND product_id = $4`, [
          o.dayNo,
          o.seq,
          o.itemId,
          productId,
        ]);
      }
      return order.length;
    });
  }
}

async function insertItem(
  client: { query: (sql: string, params: readonly unknown[]) => Promise<unknown> },
  productId: number,
  item: ValidItem,
): Promise<void> {
  // 걷기 길 — 직접 정한 곳으로 코스 식별자만 남긴다. 코스 이름은 저장하지 않는다 (DR-MD-005 · UI-S2-048)
  if (item.walkId !== null) {
    await client.query(
      `INSERT INTO itinerary_item
         (product_id, day_no, seq, start_time, end_time, end_time_source, place_label, item_type, match_status, origin, walk_id)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,'EXCLUDED',$8,$9)`,
      [productId, item.dayNo, item.seq, item.startTime, item.endTime, item.endTimeSource, item.itemType, item.origin, item.walkId],
    );
    return;
  }
  // 입력하는 순간 고른 관광지가 있으면 CONFIRMED 로 넣는다 (UI-S2-020 · D8). place_label 은 사용자가
  // 친 이름 그대로 두고(공식 명칭은 표시할 때 읽는다 · DR-PR-001) 코드·좌표·분류만 채운다.
  // 줄이 들어온 경로도 남긴다 (FR-PL-020). 장소 담기로 넣은 줄은 기획 화면 장소 담기와 같이 고른
  // 방식을 비운다 — 「장소 담기에서 넣음」 은 origin 으로 표시한다 (DR-MD-002 · 003).
  if (item.content !== null) {
    await client.query(
      `INSERT INTO itinerary_item
         (product_id, day_no, seq, start_time, end_time, end_time_source, place_label, item_type,
          kto_content_id, content_type_id, lcls_systm1, lcls_systm2, lcls_systm3, mapx, mapy,
          matched_by, match_status, origin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'CONFIRMED',$17)`,
      [
        productId, item.dayNo, item.seq, item.startTime, item.endTime, item.endTimeSource, item.placeLabel, item.itemType,
        item.content.contentId, item.content.contentTypeId,
        item.content.lcls1, item.content.lcls2, item.content.lcls3, item.content.mapx, item.content.mapy,
        item.origin === 'PICKER' ? null : 'USER', item.origin,
      ],
    );
    return;
  }
  // 안 고른 줄은 PENDING 이다 — 확정은 /plan 에서 이어 붙는다 (UI-S2-020: 못 고른 곳은 그대로 남긴다).
  // 「직접 정한 곳으로 두기」를 고른 줄은 직접 정한 곳(EXCLUDED)이다 (UI-S2-021 · FR-IN-025)
  await client.query(
    `INSERT INTO itinerary_item
       (product_id, day_no, seq, start_time, end_time, end_time_source, place_label, item_type, match_status, origin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$10,$9)`,
    [productId, item.dayNo, item.seq, item.startTime, item.endTime, item.endTimeSource, item.placeLabel, item.itemType, item.origin,
      item.excluded ? 'EXCLUDED' : 'PENDING'],
  );
}

interface ListRaw {
  id: string;
  name: string;
  start_date: Date | string;
  nights: number;
  ldong_regn_cd: string;
  ldong_signgu_cd: string | null;
  pending: number;
  unread: number;
  active: number;
  risks: number;
  run_id: string | null;
  executed_at: Date | string | null;
  readiness_score: number | null;
  current_kind: 'LATEST' | 'RESTORED' | 'STALE' | null;
  latest_blocker_cnt: number | null;
  is_partial: boolean | null;
  blocker_cnt: number | null;
  error_cnt: number | null;
  warn_cnt: number | null;
  unverified_cnt: number | null;
  weight_snapshot: Readonly<Record<Severity, number>> | null;
  target_count: number | null;
  failed_count: number | null;
  planned_at: Date | string | null;
  released_at: Date | string | null;
  started_by: string | null;
}

/**
 * 출시 승인이 통과하는가 — 지금 일정의 실행에 차단이 없고, 트리거가 보는 가장 최근 실행에도
 * 차단이 없어야 한다 (DR-IN-007 · #551). 반영 뒤 재검수 전(STALE)은 판정할 실행이 없다.
 */
export function isReleasable(
  kind: CurrentRun['kind'] | null,
  currentBlockers: number | null,
  latestBlockers: number | null,
): boolean {
  if (kind !== 'LATEST' && kind !== 'RESTORED') return false;
  return (currentBlockers ?? 0) === 0 && (latestBlockers ?? 0) === 0;
}

function toListRow(r: ListRaw, scores: ReadonlyMap<string, ScoreResult>): ProductListRow {
  // 저장값이 아니라 다시 계산한 값이다. 못 찾으면(있을 수 없다) 저장값으로 둔다
  const current = r.run_id === null ? undefined : scores.get(r.run_id);
  const latestAudit =
    r.run_id === null
      ? null
      : {
          auditRunId: Number(r.run_id),
          executedAt: isoStamp(r.executed_at) ?? '',
          readinessScore: current === undefined ? r.readiness_score : current.score,
          isPartial: r.is_partial ?? false,
          counts: current === undefined
            ? {
                blocker: r.blocker_cnt ?? 0,
                error: r.error_cnt ?? 0,
                warning: r.warn_cnt ?? 0,
                unverified: r.unverified_cnt ?? 0,
              }
            : {
                blocker: current.counts.BLOCKER,
                error: current.counts.ERROR,
                warning: current.counts.WARNING,
                unverified: current.counts.UNVERIFIED,
              },
          // 출시 승인과 같은 판정이다 (`ProductService.release` · #551)
          releasable: isReleasable(r.current_kind, r.blocker_cnt, r.latest_blocker_cnt),
        };
  return {
    id: Number(r.id),
    name: r.name,
    startDate: isoDate(r.start_date),
    nights: r.nights,
    ldongRegnCd: r.ldong_regn_cd,
    ldongSignguCd: r.ldong_signgu_cd,
    pendingMatches: r.pending,
    unreadNotifications: r.unread,
    activeNotifications: r.active,
    risksSinceAudit: r.risks,
    latestAudit,
    plannedAt: isoStamp(r.planned_at),
    releasedAt: isoStamp(r.released_at),
    startedBy: r.started_by ?? null,
  };
}

interface DetailRaw {
  id: string;
  name: string;
  ldong_regn_cd: string;
  ldong_signgu_cd: string | null;
  start_date: Date | string;
  nights: number;
  target_key: string | null;
  concept_key: string | null;
  head_count: number | null;
  transport: Transport;
  released_at: Date | string | null;
  planned_at: Date | string | null;
  plan_origin: unknown | null;
  created_at: Date | string;
}

interface ItemRaw {
  id: string;
  day_no: number;
  seq: number;
  start_time: string;
  end_time: string | null;
  place_label: string | null;
  item_type: ItemType;
  kto_content_id: string | null;
  match_status: MatchStatus;
  origin: string | null;
  mapx?: number | string | null;
  mapy?: number | string | null;
  walk_id?: string | null;
  lcls_systm2?: string | null;
  end_time_source?: EndTimeSource;
}

function toItemDetail(r: ItemRaw): ItemDetail {
  return {
    itemId: Number(r.id),
    dayNo: r.day_no,
    seq: r.seq,
    start: r.start_time.slice(0, 5),
    end: r.end_time === null ? null : r.end_time.slice(0, 5),
    place: r.place_label ?? '',
    itemType: r.item_type,
    ktoContentId: r.kto_content_id,
    matchStatus: r.match_status,
    mapx: r.mapx == null ? null : Number(r.mapx),
    mapy: r.mapy == null ? null : Number(r.mapy),
    walkId: r.walk_id ?? null,
    lcls2: r.lcls_systm2 ?? null,
    endTimeSource: r.end_time_source ?? 'INPUT',
  };
}
