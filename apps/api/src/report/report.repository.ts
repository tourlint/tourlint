import type { Pool } from 'pg';
import type { ItinerarySnapshot } from '../audit/patch-snapshot';

/**
 * 리포트가 읽는 것들.
 *
 * **모든 조회에 `account_id` 를 건다.** 타 계정 리소스는 존재 여부를 노출하지 않고 없는 것으로
 * 다룬다 (PM-DA-002 · 003 · EX-SY-003). `AuditController` 가 아직 계정을 대조하지 않아
 * `audit_run` 을 계정으로 좁히는 조회가 이 저장소에 처음 생긴다.
 */

export interface OwnedRun {
  readonly auditRunId: number;
  readonly productId: number;
}

export interface ProductRow {
  readonly name: string;
  readonly ldongRegnCd: string;
  readonly ldongSignguCd: string | null;
  readonly startDate: string;
  readonly nights: number;
  readonly headCount: number | null;
  readonly transport: string;
  readonly releasedAt: string | null;
}

export interface ItemRow {
  readonly itemId: number;
  readonly dayNo: number;
  readonly seq: number;
  readonly start: string;
  readonly end: string | null;
  readonly place: string;
  readonly itemType: string;
  readonly ktoContentId: string | null;
  readonly contentTypeId: number | null;
  readonly matchStatus: string;
}

export interface FingerprintRow {
  readonly ktoContentId: string;
  readonly contentTypeId: number;
  readonly showFlag: 0 | 1;
  readonly ktoModifiedTime: string;
  readonly fieldHash: string;
}

export interface PatchRow {
  readonly id: number;
  readonly appliedAt: Date;
  readonly before: ItinerarySnapshot;
  readonly after: ItinerarySnapshot;
  readonly beforeAuditRunId: number | null;
  readonly afterAuditRunId: number | null;
  readonly revertedAt: Date | null;
}

export class ReportRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * 그 검수 실행이 이 계정 것인가.
   *
   * 없으면 `null` 이고 호출자는 404 를 낸다 — 남의 것이라고 알려 주면 그 자체가 존재
   * 확인이다 (403 이 아니라 404 인 이유, EX-SY-003).
   */
  async runOwnedBy(auditRunId: number, accountId: number): Promise<OwnedRun | null> {
    const { rows } = await this.pool.query<{ id: string; product_id: string }>(
      `SELECT r.id, r.product_id
         FROM audit_run r
         JOIN product p ON p.id = r.product_id
        WHERE r.id = $1 AND p.account_id = $2`,
      [auditRunId, accountId],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { auditRunId: Number(row.id), productId: Number(row.product_id) };
  }

  /** 가장 최근 실행 id. `AuditResultRepository.latestRunIdOf` 와 같은 정렬이어야 한다 */
  async latestRunIdOf(productId: number): Promise<number | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM audit_run WHERE product_id = $1 ORDER BY id DESC LIMIT 1`,
      [productId],
    );
    const row = rows[0];
    return row === undefined ? null : Number(row.id);
  }

  async product(productId: number): Promise<ProductRow | null> {
    const { rows } = await this.pool.query<{
      name: string; ldong_regn_cd: string; ldong_signgu_cd: string | null;
      start_date: Date | string; nights: number; head_count: number | null;
      transport: string; released_at: Date | null;
    }>(
      `SELECT name, ldong_regn_cd, ldong_signgu_cd, start_date, nights,
              head_count, transport, released_at
         FROM product WHERE id = $1`,
      [productId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      name: row.name,
      ldongRegnCd: row.ldong_regn_cd,
      ldongSignguCd: row.ldong_signgu_cd,
      startDate: isoDate(row.start_date),
      nights: Number(row.nights),
      headCount: row.head_count === null ? null : Number(row.head_count),
      transport: row.transport,
      releasedAt: row.released_at === null ? null : row.released_at.toISOString(),
    };
  }

  /** 일정 항목 전부. 검수 제외(`EXCLUDED`)도 빼지 않는다 — 건수를 세야 한다 (FR-PA-064) */
  async items(productId: number): Promise<readonly ItemRow[]> {
    const { rows } = await this.pool.query<{
      id: string; day_no: number; seq: number; start_time: string; end_time: string | null;
      place_label: string; item_type: string; kto_content_id: string | null;
      content_type_id: number | null; match_status: string;
    }>(
      `SELECT id, day_no, seq, start_time, end_time, place_label, item_type,
              kto_content_id, content_type_id, match_status
         FROM itinerary_item WHERE product_id = $1 ORDER BY day_no, seq`,
      [productId],
    );
    return rows.map((r) => ({
      itemId: Number(r.id),
      dayNo: Number(r.day_no),
      seq: Number(r.seq),
      start: String(r.start_time).slice(0, 5),
      end: r.end_time === null ? null : String(r.end_time).slice(0, 5),
      place: r.place_label,
      itemType: r.item_type,
      ktoContentId: r.kto_content_id,
      contentTypeId: r.content_type_id === null ? null : Number(r.content_type_id),
      matchStatus: r.match_status,
    }));
  }

  /**
   * 그 실행이 남긴 지문.
   *
   * `show_flag` 가 여기 있다. 리포트 생성 시점에 다시 부르는 상세 조회에는 그 값이 없어서
   * (`detailCommon2` · `detailIntro2` 응답에 없다) 비표출 차단(PM-NG-009)의 근거는 이것뿐이다.
   */
  async fingerprints(auditRunId: number): Promise<readonly FingerprintRow[]> {
    const { rows } = await this.pool.query<{
      kto_content_id: string; content_type_id: number; show_flag: number;
      kto_modified_time: string; field_hash: string;
    }>(
      `SELECT kto_content_id, content_type_id, show_flag, kto_modified_time, field_hash
         FROM content_fingerprint WHERE audit_run_id = $1 ORDER BY kto_content_id`,
      [auditRunId],
    );
    return rows.map((r) => ({
      ktoContentId: r.kto_content_id,
      contentTypeId: Number(r.content_type_id),
      showFlag: Number(r.show_flag) === 0 ? 0 : 1,
      ktoModifiedTime: r.kto_modified_time,
      fieldHash: r.field_hash,
    }));
  }

  /** 패치 이력. 되돌린 것도 준다 — 이력이지 현재 상태가 아니다 */
  async patches(productId: number): Promise<readonly PatchRow[]> {
    const { rows } = await this.pool.query<{
      id: string; applied_at: Date; before_snapshot: ItinerarySnapshot;
      after_snapshot: ItinerarySnapshot; before_audit_run_id: string | null;
      after_audit_run_id: string | null; reverted_at: Date | null;
    }>(
      `SELECT id, applied_at, before_snapshot, after_snapshot,
              before_audit_run_id, after_audit_run_id, reverted_at
         FROM patch_application WHERE product_id = $1 ORDER BY applied_at, id`,
      [productId],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      appliedAt: r.applied_at,
      before: r.before_snapshot,
      after: r.after_snapshot,
      beforeAuditRunId: r.before_audit_run_id === null ? null : Number(r.before_audit_run_id),
      afterAuditRunId: r.after_audit_run_id === null ? null : Number(r.after_audit_run_id),
      revertedAt: r.reverted_at,
    }));
  }
}

function isoDate(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}
