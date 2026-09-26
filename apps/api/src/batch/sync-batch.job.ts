import { Injectable, Logger } from '@nestjs/common';
import type { KtoClient } from '../external/kto';
import { parseIsoDate } from '../engine/calendar/dates';
import {
  buildContentFingerprint, compareFingerprint, isSupportedContentTypeId, type FingerprintSnapshot,
} from '../engine/fingerprint';
import { isKtoError } from '../external/kto';
import type { BatchState, BatchStateRepository, BatchStatus } from '../persistence/batch-state.repository';
import type {
  NotificationRepository, NotificationToSave, RegisteredContent,
} from '../persistence/notification.repository';
import {
  matchByContent, matchByEventPeriod, matchByRegion, mergeImpacts,
  type ChangedContent, type EventPeriod, type Impact, type ImpactCandidate,
} from './impact-finder';
import {
  addClock, capOpportunities, departureOf, dwellOf, isNewlyRegistered, matchByDetour, matchByFreeSlot, matchByMissingType,
  pickSlot, precheckSlot, roundRobinByAccount, type Leg, type OpportunityCandidate, type PickedSlot,
} from './opportunity';
import { isSyncDelay, isWeekend, kstToday, pendingDates, toKtoDate } from './sync-window';

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
 *
 * 예외는 목록이 페이지 상한을 넘은 날 하나다 (FR-MO-016). 그 날은 목록을 끝까지 읽을 수 없어
 * 등록 상품의 콘텐츠만 하나씩 확인한다 (`confirmRegistered`).
 */

/** 행사 유형. 이 유형만 개최 기간이 있다 (조건 3) */
export const FESTIVAL_TYPE_ID = 15 as const;

/**
 * 동기화 목록을 한 날짜에 몇 페이지까지 읽는가 (FR-MO-016 · #773). 한 페이지가 1,000건이라
 * 20페이지면 2만 건이다 — 실측 최대는 2026-07-28 의 3,206건이었다. 넘는 날은 `HIDDEN_OVERFLOW`
 * 로 남기고 목록 대신 등록 상품의 콘텐츠를 하나씩 확인한다 (`confirmRegistered` · #866).
 */
export const SYNC_PAGE_LIMIT = 20;

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
  /**
   * 신분류체계 중분류. 기회 알림 조건 4 가 쓴다 (FR-MO-030 ④).
   *
   * 목록 응답에 이미 있다 — 조건 2 의 시군구와 같이 상세 재호출이 필요 없다.
   */
  readonly lclsSystm2: string | null;
  /** 좌표. 기회 알림 조건 6 이 쓴다. 원문이 아니라 수치다 */
  readonly mapX: number | null;
  readonly mapY: number | null;
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
   * 콘텐츠 상세(`detailIntro2`)를 가져온다.
   *
   * 한 번 부르면 **행사기간(조건 3)과 지문(FR-MO-036)이 둘 다** 나온다 — 검수 러너도 같은
   * 응답 하나로 지문을 만든다 (`audit-runner` 3단계). 그래서 콘텐츠당 한 번만 부른다.
   *
   * 부르는 대상은 **행사(15)** 와 **조건 1 에 걸린 것**뿐이다. 시군구는 동기화 목록에
   * 이미 있어 조건 2 는 공짜다.
   *
   * 없으면 조건 3 과 지문 비교가 물러난다 — 알림은 그대로 만든다.
   */
  readonly fetchDetail?: (contentId: string, contentTypeId: number) => Promise<Record<string, unknown>>;
  /**
   * 그 상품이 직전 검수에서 만든 지문 (FR-RU-060).
   *
   * **상품 단위다.** 콘텐츠 전역 최신 지문을 쓰면, 다른 상품이 먼저 검수해 지문을 갱신한
   * 변경을 이 상품 사용자는 못 본 채로 「안 바뀌었다」고 넘긴다.
   */
  readonly previousFingerprints?: (productId: number) => Promise<ReadonlyMap<string, FingerprintSnapshot>>;
  /** 영향받은 상품의 재검수를 건다 (FR-MO-013). 없으면 알림만 만든다 */
  readonly requestAudit?: (productId: number) => Promise<void>;
  /** 감시 대상 상한 — **계정별**이다 (#690). 안 주면 환경변수 (FR-MO-020) */
  readonly watchLimit?: number;
  /**
   * 두 지점 사이 차로 걸리는 시간 (UI-S7-008 · FR-MO-052). 새 소식의 넣을 자리를 미리 볼 때만 쓴다.
   *
   * 그 구간만 못 재면(경로 없음 · 요청 오류) null 이다 — 직선거리로 짓지 않는다 (EI-KM-009).
   * **제공자가 응답하지 않으면(시간 초과 · 연결 실패 · 5xx) 던진다.** 사전 확인은 거기서 멈춘다 —
   * 검수 러너의 전면 장애 판단과 같다 (EX-EI-022). 없으면 사전 확인을 하지 않는다.
   */
  readonly travel?: (from: { x: number; y: number }, to: { x: number; y: number }, departureAt: string | null) => Promise<Leg | null>;
  /** 사전 확인 전체에 쓰는 시간 상한 (ms). 테스트가 줄인다. 안 주면 `PRECHECK_BUDGET_MS` */
  readonly precheckBudgetMs?: number;
}

