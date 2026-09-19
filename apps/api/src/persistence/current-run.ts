import type { Pool } from 'pg';

/**
 * 지금 일정에 대응하는 검수 실행 (#551).
 *
 * 되돌리기는 새 실행을 만들지 않는다. 되돌린 일정은 반영 전 실행이 판정한 바로 그 일정이라
 * 그 실행을 현재 결과로 가리킨다 (API 설계 5-9). 그런데 「가장 최근 실행」만 보던 곳들은
 * 되돌린 뒤에도 반영 후 실행을 현재 결과로 읽었다 — 차단을 없앤 수정안을 되돌린 일정이
 * 출시 승인을 통과했고(2026-09-11 감사 치명 1번), 새로고침하면 반영 후 점수가 다시 보였다.
 *
 * 출시 승인 · 리포트 · 상품 목록 · 검수 이력이 모두 여기서 고른다. 한쪽만 고치면 화면은
 * 「출시할 수 있음」인데 승인은 막히는 식으로 어긋난다.
 *
 *   LATEST    가장 최근 실행 뒤로 반영 · 되돌리기가 없다       → 가장 최근 실행
 *   RESTORED  가장 최근 실행 뒤에 되돌렸다                    → 그 반영의 반영 전 실행
 *   STALE     가장 최근 실행 뒤에 반영만 있다(재검수 전 · 실패) → 대응하는 실행이 없다
 *   NONE      검수한 적이 없다
 *
 * 일정 편집(`PATCH /items` 등)은 보지 않는다 — 검수 뒤 편집은 전에도 지금도 다시 검수해야
 * 결과에 들어간다. 여기서 막는 것은 반영 · 되돌리기처럼 **서버가 일정을 통째로 바꾼 경우**다.
 */
export type CurrentRun =
  | { readonly kind: 'NONE'; readonly runId: null; readonly latestRunId: null }
  | { readonly kind: 'LATEST' | 'RESTORED'; readonly runId: number; readonly latestRunId: number }
  | { readonly kind: 'STALE'; readonly runId: null; readonly latestRunId: number };

/**
 * 상품 `p` 에 붙이는 LATERAL 조각. `cur.kind` · `cur.run_id` · `cur.latest_id` 를 낸다.
 *
 * 반영 한 건의 시각은 되돌렸으면 되돌린 때, 아니면 반영한 때다. 가장 최근 실행보다 늦은
 * 것 중 마지막 하나가 지금 일정을 만든 사건이다. 되돌리기는 가장 최근 반영 한 건만, 한 번만
 * 되므로 이 하나로 충분하다.
 */
export const CURRENT_RUN_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT lr.id AS latest_id,
           CASE WHEN ev.at IS NULL THEN 'LATEST'
                WHEN ev.reverted_at IS NOT NULL AND ev.before_audit_run_id IS NOT NULL THEN 'RESTORED'
                ELSE 'STALE' END AS kind,
           CASE WHEN ev.at IS NULL THEN lr.id
                WHEN ev.reverted_at IS NOT NULL THEN ev.before_audit_run_id
                ELSE NULL END AS run_id
      FROM (SELECT id, executed_at FROM audit_run
             WHERE product_id = p.id ORDER BY executed_at DESC, id DESC LIMIT 1) lr
      LEFT JOIN LATERAL (
        SELECT pa.before_audit_run_id, pa.reverted_at, COALESCE(pa.reverted_at, pa.applied_at) AS at
          FROM patch_application pa
         WHERE pa.product_id = p.id AND COALESCE(pa.reverted_at, pa.applied_at) > lr.executed_at
         ORDER BY COALESCE(pa.reverted_at, pa.applied_at) DESC, pa.id DESC
         LIMIT 1
      ) ev ON TRUE
  ) cur ON TRUE`;

interface CurrentRaw {
  kind: 'LATEST' | 'RESTORED' | 'STALE' | null;
  run_id: string | null;
  latest_id: string | null;
}

/** LATERAL 조각이 낸 세 칸 → `CurrentRun` */
export function toCurrentRun(raw: CurrentRaw): CurrentRun {
  if (raw.kind === null || raw.latest_id === null) return { kind: 'NONE', runId: null, latestRunId: null };
  const latestRunId = Number(raw.latest_id);
  if (raw.kind === 'STALE' || raw.run_id === null) return { kind: 'STALE', runId: null, latestRunId };
  return { kind: raw.kind, runId: Number(raw.run_id), latestRunId };
}

/** 상품 하나의 현재 실행. 상품이 없으면 `null` */
export async function currentRunOf(pool: Pool, productId: number): Promise<CurrentRun | null> {
  const { rows } = await pool.query<CurrentRaw>(
    `SELECT cur.kind, cur.run_id, cur.latest_id FROM product p ${CURRENT_RUN_LATERAL} WHERE p.id = $1`,
    [productId],
  );
  const row = rows[0];
  return row === undefined ? null : toCurrentRun(row);
}
