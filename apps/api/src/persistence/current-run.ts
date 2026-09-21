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
/** `STALE` 의 까닭. 출시 거절 문구와 화면 안내가 이걸로 갈린다 (#710) */
export type StaleReason = 'PATCH' | 'EDIT';

export type CurrentRun =
  | { readonly kind: 'NONE'; readonly runId: null; readonly latestRunId: null }
  | { readonly kind: 'LATEST' | 'RESTORED'; readonly runId: number; readonly latestRunId: number }
  | { readonly kind: 'STALE'; readonly runId: null; readonly latestRunId: number; readonly reason: StaleReason };

/**
 * 앱 시계로 찍은 시각(`applied_at` · `reverted_at`)과 DB 시계로 찍은 시각(`updated_at`)을 견주는
 * 자리의 여유 (#710). 수정안 반영 · 되돌리기가 항목을 다시 쓰면 `updated_at` 은 DB 의 `now()` 인데
 * 사건 시각은 앱이 준다 — 두 시계가 조금만 어긋나도 방금 되돌린 일정이 「사람이 또 고친 일정」 으로
 * 읽힌다. 사람이 검수 · 반영 뒤 5초 안에 일정을 고치는 일은 없다.
 */
export const EDIT_GRACE_SECONDS = 5;

export const CURRENT_RUN_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT lr.id AS latest_id,
           CASE WHEN ed.edited THEN 'STALE'
                WHEN ev.at IS NULL THEN 'LATEST'
                WHEN ev.reverted_at IS NOT NULL AND ev.before_audit_run_id IS NOT NULL THEN 'RESTORED'
                ELSE 'STALE' END AS kind,
           CASE WHEN ed.edited THEN NULL
                WHEN ev.at IS NULL THEN lr.id
                WHEN ev.reverted_at IS NOT NULL THEN ev.before_audit_run_id
                ELSE NULL END AS run_id,
           CASE WHEN ed.edited THEN 'EDIT' ELSE 'PATCH' END AS stale_reason
      FROM (SELECT id, executed_at, created_at FROM audit_run
             WHERE product_id = p.id ORDER BY executed_at DESC, id DESC LIMIT 1) lr
      LEFT JOIN LATERAL (
        SELECT pa.before_audit_run_id, pa.reverted_at, COALESCE(pa.reverted_at, pa.applied_at) AS at
          FROM patch_application pa
         WHERE pa.product_id = p.id AND COALESCE(pa.reverted_at, pa.applied_at) > lr.executed_at
         ORDER BY COALESCE(pa.reverted_at, pa.applied_at) DESC, pa.id DESC
         LIMIT 1
      ) ev ON TRUE
      /*
       * 검수한 뒤에 사람이 일정을 고쳤는가 (#710). 수정안 반영 · 되돌리기만 일정 변경으로 보던 때는
       * 검수 100점 → 식사를 03:00 으로 옮김 → 재검수 없이 출시 승인이 통과했다 (PM-NG-002).
       *
       * 기준은 검수가 **저장된** 시각(created_at · DB 시계)이다. executed_at 은 앱 시계라 항목의
       * updated_at 과 바로 견줄 수 없다. 반영 · 되돌리기가 있었으면 그 사건 시각까지가 같은 일정이다.
       * 삭제는 흔적을 안 남기므로 지울 때 남은 항목을 건드린다 (ProductRepository.deleteItem).
       */
      LEFT JOIN LATERAL (
        SELECT COALESCE(max(GREATEST(i.created_at, i.updated_at))
                          > GREATEST(lr.created_at, COALESCE(ev.at, lr.created_at))
                            + interval '${String(EDIT_GRACE_SECONDS)} seconds',
                        FALSE) AS edited
          FROM itinerary_item i WHERE i.product_id = p.id
      ) ed ON TRUE
  ) cur ON TRUE`;

interface CurrentRaw {
  kind: 'LATEST' | 'RESTORED' | 'STALE' | null;
  run_id: string | null;
  latest_id: string | null;
  stale_reason?: StaleReason | null;
}

/** LATERAL 조각이 낸 세 칸 → `CurrentRun` */
export function toCurrentRun(raw: CurrentRaw): CurrentRun {
  if (raw.kind === null || raw.latest_id === null) return { kind: 'NONE', runId: null, latestRunId: null };
  const latestRunId = Number(raw.latest_id);
  if (raw.kind === 'STALE' || raw.run_id === null) {
    return { kind: 'STALE', runId: null, latestRunId, reason: raw.stale_reason === 'EDIT' ? 'EDIT' : 'PATCH' };
  }
  return { kind: raw.kind, runId: Number(raw.run_id), latestRunId };
}

/** 상품 하나의 현재 실행. 상품이 없으면 `null` */
export async function currentRunOf(pool: Pool, productId: number): Promise<CurrentRun | null> {
  const { rows } = await pool.query<CurrentRaw>(
    `SELECT cur.kind, cur.run_id, cur.latest_id, cur.stale_reason FROM product p ${CURRENT_RUN_LATERAL} WHERE p.id = $1`,
    [productId],
  );
  const row = rows[0];
  return row === undefined ? null : toCurrentRun(row);
}
