import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { readBriefingQuery, readPlacesQuery, readRegionQuery, type RawBriefingQuery, type RawPlacesQuery } from './plan.dto';
import { PlanService } from './plan.service';

/**
 * 상품 기획 (F17 · API 4-10).
 *
 * 조회만 한다 — 상품 · 항목을 바꾸는 것은 기존 API 다. 응답에 판정 · 등급 · 규칙 번호가 없다
 * (FR-PL-021).
 */
@ApiTags('실엔진')
@Controller('api/v1/plan')
export class PlanController {
  constructor(private readonly service: PlanService) {}

  /** 종류 칩 첫째 줄과 지역 요약. 지역이 바뀔 때만 부른다 (FR-PL-010) */
  @Get('briefing')
  async briefing(@Query() query: RawBriefingQuery): Promise<Record<string, unknown>> {
    return { ...(await this.service.briefing(readBriefingQuery(query))) };
  }

  /** 장소 목록 — 시군구 전체 또는 넣을 위치 근처 3km (FR-PL-010 · 011) */
  @Get('places')
  async places(@Query() query: RawPlacesQuery): Promise<Record<string, unknown>> {
    return { ...(await this.service.places(readPlacesQuery(query))) };
  }

  /** 여행 기간 앞뒤 3일에 열리는 축제 · 공연 (FR-PL-014) */
  @Get('events')
  async events(@Query() query: RawBriefingQuery): Promise<Record<string, unknown>> {
    return { ...(await this.service.events(readBriefingQuery(query))) };
  }

  /** 걷기 길 — 넣으면 직접 정한 곳이 된다 (FR-PL-015) */
  @Get('walks')
  async walks(@Query() query: { regnCd?: string; signguCd?: string }): Promise<Record<string, unknown>> {
    return { ...(await this.service.walks(readRegionQuery(query))) };
  }
}
