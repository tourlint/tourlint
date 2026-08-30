import { BadRequestException, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { SessionAccount } from '../auth/session.repository';
import type { NotificationKind } from '../batch/impact-finder';
import { NotificationService } from './notification.service';

/**
 * 알림 조회 (F13 · API 설계 4-8).
 *
 * 세 경로 다 소유자 전용이다. `AuthGuard` 가 전역이라 로그인은 강제되고, 계정 대조는
 * 저장소 SQL 이 `product.account_id` 조인으로 한다 (PM-DA-002).
 */
@ApiTags('실엔진')
@Controller('api/v1')
export class NotificationController {
  constructor(private readonly service: NotificationService) {}

  /** 목록. `kind=RISK|OPPORTUNITY` · `unread=true` (FR-MO-035) */
  @Get('notifications')
  async list(
    @CurrentAccount() account: SessionAccount,
    @Query('kind') kind?: string,
    @Query('unread') unread?: string,
    @Query('includeDismissed') includeDismissed?: string,
    @Query('productId') productId?: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ): Promise<Record<string, unknown>> {
    return this.service.list(account.accountId, {
      kind: parseKind(kind),
      unreadOnly: unread === 'true',
      includeDismissed: includeDismissed === 'true',
      productId: parseId(productId, 'productId'),
      page: parsePage(page),
      size: parseSize(size),
    });
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  async read(
    @CurrentAccount() account: SessionAccount,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Record<string, unknown>> {
    return this.service.markRead(id, account.accountId);
  }

  /** 무시. 비표출 전환 알림이면 403 `FORBIDDEN_ACTION` (FR-MO-037 · PM-NG-010) */
  @Post('notifications/:id/dismiss')
  @HttpCode(200)
  async dismiss(
    @CurrentAccount() account: SessionAccount,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Record<string, unknown>> {
    return this.service.dismiss(id, account.accountId);
  }
}

/*
 * 요청 형식 오류는 `BadRequestException` 을 그대로 쓴다. 사유코드 39종에 요청 형식용
 * 코드가 없고, 없는 코드를 지어내지 않는다 (`audit.controller.ts` 와 같은 판단).
 */
function parseKind(raw?: string): NotificationKind | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw !== 'RISK' && raw !== 'OPPORTUNITY') {
    throw new BadRequestException('kind 는 RISK 또는 OPPORTUNITY 여야 합니다.');
  }
  return raw;
}

function parseId(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestException(`${field} 가 올바르지 않습니다.`);
  return n;
}

const MAX_SIZE = 100;

function parsePage(raw?: string): number {
  const n = raw === undefined || raw === '' ? 0 : Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new BadRequestException('page 는 0 이상 정수여야 합니다.');
  return n;
}

function parseSize(raw?: string): number {
  const n = raw === undefined || raw === '' ? 20 : Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_SIZE) {
    throw new BadRequestException(`size 는 1 이상 ${MAX_SIZE} 이하 정수여야 합니다.`);
  }
  return n;
}
