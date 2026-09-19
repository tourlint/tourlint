import { Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Pool } from 'pg';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { SessionAccount } from '../auth/session.repository';
import { DomainException } from '../common/domain.exception';
import { DB_POOL } from '../persistence/db';
import { reseedDemoProducts } from '../seed/demo-seed';

/**
 * 데모 데이터 복원 (PM-TA-003). mock 의 demo/reset 을 대체한다 (NF-CO-002).
 *
 * 데모 계정만 자기 상품을 초기 상태로 되돌린다 — 일반 계정이 부르면 막는다 (PM-TA). 요청자
 * 계정의 상품만 다시 시드하므로 다른 계정 데이터는 건드리지 않는다.
 */
@Controller('api/v1/demo')
export class DemoController {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /*
   * `/docs` 에 싣지 않는다. 심사위원이 함께 쓰는 테스트 계정이 데모 계정이라, 문서에서 Try it out 을
   * 한 번 누르면 모두가 보던 상품이 지워진다. 문서 소개글에 뺀 까닭을 적었다 (#601)
   */
  @ApiExcludeEndpoint()
  @Post('reset')
  @HttpCode(HttpStatus.OK)
  async reset(@CurrentAccount() account: SessionAccount): Promise<{ reset: true; products: number }> {
    if (!account.isDemo) {
      throw new DomainException(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN_ACTION',
        '데모 계정만 데모 데이터를 복원할 수 있습니다.',
      );
    }
    const products = await reseedDemoProducts(this.pool, account.accountId);
    return { reset: true, products };
  }
}
