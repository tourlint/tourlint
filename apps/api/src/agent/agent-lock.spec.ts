import { describe, expect, it } from 'vitest';
import { RateLimitException } from '../common/domain.exception';
import { AGENT_RUNS_PER_MINUTE, AgentLock } from './agent-lock';

describe('AgentLock — 실행 전 거절 (FR-AG-002 · EX-AG-004 · EX-SY-008)', () => {
  const later = (): { promise: Promise<void>; release: () => void } => {
    let release = (): void => undefined;
    const promise = new Promise<void>((r) => { release = r; });
    return { promise, release };
  };

  it('🔴 같은 계정의 같은 에이전트가 도는 중이면 429 RATE_LIMIT_EXCEEDED — 새로 돌리지 않는다', async () => {
    const lock = new AgentLock();
    const first = later();
    let secondRan = false;

    const running = lock.runExclusive(1, 'PLACE_MATCH', () => first.promise);
    const e = await lock.runExclusive(1, 'PLACE_MATCH', async () => { secondRan = true; }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RateLimitException);
    expect((e as RateLimitException).reasonCode).toBe('RATE_LIMIT_EXCEEDED');
    expect((e as RateLimitException).retryAfterSeconds).toBeNull();
    expect(secondRan).toBe(false);

    first.release();
    await running;
  });

  it('다른 에이전트 · 다른 계정은 같이 돈다', async () => {
    const lock = new AgentLock();
    const first = later();
    const running = lock.runExclusive(1, 'PLACE_MATCH', () => first.promise);
    await expect(lock.runExclusive(1, 'CHECK_QUESTIONS', async () => 'ok')).resolves.toBe('ok');
    await expect(lock.runExclusive(2, 'PLACE_MATCH', async () => 'ok')).resolves.toBe('ok');
    first.release();
    await running;
  });

  it('🔴 실패해도 잠금을 푼다 — 한 번 실패한 뒤 영영 429 가 되지 않는다', async () => {
    const lock = new AgentLock();
    await expect(lock.runExclusive(1, 'TODAY_BRIEF', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(lock.runExclusive(1, 'TODAY_BRIEF', async () => 'again')).resolves.toBe('again');
  });

  it('🔴 분당 5회를 넘으면 Retry-After 와 함께 429, 1분이 지나면 다시 된다', async () => {
    let now = 1_000_000;
    const lock = new AgentLock(() => now);
    for (let i = 0; i < AGENT_RUNS_PER_MINUTE; i++) {
      await lock.runExclusive(1, 'PLACE_MATCH', async () => undefined);
      now += 1_000;
    }
    const e = await lock.runExclusive(1, 'PLACE_MATCH', async () => undefined).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RateLimitException);
    // 첫 실행이 60초 전으로 밀려나는 때까지: 60 − 5 = 55초
    expect((e as RateLimitException).retryAfterSeconds).toBe(55);

    now += 55_000;
    await expect(lock.runExclusive(1, 'PLACE_MATCH', async () => 'ok')).resolves.toBe('ok');
  });
});
