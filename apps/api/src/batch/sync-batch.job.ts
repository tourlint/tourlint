import { Injectable, Logger } from '@nestjs/common';
import type { KtoClient } from '../external/kto';
import { parseIsoDate } from '../engine/calendar/dates';
import { isKtoError } from '../external/kto';
import type { BatchState, BatchStateRepository, BatchStatus } from '../persistence/batch-state.repository';
import type { NotificationRepository, NotificationToSave } from '../persistence/notification.repository';
import {
  matchByContent, matchByEventPeriod, matchByRegion, mergeImpacts,
  type ChangedContent, type EventPeriod, type Impact,
} from './impact-finder';
import { isWeekend, kstToday, pendingDates, toKtoDate } from './sync-window';

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
 * 1단계가 하루 한 콜이라 밀린 날짜가 며칠이어도 감당된다.
 *
 * ## 안 하는 것
 *
 * **비표출 감지를 위한 별도 조회를 하지 않는다** (FR-MO-012 · EI-KT-012). 같은 응답의
 * `showflag` 로 읽는다 — `showflag` 를 지정하지 않으면 표출 · 비표출이 함께 온다.
 */

/** 행사 유형. 이 유형만 개최 기간이 있다 (조건 3) */
export const FESTIVAL_TYPE_ID = 15 as const;

/** 그날 바뀐 콘텐츠 하나 */
export interface SyncedContent {
  readonly contentId: string;
  readonly contentTypeId: string;
  readonly modifiedTime: string;
  /** `1` = 표출 · `0` = 비표출. 별도 조회 없이 여기서 읽는다 (FR-MO-012) */
  readonly showFlag: '0' | '1';
  readonly createdTime: string;
  /**
   * 법정동 코드. **동기화 목록 응답에 이미 들어 있다** — 조건 2 는 상세 재호출이 필요 없다.
   *
   * 코드지 원문이 아니다. `title` · `addr1` 과 달리 담아도 된다 (DB 명세서 6-4).
   */
  readonly ldongRegnCd: string | null;
  readonly ldongSignguCd: string | null;
}

/**
 * 안 돈 이유.
 *
 * 문자열이 아니라 코드다 — 스케줄러가 `DISABLED` 만 다르게 다룬다. 주말과 「볼 날짜 없음」은
 * 그날 안에 안 바뀌지만 **꺼짐은 설정 한 번으로 바뀐다.**
 */
export const SKIP_REASON = ['DISABLED', 'WEEKEND', 'NO_DATES'] as const;
export type SkipReason = (typeof SKIP_REASON)[number];

const SKIP_MESSAGE: Readonly<Record<SkipReason, string>> = {
  DISABLED: '배치가 꺼져 있다',
  WEEKEND: '주말이다',
  NO_DATES: '처리할 날짜가 없다',
};

export interface SyncBatchResult {
  readonly status: BatchStatus;
  /** 실제로 조회한 날짜들 */
  readonly dates: readonly string[];
  readonly contents: readonly SyncedContent[];
  /** 성공해서 `last_covered` 를 여기까지 올렸다. 안 올렸으면 null */
  readonly covered: string | null;
  readonly calls: number;
  readonly skippedReason: SkipReason | null;
  /** 2단계에서 영향받는 것으로 판정한 상품들 */
  readonly impacts: readonly Impact[];
  /** 실제로 넣은 알림 수. 같은 변경을 다시 넣지 않으므로 `impacts` 보다 적을 수 있다 */
  readonly notified: number;
}

export interface SyncBatchOptions {
  /**
   * 공사 클라이언트. **함수로 넘기면 처음 쓸 때 만든다.**
   *
   * `HttpKtoTransport` 는 인증키가 비면 생성자에서 던진다. 부팅 시점에 만들면 키를 안
   * 넣은 배포에서 API 전체가 못 뜬다 — 없는 키는 `/health` 가 알려 줄 일이다.
   */
  readonly kto: KtoClient | (() => KtoClient);
  readonly state: BatchStateRepository;
  readonly clock?: () => Date;
  /** 하루치 조회 전에 예산이 남았는지 묻는다. false 면 그 자리에서 멈춘다 */
  readonly hasBudget?: () => boolean | Promise<boolean>;
  /** 2단계 저장소. 없으면 1단계만 돌고 알림을 만들지 않는다 */
  readonly notifications?: NotificationRepository;
  /**
   * 행사 개최 기간을 가져온다 (조건 3 · FR-MO-030 ③).
   *
   * **이것만 상세 재호출이 필요하다.** 시군구는 동기화 목록에 이미 있어 조건 2 는 공짜고,
   * 조건 1 은 우리 DB 만 본다. 행사(15)가 아닌 유형에는 부르지 않는다.
   *
   * 없으면 조건 3 만 물러난다.
   */
  readonly eventPeriod?: (contentId: string) => Promise<EventPeriod | null>;
  /** 영향받은 상품의 재검수를 건다 (FR-MO-013). 없으면 알림만 만든다 */
  readonly requestAudit?: (productId: number) => Promise<void>;
}

