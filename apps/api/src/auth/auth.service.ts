import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Pool } from 'pg';
import { DB_POOL } from '../persistence/db';
import { AccountRepository, type AccountRow } from './account.repository';
import { SessionRepository, type SessionAccount } from './session.repository';
import { hashPassword, verifyPassword } from './password';
import { SESSION_TTL_MS } from './session-cookie';

export interface AuthedSession {
  account: { id: number; email: string; isDemo: boolean };
  sessionId: string;
  expiresAt: Date;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 8;

/**
 * 인증 — 회원가입 · 로그인 · 로그아웃.
 *
 * 두 가지 노출 방지가 이 서비스의 핵심이다.
 * - 로그인 실패는 아이디 없음과 비밀번호 불일치를 **구분하지 않는다** (EX-SY-004).
 * - 회원가입 이메일 중복도 이미 가입됐는지 알리지 않는다 (EX-SY-007).
 */
@Injectable()
export class AuthService {
  private readonly accounts: AccountRepository;
  private readonly sessions: SessionRepository;

  /**
   * 계정이 없을 때도 비밀번호 검증을 한 번 돌려, 존재 여부가 응답 시간으로 새지 않게
   * 한다. 실제 해시가 필요하니 최초 1회만 계산해 캐시한다.
   */
  private dummyHash: Promise<string> | null = null;

  constructor(@Inject(DB_POOL) pool: Pool) {
    this.accounts = new AccountRepository(pool);
    this.sessions = new SessionRepository(pool);
  }

  async signup(email: string, password: string): Promise<AuthedSession> {
    const normalizedEmail = this.requireEmail(email);
    this.requirePassword(password);

    let account: AccountRow;
    try {
      account = await this.accounts.create(normalizedEmail, await hashPassword(password));
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new BadRequestException('이 이메일로는 가입할 수 없습니다. 다른 이메일을 사용해 주세요.');
      }
      throw e;
    }
    return this.startSession(account);
  }

  async login(email: string, password: string): Promise<AuthedSession> {
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const account = normalizedEmail === '' ? null : await this.accounts.findByEmail(normalizedEmail);

    const ok =
      account === null
        ? await verifyPassword(password ?? '', await this.getDummyHash())
        : await verifyPassword(password ?? '', account.passwordHash);

    if (account === null || !ok) {
      throw new UnauthorizedException('이메일 또는 비밀번호가 올바르지 않습니다.');
    }
    return this.startSession(account);
  }

  async logout(sessionId: string | undefined): Promise<void> {
    if (sessionId === undefined || sessionId === '') return;
    await this.sessions.delete(sessionId);
  }

  /**
   * 쿠키의 세션 id 로 계정을 되찾으면서 만료 시계를 뒤로 민다 (슬라이딩). 만료·부재면
   * `null` (가드가 401 로 바꾼다). 쿠키 쪽 수명은 가드가 함께 연장한다.
   */
  async resolveSession(sessionId: string | undefined): Promise<SessionAccount | null> {
    if (sessionId === undefined || sessionId === '') return null;
    return this.sessions.find(sessionId, SESSION_TTL_MS);
  }

  private async startSession(account: AccountRow): Promise<AuthedSession> {
    const { id, expiresAt } = await this.sessions.create(account.id, SESSION_TTL_MS);
    return {
      account: { id: account.id, email: account.email, isDemo: account.isDemo },
      sessionId: id,
      expiresAt,
    };
  }

  private requireEmail(email: unknown): string {
    const value = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(value)) {
      throw new BadRequestException('이메일 형식이 올바르지 않습니다.');
    }
    return value;
  }

  private requirePassword(password: unknown): void {
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
      throw new BadRequestException(`비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`);
    }
  }

  private getDummyHash(): Promise<string> {
    if (this.dummyHash === null) {
      this.dummyHash = hashPassword('tourlint-nonexistent-account-placeholder');
    }
    return this.dummyHash;
  }
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';
}
