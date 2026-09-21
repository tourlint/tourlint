import { kstIso } from '@tourlint/shared';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { DomainException } from '../common/domain.exception';
import { DB_POOL } from '../persistence/db';
import {
  NotificationRepository,
  type NotificationFilter,
  type StoredNotification,
} from '../persistence/notification.repository';
import { diffNormalized, readNormalized } from './change-diff';
import { isDismissable } from './notification-copy';
import { describeNotification, modifiedOn, overlapDays } from './notification-detail';

/**
 * 위험 · 기회 알림 조회 (F13 · FR-MO-033 ~ 037).
 *
 * 배치가 평일 05:00 KST 로 `notification` 을 쌓고 있는데 읽는 경로가 없어 화면이 늘
 * 비어 있었다. 여기가 그 자리다.
 *
 * **아무것도 새로 판정하지 않는다.** 조건 판정은 배치가 이미 끝냈고, 여기서는 저장된
 * 것을 계정 범위로 읽어 문구를 붙일 뿐이다.
 */
/**
 * 바뀐 곳의 이름을 **표시할 때** 읽는 길. `PlaceNameResolver` 가 이 모양이다.
 * 공사 원문은 저장하지 않으므로(DB 명세서 6-4) 알림에도 이름 컬럼이 없다.
 */
export interface PlaceNameSource {
  resolve(contentIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

/**
 * 이름 조회를 기다리는 한도 (#694).
 *
 * 2026-09-21 운영에서 공사 호출이 전부 시간 초과가 나던 12분 동안 이 목록이 30초 뒤 500 을
 * 돌려줘 레이더 화면이 통째로 안 떴다. 실패는 흘려보냈지만 **느린 것**은 막지 않았기 때문이다 —
 * 이름은 콘텐츠마다 순서대로 읽고, 호출 하나가 시간 초과 10초 × 재시도다.
 * 평소 한 건은 0.2 ~ 0.5초라 2.5초면 한 쪽의 서로 다른 콘텐츠 대여섯 개를 읽는다.
 */
export const NAME_BUDGET_MS = 2_500;

/** 이름을 동시에 읽는 수 (#697). 한 쪽은 많아야 20곳이라 6이면 1초 안팎이다 */
export const NAME_CONCURRENCY = 6;

@Injectable()
export class NotificationService {
  private readonly repo: NotificationRepository;
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(DB_POOL) pool: Pool,
    private readonly names?: PlaceNameSource,
    private readonly nameBudgetMs: number = NAME_BUDGET_MS,
  ) {
    this.repo = new NotificationRepository(pool);
  }

  async list(accountId: number, filter: NotificationFilter): Promise<Record<string, unknown>> {
    const page = await this.repo.listFor(accountId, filter);
    const names = await this.placeNames(page.rows);
    return {
      content: page.rows.map((n) => toResponse(n, names)),
      page: filter.page,
      size: filter.size,
      totalElements: page.total,
      unreadCount: await this.repo.unreadCount(accountId),
    };
  }

  /** 확인 처리 (FR-CM-005) */
  /**
   * 카드에 보일 이름 (UI-S7-003 · #685). 「행사 정보가 바뀌었습니다」만으로는 어느 행사인지 모른다.
   *
   * **표출이 중단된 곳은 묻지 않는다** — 명칭을 다시 내보내지 않는다 (FR-AU-071). 공사도 그
   * 콘텐츠를 더는 돌려주지 않는다.
   *
   * **못 읽어도, 늦어도 목록은 나간다.** 이름은 덧붙이는 값이다. 예산이 다 찼거나 공사가 느리다고
   * 알림 자체를 못 보면 안 된다 — 그때는 문장만 보인다. 한도를 넘긴 조회는 버리지 않고 뒤에서
   * 끝까지 돌게 둔다. 읽은 이름이 캐시에 남아 다음 요청에는 붙는다.
   */
  private async placeNames(rows: readonly StoredNotification[]): Promise<ReadonlyMap<string, string>> {
    const source = this.names;
    if (source === undefined) return new Map();
    // 사용자가 일정에 적어 둔 이름이 있으면 그것을 쓴다 — 공사를 부르지 않는다 (DB 명세서 4-5)
    const ids = [...new Set(rows
      .filter((n) => !hiddenOf(n) && n.ktoContentId !== null && n.ktoContentId !== '' && n.schedule?.placeLabel == null)
      .map((n) => n.ktoContentId as string))];
    if (ids.length === 0) return new Map();

    /*
     * **동시에 읽고, 한도에 걸리면 읽은 데까지 내보낸다** (#697). 순서대로 읽으면 한 건 0.2 ~ 0.3초라
     * 12곳에 3초가 걸려 한도를 넘고, 통째로 버리면 첫 화면에 이름이 하나도 안 붙는다.
     * 느린 한 곳 때문에 나머지를 버리지 않는다.
     */
    const found = new Map<string, string>();
    const queue = [...ids];
    let failure: string | null = null;
    const worker = async (): Promise<void> => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          const name = (await source.resolve([id])).get(id);
          if (name !== undefined) found.set(id, name);
        } catch (e) {
          failure = (e as Error).message;
        }
      }
    };
    const all = Promise.all(Array.from({ length: Math.min(NAME_CONCURRENCY, ids.length) }, worker));

    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'LATE'>((done) => {
      timer = setTimeout(() => { done('LATE'); }, this.nameBudgetMs);
    });
    const settled = await Promise.race([all, late]);
    if (timer !== undefined) clearTimeout(timer);

    if (settled === 'LATE') {
      this.logger.warn(
        `알림 이름 ${String(ids.length)}곳 중 ${String(found.size)}곳만 ${String(this.nameBudgetMs)}ms 안에 읽었다. 나머지는 이름 없이 내보낸다`,
      );
    } else if (failure !== null) {
      // 콘텐츠 수와 사유만 남긴다. 응답 본문은 남기지 않는다 (DB 명세서 6-4)
      this.logger.warn(`알림 이름을 일부 못 읽었다: ${String(failure)}`);
    }
    // 한도 뒤에도 일꾼은 계속 돌며 found 를 고친다. 지금까지 읽은 것만 떼어 돌려준다
    return new Map(found);
  }

  async markRead(id: number, accountId: number): Promise<Record<string, unknown>> {
    const readAt = await this.repo.markRead(id, accountId);
    if (readAt === null) throw notFound();
    return { id, readAt: kstIso(readAt) };
  }

  /**
   * 무시 처리 (FR-MO-037).
   *
   * **비표출 전환 알림은 거절한다** (PM-NG-010). 사용자가 지워 버리면 출시 불가 사유가
   * 화면에서 사라진다 — 차단 등급을 무시할 수 없는 것과 같은 이유다.
   */
  async dismiss(id: number, accountId: number): Promise<Record<string, unknown>> {
    const found = await this.repo.findFor(id, accountId);
    if (found === null) throw notFound();

    if (!isDismissable(hiddenOf(found))) {
      throw new DomainException(
        HttpStatus.FORBIDDEN, 'FORBIDDEN_ACTION',
        '표출이 중단된 관광지 알림은 무시할 수 없습니다. 출시 불가 사유이므로 '
        + '다른 관광지로 대체하거나 일정에서 빼 주세요.',
      );
    }

    const dismissedAt = await this.repo.dismiss(id, accountId);
    if (dismissedAt === null) throw notFound();
    return { id, dismissedAt: kstIso(dismissedAt) };
  }
}

