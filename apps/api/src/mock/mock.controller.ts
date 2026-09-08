import { Controller, Get, Post } from '@nestjs/common';
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
  // 항목 추가·수정·삭제·순서변경은 ItemController(실엔진)로 교체됨 (FR-IN-013/014)

  // ── 관광지 매칭 (F02) ── 검색·확정·제외는 실엔진(PlaceMatchController)으로 교체됨. mock 제거 (NF-CO-002)
  // contents/:contentId 는 실엔진(ContentController)으로 교체됨. mock 제거 (NF-CO-002)
  // ldong-codes · lcls-codes 도 마찬가지 (CatalogController)

  // ── 패치 (F10 전후 비교만 남았다. F08 미리보기 · F09 확정 · 되돌리기는 실엔진이 가져갔다) ──

  // ── 리포트 (F11) ── 실엔진(ReportController)으로 교체됨. mock 제거 (NF-CO-002)

  // ── 레이더 (F12~F14) ── 전부 실엔진(RadarController · NotificationController)으로 교체됨 (NF-CO-002)

  // ── 운영 (F15·F16) ──
  // settings 계열은 SettingsController(실엔진)로 교체됨

  // ── 데모 복원 (PM-TA-003) ── 실엔진(DemoController)으로 교체됨. mock 제거 (NF-CO-002)
}
