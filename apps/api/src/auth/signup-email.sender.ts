import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'node:crypto';

const UNAVAILABLE = '인증메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.';

export function signupMailConfig(env: NodeJS.ProcessEnv = process.env): { url: string; secret: string } | null {
  const url = env.AUTH_MAIL_SCRIPT_URL?.trim() ?? '';
  const secret = env.AUTH_MAIL_SECRET?.trim() ?? '';
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)
      || !/^[a-f0-9]{64}$/.test(secret)) return null;
  return { url, secret };
}

/** 서버에서만 서명한다. Apps Script는 서명·시각·일회 요청을 검증한 뒤 고정 인증메일만 보낸다. */
@Injectable()
export class SignupEmailSender {
  requireConfigured(): void {
    if (signupMailConfig() === null) throw new ServiceUnavailableException(UNAVAILABLE);
  }

  async send(email: string, code: string, verificationId: string): Promise<void> {
    const config = signupMailConfig();
    if (config === null) throw new ServiceUnavailableException(UNAVAILABLE);
    const timestamp = Date.now();
    const signature = createHmac('sha256', config.secret)
      .update(JSON.stringify([1, verificationId, timestamp, email, code])).digest('hex');
    const signal = AbortSignal.timeout(30_000);
    try {
      let response = await fetch(config.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        redirect: 'manual', signal,
        body: JSON.stringify({ version: 1, verificationId, timestamp, email, code, signature }),
      });
      // ContentService는 결과 조회용 일회 URL로 리다이렉트한다. 서명 본문은 재전송하지 않는다.
      if (response.status === 302 || response.status === 303) {
        const location = response.headers.get('Location');
        await response.body?.cancel();
        const redirect = new URL(location ?? '');
        if (redirect.origin !== 'https://script.googleusercontent.com'
            || redirect.pathname !== '/macros/echo' || redirect.username || redirect.password) {
          throw new Error('unexpected mail redirect');
        }
        response = await fetch(redirect.href, { method: 'GET', redirect: 'error', signal });
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error('mail unavailable'); }
      const body = await response.json() as { ok?: unknown; verificationId?: unknown };
      if (body.ok !== true || body.verificationId !== verificationId) throw new Error('mail rejected');
    } catch {
      // 메일 주소·코드·서명·응답 원문을 오류나 로그로 보내지 않는다.
      throw new ServiceUnavailableException(UNAVAILABLE);
    }
  }
}
