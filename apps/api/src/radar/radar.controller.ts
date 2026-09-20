import { BadRequestException, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { SessionAccount } from '../auth/session.repository';
import { RadarService } from './radar.service';

/**
 * 수요 · 변경 레이더 (F12 ~ F14 · API 설계 4-8).
 *
 * 조회 경로는 저장된 값만 읽는다 — 공사 호출이 0건이다. T1 · T2 · T3 는 배치가 미리 산출하고,
 * 배치가 꺼진 기간에만 `region-signals/refresh` 가 사용자 요청으로 산출한다.
 */
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

  /**
   * 수요 신호의 「무엇인지」 (#644).
   *
   * 건수를 낸 것과 같은 조회 · 같은 조건으로 그 기간의 목록을 조달한다. 이름은 저장하지
   * 않으므로 여기서만 나간다 (DR-PR-001). 예산이 다 찼으면 목록 없이 이유를 준다.
   */
  @Get('radar/signals/detail')
  async signalDetail(
    @CurrentAccount() account: SessionAccount,
    @Query('productId') productId?: string,
    @Query('type') type?: string,
  ): Promise<Record<string, unknown>> {
    const id = Number(productId);
    if (productId === undefined || !Number.isInteger(id) || id <= 0) {
      throw new BadRequestException('productId 가 필요합니다.');
    }
    if (type !== 'T1' && type !== 'T2') {
      throw new BadRequestException('type 은 T1 또는 T2 입니다.');
    }
    return this.service.signalDetailOf(account.accountId, id, type);
  }

  /**
   * 관심 지역 카드의 「무엇인지」 (#650).
   *
   * 요청 계정의 관심 지역만 답한다 — 아무 지역이나 열어 주면 남의 관심사를 떠보는 통로가 된다.
   */
  @Get('radar/region-signals/detail')
  async regionSignalDetail(
    @CurrentAccount() account: SessionAccount,
    @Query('regnCd') regnCd?: string,
    @Query('signguCd') signguCd?: string,
    @Query('month') month?: string,
    @Query('type') type?: string,
  ): Promise<Record<string, unknown>> {
    if (regnCd === undefined || regnCd === '') throw new BadRequestException('regnCd 가 필요합니다.');
    if (month === undefined || !/^\d{4}-\d{2}$/.test(month)) {
      throw new BadRequestException('month 는 YYYY-MM 형식입니다.');
    }
    if (type !== 'T1' && type !== 'T2') throw new BadRequestException('type 은 T1 또는 T2 입니다.');
    return this.service.regionSignalDetailOf(
      account.accountId,
      { regnCd, signguCd: signguCd === undefined || signguCd === '' ? null : signguCd },
      month,
      type,
    );
  }

  /** 관심 지역 새 소식 — 관심 지역(시군구 + 달)마다 T1 · T2 · T3 (FR-MO-059 · 060) */
  @Get('radar/region-signals')
  async regionSignals(@CurrentAccount() account: SessionAccount): Promise<readonly Record<string, unknown>[]> {
    return this.service.regionSignals(account.accountId);
  }

  /** 관심 지역 신호를 지금 산출. 배치가 꺼진 기간에만 쓴다 (API 4-8) */
  @Post('radar/region-signals/refresh')
  @HttpCode(200)
  async refreshRegionSignals(@CurrentAccount() account: SessionAccount): Promise<readonly Record<string, unknown>[]> {
    return this.service.refreshRegionSignals(account.accountId);
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
