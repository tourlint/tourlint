import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

// ── 명세 5장 JSON 예시를 그대로 사용한다 (손으로 지어내지 않음) ──
import productCreated from '../mocks/product_created.json';
import productList from '../mocks/product_list.json';
import contentsSearch from '../mocks/contents_search.json';
import itemMatch from '../mocks/item_match.json';

/**
 * W1 전용 mock 컨트롤러 — API 명세 v1.4 계약의 응답 형태를 그대로 반환한다.
 * 실제 로직은 W1~W3에서 도메인 모듈로 하나씩 교체하며, 교체된 엔드포인트는 여기서 제거한다.
 * ⚠️ FR-OP-009 · NF-CO-002: 공사 API 호출을 모의 응답으로 "전면 대체"하지 않는다. 이 목업은 개발 단계 한정.
 */
@ApiTags('mock')
@Controller('api/v1')
export class MockController {
  // ── 인증 (FR-CM-001~004) ── 실엔진(AuthController)으로 교체됨. mock 제거 (NF-CO-002)

  // ── 상품 (F01) ──
  @Get('products') listProducts(@Query('page') page = '0', @Query('size') size = '20') {
    return { ...productList, page: Number(page), size: Number(size) };
  }
  @Post('products') @HttpCode(201) createProduct(@Body() b: any) {
    const nights = Number(b?.nights ?? 0);
    return { ...productCreated, name: b?.name ?? productCreated.name, nights, dayCount: nights + 1 };
  }
  @Get('products/:productId') getProduct(@Param('productId') id: string) {
    return { ...(productList as any).content[0], productId: Number(id) };
  }
  @Patch('products/:productId') patchProduct(@Param('productId') id: string, @Body() b: any) { return { productId: Number(id), ...b }; }
  @Delete('products/:productId') @HttpCode(204) delProduct() { return; }
  @Post('products/:productId/release') release() { return { releasedAt: new Date().toISOString() }; }

  // ── 일정 항목 (F01) ──
  @Get('products/:productId/items') items() { return { items: [] }; }
  @Post('products/:productId/items') @HttpCode(201) addItem(@Body() b: any) { return { itemId: 101, ...b }; }
  @Patch('items/:itemId') patchItem(@Param('itemId') id: string, @Body() b: any) { return { itemId: Number(id), ...b }; }
  @Delete('items/:itemId') @HttpCode(204) delItem() { return; }
  @Put('products/:productId/items/order') reorder(@Body() b: any) { return { ok: true, ...b }; }

  // ── 관광지 매칭 (F02) ──
  @Get('contents/search') search(@Query('keyword') keyword = '') { return { ...contentsSearch, keyword }; }
  @Post('items/:itemId/match') match(@Param('itemId') id: string) { return { ...itemMatch, itemId: Number(id) }; }
  @Post('items/:itemId/exclude') exclude(@Param('itemId') id: string) { return { itemId: Number(id), matchStatus: 'EXCLUDED' }; }
  @Get('contents/:contentId') content(@Param('contentId') id: string) { return { contentId: id, fetchedAt: new Date().toISOString(), ktoRaw: {} }; }
  // ldong-codes · lcls-codes 는 실엔진(CatalogController)으로 교체됨. mock 제거 (NF-CO-002)

  // ── 패치 (F10 전후 비교만 남았다. F08 미리보기 · F09 확정 · 되돌리기는 실엔진이 가져갔다) ──

  // ── 리포트 (F11) ──
  @Post('audit-runs/:runId/reports') @HttpCode(202) report() { return { reportId: 9001, status: 'QUEUED' }; }

  // ── 레이더 (F12~F14) ──
  @Get('radar/summary') radarSummary() { return { risk: 0, opportunity: 0, lastBatchAt: null, lastCovered: null }; }
  @Get('radar/changes') radarChanges() { return { content: [], page: 0, size: 20, totalElements: 0 }; }
  @Get('radar/signals') radarSignals() { return { t1: { count: 0, byType: {} }, t2: { count: 0, byType: {} } }; }
  @Get('notifications') notifications() { return { content: [], page: 0, size: 20, totalElements: 0 }; }
  @Post('notifications/:id/read') readNoti(@Param('id') id: string) { return { id: Number(id), readAt: new Date().toISOString() }; }
  @Post('notifications/:id/dismiss') dismissNoti(@Param('id') id: string) { return { id: Number(id), dismissedAt: new Date().toISOString() }; }

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

  // ── 데모 복원 (PM-TA-003 · DR-TD-007) ──
  @Post('demo/reset') resetDemo() { return { reset: true, seededAt: new Date().toISOString() }; }
}