@Injectable()
export class SyncBatchJob {
  private readonly logger = new Logger(SyncBatchJob.name);
  private readonly kto: () => KtoClient;
  private readonly state: BatchStateRepository;
  private readonly clock: () => Date;
  private readonly hasBudget: () => boolean | Promise<boolean>;
  private readonly notifications: NotificationRepository | null;
  private readonly eventPeriod: SyncBatchOptions['eventPeriod'];
  private readonly requestAudit: SyncBatchOptions['requestAudit'];

  constructor(options: SyncBatchOptions) {
    this.kto = typeof options.kto === 'function' ? options.kto : (): KtoClient => options.kto as KtoClient;
    this.state = options.state;
    this.clock = options.clock ?? ((): Date => new Date());
    this.hasBudget = options.hasBudget ?? ((): boolean => true);
    this.notifications = options.notifications ?? null;
    this.eventPeriod = options.eventPeriod;
    this.requestAudit = options.requestAudit;
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

    if (!setting.batchEnabled) return this.skip('DISABLED');
    // 주말 분은 월요일 배치가 날짜를 순회하며 함께 가져간다 (FR-MO-010)
    if (isWeekend(now)) return this.skip('WEEKEND');

    const previous = await this.state.find();
    const dates = pendingDates(previous.lastCovered, now);
    if (dates.length === 0) return this.skip('NO_DATES');

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
        page = await this.kto().areaBasedSyncList({ modifiedDate: toKtoDate(date) });
        calls++;
      } catch (e) {
        this.logger.error(`동기화 목록 조회 실패 (${date}): ${isKtoError(e) ? e.reasonCode : '알 수 없음'}`);
        // 실패한 날짜는 넘기지 않는다. 다음 배치가 그 날부터 다시 본다
        await this.record('FAILED', contents.length, now, covered);
        return { status: 'FAILED', dates, contents, covered, calls, skippedReason: null, impacts: [], notified: 0 };
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

    // ── 2단계 ──
    const { impacts, notified } = await this.findImpacts(contents, now);
    return { status, dates, contents, covered, calls, skippedReason: null, impacts, notified };
  }

  /**
   * [2단계] 변경분이 어느 상품에 닿는지 찾고 알림을 만든다 (FR-MO-013 · 030 ~ 032).
   *
   * ## 세 조건의 값이 어디서 오는가
   *
   * ```
   * 1  일정에 포함   우리 DB 만 본다             공사 콜 0
   * 2  같은 시군구   동기화 목록에 이미 있다      공사 콜 0
   * 3  행사기간      상세 재호출이 있어야 안다    행사(15) 건수만큼
   * ```
   *
   * 그래서 상세 재호출은 **행사에만** 건다. 실측 하루 177건 중 34건이 행사였다.
   *
   * 실패해도 배치 결과를 뒤집지 않는다 — 1단계는 이미 성공했고 `last_covered` 도 올라갔다.
   * 여기서 던지면 다음 배치가 같은 날짜를 다시 봐 1단계를 두 번 돌게 된다.
   */
  private async findImpacts(
    contents: readonly SyncedContent[],
    now: Date,
  ): Promise<{ impacts: readonly Impact[]; notified: number }> {
    if (this.notifications === null || contents.length === 0) return { impacts: [], notified: 0 };

    const today = kstToday(now);
    try {
      // 조건 1 — 한 번에 묻는다. 콘텐츠마다 물으면 하루 177번 왕복한다
      const direct = await this.notifications.productsWithContents(contents.map((c) => c.contentId), today);
      // 조건 2 · 3 — 출발일이 안 지난 상품 전부가 후보다 (FR-MO-018)
      const watched = await this.notifications.watchedProducts(today);

      if (direct.size === 0 && watched.length === 0) {
        this.logger.log(`변경 ${contents.length}건 · 감시 중인 상품이 없다`);
        return { impacts: [], notified: 0 };
      }

      const periods = await this.eventPeriodsOf(contents, watched.length > 0);
      const pending: NotificationToSave[] = [];
      const allImpacts: Impact[] = [];

      for (const content of contents) {
        const changed: ChangedContent = {
          ...content,
          eventPeriod: periods.get(content.contentId) ?? null,
          // 지문은 아직 안 만든다. 이 값들이 비면 FR-MO-036 재노출 차단이 안 걸린다
          hashFrom: null,
          hashTo: null,
        };
        const impacts = mergeImpacts(
          matchByContent(direct.get(content.contentId) ?? []),
          matchByRegion(changed, watched, today),
          matchByEventPeriod(changed, watched),
        );
        allImpacts.push(...impacts);
        pending.push(...impacts.map((i) => toNotification(i, changed)));
      }

      const notified = await this.notifications.insertMany(pending);
      this.logger.log(`영향 ${allImpacts.length}건 · 새 알림 ${notified}건`);

      // 조건 1 에 걸린 상품만 재검수한다. 그 콘텐츠가 실제로 일정에 들어 있다
      await this.reaudit(allImpacts);
      return { impacts: allImpacts, notified };
    } catch (e) {
      this.logger.error(`영향 탐색에 실패했다. 1단계 결과는 그대로다: ${(e as Error).message}`);
      return { impacts: [], notified: 0 };
    }
  }

