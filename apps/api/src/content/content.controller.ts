import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ContentService } from './content.service';

/**
 * 관광지 1건 실시간 조회. mock 을 대체한 실엔진 (NF-CO-002).
 *
 * `contentTypeId` 를 주면 공통정보·소개정보를 나란히 낸다. 없으면 공통정보로 유형을 먼저
 * 읽어야 해서 순차가 된다 — 콜 수는 둘 다 2다 (5-12).
 *
 * `with=accessible,pet` 은 기획 화면 카드 펼침이 쓰는 조건 축이다. 요청한 축마다 1콜이 더 붙고,
 * 안 주면 지금까지와 같다 (FR-PL-012 · API 4-10).
 */
@Controller('api/v1')
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get('contents/:contentId')
  async detail(
    @Param('contentId') contentId: string,
    @Query('contentTypeId') contentTypeId?: string,
    @Query('with') withAxes?: string,
  ): Promise<Record<string, unknown>> {
    const id = contentId.trim();
    if (id === '') throw new BadRequestException('콘텐츠 번호가 필요합니다.');
    return this.content.detail(id, contentTypeId, readWith(withAxes));
  }
}

/** `with=accessible,pet`. 모르는 축은 조용히 무시하지 않고 튕긴다 */
function readWith(raw: string | undefined): { accessible: boolean; pet: boolean } | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const axes = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const unknown = axes.filter((a) => a !== 'accessible' && a !== 'pet');
  if (unknown.length > 0) throw new BadRequestException('with 는 accessible · pet 만 받습니다.');
  return { accessible: axes.includes('accessible'), pet: axes.includes('pet') };
}
