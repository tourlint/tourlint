import { Injectable, Logger } from '@nestjs/common';
import type { KtoClient } from '../external/kto';
import { isKtoError } from '../external/kto';
import type { BatchState, BatchStateRepository, BatchStatus } from '../persistence/batch-state.repository';
import { isWeekend, pendingDates, toKtoDate } from './sync-window';

/**
 * 경량 동기화 배치 — 1단계 (F12 · FR-MO-010 ~ 016).
 *
 * ## 왜 2단계인가
 *
 * 등록된 상품의 관광지를 매일 전부 상세 조회하면 예산이 남지 않는다. 대신
 *
 *   1단계  동기화 목록(`areaBasedSyncList2`)으로 **그날 바뀐 것 전부**를 하루 1콜로 받는다
 *   2단계  그중 **등록 상품에 들어 있는 것만** 상세 재호출한다 (FR-MO-013)
 *
 * 1단계가 하루 한 콜이라 밀린 날짜가 며칠이어도 감당된다. 이 파일은 1단계까지다.
 *
 * ## 안 하는 것
 *
 * **비표출 감지를 위한 별도 조회를 하지 않는다** (FR-MO-012 · EI-KT-012). 같은 응답의
 * `showflag` 로 읽는다 — `showflag` 를 지정하지 않으면 표출 · 비표출이 함께 온다.
 */

/** 그날 바뀐 콘텐츠 하나 */
export interface SyncedContent {
  readonly contentId: string;
  readonly contentTypeId: string;
  readonly modifiedTime: string;
  /** `1` = 표출 · `0` = 비표출. 별도 조회 없이 여기서 읽는다 (FR-MO-012) */
  readonly showFlag: '0' | '1';
  readonly createdTime: string;
}

export interface SyncBatchResult {
  readonly status: BatchStatus;
  /** 실제로 조회한 날짜들 */
  readonly dates: readonly string[];
  readonly contents: readonly SyncedContent[];
  /** 성공해서 `last_covered` 를 여기까지 올렸다. 안 올렸으면 null */
  readonly covered: string | null;
  readonly calls: number;
  readonly skippedReason: string | null;
}

export interface SyncBatchOptions {
  readonly kto: KtoClient;
  readonly state: BatchStateRepository;
  readonly clock?: () => Date;
  /** 하루치 조회 전에 예산이 남았는지 묻는다. false 면 그 자리에서 멈춘다 */
  readonly hasBudget?: () => boolean | Promise<boolean>;
}

@Injectable()
export class SyncBatchJob {
  private readonly logger = new Logger(SyncBatchJob.name);
  private readonly kto: KtoClient;
  private readonly state: BatchStateRepository;
  private readonly clock: () => Date;
  private readonly hasBudget: () => boolean | Promise<boolean>;

  constructor(options: SyncBatchOptions) {
    this.kto = options.kto;
    this.state = options.state;
    this.clock = options.clock ?? ((): Date => new Date());
    this.hasBudget = options.hasBudget ?? ((): boolean => true);
  }

  /**
   * 한 번 돈다.
   *
   * **던지지 않는다.** 배치가 예외로 죽으면 스케줄러가 다음 실행까지 아무것도 안 하고,
   * 무엇이 왜 실패했는지도 안 남는다. 결과에 담아 돌려주고 상태에 기록한다.
   */
  async run(): Promise<SyncBatchResult> {
    const now = this.clock();
    const setting = await this.state.setting();

    if (!setting.batchEnabled) return this.skip('배치가 꺼져 있다');
    // 주말 분은 월요일 배치가 날짜를 순회하며 함께 가져간다 (FR-MO-010)
    if (isWeekend(now)) return this.skip('주말이다');

    const previous = await this.state.find();
    const dates = pendingDates(previous.lastCovered, now);
    if (dates.length === 0) return this.skip('처리할 날짜가 없다');

    return this.walk(dates, previous, now);
  }

