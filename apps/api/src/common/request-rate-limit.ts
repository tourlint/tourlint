import { RateLimitException } from './domain.exception';

/** 계정당 분당 상한 — 검수 실행 요청 · 리포트 생성 (NF-SC-010 · EX-SY-008 · API 3-4) */
export const REQUESTS_PER_MINUTE = 5;

const WINDOW_MS = 60_000;

/**
 * 세는 묶음. **다시 검수와 검수 시작은 한 창을 같이 쓴다** — 둘 다 검수 실행 요청이라 따로 세면
 * 번갈아 눌러 상한을 두 배로 쓸 수 있다.
 */
export type RateLimitedAction = 'AUDIT' | 'REPORT';

/** 무엇이 몇 번까지 되는지 (EX-MS-001 — 무엇이 · 왜 · 다음에 무엇을) */
const LIMIT_TEXT: Readonly<Record<RateLimitedAction, (perMinute: number) => string>> = {
  AUDIT: (n) => `검수는 1분에 ${String(n)}번까지 요청할 수 있어요.`,
  REPORT: (n) => `리포트는 1분에 ${String(n)}번까지 만들 수 있어요.`,
};

/** 가드가 요청에 실어 둔 계정 중 여기서 보는 것 */
export interface RateLimitedAccount {
  readonly accountId: number;
  readonly isDemo: boolean;
}

/**
 * 계정마다 1분 창으로 센다 (NF-SC-010 · EX-SY-008 · API 3-4). 넘으면 429 `RATE_LIMIT_EXCEEDED` 와
 * 다시 되는 때까지의 초(`Retry-After`)다.
 *
 * **공개 테스트 계정은 세지 않는다.** 심사위원 여럿이 한 계정으로 같은 가이드를 따라가므로 세면
 * 남이 누른 것 때문에 내가 막힌다 — 로그인 실패 제한(#799)과 같은 기준이다. 배치가 거는 재검수는
 * 컨트롤러를 지나지 않아 여기서 세지 않는다.
 *
 * ⚠️ **프로세스 메모리에 둔다.** 에이전트 자물쇠(`AgentLock`)와 같은 전제 — 운영 API 는 컨테이너
 *    하나다. 재배포로 비워져도 막힌 것이 잠깐 풀릴 뿐이다.
 */
export class RequestRateLimiter {
  private readonly starts = new Map<string, number[]>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly perMinute: number = REQUESTS_PER_MINUTE,
  ) {}

  /** 상한 안이면 이번 요청을 센다. 넘었으면 세지 않고 던진다 */
  take(account: RateLimitedAccount, action: RateLimitedAction): void {
    if (account.isDemo) return;

    const key = `${String(account.accountId)}:${action}`;
    const now = this.now();
    const recent = (this.starts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    const oldest = recent[0];
    if (oldest !== undefined && recent.length >= this.perMinute) {
      this.starts.set(key, recent);
      const wait = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
      throw new RateLimitException(`${LIMIT_TEXT[action](this.perMinute)} ${String(wait)}초 뒤에 다시 눌러 주세요.`, wait);
    }
    recent.push(now);
    this.starts.set(key, recent);
  }
}
