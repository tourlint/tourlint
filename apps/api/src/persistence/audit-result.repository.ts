import type { ParseConfidence, ReasonCode, Severity } from '@tourlint/shared';
import type { Pool } from 'pg';
import type { FingerprintSnapshot } from '../engine/fingerprint/types';
import type { Finding } from '../engine/rules/types';
import type { Patch } from '../audit/patch-types';
import { calculateReadiness, type ScorableFinding, type ScoreResult } from '../engine/score';
import { withTransaction, type Queryable } from './db';

/**
 * 검수 결과 저장 (DB 명세서 3-5 · 3-6 · 3-7 · 파이프라인 9단계).
 *
 * 세 테이블(`audit_run` · `finding` · `content_fingerprint`)을 **한 트랜잭션으로** 쓴다.
 * 나눠 쓰면 finding 이 빠진 `audit_run` 이 남을 수 있는데, 그러면 화면에 **점수는 있는데
 * 근거가 없는** 검수 결과가 뜬다. 근거 없는 판정을 보여주지 않는 것이 이 서비스의 전제다.
 *
 * ⚠️ `audit_run` 은 불변이다 (`PM-NG-004`, DB 트리거가 UPDATE 를 막는다). 무시 처리로 점수가
 * 달라져도 저장값을 고치지 않고 **조회 시점에 다시 계산한다** (FR-AU-046).
 */

export interface FingerprintToSave {
  readonly ktoContentId: string;
  readonly contentTypeId: number;
  readonly fetchedAt: Date;
  /** 원본 `YYYYMMDDHHmmss` 문자열. 비교 목적이므로 변환하지 않는다 (DR-PR-008) */
  readonly ktoModifiedTime: string;
  readonly showFlag: 0 | 1;
  readonly fieldNames: readonly string[];
  readonly fieldHash: string;
  /** 정규화 결과. 파싱 전면 실패면 null */
  readonly normalizedJson: unknown | null;
  readonly parseConfidence: ParseConfidence;
}

export interface AuditResultToSave {
  readonly productId: number;
  readonly executedAt: Date;
  readonly rulesetVersion: string;
  readonly targetCount: number;
  readonly failedCount: number;
  readonly findings: readonly Finding[];
  readonly fingerprints: readonly FingerprintToSave[];
  /** 산출 시점 가중치. 설정 변경의 소급 적용을 막는다 (DR-CF-006) */
  readonly weights: Readonly<Record<Severity, number>>;
  readonly score: ScoreResult;
  /**
   * 상품 단위 총 이동시간 · 거리 (FR-RU-084 · F10 의 입력).
   *
   * **실행 시점에 남기지 않으면 영영 못 얻는다.** 외부 호출로만 나오는 값이고,
   * `finding` 에는 부족한 구간만 남으며, 재계산하면 그때의 교통 상황으로 다른 값이 온다.
   */
  readonly travelTotals: { readonly durationSeconds: number; readonly distanceMeters: number };
}

export interface StoredFinding extends ScorableFinding {
  readonly id: number;
  readonly ruleCode: string;
  readonly reasonCode: ReasonCode;
  readonly targetItemId: number | null;
  readonly targetItemId2: number | null;
  readonly message: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly requiresExternal: boolean;
  readonly externalSource: string | null;
  readonly dismissReason: string | null;
  readonly confirmed: boolean;
  readonly patches: readonly Patch[];
}

/** 콘텐츠 1건의 해석 결과. `normalized` 는 해석하지 못했으면 `null` 이다 */
export interface NormalizedView {
  readonly normalized: unknown | null;
  readonly confidence: string;
}

