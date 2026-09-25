/**
 * 로그인 실패를 계정(이메일)마다 센다 (NF-SC-010 · EX-SY-008 · #799).
 *
 * **IP 로 세지 않는다.** 화면은 API 의 공개 주소로 요청을 넘겨서 API 가 보는 IP 는 모든 사용자에게
 * 같은 웹 서버 쪽 주소다 — IP 로 세면 한 사람의 실패로 전원이 막힌다.
 *
 * 성공은 세지 않고, 성공해도 실패 수를 지우지 않는다. 창은 첫 실패에서 시작해 끝나면 통째로 풀린다.
 * 메모리에 둔다 — 운영은 API 컨테이너 하나이고, 재배포로 비워져도 막힌 것이 잠깐 풀릴 뿐이다.
 */
export const LOGIN_FAILURE_LIMIT = 10;
export const LOGIN_FAILURE_WINDOW_MS = 10 * 60_000;

/** 이만큼 쌓이면 끝난 창을 치운다 */
const SWEEP_AT = 1000;

interface FailureWindow {
  count: number;
  readonly resetAt: number;
}

export class LoginThrottle {
  private readonly windows = new Map<string, FailureWindow>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly limit = LOGIN_FAILURE_LIMIT,
    private readonly windowMs = LOGIN_FAILURE_WINDOW_MS,
  ) {}

  /** 막혀 있으면 다시 시도할 수 있을 때까지 남은 초, 아니면 null */
  blockedFor(key: string): number | null {
    const window = this.current(key);
    if (window === undefined || window.count < this.limit) return null;
    return Math.max(1, Math.ceil((window.resetAt - this.now()) / 1000));
  }

  recordFailure(key: string): void {
    const window = this.current(key);
    if (window === undefined) this.windows.set(key, { count: 1, resetAt: this.now() + this.windowMs });
    else window.count++;
    if (this.windows.size >= SWEEP_AT) this.sweep();
  }

  private current(key: string): FailureWindow | undefined {
    const window = this.windows.get(key);
    if (window !== undefined && window.resetAt <= this.now()) {
      this.windows.delete(key);
      return undefined;
    }
    return window;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}
