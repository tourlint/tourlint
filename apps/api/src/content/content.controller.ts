import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ContentService } from './content.service';

/**
 * 관광지 1건 실시간 조회. mock 을 대체한 실엔진 (NF-CO-002).
 *
 * `contentTypeId` 를 주면 공통정보·소개정보를 나란히 낸다. 없으면 공통정보로 유형을 먼저
 * 읽어야 해서 순차가 된다 — 콜 수는 둘 다 2다 (5-12).
 */
@ApiTags('실엔진')
@Controller('api/v1')
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get('contents/:contentId')
  async detail(
    @Param('contentId') contentId: string,
    @Query('contentTypeId') contentTypeId?: string,
  ): Promise<Record<string, unknown>> {
    const id = contentId.trim();
    if (id === '') throw new BadRequestException('콘텐츠 번호가 필요합니다.');
    return this.content.detail(id, contentTypeId);
  }
}