export interface StoredAuditRun {
  readonly id: number;
  readonly productId: number;
  readonly executedAt: Date;
  readonly rulesetVersion: string;
  /** **저장 시점** 점수. 무시 처리가 반영되지 않은 값이다 */
  readonly storedScore: number | null;
  readonly isPartial: boolean;
  readonly targetCount: number;
  readonly failedCount: number;
  readonly weights: Readonly<Record<Severity, number>>;
  /** 산출하지 않은 실행은 `null` 이다. 0 과 다르다 — 0 은 「합이 0」이다 */
  readonly travelTotals: { readonly durationSeconds: number; readonly distanceMeters: number } | null;
  readonly findings: readonly StoredFinding[];
  /** **조회 시점** 재계산 결과. 화면·리포트는 이 값을 쓴다 (FR-AU-046) */
  readonly current: ScoreResult;
}

export class AuditResultRepository {
  constructor(private readonly pool: Pool) {}

  /** 세 테이블을 한 트랜잭션으로 쓴다. 새 `audit_run.id` 를 돌려준다 */
  async save(result: AuditResultToSave): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const runId = await insertAuditRun(client, result);
      await insertFindings(client, runId, result.findings);
      await insertFingerprints(client, runId, result.fingerprints);
      return runId;
    });
  }

  /**
   * 검수 실행 하나를 읽는다.
   *
   * **점수를 다시 계산해 돌려준다.** 저장값은 `storedScore` 로 함께 주되, 화면에 쓰는 값은
   * `current` 다 — 무시 · 무시 해제는 과거 저장값을 바꾸지 않고 조회 시점에 반영된다
   * (FR-AU-046 · PM-NG-004).
   */
  async findById(auditRunId: number): Promise<StoredAuditRun | null> {
    const run = await this.pool.query<AuditRunRow>(
      `SELECT id, product_id, executed_at, ruleset_version, readiness_score, is_partial,
              target_count, failed_count, weight_snapshot, travel_seconds, travel_meters
         FROM audit_run WHERE id = $1`,
      [auditRunId],
    );
    const row = run.rows[0];
    if (row === undefined) return null;

    const findings = await this.findingsOf(auditRunId);
    const weights = row.weight_snapshot;

    return {
      id: Number(row.id),
      productId: Number(row.product_id),
      executedAt: row.executed_at,
      rulesetVersion: row.ruleset_version,
      storedScore: row.readiness_score === null ? null : Number(row.readiness_score),
      isPartial: row.is_partial,
      targetCount: row.target_count,
      failedCount: row.failed_count,
      weights,
      // 컬럼이 생기기 전 실행은 NULL 이다. 0 으로 뭉개면 「이동이 없었다」로 읽힌다
      travelTotals: row.travel_seconds === null || row.travel_meters === null
        ? null
        : { durationSeconds: Number(row.travel_seconds), distanceMeters: Number(row.travel_meters) },
      findings,
      // 저장값을 그대로 쓰지 않는다. 무시 상태가 바뀌었을 수 있다
      current: calculateReadiness({
        findings,
        weights,
        targetCount: row.target_count,
        failedCount: row.failed_count,
      }),
    };
  }

  /**
   * 그 상품의 **직전 검수**에서 만든 지문을 `kto_content_id` 로 찾는다 (FR-MO-004).
   *
   * 콘텐츠 전역이 아니라 상품 단위로 본다 — `FR-RU-060` 이 "직전 **검수** 지문과 현재 지문을
   * 비교" 라고 정하고, 알림도 상품 단위로 만들어지기 때문이다. 다른 상품이 먼저 검수해
   * 만든 지문을 직전으로 삼으면 이 상품 사용자는 못 본 변경을 "이미 알렸다" 고 넘긴다.
   */
  async previousFingerprints(productId: number): Promise<ReadonlyMap<string, FingerprintSnapshot>> {
    const { rows } = await this.pool.query<PreviousFingerprintRow>(
      `SELECT DISTINCT ON (f.kto_content_id)
              f.kto_content_id, f.field_names, f.field_hash, f.show_flag, f.kto_modified_time
         FROM content_fingerprint f
         JOIN audit_run r ON r.id = f.audit_run_id
        WHERE r.product_id = $1
        ORDER BY f.kto_content_id, f.fetched_at DESC`,
      [productId],
    );
    return new Map(rows.map((r) => [r.kto_content_id, {
      fieldNames: r.field_names,
      fieldHash: r.field_hash,
      showFlag: (r.show_flag === 0 ? 0 : 1) as 0 | 1,
      ktoModifiedTime: r.kto_modified_time,
    }]));
  }

  /**
   * 그 상품의 가장 최근 검수 실행 id.
   *
   * 패치 확정이 `before_audit_run_id` 로 붙잡는 값이다 (FR-PA-025 · 전후 비교의 좌측).
   * 한 번도 검수하지 않은 상품이면 `null` 이고, 그때는 비교할 좌측이 없다.
   */
  async latestRunIdOf(productId: number): Promise<number | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM audit_run WHERE product_id = $1 ORDER BY id DESC LIMIT 1`,
      [productId],
    );
    const row = rows[0];
    return row === undefined ? null : Number(row.id);
  }

  /**
   * 그 실행이 남긴 콘텐츠별 지문. **대표 지문(DR-FP-008)의 재료**다.
   *
   * 대표 지문은 컬럼으로 없고 조회 시점에 산출한다. 이걸 안 읽으면 검수 근거 영역의
   * 데이터 지문이 계속 `null` 로 나간다 (FR-PA-062 · UI-S6-005).
   */
  async fingerprintHashesOf(
    auditRunId: number,
  ): Promise<readonly { ktoContentId: string; fieldHash: string }[]> {
    const { rows } = await this.pool.query<{ kto_content_id: string; field_hash: string }>(
      `SELECT kto_content_id, field_hash
         FROM content_fingerprint WHERE audit_run_id = $1 ORDER BY kto_content_id`,
      [auditRunId],
    );
    return rows.map((r) => ({ ktoContentId: r.kto_content_id, fieldHash: r.field_hash }));
  }

  /**
   * 그 실행이 남긴 **AI 해석** — 콘텐츠별 정규화 결과와 신뢰도 (FR-AU-007 · DR-NM).
   *
   * 판정 근거 3단 중 가운데 단이다. 자체 산출물이라 공사 호출 없이 DB 에서 온다 (5-12).
   */
  async normalizedOf(auditRunId: number): Promise<ReadonlyMap<string, NormalizedView>> {
    const { rows } = await this.pool.query<{
      kto_content_id: string; normalized_json: unknown | null; parse_confidence: string;
    }>(
      `SELECT kto_content_id, normalized_json, parse_confidence
         FROM content_fingerprint WHERE audit_run_id = $1`,
      [auditRunId],
    );
    return new Map(rows.map((r) => [
      r.kto_content_id,
      { normalized: r.normalized_json, confidence: r.parse_confidence },
    ]));
  }

  async findingsOf(auditRunId: number): Promise<readonly StoredFinding[]> {
    const { rows } = await this.pool.query<FindingRow>(
      `SELECT id, rule_code, severity, reason_code, target_item_id, target_item_id2,
              message, evidence, requires_external, external_source, patches,
              dismissed_at, dismiss_reason, confirmed_at
         FROM finding WHERE audit_run_id = $1 ORDER BY id`,
      [auditRunId],
    );
    return rows.map(toStoredFinding);
  }

  /**
   * 선택된 수정안을 finding 에서 꺼낸다.
   *
   * **상품 소유를 SQL 에서 확인한다.** 위층에서 확인하고 여기서 안 하면, 다른 상품의
   * finding id 를 넣어 남의 일정을 미리 볼 수 있게 된다. 조건을 쿼리에 붙여 두면
   * 호출 경로가 늘어도 새지 않는다.
   */
  /**
   * 무시 처리 (FR-AU-045).
   *
   * **차단 등급은 무시할 수 없다** (PM-NG-001 · DR-IN-006). DB 제약
   * `ck_finding_blocker_not_dismissed` 이 마지막 방어선이고, 여기서는 그 전에 걸러
   * 사용자에게 말이 되는 오류를 준다 — 제약 위반은 500 으로 나가기 때문이다.
   *
   * 이미 무시된 건을 다시 무시해도 시각이 갱신되지 않는다. 무시한 시점이 기록이라
   * 덮으면 「언제 무시했나」가 사라진다.
   */
  async dismiss(findingId: number, reason: string | null): Promise<'OK' | 'NOT_FOUND' | 'BLOCKER'> {
    const { rows } = await this.pool.query<{ severity: Severity }>(
      `SELECT severity FROM finding WHERE id = $1`, [findingId],
    );
    const found = rows[0];
    if (found === undefined) return 'NOT_FOUND';
    if (found.severity === 'BLOCKER') return 'BLOCKER';

    await this.pool.query(
      `UPDATE finding SET dismissed_at = now(), dismiss_reason = $2
        WHERE id = $1 AND dismissed_at IS NULL`,
      [findingId, reason],
    );
    return 'OK';
  }

  /** 무시 해제 (FR-AU-047). 사유도 함께 지운다 — 남겨 두면 해제된 건에 사유가 붙어 있다 */
  async undismiss(findingId: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE finding SET dismissed_at = NULL, dismiss_reason = NULL WHERE id = $1`, [findingId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * 확인 필요 목록의 체크 (FR-AU-008).
   *
   * 무시와 다르다 — 무시는 「이 판정을 안 보겠다」이고 확인은 「내가 직접 알아봤다」다.
   * 점수에서 빠지지 않는다.
   */
  async confirm(findingId: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE finding SET confirmed_at = now() WHERE id = $1 AND confirmed_at IS NULL`, [findingId],
    );
    if ((rowCount ?? 0) > 0) return true;
    // 이미 확인된 건도 성공으로 본다. 두 번 눌렀다고 오류를 낼 일이 아니다
    const { rows } = await this.pool.query(`SELECT 1 FROM finding WHERE id = $1`, [findingId]);
    return rows.length > 0;
  }

  /** 그 상품의 검수 이력. 최신순 (F13 · API 설계 5-9) */
  async runsOfProduct(productId: number, limit = 20): Promise<readonly StoredAuditRun[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM audit_run WHERE product_id = $1 ORDER BY executed_at DESC, id DESC LIMIT $2`,
      [productId, limit],
    );
    const out: StoredAuditRun[] = [];
    for (const r of rows) {
      const run = await this.findById(Number(r.id));
      if (run !== null) out.push(run);
    }
    return out;
  }

  async patchesOfProduct(
    productId: number,
    findingIds: readonly number[],
  ): Promise<ReadonlyMap<number, readonly Patch[]>> {
    if (findingIds.length === 0) return new Map();
    const { rows } = await this.pool.query<{ id: string; patches: unknown }>(
      `SELECT f.id, f.patches
         FROM finding f
         JOIN audit_run r ON r.id = f.audit_run_id
        WHERE r.product_id = $1 AND f.id = ANY($2::bigint[])`,
      [productId, findingIds],
    );
    return new Map(rows.map((r) => [Number(r.id), (r.patches ?? []) as readonly Patch[]]));
  }
}