/**
 * 한 번 도는 배치가 사전 확인하는 새 소식 수 (UI-S7-008). 한 건에 길찾기가 많아야 세 번이다.
 * 상품당 상한(`OPPORTUNITY_CAP_PER_PRODUCT`)을 지난 알림만 세고, 계정마다 돌아가며 나눈다.
 */
export const PRECHECK_LIMIT_PER_RUN = 20;

/**
 * 사전 확인 전체에 쓰는 시간 상한 (ms). 넘으면 남은 새 소식은 사전 확인 없이 넣는다.
 *
 * 카카오가 느리면 `route()` 한 번이 40초를 넘는다(미래 운행 1번 + 현재 시각 3번, 각 10초 + 대기).
 * 상한이 없으면 스무 건 × 세 구간 동안 새 소식이 들어가지 않는다. 바뀐 정보는 사전 확인 전에 넣는다.
 */
export const PRECHECK_BUDGET_MS = 60_000;

/** 사전 확인 시간을 다 썼다 */
class PrecheckTimeUp extends Error {
  constructor() {
    super('사전 확인 시간 상한');
    this.name = 'PrecheckTimeUp';
  }
}

/** 넣을 자리를 잡은 새 소식 — 좌표는 사전 확인에만 쓰고 알림에 남기지 않는다 */
interface Slotted {
  readonly picked: PickedSlot;
  readonly candidate: OpportunityCandidate;
  readonly content: SyncedContent;
}

/**
 * 감시 대상 상품 수 상한 (FR-MO-020). **계정마다** 출발일 임박순으로 이만큼 본다 (#690).
 *
 * **설정 화면 항목이 아니다.** FR-OP-021 이 설정을 10종으로 못박았고 FR-OP-024 는 전역 값을
 * 「배치 실행 시각 · 일일 호출 예산」 둘로 한정한다. FR-MO-020 자체가 「개발 기간 중」으로
 * 한정한 운영 가드라 환경변수로 둔다 — DB 도 설정 API 도 건드리지 않는다.
 */
export const DEFAULT_BATCH_WATCH_LIMIT = 10;

export function readWatchLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BATCH_WATCH_LIMIT);
  // 0 이나 음수는 「감시 안 함」이 아니라 설정 실수다. 기본값으로 돌린다
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_BATCH_WATCH_LIMIT;
}

@Injectable()
export class SyncBatchJob {
  private readonly logger = new Logger(SyncBatchJob.name);
  private readonly kto: () => KtoClient;
  private readonly state: BatchStateRepository;
  private readonly clock: () => Date;
  private readonly hasBudget: () => boolean | Promise<boolean>;
  private readonly notifications: NotificationRepository | null;
  private readonly fetchDetail: SyncBatchOptions['fetchDetail'];
  private readonly previousFingerprints: SyncBatchOptions['previousFingerprints'];
  private readonly requestAudit: SyncBatchOptions['requestAudit'];
  private readonly watchLimit: number;
  private readonly travel: SyncBatchOptions['travel'];
  private readonly precheckBudgetMs: number;

