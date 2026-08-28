import { Injectable, Logger } from '@nestjs/common';
import type { KtoClient } from '../external/kto';
import { parseIsoDate } from '../engine/calendar/dates';
import { buildContentFingerprint, compareFingerprint, type FingerprintSnapshot } from '../engine/fingerprint';
import { isKtoError } from '../external/kto';
import type { BatchState, BatchStateRepository, BatchStatus } from '../persistence/batch-state.repository';
import type { NotificationRepository, NotificationToSave } from '../persistence/notification.repository';
import {
  matchByContent, matchByEventPeriod, matchByRegion, mergeImpacts,
  type ChangedContent, type EventPeriod, type Impact, type ImpactCandidate,
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

  constructor(options: SyncBatchOptions) {
    this.kto = typeof options.kto === 'function' ? options.kto : (): KtoClient => options.kto as KtoClient;
    this.state = options.state;
    this.clock = options.clock ?? ((): Date => new Date());
    this.hasBudget = options.hasBudget ?? ((): boolean => true);
    this.notifications = options.notifications ?? null;
    this.fetchDetail = options.fetchDetail;
    this.previousFingerprints = options.previousFingerprints;
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

      const details = await this.fetchDetails(contents, direct, watched.length > 0);
      const previous = new Map<number, ReadonlyMap<string, FingerprintSnapshot>>();
      const pending: NotificationToSave[] = [];
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
        for (const candidate of direct.get(content.contentId) ?? []) {
          const decision = await this.judge(candidate.productId, changed, detail, previous);
          if (decision.reaudit) toReaudit.add(candidate.productId);
          if (!decision.notify) {
            unchanged++;
            continue;
          }
          kept.push(candidate);
          hashes.set(candidate.productId, decision.hashes);
        }

        const impacts = mergeImpacts(
          matchByContent(kept),
          matchByRegion(changed, watched, today),
          matchByEventPeriod(changed, watched),
        );
        allImpacts.push(...impacts);
        pending.push(...impacts.map((i) => toNotification(i, changed, hashes.get(i.productId) ?? NO_HASHES)));
      }

      const notified = await this.notifications.insertMany(pending);
      this.logger.log(
        `영향 ${allImpacts.length}건 · 새 알림 ${notified}건`
        + (unchanged > 0 ? ` · 판정 필드가 그대로라 넘긴 것 ${unchanged}건` : ''),
      );

      await this.reaudit([...toReaudit]);
      return { impacts: allImpacts, notified };
    } catch (e) {
      this.logger.error(`영향 탐색에 실패했다. 1단계 결과는 그대로다: ${(e as Error).message}`);
      return { impacts: [], notified: 0 };
    }
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
export function changeKeyOf(content: SyncedContent, hashes: ChangeHashes): string {
  if (hashes.to !== null) return `FP:${hashes.from ?? '-'}:${hashes.to}`;
  return `MT:${content.modifiedTime}`;
}

/**
 * 알림 본문 (FR-MO-033).
 *
 * ⚠️ **공사 원문을 담지 않는다.** 상품명 · 관광지명은 화면이 자기 데이터로 채운다 —
 *    여기 담으면 알림 테이블에 원문이 남는다 (FR-MO-002).
 */
function toNotification(impact: Impact, content: ChangedContent, hashes: ChangeHashes): NotificationToSave {
  return {
    productId: impact.productId,
    kind: impact.kind,
    condition: impact.condition,
    ktoContentId: content.contentId,
    hashFrom: hashes.from,
    hashTo: hashes.to,
    changeKey: changeKeyOf(content, hashes),
    body: {
      condition: impact.condition,
      contentTypeId: content.contentTypeId,
      modifiedTime: content.modifiedTime,
      // 비표출 전환은 R06 이 차단으로 판정한다. 알림에도 그 사실을 남긴다
      hidden: content.showFlag === '0',
    },
  };
}