// ── 쓰기 ──────────────────────────────────────────────────────────────

async function insertAuditRun(client: Queryable, r: AuditResultToSave): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO audit_run
       (product_id, executed_at, ruleset_version, readiness_score, is_partial,
        target_count, failed_count, blocker_cnt, error_cnt, warn_cnt, unverified_cnt, weight_snapshot,
        travel_seconds, travel_meters)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      r.productId, r.executedAt, r.rulesetVersion,
      r.score.score, r.score.isPartial,
      r.targetCount, r.failedCount,
      // 저장하는 건수는 **전체**다. 무시는 저장 이후에 일어나고 조회 시점에 반영된다
      r.score.counts.BLOCKER, r.score.counts.ERROR, r.score.counts.WARNING, r.score.counts.UNVERIFIED,
      JSON.stringify(r.weights),
      r.travelTotals.durationSeconds, r.travelTotals.distanceMeters,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('audit_run 을 만들지 못했다');
  return Number(id);
}

async function insertFindings(client: Queryable, runId: number, findings: readonly Finding[]): Promise<void> {
  for (const f of findings) {
    await client.query(
      `INSERT INTO finding
         (audit_run_id, rule_code, rule_version, severity, reason_code,
          target_item_id, target_item_id2, message, evidence, requires_external, external_source, patches)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        runId, f.ruleCode, f.ruleVersion, f.severity, f.reasonCode,
        f.targetItemId, f.targetItemId2 ?? null, f.message,
        /*
         * `finding` 에 확인 필요 여부를 담을 컬럼이 없어 `evidence` 로 내려보낸다.
         * 목록에서 체크한 **시각**은 `confirmed_at` 이 갖는다 — 둘은 다른 정보다.
         */
        JSON.stringify({ ...f.evidence, needsConfirmation: f.needsConfirmation }),
        f.requiresExternal, f.externalSource,
        // 표시 문구(label)를 담지 않는다. 대체 관광지 명칭은 공사 원문이다 (DR-PR-001)
        JSON.stringify(f.patches ?? []),
      ],
    );
  }
}

async function insertFingerprints(
  client: Queryable,
  runId: number,
  fingerprints: readonly FingerprintToSave[],
): Promise<void> {
  for (const fp of fingerprints) {
    await client.query(
      `INSERT INTO content_fingerprint
         (audit_run_id, kto_content_id, content_type_id, fetched_at, kto_modified_time,
          show_flag, field_names, field_hash, normalized_json, parse_confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        runId, fp.ktoContentId, fp.contentTypeId, fp.fetchedAt, fp.ktoModifiedTime,
        fp.showFlag, fp.fieldNames, fp.fieldHash,
        fp.normalizedJson === null ? null : JSON.stringify(fp.normalizedJson),
        fp.parseConfidence,
      ],
    );
  }
}

