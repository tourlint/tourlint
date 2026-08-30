import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { IsoDate } from '../engine/calendar/dates';
import type { BatchStateRepository } from '../persistence/batch-state.repository';
import type { SignalBatchJob } from './signal-batch.job';
import type { SkipReason, SyncBatchJob } from './sync-batch.job';
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
 * 조용히 어긋난다. 다만 **꺼져 있어서 안 돈 날은 하루를 쓴 것으로 치지 않는다** — 설정
 * 한 번으로 바뀌는 조건이라, 낮에 켠 것이 다음 날 새벽까지 아무 일도 안 하면 고장으로
 * 보인다.
 *
 * ⚠️ **인스턴스가 둘이면 둘 다 돈다.** 같은 분에 깨어나 같은 `last_covered` 를 보고 같은
 *    날짜를 두 번 조회한다. 지금 Railway 는 1개로 띄운다 — 늘릴 때 잠금이 필요하다.
 */
export interface SyncBatchSchedulerOptions {
  readonly job: SyncBatchJob;
  readonly state: BatchStateRepository;
  readonly clock?: () => Date;
  /**
   * T1 · T2 산출 (F14). 변경 감지가 끝난 뒤에 이어서 돈다.
   *
   * 별도 잡이라 여기서 실패해도 변경 감지 결과는 이미 저장돼 있다 — 둘은 서로
   * 끌고 내려가지 않아야 한다.
   */
  readonly signalJob?: SignalBatchJob;
}

@Injectable()
export class SyncBatchScheduler {
  private readonly logger = new Logger(SyncBatchScheduler.name);
  private readonly job: SyncBatchJob;
  private readonly state: BatchStateRepository;
  private readonly clock: () => Date;
  private readonly signalJob: SignalBatchJob | null;

  /** 마지막으로 배치를 건 날 (KST). 하루 한 번을 이걸로 지킨다 */
  private lastFired: IsoDate | null = null;
  /** 앞 실행이 아직 도는 중. 14일치 순회 + 상세 재호출은 1분을 넘길 수 있다 */
  private running = false;
  /** 같은 이유로 계속 건너뛰는 중. 1분마다 같은 줄을 남기지 않으려고 들고 있는다 */
  private muted: SkipReason | null = null;

  constructor(options: SyncBatchSchedulerOptions) {
    this.job = options.job;
    this.state = options.state;
    this.clock = options.clock ?? ((): Date => new Date());
    this.signalJob = options.signalJob ?? null;
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

      if (result.skippedReason === 'DISABLED') {
        // 켜면 다음 분에 돈다. 재배포를 기다리게 하지 않는다
        if (this.muted !== 'DISABLED') {
          this.logger.log('배치가 꺼져 있다. 켜면 1분 안에 돈다');
          this.muted = 'DISABLED';
        }
        return;
      }
      this.muted = null;

      /*
       * **여기서부터는 결과와 무관하게 오늘을 썼다.** 주말과 「볼 날짜 없음」은 그날 안에
       * 안 바뀌고, 실패한 날짜는 `last_covered` 가 안 올라가 내일 배치가 다시 본다 —
       * 여기서 재시도하면 같은 실패를 1분마다 반복한다.
       */
      this.lastFired = today;
      this.logger.log(
        result.skippedReason !== null
          ? `배치를 건너뛰었다 — ${result.skippedReason}`
          : `배치 ${result.status} · 날짜 ${result.dates.length}일 · 변경 ${result.contents.length}건`
            + ` · 알림 ${result.notified}건 · 콜 ${result.calls}`,
      );

      await this.runSignals();
    } catch (e) {
      // `run()` 은 던지지 않기로 돼 있다. 그래도 던졌다면 다음 분에 다시 본다
      this.logger.error(`배치가 던졌다: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * 수요 신호 산출. **던지지 않는다** — 변경 감지는 이미 끝났고 저장됐다.
   *
   * 신호를 못 만든 것과 변경을 못 잡은 것은 심각도가 다르다. 여기서 예외가 올라가면
   * 바깥 catch 가 「배치가 던졌다」로 남겨 변경 감지가 실패한 것처럼 읽힌다.
   */
  private async runSignals(): Promise<void> {
    if (this.signalJob === null) return;
    try {
      const r = await this.signalJob.run();
      this.logger.log(
        r.skippedReason !== null
          ? `신호 산출을 건너뛰었다 — ${r.skippedReason}`
          : `신호 산출 ${r.computed}건 · 실패 ${r.failed}건`,
      );
    } catch (e) {
      this.logger.error(`신호 산출이 던졌다: ${(e as Error).message}`);
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
