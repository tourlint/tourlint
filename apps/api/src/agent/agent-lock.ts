import type { AgentPurpose } from '../external/llm';
import { RateLimitException } from '../common/domain.exception';

/** 계정당 같은 에이전트의 분당 실행 상한 — 검수 실행 · 리포트 생성과 같은 5회 (EX-SY-008 · API 3-4) */
export const AGENT_RUNS_PER_MINUTE = 5;

/**
 * 실행 전 거절 (FR-AG-002 · EX-AG-004 · D10).
 *
 * **같은 계정의 같은 에이전트는 동시에 하나만 돈다.** 화면이 버튼을 막아도 새로고침 · 두 탭으로
 * 다시 올 수 있어 서버가 막는다. 도는 중에 온 요청은 새로 돌리지 않고 429 다 — 줄 세워 기다리게
 * 하면 30초 상한 두 번이 쌓인다.
 *
 * ⚠️ **프로세스 메모리에 둔다.** 인스턴스가 둘이면 인스턴스마다 따로 센다. 지금 Railway 는 1개다
 *    (`SyncBatchScheduler` 와 같은 전제).
 */
export class AgentLock {
  private readonly running = new Set<string>();
  private readonly starts = new Map<string, number[]>();

  constructor(
    private readonly clock: () => number = () => Date.now(),
    private readonly perMinute: number = AGENT_RUNS_PER_MINUTE,
  ) {}

  async runExclusive<T>(accountId: number, purpose: AgentPurpose, run: () => Promise<T>): Promise<T> {
    const key = `${accountId}:${purpose}`;
    if (this.running.has(key)) {
      throw new RateLimitException('이미 정리하고 있어요. 끝나면 다시 눌러 주세요.', null);
    }

    const now = this.clock();
    const recent = (this.starts.get(key) ?? []).filter((t) => now - t < 60_000);
    const oldest = recent[0];
    if (oldest !== undefined && recent.length >= this.perMinute) {
      throw new RateLimitException(
        '짧은 시간에 너무 많이 눌렀어요. 잠시 뒤에 다시 눌러 주세요.',
        Math.max(1, Math.ceil((60_000 - (now - oldest)) / 1000)),
      );
    }
    recent.push(now);
    this.starts.set(key, recent);

    this.running.add(key);
    try {
      return await run();
    } finally {
      this.running.delete(key);
    }
  }
}
