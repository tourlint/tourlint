import { Body, Controller, Delete, HttpCode, Param, ParseIntPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { SessionAccount } from '../auth/session.repository';
import { ProductService } from './product.service';

/**
 * 일정 항목 개별 CRUD (F01 · FR-IN-013/014). mock 의 항목 라우트를 대체한다 (NF-CO-002).
 *
 * 경로가 `products/:id/items` 와 `items/:itemId` 로 갈려 ProductController(=/products) 와
 * 따로 둔다. 소유권은 서비스가 item -> product -> account 로 스코프한다 (PM-DA-003).
 */
@ApiTags('실엔진')
@Controller('api/v1')
export class ItemController {
  constructor(private readonly service: ProductService) {}

  @Post('products/:productId/items')
  @HttpCode(201)
  async add(
    @CurrentAccount() account: SessionAccount,
    @Param('productId', ParseIntPipe) productId: number,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.service.addItem(account.accountId, productId, body);
  }

  @Put('products/:productId/items/order')
  async reorder(
    @CurrentAccount() account: SessionAccount,
    @Param('productId', ParseIntPipe) productId: number,
    @Body() body: unknown,
  ): Promise<{ productId: number; reordered: number }> {
    return this.service.reorderItems(account.accountId, productId, body);
  }

  @Patch('items/:itemId')
  async patch(
    @CurrentAccount() account: SessionAccount,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.service.patchItem(account.accountId, itemId, body);
  }

  @Delete('items/:itemId')
  @HttpCode(204)
  async remove(
    @CurrentAccount() account: SessionAccount,
    @Param('itemId', ParseIntPipe) itemId: number,
  ): Promise<void> {
    await this.service.removeItem(account.accountId, itemId);
  }
}
