import { BadRequestException, Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { SessionAccount } from '../auth/session.repository';
import { PlaceSuggestionService } from './place-suggestion.service';

/**
 * 기획 에이전트 (F18 · API 4-11).
 *
 * 사람이 \[AI로 한 번에 찾기\]를 누를 때만 돈다. 제안만 하고 항목을 바꾸지 않는다 —
 * 고르는 것은 \[이곳으로 선택\](`POST items/{id}/match`)이다 (FR-AG-012).
 */
@ApiTags('실엔진')
@Controller('api/v1/products')
export class PlaceSuggestionController {
  constructor(private readonly service: PlaceSuggestionService) {}

  @Post(':productId/place-suggestions')
  @HttpCode(200)
  async suggest(
    @CurrentAccount() account: SessionAccount,
    @Param('productId') productId: string,
    @Body() body: { itemIds?: unknown } | undefined,
  ): Promise<Record<string, unknown>> {
    const id = Number(productId);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('productId 가 올바르지 않습니다.');
    return { ...(await this.service.suggest(account.accountId, id, readItemIds(body?.itemIds))) };
  }
}

/** 없으면 고르지 않은 줄 전부다. 모양이 아니면 조용히 전부로 바꾸지 않고 튕긴다 */
function readItemIds(value: unknown): readonly number[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((v) => !Number.isInteger(v) || (v as number) <= 0)) {
    throw new BadRequestException('itemIds 는 항목 번호 목록이어야 합니다.');
  }
  return value as number[];
}
