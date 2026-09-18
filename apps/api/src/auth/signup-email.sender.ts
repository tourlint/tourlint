import { Injectable, ServiceUnavailableException } from '@nestjs/common';

const UNAVAILABLE = '인증메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.';

/** 발신 도메인 인증은 Resend에서 완료해야 한다. 키·코드·응답 원문은 로그에 남기지 않는다. */
@Injectable()
export class SignupEmailSender {
  requireConfigured(): void {
    if (!process.env.RESEND_API_KEY?.trim() || !process.env.AUTH_EMAIL_FROM?.trim()) {
      throw new ServiceUnavailableException(UNAVAILABLE);
    }
  }

  async send(email: string, code: string, verificationId: string): Promise<void> {
    this.requireConfigured();
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `signup/${verificationId}`,
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          from: process.env.AUTH_EMAIL_FROM,
          to: [email],
          subject: '[TourLint] 회원가입 이메일 인증코드',
          text: `TourLint 회원가입 인증코드는 ${code} 입니다.\n\n10분 안에 가입 화면에 입력해 주세요.\n이 코드를 다른 사람에게 알려주지 마세요.\n직접 요청하지 않았다면 이 메일을 무시하셔도 됩니다.`,
        }),
      });
      // 응답 본문은 보관하거나 오류에 붙이지 않는다.
      await response.body?.cancel();
      if (!response.ok) throw new Error('mail rejected');
    } catch {
      throw new ServiceUnavailableException(UNAVAILABLE);
    }
  }
}
