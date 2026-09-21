import type { Pool } from 'pg';
import type { ImpactCandidate, MatchCondition, NotificationKind } from '../batch/impact-finder';
import type { OpportunityCandidate, OpportunityItem } from '../batch/opportunity';
import { CURRENT_RUN_LATERAL } from './current-run';
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
   *
   * **기획 중 상품도 뺀다** (`planned_at IS NULL` · B6 함정). 아직 검수 시작을 안 누른
   * 상품은 F13 영향 탐색·알림 대상이 아니다 — 검수 시작(handoff)부터 감시한다.
   */
  async productsWithContents(
    contentIds: readonly string[],
    today: IsoDate,
  ): Promise<ReadonlyMap<string, readonly ImpactCandidate[]>> {
    const out = new Map<string, ImpactCandidate[]>();
    if (contentIds.length === 0) return out;

    const { rows } = await this.pool.query<CandidateRow & { kto_content_id: string }>(
      `SELECT DISTINCT i.kto_content_id, p.id, p.start_date, p.nights, p.ldong_regn_cd, p.ldong_signgu_cd
         FROM product p
         JOIN itinerary_item i ON i.product_id = p.id
        WHERE i.kto_content_id = ANY($1::text[])
          AND i.match_status = 'CONFIRMED'
          AND p.planned_at IS NOT NULL
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

  /**
   * 조건 2 · 3 후보 — 감시 대상 상품. 날짜 · 지역 판정은 `ImpactFinder` 가 한다.
   *
   * **출발일 임박순이다** (FR-MO-020). 상한에 걸려 잘려나가는 것은 가장 덜 급한 상품이어야
   * 하고, 같은 날 출발이면 id 로 갈라 실행마다 같은 결과를 낸다 (NF-MT-001).
   *
   * **기획 중 상품은 뺀다** (`planned_at IS NULL` · B6 함정). 검수 시작 전 상품은 감시하지
   * 않는다 — 조건 2 · 3 도 검수 시작(handoff)부터다.
   *
   * **상한은 계정별로 센다** (#690). 전체에서 상위 N 개를 뽑으면 한 계정의 알림이 다른 계정의
   * 상품 수에 달린다 — 2026-09-21 운영 배치는 알림 100건 중 96건을 다른 계정 상품에 만들었고,
   * 이른 출발 상품이 다른 계정에 N 개 있으면 그 계정은 조건 2 ~ 6 을 하나도 못 받는다. 공사
   * 호출은 늘지 않는다 — 상세 재호출 대상은 감시 상품 수가 아니라 그날 바뀐 행사 수다.
   */
  async watchedProducts(today: IsoDate, limit?: number): Promise<readonly ImpactCandidate[]> {
    const { rows } = await this.pool.query<CandidateRow>(
      `SELECT id, start_date, nights, ldong_regn_cd, ldong_signgu_cd
         FROM (SELECT p.id, p.start_date, p.nights, p.ldong_regn_cd, p.ldong_signgu_cd,
                      row_number() OVER (PARTITION BY p.account_id ORDER BY p.start_date, p.id) AS rank_in_account
                 FROM product p
                WHERE p.planned_at IS NOT NULL
                  AND p.start_date + p.nights >= $1::date) ranked
        WHERE $2::int IS NULL OR rank_in_account <= $2::int
        ORDER BY start_date, id`,
      [today, limit ?? null],
    );
    return rows.map(toCandidate);
  }

  /**
   * 조건 4 ~ 6 후보 (FR-MO-030 ④⑤⑥). 감시 대상 상품에 결손 유형과 일정 항목을 붙인다.
   *
   * 결손 유형은 **지금 일정의 검수 실행**의 R10 판정에서 읽는다(#551 · `current-run`). 되돌린
   * 일정이면 반영 전 실행이다. 사용자가 그 판정을 무시했으면 비운다 — 채우지 않겠다고 한 유형을
   * 새 소식으로 다시 권하지 않는다. 검수한 적이 없으면 결손도 없다.
   *
   * 항목은 매칭 상태와 관계없이 모두 싣는다. 고르지 않은 줄도 그 시간을 차지한다.
   */
  async opportunityCandidates(watched: readonly ImpactCandidate[]): Promise<readonly OpportunityCandidate[]> {
    if (watched.length === 0) return [];
    const ids = watched.map((c) => c.productId);

    const missing = await this.pool.query<{ product_id: string; missing: unknown }>(
      `SELECT p.id AS product_id, f.evidence -> 'missingLcls2' AS missing
         FROM product p
         ${CURRENT_RUN_LATERAL}
         JOIN finding f ON f.audit_run_id = COALESCE(cur.run_id, cur.latest_id)
                       AND f.rule_code = 'R10' AND f.dismissed_at IS NULL
        WHERE p.id = ANY($1::bigint[])`,
      [ids],
    );
    const missingOf = new Map<number, string[]>();
    for (const row of missing.rows) {
      const codes = Array.isArray(row.missing) ? row.missing.filter((c): c is string => typeof c === 'string') : [];
      missingOf.set(Number(row.product_id), [...(missingOf.get(Number(row.product_id)) ?? []), ...codes]);
    }

    const items = await this.pool.query<{
      product_id: string; day_no: number; seq: number; start_time: string; end_time: string | null;
      mapx: string | number | null; mapy: string | number | null;
    }>(
      `SELECT product_id, day_no, seq,
              to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time, mapx, mapy
         FROM itinerary_item
        WHERE product_id = ANY($1::bigint[])
        ORDER BY product_id, day_no, seq`,
      [ids],
    );
    const itemsOf = new Map<number, OpportunityItem[]>();
    for (const row of items.rows) {
      const list = itemsOf.get(Number(row.product_id)) ?? [];
      list.push({
        dayNo: row.day_no,
        seq: row.seq,
        startTime: row.start_time,
        endTime: row.end_time,
        mapX: row.mapx === null ? null : Number(row.mapx),
        mapY: row.mapy === null ? null : Number(row.mapy),
      });
      itemsOf.set(Number(row.product_id), list);
    }

    return watched.map((c) => ({
      ...c,
      missingLcls2: [...new Set(missingOf.get(c.productId) ?? [])],
      items: itemsOf.get(c.productId) ?? [],
    }));
  }

  /**
   * 알림 목록 (FR-MO-033 · 035).
   *
   * **계정을 대조한다.** `notification` 은 `product` 를 통해서만 계정에 매인다 —
   * 조인 조건을 빼면 남의 알림이 그대로 나간다 (PM-DA-002).
   *
   * 무시한 알림은 기본으로 빼되 `includeDismissed` 로 되돌려 볼 수 있게 둔다.
   * 지운 것이 아니라 접어 둔 것이기 때문이다.
   */
  async listFor(accountId: number, filter: NotificationFilter): Promise<NotificationPage> {
    const where = ['p.account_id = $1', "p.start_date + p.nights >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date"];
    const params: unknown[] = [accountId];
    if (filter.kind !== undefined) {
      params.push(filter.kind);
      where.push(`n.kind = $${params.length}`);
    }
    if (filter.unreadOnly) where.push('n.read_at IS NULL');
    if (!filter.includeDismissed) where.push('n.dismissed_at IS NULL');
    if (filter.productId !== undefined) {
      params.push(filter.productId);
      where.push(`n.product_id = $${params.length}`);
    }
    const clause = where.join(' AND ');

    const total = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM notification n
         JOIN product p ON p.id = n.product_id
        WHERE ${clause}`,
      params,
    );

    params.push(filter.size, filter.page * filter.size);
    const { rows } = await this.pool.query<NotificationRow>(
      `SELECT n.id, n.product_id, n.kind, n.match_condition, n.kto_content_id,
              n.change_hash_from, n.change_hash_to, n.body, n.read_at, n.dismissed_at,
              n.created_at, p.name AS product_name, p.start_date
         FROM notification n
         JOIN product p ON p.id = n.product_id
        WHERE ${clause}
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { total: Number(total.rows[0]?.n ?? 0), rows: rows.map(toStored) };
  }

  /** 한 건. 소유자가 아니면 `null` 이고 호출자가 404 를 만든다 (EX-SY-003) */
  async findFor(id: number, accountId: number): Promise<StoredNotification | null> {
    const { rows } = await this.pool.query<NotificationRow>(
      `SELECT n.id, n.product_id, n.kind, n.match_condition, n.kto_content_id,
              n.change_hash_from, n.change_hash_to, n.body, n.read_at, n.dismissed_at,
              n.created_at, p.name AS product_name, p.start_date
         FROM notification n
         JOIN product p ON p.id = n.product_id
        WHERE n.id = $1 AND p.account_id = $2`,
      [id, accountId],
    );
    const row = rows[0];
    return row === undefined ? null : toStored(row);
  }

  /**
   * 확인 처리 (FR-CM-005). **이미 읽은 것은 시각을 덮어쓰지 않는다** —
   * 처음 읽은 때가 기록이고, 목록을 다시 열 때마다 갱신되면 그 기록이 사라진다.
   */
  async markRead(id: number, accountId: number): Promise<Date | null> {
    const { rows } = await this.pool.query<{ read_at: Date }>(
      `UPDATE notification n
          SET read_at = COALESCE(n.read_at, now())
         FROM product p
        WHERE p.id = n.product_id AND n.id = $1 AND p.account_id = $2
        RETURNING n.read_at`,
      [id, accountId],
    );
    return rows[0]?.read_at ?? null;
  }

  /**
   * 무시 처리 (FR-MO-037).
   *
   * ⚠️ **비표출 전환 알림은 여기 오면 안 된다.** 무시 금지 판정은 서비스가 하고
   * 403 을 낸다 (PM-NG-010). 저장소는 소유권만 본다.
   */
  async dismiss(id: number, accountId: number): Promise<Date | null> {
    const { rows } = await this.pool.query<{ dismissed_at: Date }>(
      `UPDATE notification n
          SET dismissed_at = COALESCE(n.dismissed_at, now())
         FROM product p
        WHERE p.id = n.product_id AND n.id = $1 AND p.account_id = $2
        RETURNING n.dismissed_at`,
      [id, accountId],
    );
    return rows[0]?.dismissed_at ?? null;
  }

  /** 안 읽은 건수. 헤더 배지가 쓴다 (UI-CM-005) */
  async unreadCount(accountId: number): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM notification n
         JOIN product p ON p.id = n.product_id
        WHERE p.account_id = $1 AND n.read_at IS NULL AND n.dismissed_at IS NULL
          AND p.start_date + p.nights >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date`,
      [accountId],
    );
    return Number(rows[0]?.n ?? 0);
  }
}