  constructor(options: SyncBatchOptions) {
    this.kto = typeof options.kto === 'function' ? options.kto : (): KtoClient => options.kto as KtoClient;
    this.state = options.state;
    this.clock = options.clock ?? ((): Date => new Date());
    this.hasBudget = options.hasBudget ?? ((): boolean => true);
    this.notifications = options.notifications ?? null;
    this.fetchDetail = options.fetchDetail;
    this.previousFingerprints = options.previousFingerprints;
    this.requestAudit = options.requestAudit;
    this.watchLimit = options.watchLimit ?? readWatchLimit();
    this.travel = options.travel;
    this.precheckBudgetMs = options.precheckBudgetMs ?? PRECHECK_BUDGET_MS;
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
    /** 페이지 상한을 넘은 날. 순회는 여기서 멈추고 개별 확인으로 넘어간다 */
    let overflowDay: string | null = null;

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
       * 어제가 평일인데 0건이면 동기화 지연 신호다 (FR-MO-015). `last_covered` 를 올리지 않고
       * 멈춰 다음 배치가 그 날짜를 다시 본다. 공사가 그날 분을 아직 안 올렸을 수 있어서다 —
       * 건수는 조회 시각에 따라 크게 변한다 (EI-KT-011).
       *
       * 주말과 이틀 이상 지난 날의 0건은 변경이 없는 날이다. 처리한 것으로 치고 넘어간다
       * (`isSyncDelay`).
       */
      if (page.items.length === 0) {
        if (isSyncDelay(date, now)) {
          emptyDay = date;
          break;
        }
        this.logger.log(`${date} 조회가 0건이다. 주말 · 공휴일로 보고 넘어간다`);
        covered = date;
        continue;
      }

      /*
       * 그날 변경이 한 페이지(1,000건)를 넘으면 이어서 읽는다 (FR-MO-016 · #773). 전에는
       * 1페이지만 읽어 뒤쪽의 표출 중단 · 변경을 놓쳤고, 놓쳤다는 기록도 없었다.
       *
       * 도중에 예산이 떨어지면 **그 날짜를 통째로 다음 배치로 넘긴다.** 읽은 데까지만 처리하고
       * `last_covered` 를 올리면 나머지를 영영 못 본다.
       */
      const dayItems = [...page.items];
      const total = page.totalCount ?? dayItems.length;
      /*
       * 상한을 넘는 날은 첫 쪽의 `totalCount` 로 이미 안다 (EX-MO-003 · #866). 20쪽을 읽고 나서
       * 버리면 콜만 쓴다 — 그 날에서 순회를 멈추고 개별 확인으로 간다.
       */
      if (Math.ceil(total / Math.max(page.numOfRows ?? 0, dayItems.length)) > SYNC_PAGE_LIMIT) {
        overflowDay = date;
        break;
      }
      let pageNo = 1;
      let budgetOut = false;
      while (dayItems.length < total && pageNo < SYNC_PAGE_LIMIT) {
        if (!(await this.hasBudget())) {
          budgetOut = true;
          break;
        }
        pageNo++;
        let next;
        try {
          next = await this.kto().areaBasedSyncList({ modifiedDate: toKtoDate(date), pageNo });
          calls++;
        } catch (e) {
          this.logger.error(`동기화 목록 조회 실패 (${date} · ${pageNo}쪽): ${isKtoError(e) ? e.reasonCode : '알 수 없음'}`);
          await this.record('FAILED', contents.length, now, covered);
          return { status: 'FAILED', dates, contents, covered, calls, skippedReason: null, impacts: [], notified: 0 };
        }
        if (next.items.length === 0) break;
        dayItems.push(...next.items);
      }
      if (budgetOut) {
        this.logger.warn(`예산이 남지 않아 ${date} 를 끝까지 읽지 못했다. 그 날부터 다음 배치로 넘긴다`);
        break;
      }
      // 쪽마다 덜 채워 와 상한까지 읽고도 모자라면 이것도 넘친 날이다 — 읽은 데까지로 끝내지 않는다
      if (dayItems.length < total && pageNo >= SYNC_PAGE_LIMIT) {
        overflowDay = date;
        break;
      }

      contents.push(...dayItems.map(toSyncedContent));
      covered = date;
    }

    /*
     * 넘친 날은 등록 상품의 콘텐츠를 하나씩 본다 (FR-MO-016 · EX-MO-003). **다 본 뒤에만** 그
     * 날짜를 처리한 것으로 친다 — 못 다 보면 `last_covered` 가 앞 날짜에 머물러 다음 배치가
     * 그 날짜부터 다시 본다.
     */
    let checked: Confirmation = NOT_CONFIRMED;
    if (overflowDay !== null) {
      this.logger.error(
        `${overflowDay} 변경이 페이지 상한(${SYNC_PAGE_LIMIT}쪽)을 넘는다 (BATCH_HIDDEN_OVERFLOW). 등록 상품의 콘텐츠를 하나씩 확인한다`,
      );
      checked = await this.confirmRegistered(overflowDay, now);
      if (checked.done) covered = overflowDay;
    }

    const status: BatchStatus = overflowDay !== null
      ? 'HIDDEN_OVERFLOW'
      : emptyDay !== null && covered === null ? 'EMPTY' : 'OK';
    if (emptyDay !== null) {
      this.logger.warn(`${emptyDay}(어제 · 평일) 조회가 0건이다. 다음 배치가 다시 보도록 last_covered 를 올리지 않는다 (FR-MO-015)`);
    }
    await this.record(status, contents.length, now, covered);

