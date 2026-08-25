import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CatalogService, type CodeItem } from './catalog.service';

/**
 * 지역·분류 코드 (F01 등록 화면). mock 을 대체한 실엔진 — 공사 코드 조회를 프록시한다.
 *
 * 인증이 필요하다(@Public 아님) — 등록 화면은 로그인 뒤에서만 연다. 브라우저는 세션 쿠키와
 * 함께 같은 오리진 `/api/*` 로 부른다.
 */
@ApiTags('실엔진')
@Controller('api/v1')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /**
   * 지역 코드. `regnCd` 없으면 시도, 있으면 그 시도의 시군구.
   * 응답은 `{ items: [{ code, name }] }` (mock 계약과 동일).
   */
  @Get('ldong-codes')
  async regions(@Query('regnCd') regnCd?: string): Promise<{ items: CodeItem[] }> {
    const items =
      regnCd !== undefined && regnCd !== '' ? await this.catalog.signgus(regnCd) : await this.catalog.regions();
    return { items };
  }

  /** 분류(유형) 대분류 목록 */
  @Get('lcls-codes')
  async categories(): Promise<{ items: CodeItem[] }> {
    return { items: await this.catalog.categories() };
  }
}