  /**
   * 행사 개최 기간을 모은다 (조건 3).
   *
   * **예산이 떨어지면 거기서 멈추고 몇 건을 못 봤는지 남긴다.** 조용히 자르면 조건 3 이
   * 안 걸린 것인지 안 본 것인지 구분이 안 된다.
   */
  private async eventPeriodsOf(
    contents: readonly SyncedContent[],
    hasWatched: boolean,
  ): Promise<ReadonlyMap<string, EventPeriod>> {
    const out = new Map<string, EventPeriod>();
    // 감시 중인 상품이 없으면 기간을 알아도 걸릴 곳이 없다
    if (this.eventPeriod === undefined || !hasWatched) return out;

    // 응답은 문자열로 온다. 빈 값은 0 이 돼 걸리지 않는다
    const festivals = contents.filter((c) => Number(c.contentTypeId) === FESTIVAL_TYPE_ID);
    let seen = 0;
    for (const festival of festivals) {
      if (!(await this.hasBudget())) break;
      seen++;
      try {
        const period = await this.eventPeriod(festival.contentId);
        if (period !== null) out.set(festival.contentId, period);
      } catch (e) {
        // 한 건이 실패해도 나머지는 본다. 조건 3 만 물러난다
        this.logger.warn(`행사 ${festival.contentId} 기간을 못 읽었다: ${(e as Error).message}`);
      }
    }

    if (seen < festivals.length) {
      this.logger.warn(`예산이 남지 않아 행사 ${festivals.length - seen}건의 기간을 못 봤다 (조건 3 미판정)`);
    }
    return out;
  }

  /** 조건 1 상품만 재검수를 건다 (FR-MO-013). 한 상품이 여러 번 걸려도 한 번만 */
  private async reaudit(impacts: readonly Impact[]): Promise<void> {
    if (this.requestAudit === undefined) return;
    const targets = [...new Set(impacts.filter((i) => i.condition === 1).map((i) => i.productId))];
    for (const productId of targets) {
      try {
        await this.requestAudit(productId);
      } catch (e) {
        // 한 상품이 실패해도 나머지는 건다
        this.logger.error(`상품 ${productId} 재검수를 걸지 못했다: ${(e as Error).message}`);
      }
    }
  }

  private skip(reason: SkipReason): SyncBatchResult {
    this.logger.log(`배치를 건너뛴다 — ${SKIP_MESSAGE[reason]}`);
    // 건너뛴 것은 실행이 아니다. 상태를 건드리지 않는다
    return { status: 'OK', dates: [], contents: [], covered: null, calls: 0, skippedReason: reason, impacts: [], notified: 0 };
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
    ldongRegnCd: code(item.lDongRegnCd),
    ldongSignguCd: code(item.lDongSignguCd),
  };
}

/**
 * 행사 상세 → 개최 기간 (조건 3 · FR-MO-030 ③).
 *
 * `YYYYMMDD` 로 온다. **한쪽이라도 없거나 날짜가 아니면 `null` 이다** — 기간을 모르는 것을
 * 「안 겹친다」로 읽지 않는다. 모르면 조건 3 만 판정하지 않고 넘어간다.
 */
export function toEventPeriod(detail: Record<string, unknown>): EventPeriod | null {
  const start = toIsoDay(detail.eventstartdate);
  const end = toIsoDay(detail.eventenddate);
  return start === null || end === null ? null : { start, end };
}

function toIsoDay(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!/^\d{8}$/.test(raw)) return null;
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  // 20261352 같은 값을 날짜로 받아들이지 않는다
  return parseIsoDate(iso) === null ? null : iso;
}

/** 빈 문자열은 없는 것이다. `''` 끼리 같다고 봐서 엉뚱한 지역이 묶이면 안 된다 */
function code(value: unknown): string | null {
  const s = value === undefined || value === null ? '' : String(value).trim();
  return s === '' ? null : s;
}

/**
 * 알림 본문 (FR-MO-033).
 *
 * ⚠️ **공사 원문을 담지 않는다.** 상품명 · 관광지명은 화면이 자기 데이터로 채운다 —
 *    여기 담으면 알림 테이블에 원문이 남는다 (FR-MO-002).
 */
function toNotification(impact: Impact, content: ChangedContent): NotificationToSave {
  return {
    productId: impact.productId,
    kind: impact.kind,
    condition: impact.condition,
    ktoContentId: content.contentId,
    hashFrom: content.hashFrom,
    hashTo: content.hashTo,
    body: {
      condition: impact.condition,
      contentTypeId: content.contentTypeId,
      modifiedTime: content.modifiedTime,
      // 비표출 전환은 R06 이 차단으로 판정한다. 알림에도 그 사실을 남긴다
      hidden: content.showFlag === '0',
    },
  };
}