    // ── 2단계 ── 넘친 날 앞의 날짜들. 넘친 날의 목록은 쓰지 않는다 — 개별 확인이 그 몫이다
    const { impacts, notified } = await this.findImpacts(contents, now, dates[0] ?? null);
    return {
      status, dates, contents, covered, calls, skippedReason: null,
      impacts: [...checked.impacts, ...impacts],
      notified: checked.notified + notified,
    };
  }

  /**
   * 페이지 상한을 넘은 날 — 목록 대신 등록 상품의 콘텐츠를 하나씩 확인한다 (FR-MO-016 · EX-MO-003).
   *
   * 여행이 끝나지 않은 등록 상품(조건 1 후보와 같은 범위)의 콘텐츠마다 소개정보를 한 번 부르고,
   * 한 콜씩 예산 문을 지난다.
   *
   *   · **없는 곳은 표출 중단이다.** 공사는 숨은 곳을 「없는 곳」 으로 답한다(#745). 알림에
   *     `hidden` 을 남기면 재검수가 그 기록으로 R06-b 차단을 낸다. 이미 표출 중단으로 남긴
   *     곳이면 다시 알리지 않는다
   *   · 있는 곳은 그 상품의 직전 지문과 견준다 — 조건 1 과 같은 판정(`judge`)이다
   *
   * **전부 확인해야 `done` 이다.** 예산이 떨어지거나 한 곳이라도 못 읽으면 그 날짜를 처리한 것으로
   * 치지 않는다. 다음 배치가 다시 확인해도 같은 변경은 `change_key` 가 같아 두 번 들어가지 않는다.
   */
  private async confirmRegistered(date: string, now: Date): Promise<Confirmation> {
    const notifications = this.notifications;
    const fetchDetail = this.fetchDetail;
    if (notifications === null || fetchDetail === undefined) {
      this.logger.warn(`${date} 을 개별 확인할 수 없다 (알림 저장소 · 상세 조회 없음). 그 날부터 다음 배치로 넘긴다`);
      return NOT_CONFIRMED;
    }

    const today = kstToday(now);
    try {
      const targets = (await notifications.registeredContents(today))
        .filter((t) => isSupportedContentTypeId(t.contentTypeId));
      const direct = await notifications.productsWithContents(targets.map((t) => t.contentId), today);
      const previous = new Map<number, ReadonlyMap<string, FingerprintSnapshot>>();
      const hiddenBefore = new Map<number, ReadonlySet<string>>();
      const pending: NotificationToSave[] = [];
      const impacts: Impact[] = [];
      const toReaudit = new Set<number>();
      let done = true;
      let seen = 0;

      for (const target of targets) {
        if (!(await this.hasBudget())) {
          done = false;
          break;
        }
        let detail: Record<string, unknown> | null = null;
        try {
          detail = await fetchDetail(target.contentId, target.contentTypeId);
        } catch (e) {
          if (!isKtoError(e) || e.reasonCode !== 'CONTENT_NOT_FOUND') {
            // 못 읽은 곳을 「안 바뀌었다」 로 넘기지 않는다 (FR-RU-051). 그 날짜는 끝난 것이 아니다
            this.logger.warn(`콘텐츠 ${target.contentId} 를 확인하지 못했다: ${isKtoError(e) ? e.reasonCode : '알 수 없음'}`);
            done = false;
            continue;
          }
        }
        seen++;

        const content = registeredContent(target, detail);
        for (const { productId } of direct.get(target.contentId) ?? []) {
          let decision: { notify: boolean; reaudit: boolean; hashes: ChangeHashes };
          if (detail === null) {
            let known = hiddenBefore.get(productId);
            if (known === undefined) {
              known = await notifications.hiddenContentIds(productId);
              hiddenBefore.set(productId, known);
            }
            if (known.has(target.contentId)) continue;
            decision = UNKNOWN_CHANGE;
          } else {
            decision = await this.judge(productId, content, detail, previous);
          }
          if (decision.reaudit) toReaudit.add(productId);
          if (!decision.notify) continue;

          const impact: Impact = { productId, condition: 1, kind: 'RISK' };
          impacts.push(impact);
          /*
           * 지문이 있으면 조건 1 과 같은 키다 — 목록으로 먼저 본 같은 변경과 겹치지 않는다. 없으면
           * (표출 중단 · 지문을 못 만듦) 목록의 수정 시각이 없으니 확인한 날짜로 묶는다.
           */
          const changeKey = decision.hashes.to !== null
            ? changeKeyOf(content, decision.hashes)
            : `CHECKED:${date}`;
          pending.push(toNotification(impact, content, decision.hashes, changeKey));
        }
      }

      const notified = pending.length === 0 ? 0 : await notifications.insertMany(pending);
      this.logger.log(
        `${date} 개별 확인 ${seen}/${targets.length}곳 · 영향 ${impacts.length}건 · 새 알림 ${notified}건`
        + (done ? '' : ' · 다 보지 못해 다음 배치가 다시 본다'),
      );
      await this.reaudit([...toReaudit]);
      return { done, impacts, notified };
    } catch (e) {
      this.logger.error(`${date} 개별 확인에 실패했다: ${(e as Error).message}`);
      return NOT_CONFIRMED;
    }
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
    /** 이번 배치가 본 첫 날짜. 그 뒤에 등록된 곳만 기회 알림(4 ~ 6) 대상이다 */
    newSince: string | null,
  ): Promise<{ impacts: readonly Impact[]; notified: number }> {
    if (this.notifications === null || contents.length === 0) return { impacts: [], notified: 0 };

    const today = kstToday(now);
    try {
      // 조건 1 — 한 번에 묻는다. 콘텐츠마다 물으면 하루 177번 왕복한다
      const direct = await this.notifications.productsWithContents(contents.map((c) => c.contentId), today);
      // 조건 2 · 3 — 출발일이 안 지난 상품 전부가 후보다 (FR-MO-018)
      const watched = await this.notifications.watchedProducts(today, this.watchLimit);
      /*
       * 조건 4 ~ 6 — 새로 등록된 곳이 있을 때만 상품 속(결손 유형 · 일정)을 읽는다 (FR-MO-030 ④⑤⑥).
       * 오래 세워 두었던 판정 함수를 여기서 부른다. 전에는 아무도 부르지 않아 새 소식이 늘 0건이었다 (#616).
       */
      const fresh = newSince === null ? [] : contents.filter((c) => isNewlyRegistered(c, newSince));
      const opportunity: readonly OpportunityCandidate[] = fresh.length > 0 && watched.length > 0
        ? await this.notifications.opportunityCandidates(watched)
        : [];

      if (direct.size === 0 && watched.length === 0) {
        this.logger.log(`변경 ${contents.length}건 · 감시 중인 상품이 없다`);
        return { impacts: [], notified: 0 };
      }

      const details = await this.fetchDetails(contents, direct, watched.length > 0);
      const previous = new Map<number, ReadonlyMap<string, FingerprintSnapshot>>();
      const pending: NotificationToSave[] = [];
      // 새 소식마다 잡은 넣을 자리. 사전 확인에서 앞뒤 좌표를 다시 쓴다 (UI-S7-008)
      const slotted = new Map<NotificationToSave, Slotted>();
      const allImpacts: Impact[] = [];
      const toReaudit = new Set<number>();
      let unchanged = 0;

      for (const content of contents) {
        const detail = details.get(content.contentId) ?? null;
        const changed: ChangedContent = {
          ...content,
          eventPeriod: detail === null ? null : toEventPeriod(detail),
        };

        /*
         * 조건 1 은 **상품마다 따로 본다.** 직전 지문이 상품별이라, 같은 콘텐츠라도 한
         * 상품에는 「안 바뀌었다」이고 다른 상품에는 「처음 본다」일 수 있다.
         */
        const kept: ImpactCandidate[] = [];
        const hashes = new Map<number, ChangeHashes>();
        /*
         * 조건 1 에서 「안 바뀌었다」 로 넘긴 상품 (#704). **그 곳을 일정에 넣은 상품은 조건 1 의
         * 판정이 전부다.** 이걸 기억하지 않으면 바로 아래 조건 2 · 3 이 같은 콘텐츠로 같은 상품을
         * 다시 잡는다 — 일정에 든 행사가 지문은 그대로인데 「행사 정보가 바뀌었습니다」 로 나갔다.
         */
        const settled = new Set<number>();
        for (const candidate of direct.get(content.contentId) ?? []) {
          const decision = await this.judge(candidate.productId, changed, detail, previous);
          if (decision.reaudit) toReaudit.add(candidate.productId);
          if (!decision.notify) {
            unchanged++;
            settled.add(candidate.productId);
            continue;
          }
          kept.push(candidate);
          hashes.set(candidate.productId, decision.hashes);
        }
        const others = settled.size === 0 ? watched : watched.filter((c) => !settled.has(c.productId));

        const dwell = dwellOf(content.lclsSystm2);
        const chances = opportunity.length > 0 && fresh.includes(content)
          ? [
            ...matchByMissingType(content, opportunity),
            ...matchByFreeSlot(content, opportunity, dwell),
            ...matchByDetour(content, opportunity, dwell),
          ]
          : [];
        // 같은 곳이 한 상품에 여러 조건으로 걸리면 번호가 작은 것 하나만 남는다 — 바뀐 정보가 새 소식을 이긴다
        const impacts = mergeImpacts(
          matchByContent(kept),
          matchByRegion(changed, others, today),
          matchByEventPeriod(changed, others),
          chances,
        );
        allImpacts.push(...impacts);
        for (const impact of impacts) {
          const n = toNotification(impact, changed, hashes.get(impact.productId) ?? NO_HASHES);
          const candidate = impact.kind === 'OPPORTUNITY' ? opportunity.find((c) => c.productId === impact.productId) : undefined;
          if (candidate === undefined) {
            pending.push(n);
            continue;
          }
          // 넣을 자리 (0콜). 못 잡았으면 그 까닭을 남긴다 — 모르는 것과 없는 것이 다르다
          const picked = pickSlot(content, candidate, dwell);
          if (typeof picked === 'string') {
            pending.push({ ...n, body: { ...n.body, slotMissing: picked } });
            continue;
          }
          const withSlot = { ...n, body: { ...n.body, slot: picked.slot } };
          slotted.set(withSlot, { picked, candidate, content });
          pending.push(withSlot);
        }
      }

      // 기회 알림은 상품마다 상한까지만 넣는다. 바뀐 정보는 자르지 않는다
      const risks = pending.filter((n) => n.kind === 'RISK');
      const { kept: chancesKept, dropped } = capOpportunities(
        pending
          .filter((n) => n.kind === 'OPPORTUNITY')
          .map((n) => ({ productId: n.productId, condition: n.condition as 4 | 5 | 6, contentId: n.ktoContentId ?? '', notification: n })),
      );
      if (dropped > 0) this.logger.log(`기회 알림 ${dropped}건은 상품당 상한을 넘어 넣지 않았다`);
      /*
       * 바뀐 정보 · 표출 중단을 먼저 넣고 재검수를 건다. `last_covered` 는 이미 올라갔다 — 새 소식의
       * 사전 확인(길찾기)이 느리거나 막힌 사이 프로세스가 다시 뜨면 그날 알림이 영영 사라진다.
       */
      const riskNotified = risks.length === 0 ? 0 : await this.notifications.insertMany(risks);
      await this.reaudit([...toReaudit]);
      const checked = await this.precheck(chancesKept.map((c) => c.notification), slotted);
      const chanceNotified = checked.length === 0 ? 0 : await this.notifications.insertMany(checked);
      const notified = riskNotified + chanceNotified;
      this.logger.log(
        `영향 ${allImpacts.length}건 · 새 알림 ${notified}건`
        + (unchanged > 0 ? ` · 판정 필드가 그대로라 넘긴 것 ${unchanged}건` : ''),
      );
      return { impacts: allImpacts, notified };
    } catch (e) {
      this.logger.error(`영향 탐색에 실패했다. 1단계 결과는 그대로다: ${(e as Error).message}`);
      return { impacts: [], notified: 0 };
    }
  }

  /**
   * 넣을 자리를 길찾기로 미리 본다 (UI-S7-008 · FR-MO-052).
   *
   * 상한 안에 든 새 소식만, 한 배치에 `PRECHECK_LIMIT_PER_RUN` 건까지 **계정마다 돌아가며** 본다.
   * 대중교통이거나 이동수단을 모르면 부르지 않는다 (EI-KM-007). 제공자가 응답하지 않으면(시간 초과 ·
   * 연결 실패 · 5xx) 첫 실패에서 멈추고, 전체가 `precheckBudgetMs` 를 넘어도 멈춘다 — 검수 러너의
   * 전면 장애 판단과 같다 (EX-EI-022). 못 본 알림은 사전 확인 없이 들어간다 — 화면이 「넣은 뒤 다시
   * 검수에서 확인」으로 적는다. **던지지 않는다.**
   */
  private async precheck(
    items: readonly NotificationToSave[],
    slotted: ReadonlyMap<NotificationToSave, Slotted>,
  ): Promise<NotificationToSave[]> {
    const travel = this.travel;
    if (travel === undefined) return [...items];
    const eligible = items.filter((n) => {
      const transport = slotted.get(n)?.candidate.transport;
      return transport === 'CAR' || transport === 'CHARTER_BUS';
    });
    const turns = roundRobinByAccount(eligible, (n) => accountKeyOf(slotted.get(n) as Slotted)).slice(0, PRECHECK_LIMIT_PER_RUN);

    const deadline = Date.now() + this.precheckBudgetMs;
    const timed: NonNullable<SyncBatchOptions['travel']> = (from, to, departureAt) =>
      beforeDeadline(() => travel(from, to, departureAt), deadline);
    const checked = new Map<NotificationToSave, NotificationToSave>();
    for (const n of turns) {
      const found = slotted.get(n) as Slotted;
      let legs: Awaited<ReturnType<typeof measureLegs>>;
      try {
        legs = await measureLegs(found, timed);
      } catch (e) {
        // 문구만 남긴다 — 제공자 오류 문장에는 요청 값이 섞이지 않지만 굳이 옮기지 않는다 (EI-CM-002)
        const why = e instanceof PrecheckTimeUp ? `${String(this.precheckBudgetMs)}ms 상한` : '길찾기가 응답하지 않음';
        this.logger.warn(`새 소식 사전 확인을 멈춘다 (${why}) — ${String(checked.size)}/${String(turns.length)}건만 봤다. 나머지는 사전 확인 없이 넣는다`);
        break;
      }
      checked.set(n, { ...n, body: { ...n.body, precheck: precheckSlot(found.picked.slot, legs) } });
    }
    return items.map((n) => checked.get(n) ?? n);
  }

  /**
   * 상세를 모은다. **콘텐츠당 한 번**이다.
   *
   * 부르는 대상은 둘 — 행사(15)는 개최 기간(조건 3)이 필요하고, 조건 1 에 걸린 것은
   * 지문 비교가 필요하다. 한 응답으로 둘 다 나온다.
   *
   * **예산이 떨어지면 거기서 멈추고 몇 건을 못 봤는지 남긴다.** 조용히 자르면 조건이
   * 안 걸린 것인지 안 본 것인지 구분이 안 된다.
   */
  private async fetchDetails(
    contents: readonly SyncedContent[],
    direct: ReadonlyMap<string, readonly ImpactCandidate[]>,
    hasWatched: boolean,
  ): Promise<ReadonlyMap<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    if (this.fetchDetail === undefined) return out;

    // 유형은 문자열로 온다. 빈 값은 0 이 돼 행사로 안 걸린다
    const targets = contents.filter((c) =>
      direct.has(c.contentId) || (hasWatched && Number(c.contentTypeId) === FESTIVAL_TYPE_ID));

    let seen = 0;
    for (const target of targets) {
      if (!(await this.hasBudget())) break;
      seen++;
      try {
        out.set(target.contentId, await this.fetchDetail(target.contentId, Number(target.contentTypeId)));
      } catch (e) {
        // 한 건이 실패해도 나머지는 본다. 그 콘텐츠만 지문·기간 없이 간다
        this.logger.warn(`콘텐츠 ${target.contentId} 상세를 못 읽었다: ${(e as Error).message}`);
      }
    }

    if (seen < targets.length) {
      this.logger.warn(`예산이 남지 않아 상세 ${targets.length - seen}건을 못 봤다 (조건 3 · 지문 비교 미판정)`);
    }
    return out;
  }

  /**
   * 이 상품에 이 변경을 알릴 것인가 (FR-MO-036 · DR-FP-011).
   *
   * 지문을 만들어 그 상품의 직전 지문과 비교한다. **공사가 사진이나 설명만 고쳐도
   * `modifiedtime` 은 올라간다** — 판정 필드가 그대로면 알리지 않고 재검수도 안 건다.
   *
   * 비교할 수 없는 경우는 알린다. 모르는 것을 「안 바뀌었다」로 읽지 않는다 (FR-RU-051).
   */
  private async judge(
    productId: number,
    content: ChangedContent,
    detail: Record<string, unknown> | null,
    cache: Map<number, ReadonlyMap<string, FingerprintSnapshot>>,
  ): Promise<{ notify: boolean; reaudit: boolean; hashes: ChangeHashes }> {
    if (detail === null || this.previousFingerprints === undefined) return UNKNOWN_CHANGE;

    let current: FingerprintSnapshot;
    try {
      const fp = buildContentFingerprint({ contentTypeId: Number(content.contentTypeId), raw: detail });
      current = {
        ...fp,
        showFlag: content.showFlag === '0' ? 0 : 1,
        ktoModifiedTime: content.modifiedTime,
      };
    } catch (e) {
      // 지원하지 않는 유형 등. 지문을 못 만들면 비교할 수 없다
      this.logger.warn(`콘텐츠 ${content.contentId} 지문을 못 만들었다: ${(e as Error).message}`);
      return UNKNOWN_CHANGE;
    }

    let seen = cache.get(productId);
    if (seen === undefined) {
      seen = await this.previousFingerprints(productId);
      cache.set(productId, seen);
    }
    const previous = seen.get(content.contentId) ?? null;
    const verdict = compareFingerprint(previous, current);
    const hashes = { from: previous?.fieldHash ?? null, to: current.fieldHash };

    /*
     * `FIRST` 는 이 상품이 그 콘텐츠를 한 번도 검수하지 않았다는 뜻이다. 검수 러너에서는
     * 알릴 것이 없지만 — 그 자리에서 검수 중이다 — 배치에서는 다르다. 기준이 없으니
     * 「안 바뀌었다」고 말할 수 없다.
     */
    if (verdict.kind === 'FIRST') return { notify: true, reaudit: true, hashes };
    return { notify: verdict.notify, reaudit: verdict.reaudit, hashes };
  }

  /** 재검수를 건다 (FR-MO-013). 한 상품이 여러 번 걸려도 한 번만 */
  private async reaudit(targets: readonly number[]): Promise<void> {
    if (this.requestAudit === undefined) return;
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

/** 사전 확인을 나눌 계정. 계정을 모르면 상품 하나를 한 계정으로 본다 */
function accountKeyOf(found: Slotted): string {
  const { accountId, productId } = found.candidate;
  return accountId === undefined ? `product:${String(productId)}` : `account:${String(accountId)}`;
}

/**
 * 상한 시각 전에 끝난 호출만 받는다. 넘으면 그 호출을 기다리지 않는다 — 호출은 뒤에서 제 시간 상한까지
 * 돌고 끝나지만 결과는 버린다. 상한이 지났으면 부르지도 않는다.
 */
function beforeDeadline<T>(start: () => Promise<T>, deadline: number): Promise<T> {
  const left = deadline - Date.now();
  if (left <= 0) return Promise.reject(new PrecheckTimeUp());
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new PrecheckTimeUp()); }, left);
  });
  const work = start();
  // 늦게 끝난 호출의 실패가 처리되지 않은 거절로 남지 않게 한다
  work.catch(() => undefined);
  return Promise.race([work, late]).finally(() => { clearTimeout(timer); });
}

