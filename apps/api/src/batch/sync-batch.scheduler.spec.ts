import { describe, expect, it, vi } from 'vitest';
import type { BatchStateRepository, SystemSetting } from '../persistence/batch-state.repository';
import type { SyncBatchJob, SyncBatchResult } from './sync-batch.job';
import { SyncBatchScheduler } from './sync-batch.scheduler';

/** 한국 시간 문자열을 Date 로. 서버 시간대에 흔들리지 않게 한다 */
const kst = (iso: string): Date => new Date(`${iso}+09:00`);

const RESULT: SyncBatchResult = {
  status: 'OK', dates: ['2026-08-26'], contents: [], covered: '2026-08-26',
  calls: 1, skippedReason: null, impacts: [], notified: 0,
};

function stub(over: {
  setting?: () => Promise<SystemSetting>;
  run?: () => Promise<SyncBatchResult>;
} = {}) {
  const settings = { batchTime: '05:00', batchEnabled: true, dailyQuota: 800 };
  const setting = vi.fn(over.setting ?? (async () => settings));
  const run = vi.fn(over.run ?? (async () => RESULT));

  let now = kst('2026-08-27T05:00:00');
  const scheduler = new SyncBatchScheduler({
    job: { run } as unknown as SyncBatchJob,
    state: { setting } as unknown as BatchStateRepository,
    clock: () => now,
  });
  return {
    scheduler, run, setting, settings,
    at: async (iso: string): Promise<void> => {
      now = kst(iso);
      await scheduler.tick();
    },
  };
}

describe('설정 시각에 건다 (FR-MO-010)', () => {
  it('시각 전에는 안 건다', async () => {
    const s = stub();
    await s.at('2026-08-27T04:59:00');
    expect(s.run).not.toHaveBeenCalled();
  });

  it('시각이 되면 건다', async () => {
    const s = stub();
    await s.at('2026-08-27T05:00:00');
    expect(s.run).toHaveBeenCalledTimes(1);
  });

  it('🔴 정각을 놓쳐도 그날 안에 건다', async () => {
    /*
     * 05:00 에 프로세스가 안 떠 있었으면 09:00 에 올라와서라도 건다. 정각 일치만 보면
     * 그 1분에 배포가 겹친 날은 통째로 빈다.
     */
    const s = stub();
    await s.at('2026-08-27T09:13:00');
    expect(s.run).toHaveBeenCalledTimes(1);
  });

  it('🔴 설정을 매번 읽어 바뀐 시각을 따라간다', async () => {
    /*
     * 재배포 없이 설정 화면에서 바꾼 시각이 그대로 먹어야 한다. **깨어난 뒤에 바꾼다** —
     * 처음 읽은 값을 캐시해도 걸리게 하려면 tick 사이에 값이 움직여야 한다.
     */
    const s = stub();
    s.settings.batchTime = '07:30';
    await s.at('2026-08-27T05:00:00');
    expect(s.run).not.toHaveBeenCalled();

    // 07:30 을 기다리는 동안 06:00 으로 당겼다
    s.settings.batchTime = '06:00';
    await s.at('2026-08-27T06:00:00');
    expect(s.run).toHaveBeenCalledTimes(1);

    // 다음 날은 다시 뒤로 미뤘다
    s.settings.batchTime = '09:00';
    await s.at('2026-08-28T06:00:00');
    expect(s.run).toHaveBeenCalledTimes(1);
    await s.at('2026-08-28T09:00:00');
    expect(s.run).toHaveBeenCalledTimes(2);
  });

  it('🔴 한국 시간으로 본다 — 배포 환경이 UTC 다', async () => {
    // 한국 02:00 은 UTC 17:00. 서버 시계를 그대로 보면 17:00 > 05:00 이라 새벽 2시에 건다
    const dawn = kst('2026-08-27T02:00:00');
    expect(dawn.getUTCHours()).toBe(17);

    const s = stub();
    await s.at('2026-08-27T02:00:00');
    expect(s.run).not.toHaveBeenCalled();
  });
});

