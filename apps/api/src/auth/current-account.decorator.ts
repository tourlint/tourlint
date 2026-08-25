import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionAccount } from './session.repository';

/**
 * 가드가 요청에 붙여 둔 로그인 계정. 가드를 통과한 라우트에서만 값이 보장된다.
 */
export interface RequestWithAccount extends Request {
  account?: SessionAccount;
}

export const CurrentAccount = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionAccount => {
    const req = ctx.switchToHttp().getRequest<RequestWithAccount>();
    if (req.account === undefined) {
      // 가드를 통과했다면 도달할 수 없다. 도달했다면 배선이 잘못된 것이라 조용히 넘기지 않는다.
      throw new Error('CurrentAccount 는 인증 가드 뒤에서만 쓸 수 있다');
    }
    return req.account;
  },
);