/** `body.hidden` 은 배치가 `show_flag === '0'` 일 때 넣는다 */
function hiddenOf(n: StoredNotification): boolean {
  return n.body.hidden === true;
}

/**
 * 응답 한 줄 (FR-MO-033 · 058).
 *
 * 관광지명을 담지 않는다 — 공사 원문이라 저장하지도 내보내지도 않는다 (FR-MO-002).
 * 화면은 `ktoContentId` 로 자기 일정의 `placeLabel` 을 찾아 붙인다.
 */
function toResponse(n: StoredNotification, names: ReadonlyMap<string, string>): Record<string, unknown> {
  const hidden = hiddenOf(n);
  const eventPeriod = eventPeriodOf(n.body);
  const hasBefore = n.normalizedBefore !== null;
  const hasAfter = n.normalizedAfter !== null;
  const changes = hasBefore && hasAfter ? diffNormalized(n.normalizedBefore, n.normalizedAfter) : [];
  const overlap = overlapDays(n.startDate, n.nights, eventPeriod);
  const copy = describeNotification({
    condition: n.condition, hidden, schedule: n.schedule, changes, hasBefore, hasAfter,
    eventPeriod, overlapDays: overlap,
  });
  const resolved = n.ktoContentId === null ? null : (names.get(n.ktoContentId) ?? null);
  return {
    notificationId: n.id,
    kind: n.kind,
    condition: n.condition,
    productId: n.productId,
    productName: n.productName,
    startDate: n.startDate,
    ktoContentId: n.ktoContentId,
    // 사용자가 적은 이름이 먼저다. 일정에 없는 곳만 볼 때 읽은 이름을 쓴다. 표출이 중단된 곳은 null
    placeName: hidden ? null : (n.schedule?.placeLabel ?? resolved),
    // 그 곳이 일정에 든 줄 (UI-S7-003 「해당 일정」). 일정에 없는 곳이면 null
    schedule: n.schedule === null ? null : { dayNo: n.schedule.dayNo, startTime: n.schedule.startTime },
    // 판독 결과 전 → 후 (UI-S7-004). 견줄 검수가 둘 다 있을 때만 채운다
    changes,
    // 견줄 이전 검수가 없을 때 보일 지금 판독값. 행사(15)는 휴무일 · 운영시간으로 말하는 곳이 아니다
    current: !hasBefore && hasAfter && Number(n.body.contentTypeId) !== 15 ? readNormalized(n.normalizedAfter) : [],
    // 공사가 그 관광정보를 고친 날
    modifiedOn: modifiedOn(n.body.modifiedTime),
    eventPeriod,
    overlapDays: overlap,
    what: copy.what,
    impact: copy.impact,
    action: copy.action,
    hidden,
    // FR-MO-058 — 지문 비교값. 조건 2·3 은 지문 이력이 없어 둘 다 null 이다
    fingerprint: { from: n.hashFrom, to: n.hashTo },
    dismissable: isDismissable(hidden),
    readAt: n.readAt === null ? null : kstIso(n.readAt),
    dismissedAt: n.dismissedAt === null ? null : kstIso(n.dismissedAt),
    createdAt: kstIso(n.createdAt),
  };
}

/** `body.eventPeriod`. 배치가 #703 뒤로 남긴다 — 그 전 알림에는 없다 */
function eventPeriodOf(body: Readonly<Record<string, unknown>>): { start: string; end: string } | null {
  const p = body.eventPeriod;
  if (typeof p !== 'object' || p === null) return null;
  const { start, end } = p as { start?: unknown; end?: unknown };
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  return typeof start === 'string' && typeof end === 'string' && iso.test(start) && iso.test(end) ? { start, end } : null;
}

function notFound(): DomainException {
  return new DomainException(
    HttpStatus.NOT_FOUND, 'NOT_FOUND', '알림을 찾을 수 없습니다. 목록을 새로 고쳐 주세요.',
  );
}