describe('하루 한 번', () => {
  it('🔴 같은 날 여러 번 깨어나도 한 번만 건다', async () => {
    const s = stub();
    await s.at('2026-08-27T05:00:00');
    await s.at('2026-08-27T05:01:00');
    await s.at('2026-08-27T18:00:00');
    expect(s.run).toHaveBeenCalledTimes(1);
  });

  it('날이 바뀌면 다시 건다', async () => {
    const s = stub();
    await s.at('2026-08-27T05:00:00');
    await s.at('2026-08-28T05:00:00');
    expect(s.run).toHaveBeenCalledTimes(2);
  });

  it('🔴 이미 건 날은 설정을 읽지도 않는다', async () => {
    // 하루 1440번 깨어난다. 건 뒤로는 DB 를 안 본다
    const s = stub();
    await s.at('2026-08-27T05:00:00');
    expect(s.setting).toHaveBeenCalledTimes(1);

    await s.at('2026-08-27T05:01:00');
    await s.at('2026-08-27T05:02:00');
    expect(s.setting).toHaveBeenCalledTimes(1);
  });

  it('🔴 앞 실행이 안 끝났으면 겹쳐 걸지 않는다', async () => {
    // 14일치 순회 + 재검수는 1분을 넘길 수 있다
    let release = (): void => {};
    let entered = (): void => {};
    const running = new Promise<void>((r) => { entered = r; });
    const s = stub({
      run: () => {
        entered();
        return new Promise((r) => { release = (): void => r(RESULT); });
      },
    });

    const first = s.at('2026-08-27T05:00:00');
    await running; // 첫 실행이 run 안에 들어갔다
    await s.at('2026-08-27T05:01:00');
    expect(s.run).toHaveBeenCalledTimes(1);

    release();
    await first;
  });
});

describe('실패해도 다음 분에 다시 본다', () => {
  it('🔴 run 이 던져도 tick 이 죽지 않는다', async () => {
    const s = stub({ run: async () => { throw new Error('DB 가 끊겼다'); } });
    await expect(s.at('2026-08-27T05:00:00')).resolves.toBeUndefined();
  });

  it('🔴 run 이 던지면 오늘 건 것으로 치지 않는다', async () => {
    let fail = true;
    const s = stub({
      run: async () => {
        if (fail) throw new Error('DB 가 끊겼다');
        return RESULT;
      },
    });
    await s.at('2026-08-27T05:00:00');
    fail = false;
    await s.at('2026-08-27T05:01:00');
    expect(s.run).toHaveBeenCalledTimes(2);
  });

  it('🔴 설정을 못 읽으면 걸지 않는다', async () => {
    // 기본값 05:00 으로 돌려 걸면, 설정이 07:30 인 날 두 번 도는 수가 있다
    const s = stub({ setting: async () => { throw new Error('DB 가 끊겼다'); } });
    await s.at('2026-08-27T05:00:00');
    expect(s.run).not.toHaveBeenCalled();
  });

  it('🔴 시각 형식이 깨졌으면 걸지 않는다', async () => {
    const s = stub();
    s.settings.batchTime = '5시';
    await s.at('2026-08-27T23:00:00');
    expect(s.run).not.toHaveBeenCalled();
  });
});

describe('주말과 활성화 여부는 여기서 안 본다', () => {
  it('🔴 주말에도 걸고, 건너뛸지는 run 이 정한다', async () => {
    /*
     * 두 곳에서 판단하면 한쪽만 고칠 때 조용히 어긋난다. `run()` 이 이미 주말 · 비활성을
     * 보고 이유를 남긴다.
     */
    const skipped: SyncBatchResult = { ...RESULT, dates: [], covered: null, calls: 0, skippedReason: '주말이다' };
    const s = stub({ run: async () => skipped });
    await s.at('2026-08-29T05:00:00'); // 토요일
    expect(s.run).toHaveBeenCalledTimes(1);
  });
});

describe('스케줄 등록', () => {
  /*
   * `@nestjs/schedule` 은 프로바이더의 메서드를 훑으며 이 메타데이터를 찾는다. 데코레이터가
   * 빠지면 클래스는 멀쩡히 만들어지고 `tick` 만 영영 안 불린다 — 로그도 오류도 없다.
   *
   * 키 이름을 문자열로 적는다. `@nestjs/schedule` 이 dist 안쪽에서만 내보내는 상수라
   * 경로로 가져오면 판올림에 깨진다.
   */
  const cronOptions = (): { cronTime?: string } | undefined =>
    Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', SyncBatchScheduler.prototype.tick) as
      { cronTime?: string } | undefined;

  it('🔴 tick 에 @Cron 이 붙어 있다', () => {
    expect(cronOptions()).toBeDefined();
  });

  it('🔴 매분 깨어난다 — 설정 시각을 cron 식에 박지 않는다', () => {
    // 05:00 을 식에 박으면 system_setting.batch_time 이 죽은 값이 된다 (FR-MO-010)
    expect(cronOptions()?.cronTime).toBe('*/1 * * * *');
  });
});
