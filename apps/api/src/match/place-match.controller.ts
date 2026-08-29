import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { SessionAccount } from '../auth/session.repository';
import { PlaceMatchService } from './place-match.service';

/**
 * 관광지 확정(매칭) (F02 · API 설계 5-3). mock 의 검색·확정·제외 라우트를 대체한다 (NF-CO-002).
 *
 * 검색은 로그인만 있으면 되고(공사 프록시), 확정·제외는 요청 계정의 항목만 다룬다.
 */
@ApiTags('실엔진')
@Controller('api/v1')
export class PlaceMatchController {
  constructor(private readonly service: PlaceMatchService) {}

  @Get('contents/search')
  async search(
    @Query('keyword') keyword = '',
    @Query('regnCd') regnCd?: string,
    @Query('signguCd') signguCd?: string,
    @Query('page') page = '0',
    @Query('size') size = '20',
  ): Promise<Record<string, unknown>> {
    return this.service.search({
      keyword,
      regnCd: regnCd === '' ? undefined : regnCd,
      signguCd: signguCd === '' ? undefined : signguCd,
      page: toInt(page, 0),
      size: toInt(size, 20),
    });
  }

  @Post('items/:itemId/match')
  @HttpCode(200)
  async match(
    @CurrentAccount() account: SessionAccount,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() body: { contentid?: unknown } | undefined,
  ): Promise<Record<string, unknown>> {
    const contentId = typeof body?.contentid === 'string' ? body.contentid : '';
    return this.service.match(account.accountId, itemId, contentId);
  }

  @Post('items/:itemId/exclude')
  @HttpCode(200)
  async exclude(
    @CurrentAccount() account: SessionAccount,
    @Param('itemId', ParseIntPipe) itemId: number,
  ): Promise<Record<string, unknown>> {
    return this.service.exclude(account.accountId, itemId);
  }
}

function toInt(raw: string, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