export interface NotificationFilter {
  readonly kind?: NotificationKind;
  readonly unreadOnly: boolean;
  readonly includeDismissed: boolean;
  readonly productId?: number;
  readonly page: number;
  readonly size: number;
}

export interface StoredNotification {
  readonly id: number;
  readonly productId: number;
  readonly productName: string;
  readonly startDate: string;
  readonly kind: NotificationKind;
  readonly condition: MatchCondition;
  readonly ktoContentId: string | null;
  /** 조건 2 · 3 은 둘 다 null 이다 — 그 콘텐츠가 어느 일정에도 없어 지문 이력이 없다 */
  readonly hashFrom: string | null;
  readonly hashTo: string | null;
  readonly body: Readonly<Record<string, unknown>>;
  readonly readAt: Date | null;
  readonly dismissedAt: Date | null;
  readonly createdAt: Date;
}

export interface NotificationPage {
  readonly total: number;
  readonly rows: readonly StoredNotification[];
}

interface NotificationRow {
  id: string;
  product_id: string;
  kind: string;
  match_condition: number;
  kto_content_id: string | null;
  change_hash_from: string | null;
  change_hash_to: string | null;
  body: Record<string, unknown>;
  read_at: Date | null;
  dismissed_at: Date | null;
  created_at: Date;
  product_name: string;
  start_date: Date | string;
}

function toStored(row: NotificationRow): StoredNotification {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    productName: row.product_name,
    startDate: toIsoDate(row.start_date),
    kind: row.kind as NotificationKind,
    condition: Number(row.match_condition) as MatchCondition,
    ktoContentId: row.kto_content_id,
    hashFrom: row.change_hash_from,
    hashTo: row.change_hash_to,
    body: row.body,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
    createdAt: row.created_at,
  };
}

interface CandidateRow {
  id: string;
  start_date: Date | string;
  nights: number;
  ldong_regn_cd: string;
  ldong_signgu_cd: string | null;
}

function toCandidate(row: CandidateRow): ImpactCandidate {
  return {
    productId: Number(row.id),
    startDate: toIsoDate(row.start_date),
    nights: row.nights,
    ldongRegnCd: row.ldong_regn_cd,
    ldongSignguCd: row.ldong_signgu_cd,
  };
}

/** `DATE` 는 드라이버 설정에 따라 `Date` 로도 문자열로도 온다. 한국 시간 기준이다 */
function toIsoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10);
}
