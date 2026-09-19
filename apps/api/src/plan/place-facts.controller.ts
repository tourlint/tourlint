import { BadRequestException, Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { SessionAccount } from '../auth/session.repository';
import { PlaceFactsService } from './place-facts.service';

/**
 * 장소 정보 한 줄 (F17 · API 4-10).
 *
 * 고른 직후 그 항목만 부른다. 저장 · 판정이 없어 여러 번 불러도 상품은 그대로다 (FR-PL-005).
 */
@Controller('api/v1/products')
export class PlaceFactsController {
  constructor(private readonly service: PlaceFactsService) {}

  @Post(':productId/place-facts')
  @HttpCode(200)
  async placeFacts(
    @CurrentAccount() account: SessionAccount,
    @Param('productId') productId: string,
    @Body() body: { itemIds?: unknown } | undefined,
  ): Promise<Record<string, unknown>> {
    const id = Number(productId);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('productId 가 올바르지 않습니다.');
    return { items: await this.service.factsOf(account.accountId, id, readItemIds(body?.itemIds)) };
  }
}

/** 없으면 고른 항목 전부다. 모양이 아니면 조용히 전부로 바꾸지 않고 튕긴다 */
function readItemIds(value: unknown): readonly number[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((v) => !Number.isInteger(v) || (v as number) <= 0)) {
    throw new BadRequestException('itemIds 는 항목 번호 목록이어야 합니다.');
  }
  return value as number[];
}
