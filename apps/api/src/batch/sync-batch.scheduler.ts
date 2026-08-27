import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { IsoDate } from '../engine/calendar/dates';
import type { BatchStateRepository } from '../persistence/batch-state.repository';
import type { SyncBatchJob } from './sync-batch.job';
import { kstMinutesOfDay, kstToday, minutesOfDay } from './sync-window';

/**
 * 경량 배치를 저절로 돌린다 (FR-MO-010).
 *
 * ## 왜 매분 깨우는가
 *
 * 실행 시각이 `system_setting.batch_time` 이라 설정 화면에서 바뀐다. cron 식에 05:00 을
 * 박으면 그 설정이 죽은 값이 되고, 바꾸려면 재배포해야 한다. 매분 깨어나 「지금이 그
 * 시각을 지났는가」만 본다 — 1분에 설정 한 줄 읽는 값이다.
 *
 * ## 정각이 아니라 지나침으로 본다
 *
 * 05:00 에 프로세스가 안 떠 있었으면 09:00 에 올라와서라도 그날 몫을 건다. 정각 일치만
 * 보면 그 1분에 배포가 겹친 날은 통째로 빈다.
 *
 * ## 주말 · 활성화 여부는 여기서 안 본다
 *
 * `SyncBatchJob.run()` 이 이미 판단하고 이유를 남긴다. 두 곳에서 보면 한쪽만 고칠 때
 * 조용히 어긋난다.
 *
 * ⚠️ **인스턴스가 둘이면 둘 다 돈다.** 같은 분에 깨어나 같은 `last_covered` 를 보고 같은
 *    날짜를 두 번 조회한다. 지금 Railway 는 1개로 띄운다 — 늘릴 때 잠금이 필요하다.
 */
export interface SyncBatchSchedulerOptions {
  readonly job: SyncBatchJob;
  readonly state: BatchStateRepository;
  readonly clock?: () => Date;
}

@Injectable()
export class SyncBatchScheduler {
  private readonly logger = new Logger(SyncBatchScheduler.name);
  private readonly job: SyncBatchJob;
  private readonly state: BatchStateRepository;
  private readonly clock: () => Date;

  /** 마지막으로 배치를 건 날 (KST). 하루 한 번을 이걸로 지킨다 */
  private lastFired: IsoDate | null = null;
  /** 앞 실행이 아직 도는 중. 14일치 순회 + 상세 재호출은 1분을 넘길 수 있다 */
  private running = false;

  constructor(options: SyncBatchSchedulerOptions) {
    this.job = options.job;
    this.state = options.state;
    this.clock = options.clock ?? ((): Date => new Date());
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;

    const now = this.clock();
    const today = kstToday(now);
    // 오늘 몫을 이미 걸었으면 설정을 읽지도 않는다. 남은 하루치 DB 조회를 아낀다
    if (this.lastFired === today) return;

    const at = await this.dueMinute();
    if (at === null || kstMinutesOfDay(now) < at) return;

    this.running = true;
    try {
      const result = await this.job.run();
      /*
       * **결과와 무관하게 오늘은 걸었다.** 실패한 날짜는 `last_covered` 가 안 올라가
       * 내일 배치가 다시 본다 — 여기서 재시도하면 같은 실패를 1분마다 반복한다.
       */
      this.lastFired = today;
      this.logger.log(
        result.skippedReason !== null
          ? `배치를 건너뛰었다 — ${result.skippedReason}`
          : `배치 ${result.status} · 날짜 ${result.dates.length}일 · 변경 ${result.contents.length}건`
            + ` · 알림 ${result.notified}건 · 콜 ${result.calls}`,
      );
    } catch (e) {
      // `run()` 은 던지지 않기로 돼 있다. 그래도 던졌다면 다음 분에 다시 본다
      this.logger.error(`배치가 던졌다: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** 오늘 배치를 걸 분. 못 읽었으면 `null` — 그 분은 그냥 넘긴다 */
  private async dueMinute(): Promise<number | null> {
    let batchTime: string;
    try {
      batchTime = (await this.state.setting()).batchTime;
    } catch (e) {
      this.logger.error(`배치 설정을 읽지 못했다: ${(e as Error).message}`);
      return null;
    }

    const at = minutesOfDay(batchTime);
    if (at === null) this.logger.error(`배치 실행 시각이 HH:MM 이 아니다: ${batchTime}`);
    return at;
  }
}
