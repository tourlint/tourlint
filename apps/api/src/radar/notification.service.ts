import { HttpStatus, Inject, Injectable } from '@nestjs/common';
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
@Injectable()
export class NotificationService {
  private readonly repo: NotificationRepository;

  constructor(@Inject(DB_POOL) pool: Pool) {
    this.repo = new NotificationRepository(pool);
  }

  async list(accountId: number, filter: NotificationFilter): Promise<Record<string, unknown>> {
    const page = await this.repo.listFor(accountId, filter);
    return {
      content: page.rows.map(toResponse),
      page: filter.page,
      size: filter.size,
      totalElements: page.total,
      unreadCount: await this.repo.unreadCount(accountId),
    };
  }

  /** 확인 처리 (FR-CM-005) */
  async markRead(id: number, accountId: number): Promise<Record<string, unknown>> {
    const readAt = await this.repo.markRead(id, accountId);
    if (readAt === null) throw notFound();
    return { id, readAt: readAt.toISOString() };
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
    return { id, dismissedAt: dismissedAt.toISOString() };
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
function toResponse(n: StoredNotification): Record<string, unknown> {
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
    readAt: n.readAt === null ? null : n.readAt.toISOString(),
    dismissedAt: n.dismissedAt === null ? null : n.dismissedAt.toISOString(),
    createdAt: n.createdAt.toISOString(),
  };
}

/** 남의 것도 없는 것도 똑같이 404 다 (EX-SY-003 · PM-DA-003) */
function notFound(): DomainException {
  return new DomainException(
    HttpStatus.NOT_FOUND, 'NOT_FOUND', '알림을 찾을 수 없습니다. 목록을 새로 고쳐 주세요.',
  );
}
