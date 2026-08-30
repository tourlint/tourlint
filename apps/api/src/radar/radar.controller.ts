import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { SessionAccount } from '../auth/session.repository';
import { RadarService } from './radar.service';

/**
 * 수요 · 변경 레이더 (F12 ~ F14 · API 설계 4-8).
 *
 * 세 경로 다 저장된 값만 읽는다 — 공사 호출이 0건이다. T1 · T2 는 배치가 미리 산출한다.
 */
@ApiTags('실엔진')
@Controller('api/v1')
export class RadarController {
  constructor(private readonly service: RadarService) {}

  @Get('radar/summary')
  async summary(@CurrentAccount() account: SessionAccount): Promise<Record<string, unknown>> {
    return this.service.summary(account.accountId);
  }

  @Get('radar/changes')
  async changes(
    @CurrentAccount() account: SessionAccount,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ): Promise<Record<string, unknown>> {
    return this.service.changes(account.accountId, parsePage(page), parseSize(size));
  }

  /**
   * 수요 신호. **상품 하나에 대해서만 답한다.**
   *
   * T2 의 조회 창이 그 상품의 여행일에서 나오기 때문이다 (`t2Window`). 상품 없이 부르면
   * 어느 기간의 행사를 세야 하는지 정할 수 없다.
   */
  @Get('radar/signals')
  async signals(
    @CurrentAccount() account: SessionAccount,
    @Query('productId') productId?: string,
  ): Promise<Record<string, unknown>> {
    const id = Number(productId);
    if (productId === undefined || !Number.isInteger(id) || id <= 0) {
      throw new BadRequestException('productId 가 필요합니다.');
    }
    return this.service.signalsOf(account.accountId, id);
  }
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
