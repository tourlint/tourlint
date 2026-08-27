import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { SessionAccount } from '../auth/session.repository';
import type { CreateProductDto, UpdateProductDto } from './product.dto';
import { ProductService } from './product.service';

/**
 * 상품 CRUD (F01 · API 설계 5-1/5-2). mock 의 products 라우트를 대체한다 (NF-CO-002).
 *
 * 인증 필요 — 전역 가드가 막는다. 목록·조회·수정·삭제는 요청 계정의 상품만 다룬다.
 */
@ApiTags('실엔진')
@Controller('api/v1/products')
export class ProductController {
  constructor(private readonly service: ProductService) {}

  @Post()
  @HttpCode(201)
  async create(
    @CurrentAccount() account: SessionAccount,
    @Body() body: CreateProductDto,
  ): Promise<Record<string, unknown>> {
    return { ...(await this.service.create(account.accountId, body)) };
  }

  @Get()
  async list(
    @CurrentAccount() account: SessionAccount,
    @Query('page') page = '0',
    @Query('size') size = '20',
  ): Promise<Record<string, unknown>> {
    return this.service.list(account.accountId, clamp(page, 0), clamp(size, 20, 100));
  }

  @Get(':productId')
  async detail(
    @CurrentAccount() account: SessionAccount,
    @Param('productId', ParseIntPipe) productId: number,
  ): Promise<Record<string, unknown>> {
    return this.service.detail(account.accountId, productId);
  }

  @Patch(':productId')
  async update(
    @CurrentAccount() account: SessionAccount,
    @Param('productId', ParseIntPipe) productId: number,
    @Body() body: UpdateProductDto,
  ): Promise<Record<string, unknown>> {
    return { ...(await this.service.update(account.accountId, productId, body)) };
  }

  @Delete(':productId')
  @HttpCode(204)
  async remove(
    @CurrentAccount() account: SessionAccount,
    @Param('productId', ParseIntPipe) productId: number,
  ): Promise<void> {
    await this.service.remove(account.accountId, productId);
  }
}

/** 페이지·크기는 음수·과대값을 막는다. 크기 상한은 목록 폭주를 막기 위한 것 */
function clamp(raw: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}
