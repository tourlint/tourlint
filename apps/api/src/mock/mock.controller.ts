import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

/**
 * W1 전용 mock 컨트롤러 — API 명세 v1.4 계약의 응답 형태를 그대로 반환한다.
 * 실제 로직은 W1~W3에서 도메인 모듈로 하나씩 교체하며, 교체된 엔드포인트는 여기서 제거한다.
 * ⚠️ FR-OP-009 · NF-CO-002: 공사 API 호출을 모의 응답으로 "전면 대체"하지 않는다. 이 목업은 개발 단계 한정.
 */
@ApiTags('mock')
@Controller('api/v1')
export class MockController {
  // ── 인증 (FR-CM-001~004) ── 실엔진(AuthController)으로 교체됨. mock 제거 (NF-CO-002)

  // ── 상품 (F01) ── 목록·생성·조회·수정·삭제는 실엔진(ProductController)으로 교체됨. mock 제거 (NF-CO-002)
  @Post('products/:productId/release') release() { return { releasedAt: new Date().toISOString() }; }

  // ── 일정 항목 (F01) ── 개별 항목 CRUD·순서변경은 후속(등록은 상품 생성에 포함) ──
  @Get('products/:productId/items') items() { return { items: [] }; }
  @Post('products/:productId/items') @HttpCode(201) addItem(@Body() b: any) { return { itemId: 101, ...b }; }
  @Patch('items/:itemId') patchItem(@Param('itemId') id: string, @Body() b: any) { return { itemId: Number(id), ...b }; }
  @Delete('items/:itemId') @HttpCode(204) delItem() { return; }
  @Put('products/:productId/items/order') reorder(@Body() b: any) { return { ok: true, ...b }; }

  // ── 관광지 매칭 (F02) ── 검색·확정·제외는 실엔진(PlaceMatchController)으로 교체됨. mock 제거 (NF-CO-002)
  @Get('contents/:contentId') content(@Param('contentId') id: string) { return { contentId: id, fetchedAt: new Date().toISOString(), ktoRaw: {} }; }
  // ldong-codes · lcls-codes 는 실엔진(CatalogController)으로 교체됨. mock 제거 (NF-CO-002)

  // ── 패치 (F10 전후 비교만 남았다. F08 미리보기 · F09 확정 · 되돌리기는 실엔진이 가져갔다) ──

  // ── 리포트 (F11) ── 실엔진(ReportController)으로 교체됨. mock 제거 (NF-CO-002)

  // ── 레이더 (F12~F14) ──
  @Get('radar/summary') radarSummary() { return { risk: 0, opportunity: 0, lastBatchAt: null, lastCovered: null }; }
  @Get('radar/changes') radarChanges() { return { content: [], page: 0, size: 20, totalElements: 0 }; }
  // 알림 3종은 실엔진(NotificationController)으로 교체됨. mock 제거 (NF-CO-002)
  @Get('radar/signals') radarSignals() { return { t1: { count: 0, byType: {} }, t2: { count: 0, byType: {} } }; }

  // ── 운영 (F15·F16) ──
  @Get('settings') settings() {
    return {
      weights: { BLOCKER: 25, ERROR: 10, WARNING: 4, UNVERIFIED: 3 },
      r07SpanHours: 6, r07MealMinutes: 60, r04Threshold: 3,
      watchKeywords: [],
      global: { batchTime: '05:00', batchEnabled: false, dailyQuota: 800, scope: '서비스 전체 기준' },
    };
  }
  @Put('settings') putSettings(@Body() b: any) { return { ...this.settings(), ...b }; }

  // ── 데모 복원 (PM-TA-003) ── 실엔진(DemoController)으로 교체됨. mock 제거 (NF-CO-002)
}