// ── 행 매핑 ───────────────────────────────────────────────────────────

interface AuditRunRow {
  id: string;
  product_id: string;
  executed_at: Date;
  ruleset_version: string;
  readiness_score: number | null;
  is_partial: boolean;
  target_count: number;
  failed_count: number;
  weight_snapshot: Record<Severity, number>;
  travel_seconds: number | null;
  travel_meters: number | null;
}

interface PreviousFingerprintRow {
  kto_content_id: string;
  field_names: string[];
  field_hash: string;
  show_flag: number;
  kto_modified_time: string;
}

interface FindingRow {
  id: string;
  rule_code: string;
  severity: Severity;
  reason_code: ReasonCode;
  target_item_id: string | null;
  target_item_id2: string | null;
  message: string;
  evidence: Record<string, unknown>;
  requires_external: boolean;
  external_source: string | null;
  patches: unknown[];
  dismissed_at: Date | null;
  dismiss_reason: string | null;
  confirmed_at: Date | null;
}

function toStoredFinding(row: FindingRow): StoredFinding {
  return {
    id: Number(row.id),
    ruleCode: row.rule_code,
    severity: row.severity,
    reasonCode: row.reason_code,
    targetItemId: row.target_item_id === null ? null : Number(row.target_item_id),
    targetItemId2: row.target_item_id2 === null ? null : Number(row.target_item_id2),
    message: row.message,
    evidence: row.evidence,
    requiresExternal: row.requires_external,
    externalSource: row.external_source,
    patches: (row.patches ?? []) as StoredFinding['patches'],
    dismissed: row.dismissed_at !== null,
    dismissReason: row.dismiss_reason,
    confirmed: row.confirmed_at !== null,
    needsConfirmation: row.evidence.needsConfirmation === true,
  };
}