/**
 * 넣을 자리의 앞뒤 이동을 잰다. 나오는 이동은 들어가서 머문 뒤의 시각에 떠난다.
 *
 * **앞 구간을 못 재면 뒤 구간은 부르지 않는다** — 하나라도 모르면 사전 확인은 어차피 「모른다」다.
 * 그 구간만의 실패는 null 이고, 제공자가 응답하지 않으면 `travel` 이 던진 것을 그대로 올린다.
 */
async function measureLegs(
  found: Slotted,
  travel: NonNullable<SyncBatchOptions['travel']>,
): Promise<{ in: Leg | null; out: Leg | null; direct: Leg | null }> {
  const { picked, candidate, content } = found;
  const { slot, before, after } = picked;
  const at = (point: { mapX: number | null; mapY: number | null }): { x: number; y: number } | null =>
    point.mapX === null || point.mapY === null ? null : { x: point.mapX, y: point.mapY };
  const via = at(content);
  const from = at(before);
  const to = after === null ? null : at(after);
  const leg = async (a: { x: number; y: number } | null, b: { x: number; y: number } | null, time: string | null): Promise<Leg | null> =>
    a === null || b === null || time === null ? null : travel(a, b, departureOf(candidate.startDate, slot.dayNo, time));

  const inLeg = await leg(from, via, slot.from);
  if (inLeg === null || after === null) return { in: inLeg, out: null, direct: null };
  const outLeg = await leg(via, to, addClock(slot.from, inLeg.minutes + slot.dwellMinutes));
  if (outLeg === null) return { in: inLeg, out: null, direct: null };
  const direct = await leg(from, to, slot.from);
  return { in: inLeg, out: outLeg, direct };
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
    lclsSystm2: code(item.lclsSystm2),
    mapX: coordinate(item.mapx),
    mapY: coordinate(item.mapy),
  };
}

