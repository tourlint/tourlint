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
import { isDismissable, notificationCopy } from './notification-copy';

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
    if (this.names === undefined) return new Map();
    const ids = rows.filter((n) => !hiddenOf(n) && n.ktoContentId !== null && n.ktoContentId !== '')
      .map((n) => n.ktoContentId as string);
    if (ids.length === 0) return new Map();
    let timer: NodeJS.Timeout | undefined;
    try {
      const late = new Promise<null>((done) => {
        timer = setTimeout(() => { done(null); }, this.nameBudgetMs);
      });
      const names = this.names.resolve(ids);
      // 한도를 넘긴 뒤 실패해도 처리되지 않은 거절로 남지 않게 한다
      names.catch(() => undefined);
      const settled = await Promise.race([names, late]);
      if (settled === null) {
        this.logger.warn(`알림 ${String(ids.length)}건의 이름이 ${String(this.nameBudgetMs)}ms 안에 안 왔다. 이름 없이 내보낸다`);
        return new Map();
      }
      return settled;
    } catch (e) {
      // 콘텐츠 id 와 사유만 남긴다. 응답 본문은 남기지 않는다 (DB 명세서 6-4)
      this.logger.warn(`알림 ${String(ids.length)}건의 이름을 못 읽었다: ${(e as Error).message}`);
      return new Map();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
  const copy = notificationCopy(n.condition, hidden);
  return {
    notificationId: n.id,
    kind: n.kind,
    condition: n.condition,
    productId: n.productId,
    productName: n.productName,
    startDate: n.startDate,
    ktoContentId: n.ktoContentId,
    // 표시 시점에 읽은 이름. 못 읽었거나 표출이 중단된 곳은 null 이다
    placeName: hidden || n.ktoContentId === null ? null : (names.get(n.ktoContentId) ?? null),
    what: copy.what,
    impact: copy.impact,
    action: copy.action,
    hidden,
    // FR-MO-058 — 지문 비교값. 조건 2·3 은 지문 이력이 없어 둘 다 null 이다
    fingerprint: { from: n.hashFrom, to: n.hashTo },
    /*
     * FR-MO-037 · PM-NG-010 — 무시할 수 있는지를 화면이 미리 알아야 버튼을 감출 수 있다.
     * 눌러 보고 403 을 받는 것은 화면이 규정을 모른다는 뜻이다.
     */
    dismissable: isDismissable(hidden),
    readAt: n.readAt === null ? null : kstIso(n.readAt),
    dismissedAt: n.dismissedAt === null ? null : kstIso(n.dismissedAt),
    createdAt: kstIso(n.createdAt),
  };
}

/** 남의 것도 없는 것도 똑같이 404 다 (EX-SY-003 · PM-DA-003) */
function notFound(): DomainException {
  return new DomainException(
    HttpStatus.NOT_FOUND, 'NOT_FOUND', '알림을 찾을 수 없습니다. 목록을 새로 고쳐 주세요.',
  );
}