  /**
   * 날짜를 하루씩 순회한다.
   *
   * **한 날짜가 실패하면 거기서 멈춘다.** 건너뛰고 다음 날로 가면 `last_covered` 가
   * 그 너머로 올라가 실패한 날의 변경을 영영 못 본다.
   */
  private async walk(
    dates: readonly string[],
    previous: BatchState,
    now: Date,
  ): Promise<SyncBatchResult> {
    const contents: SyncedContent[] = [];
    let covered: string | null = null;
    let calls = 0;
    let emptyDay: string | null = null;

    for (const date of dates) {
      if (!(await this.hasBudget())) {
        this.logger.warn(`예산이 남지 않아 ${date} 이후를 다음 배치로 넘긴다`);
        break;
      }

      let page;
      try {
        page = await this.kto.areaBasedSyncList({ modifiedDate: toKtoDate(date) });
        calls++;
      } catch (e) {
        this.logger.error(`동기화 목록 조회 실패 (${date}): ${isKtoError(e) ? e.reasonCode : '알 수 없음'}`);
        // 실패한 날짜는 넘기지 않는다. 다음 배치가 그 날부터 다시 본다
        await this.record('FAILED', contents.length, now, covered);
        return { status: 'FAILED', dates, contents, covered, calls, skippedReason: null };
      }

      /*
       * 평일 0건은 동기화 지연 신호다 (FR-MO-015). `last_covered` 를 올리지 않고 멈춰
       * 다음 배치가 그 날짜를 다시 본다. 공사가 그날 분을 아직 안 올렸을 수 있어서다 —
       * 건수는 조회 시각에 따라 크게 변한다 (EI-KT-011).
       */
      if (page.items.length === 0) {
        emptyDay = date;
        break;
      }

      contents.push(...page.items.map(toSyncedContent));
      covered = date;
    }

    const status: BatchStatus = emptyDay !== null && covered === null ? 'EMPTY' : 'OK';
    if (emptyDay !== null) {
      this.logger.warn(`${emptyDay} 조회가 0건이다. last_covered 를 올리지 않는다 (FR-MO-015)`);
    }
    await this.record(status, contents.length, now, covered);
    return { status, dates, contents, covered, calls, skippedReason: null };
  }

  private skip(reason: string): SyncBatchResult {
    this.logger.log(`배치를 건너뛴다 — ${reason}`);
    // 건너뛴 것은 실행이 아니다. 상태를 건드리지 않는다
    return { status: 'OK', dates: [], contents: [], covered: null, calls: 0, skippedReason: reason };
  }

  private async record(
    status: BatchStatus, itemCount: number, ranAt: Date, covered: string | null,
  ): Promise<void> {
    try {
      await this.state.record({
        status, itemCount, ranAt,
        // 성공한 날짜까지만 올린다 (FR-MO-014 · DR-CF-005)
        ...(covered === null ? {} : { lastCovered: covered }),
      });
    } catch (e) {
      // 상태 기록 실패가 배치 결과를 뒤집지 않는다. 다만 조용히 넘기지도 않는다
      this.logger.error(`배치 상태를 남기지 못했다: ${(e as Error).message}`);
    }
  }
}

/**
 * 응답 항목 → 우리 모양.
 *
 * ⚠️ **여기서 담는 것은 판정에 쓰는 값뿐이다.** `title` · `addr1` · `firstimage` 같은
 *    공사 원문은 담지 않는다 — 담으면 그대로 로그와 알림으로 새어 나간다
 *    (FR-MO-002 · DB 명세서 6-4).
 */
export function toSyncedContent(item: Record<string, unknown>): SyncedContent {
  return {
    contentId: String(item.contentid ?? ''),
    contentTypeId: String(item.contenttypeid ?? ''),
    modifiedTime: String(item.modifiedtime ?? ''),
    showFlag: String(item.showflag ?? '1') === '0' ? '0' : '1',
    createdTime: String(item.createdtime ?? ''),
  };
}