/** 좌표. 빈 문자열이 0 으로 읽히면 적도 앞바다가 된다 */
function coordinate(value: unknown): number | null {
  const raw = String(value ?? '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n !== 0 ? n : null;
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
 * 변경의 근거 지문. 상품마다 다르므로 콘텐츠가 아니라 알림 행에 붙인다.
 *
 * 재노출 판정에는 쓰지 않는다 — 그건 `changeKeyOf` 가 만드는 `change_key` 다
 * (DB 명세서 v1.7).
 */
export interface ChangeHashes {
  readonly from: string | null;
  readonly to: string | null;
}

const NO_HASHES: ChangeHashes = { from: null, to: null };

/** 비교할 수 없을 때. 모르는 것을 「안 바뀌었다」로 읽지 않는다 (FR-RU-051) */
const UNKNOWN_CHANGE = { notify: true, reaudit: true, hashes: NO_HASHES } as const;

/** 넘친 날 개별 확인의 결과. `done` 이어야 그 날짜를 처리한 것으로 친다 */
interface Confirmation {
  readonly done: boolean;
  readonly impacts: readonly Impact[];
  readonly notified: number;
}

const NOT_CONFIRMED: Confirmation = { done: false, impacts: [], notified: 0 };

/**
 * 개별 확인한 콘텐츠를 목록 항목 모양으로 (FR-MO-016). 상세가 없으면(없는 곳) 표출 중단이다.
 *
 * 목록에서 온 것이 아니라 모르는 값 — 수정 시각 · 등록 시각 · 지역 · 분류 · 좌표 — 은 비운다.
 * 비어 있으면 조건 2 ~ 6 이 걸리지 않고, 알림 카드도 공사가 고친 날을 적지 않는다.
 */
function registeredContent(target: RegisteredContent, detail: Record<string, unknown> | null): ChangedContent {
  return {
    contentId: target.contentId,
    contentTypeId: String(target.contentTypeId),
    modifiedTime: '',
    showFlag: detail === null ? '0' : '1',
    createdTime: '',
    ldongRegnCd: null,
    ldongSignguCd: null,
    lclsSystm2: null,
    mapX: null,
    mapY: null,
    eventPeriod: detail === null ? null : toEventPeriod(detail),
  };
}

/**
 * 재노출 판정 키 (FR-MO-036 · DB 명세서 v1.7).
 *
 * **조건마다 「같은 변경」의 뜻이 다르다.**
 *
 * ```
 * 조건 1     판정 필드가 이 상태로 바뀐 것    FP:{직전지문|-}:{현재지문}
 * 조건 2·3   그 콘텐츠가 이때 갱신된 것       MT:{modifiedtime}
 * ```
 *
 * 조건 2 · 3 은 그 콘텐츠가 어느 일정에도 없어 지문 이력이 없다. 없는 것을 지어내는 대신
 * 갱신 시각을 식별자로 쓴다 — 다시 바뀌면 시각이 달라져 새 알림이 뜬다.
 */
export function changeKeyOf(content: SyncedContent, hashes: ChangeHashes, kind: 'RISK' | 'OPPORTUNITY' = 'RISK'): string {
  // 새 소식은 등록 한 번에 한 번이다. 등록 뒤 설명이 고쳐져도 같은 곳을 다시 권하지 않는다
  if (kind === 'OPPORTUNITY') return `NEW:${content.createdTime}`;
  if (hashes.to !== null) return `FP:${hashes.from ?? '-'}:${hashes.to}`;
  return `MT:${content.modifiedTime}`;
}

/**
 * 알림 본문 (FR-MO-033).
 *
 * ⚠️ **공사 원문을 담지 않는다.** 상품명 · 관광지명은 화면이 자기 데이터로 채운다 —
 *    여기 담으면 알림 테이블에 원문이 남는다 (FR-MO-002).
 */
function toNotification(
  impact: Impact,
  content: ChangedContent,
  hashes: ChangeHashes,
  changeKey: string = changeKeyOf(content, hashes, impact.kind),
): NotificationToSave {
  return {
    productId: impact.productId,
    kind: impact.kind,
    condition: impact.condition,
    ktoContentId: content.contentId,
    hashFrom: hashes.from,
    hashTo: hashes.to,
    changeKey,
    body: {
      condition: impact.condition,
      contentTypeId: content.contentTypeId,
      modifiedTime: content.modifiedTime,
      // 비표출 전환은 R06 이 차단으로 판정한다. 알림에도 그 사실을 남긴다
      hidden: content.showFlag === '0',
      /*
       * 행사 기간 (#703). 조건 3 을 건 근거인데 남기지 않아 카드가 「행사 정보가 바뀌었습니다」 밖에
       * 못 말했다. 원문(`20261031`)이 아니라 읽어 낸 날짜다 — 이름 · 주소 같은 원문은 여전히 안 남긴다.
       */
      ...(content.eventPeriod?.start != null && content.eventPeriod.end != null
        ? { eventPeriod: { start: content.eventPeriod.start, end: content.eventPeriod.end } }
        : {}),
    },
  };
}
