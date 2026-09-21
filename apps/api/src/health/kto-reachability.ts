import { Injectable } from '@nestjs/common';

/**
 * 이 컨테이너가 공사에 닿는가 (#700).
 *
 * 2026-09-21 에 새로 뜬 컨테이너 다섯 중 둘이 공사에 아예 못 닿았다. 같은 시각 국내 직접 호출은
 * 0.16초였고 같은 커밋으로 다시 띄우면 풀렸다 — 컨테이너마다 공사로 나가는 길이 갈린다.
 * `/health` 가 이것을 모르면 Railway 가 그 컨테이너로 트래픽을 넘기고 멀쩡한 옛 컨테이너를 내린다.
 *
 * **한 번 닿으면 되돌리지 않는다.** Railway 는 배포 때만 검사한다. 도중의 흔들림을 503 으로
 * 알려도 할 수 있는 일이 없고, 바깥에서 상태를 보는 사람만 헷갈린다.
 */
export type KtoReach = 'unknown' | 'ok' | 'failed';

/**
 * 다시 시도하기 전 기다리는 시간 (ms). 처음 5분은 촘촘히 — Railway 의 검사 시간(기본 300초) 안에
 * 풀리면 배포가 통과한다. 그 뒤는 10분 간격이다. **시간 초과도 호출 기록에 남아 일일 예산 계산에
 * 들어간다** — 20초 간격으로 하루를 돌면 4,320건이다.
 */
export const RETRY_FAST_MS = 20_000;
export const RETRY_FAST_TIMES = 15;
export const RETRY_SLOW_MS = 600_000;

export function retryDelayMs(attempt: number): number {
  return attempt <= RETRY_FAST_TIMES ? RETRY_FAST_MS : RETRY_SLOW_MS;
}

@Injectable()
export class KtoReachability {
  private current: KtoReach = 'unknown';

  get state(): KtoReach {
    return this.current;
  }

  /**
   * `probe` 가 참을 줄 때까지 지켜본다. 첫 시도가 실패하면 `failed` 로 두고 뒤에서 다시 부른다.
   * 던지는 것도 실패로 센다 — 여기서 새는 예외가 부팅을 죽이면 안 된다.
   */
  async track(
    probe: () => Promise<boolean>,
    log: (line: string) => void = () => undefined,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => { setTimeout(done, ms); }),
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 0) await sleep(retryDelayMs(attempt));
      let reached = false;
      try {
        reached = await probe();
      } catch {
        reached = false;
      }
      if (reached) {
        if (attempt > 0) log(`공사 연결 회복 · ${String(attempt)}번 다시 시도한 뒤`);
        this.current = 'ok';
        return;
      }
      if (this.current !== 'failed') log('공사에 닿지 못했다. /health 는 닿을 때까지 503 을 준다 (#700)');
      this.current = 'failed';
    }
  }
}
