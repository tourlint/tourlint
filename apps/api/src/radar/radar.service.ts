import { kstIso } from '@tourlint/shared';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import type { Pool } from 'pg';
import type { KtoService } from '@tourlint/shared';
import { DomainException } from '../common/domain.exception';
import { SignalBatchJob } from '../batch/signal-batch.job';
import { kstToday, nextBatchAt } from '../batch/sync-window';
import { lastYearMonthWindow, monthWindow, t2Window } from '../engine/signals';
import { ktoBudgetGuard } from '../external/budget-guard';
import { PgApiCallLogger } from '../persistence/api-call-log.repository';
import { BatchStateRepository } from '../persistence/batch-state.repository';
import { DemandSignalRepository, type StoredSignal } from '../persistence/demand-signal.repository';
import { DB_POOL } from '../persistence/db';
import { diffNormalized } from './change-diff';
import { notificationCopy } from './notification-copy';
import { RadarRepository, type ChangeRow } from './radar.repository';

/**
 * 수요 · 변경 레이더 (F12 ~ F14 · FR-MO-050 · 006 · 058 · FR-RU-110 ~ 122).
 *
 * **읽기는 아무것도 새로 산출하지 않는다.** 조건 판정과 T1 · T2 · T3 산출은 배치가 끝냈고
 * 여기서는 저장된 것을 계정 범위로 읽어 표시 형태로 바꿀 뿐이다. 공사 호출이 0건이다.
 * 예외는 배치가 꺼진 기간의 `refreshRegionSignals` 하나다.
 */
@Injectable()
export class RadarService {
  private readonly radar: RadarRepository;
  private readonly signals: DemandSignalRepository;
  private readonly state: BatchStateRepository;
  private readonly calls: PgApiCallLogger;

  constructor(
    @Inject(DB_POOL) pool: Pool,
    /** 관심 지역 신호를 지금 산출할 때만 쓴다. 읽기 경로는 이것 없이 돈다 */
    @Optional() @Inject(SignalBatchJob) private readonly signalJob?: SignalBatchJob,
  ) {
    this.radar = new RadarRepository(pool);
    this.signals = new DemandSignalRepository(pool);
    this.state = new BatchStateRepository(pool);
    this.calls = new PgApiCallLogger(pool);
  }

  /**
   * 요약 (FR-MO-050 · NF-OB-004).
   *
   * `nextBatchAt` 은 새 소식 · 신호가 언제 다시 세어지는지다(API 4-8). 배치가 꺼져 있으면
   * `null` 이다.
   */
  async summary(accountId: number, now: Date = new Date()): Promise<Record<string, unknown>> {
    const [counts, batch, setting] = await Promise.all([
      this.radar.counts(accountId),
      this.radar.batchState(),
      this.state.setting(),
    ]);
    return {
      risk: counts.risk,
      opportunity: counts.opportunity,
      unread: counts.unread,
      affectedProducts: counts.affectedProducts,
      changedContents: counts.changedContents,
      lastBatchAt: batch?.lastRunAt == null ? null : kstIso(batch.lastRunAt),
      nextBatchAt: nextBatchAt(now, setting.batchTime, setting.batchEnabled),
      lastBatch: batch === null ? null : {
        runAt: batch.lastRunAt === null ? null : kstIso(batch.lastRunAt),
        covered: batch.lastCovered,
        status: batch.lastStatus,
        itemCount: batch.lastItemCount,
      },
    };
  }

  /** 변경 감지 내역 (FR-MO-006 · 058) */
  async changes(accountId: number, page: number, size: number): Promise<Record<string, unknown>> {
    const found = await this.radar.changes(accountId, page, size);
    return {
      content: found.rows.map(toChangeResponse),
      page, size, totalElements: found.total,
    };
  }

  /**
   * 수요 신호 (FR-RU-110 ~ 122 · FR-MO-056).
   *
   * 배치가 산출해 둔 값을 읽는다. **없으면 `null` 이고 0 이 아니다** — 0 은 「세어 보니
   * 없었다」이고 `null` 은 「아직 안 세어 봤다」다. 화면이 그 둘을 구분해야 한다.
   *
   * `t1.keywordHits` 는 요청 계정의 관심 키워드만이다 (FR-RU-112). 배치가 아직 안 본
   * 키워드(등록한 뒤 첫 배치 전)는 `contentIds: null` 이고 빈 배열이 아니다.
   */
  async signalsOf(accountId: number, productId: number, now: Date = new Date()): Promise<Record<string, unknown>> {
    const product = await this.radar.product(accountId, productId);
    if (product === null) {
      throw new DomainException(
        HttpStatus.NOT_FOUND, 'NOT_FOUND', '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.',
      );
    }

    const region = {
      ldongRegnCd: product.ldongRegnCd,
      ldongSignguCd: product.ldongSignguCd,
    };
    /*
     * 날짜는 한국 시간이다 — 배치가 한국 날짜로 창을 만든다. T1 은 가장 최근 창을 읽는다:
     * 오늘 창은 배치 시각 뒤에야 생기므로, 오늘 창만 찾으면 새벽마다 「아직 안 셌다」가 된다.
     */
    const today = kstToday(now);
    const w2 = t2Window(product.startDate, product.nights, region);

    const [t1, t2, keywords] = await Promise.all([
      this.signals.findLatestT1(region, today),
      w2 === null ? Promise.resolve(null) : this.signals.find('T2', w2),
      this.radar.watchKeywords(accountId),
    ]);

    return {
      productId: product.productId,
      t1: withKeywordHits(t1, keywords),
      t2: toSignalResponse(t2),
      /*
       * FR-RU-121 — 강도 점수를 만들지 않는다. 건수와 유형 분포뿐이다.
       * FR-RU-122 · FR-MO-055 — SNS · 검색 트렌드 · 혼잡도를 쓰지 않고 판매량 · 흥행을
       * 말하지 않는다. 응답에 그런 필드를 두지 않는 것이 그 약속의 이행이다.
       */
      notice: '관측된 건수와 유형 분포입니다. 판매량 · 흥행을 예측하지 않습니다.',
    };
  }

  /**
   * 관심 지역 새 소식 (FR-MO-059 · 060 · API 4-8). 저장된 값만 읽는다 — 공사 호출 0건.
   *
   * 칸마다 T1(가장 최근 30일) · 그 달의 T2 · 지난해 같은 달의 T3 다. 산출 전은 `null` 이고
   * 0 이 아니다. T3 는 지난해 코드와 이어지지 않는 지역이면 늘 `null` 이다 (EI-KT-026).
   */
  async regionSignals(accountId: number, now: Date = new Date()): Promise<readonly Record<string, unknown>[]> {
    const today = kstToday(now);
    const [watches, keywords] = await Promise.all([
      this.radar.watchRegions(accountId),
      this.radar.watchKeywords(accountId),
    ]);
    const unique = [...new Map(watches.map((w) => [`${w.ldongRegnCd}|${w.ldongSignguCd}|${w.month}`, w])).values()];

    return Promise.all(unique.map(async (w) => {
      const region = { ldongRegnCd: w.ldongRegnCd, ldongSignguCd: w.ldongSignguCd };
      const w2 = monthWindow(w.month, region);
      const w3 = lastYearMonthWindow(w.month, region);
      const [t1, t2, t3] = await Promise.all([
        this.signals.findLatestT1(region, today),
        w2 === null ? Promise.resolve(null) : this.signals.find('T2', w2),
        w3 === null ? Promise.resolve(null) : this.signals.find('T3', w3),
      ]);
      return {
        region: { regnCd: w.ldongRegnCd, signguCd: w.ldongSignguCd },
        month: w.month,
        t1: withKeywordHits(t1, keywords),
        t2: withKeywordHits(t2, keywords),
        // FR-MO-060 — 관측된 수 · 기준 기간 · 출처만. 인기 · 예측 필드를 두지 않는다
        t3: t3 === null ? null : {
          count: t3.count,
          basisMonth: t3.window.from.slice(0, 7),
          source: VISITOR_SOURCE,
          computedAt: kstIso(t3.computedAt),
        },
      };
    }));
  }

  /**
   * 관심 지역 신호를 지금 산출한다 (FR-MO-059 · API 4-8 `region-signals/refresh`).
   *
   * **배치가 꺼진 기간에만 쓴다.** 켜져 있으면 평일 아침마다 배치가 세므로 403 이다. 예산은
   * 기획 조회와 같은 100% 게이트(`PLAN`)이고 국문 관광정보 예산이 다 찼으면 부르기 전에 429 다.
   * 방문자수 예산이 막히면 T3 만 못 세고 나머지는 돌려준다.
   */
  async refreshRegionSignals(accountId: number, now: Date = new Date()): Promise<readonly Record<string, unknown>[]> {
    const setting = await this.state.setting();
    if (setting.batchEnabled) {
      throw new DomainException(
        HttpStatus.FORBIDDEN, 'FORBIDDEN_ACTION',
        '평일 아침마다 자동으로 새로 확인하고 있어요. 지금 확인은 자동 확인이 꺼져 있을 때만 쓸 수 있어요.',
      );
    }
    if (this.signalJob === undefined) throw new Error('관심 지역 신호 산출이 연결되지 않았다');

    const gate = async (service: KtoService): Promise<boolean> =>
      (await ktoBudgetGuard(service, { counter: this.calls, dailyQuota: setting.dailyQuota }).check('PLAN')).allowed;
    if (!await gate('KOR')) {
      throw new DomainException(
        HttpStatus.TOO_MANY_REQUESTS, 'BUDGET_EXHAUSTED',
        '오늘 사용할 수 있는 관광정보 조회량을 모두 썼습니다. 내일 다시 확인해 주세요.',
      );
    }
    await this.signalJob.refreshWatchRegions(accountId, gate);
    return this.regionSignals(accountId, now);
  }
}

/** T3 출처. 화면에는 서비스 이름을 적지 않는다(UI-S7-015) — 근거 보기에서만 쓴다 */
export const VISITOR_SOURCE = '빅데이터 지역별 방문자수';

/**
 * 신호 하나. 산출 전이면 `null` 이다.
 *
 * `window` 를 그대로 실어 화면이 「최근 30일」처럼 조회 조건을 적을 수 있게 한다 (FR-MO-056).
 */
function toSignalResponse(s: StoredSignal | null): Record<string, unknown> | null {
  if (s === null) return null;
  return {
    count: s.count,
    byType: s.byType,
    window: { from: s.window.from, to: s.window.to },
    computedAt: kstIso(s.computedAt),
  };
}

/** 신호에 요청 계정의 키워드 일치를 붙인다. 산출 전이면 `null` */
function withKeywordHits(s: StoredSignal | null, keywords: readonly string[]): Record<string, unknown> | null {
  const response = toSignalResponse(s);
  return s === null || response === null ? null : { ...response, keywordHits: keywordHits(s, keywords) };
}

/**
 * 요청 계정의 관심 키워드별 일치 곳 (FR-RU-112 · DR-PR-009).
 *
 * 저장값은 그 지역 상품을 가진 계정들의 키워드 합집합이라, **요청 계정 것만** 골라 낸다 —
 * 남의 키워드와 그 일치 곳이 드러나면 안 된다. 이름은 싣지 않는다(화면이 조회한다).
 */
function keywordHits(
  signal: StoredSignal,
  keywords: readonly string[],
): readonly { keyword: string; contentIds: readonly string[] | null }[] {
  const mine = [...new Set(keywords.map((k) => k.trim()).filter((k) => k !== ''))];
  return mine.map((keyword) => ({
    keyword,
    contentIds: Object.hasOwn(signal.byKeyword, keyword) ? (signal.byKeyword[keyword] ?? null) : null,
  }));
}

/**
 * 변경 한 줄 (FR-MO-006 · 058).
 *
 * 관광지명은 **사용자가 입력한 `place_label`** 이다. 공사 원문을 싣지 않는다 (FR-MO-002).
 */
function toChangeResponse(row: ChangeRow): Record<string, unknown> {
  const copy = notificationCopy(row.condition, row.hidden);
  const readable = diffNormalized(row.normalizedBefore, row.normalizedAfter);
  return {
    notificationId: row.notificationId,
    productId: row.productId,
    productName: row.productName,
    ktoContentId: row.ktoContentId,
    placeLabel: row.placeLabel,
    condition: row.condition,
    hidden: row.hidden,
    what: copy.what,
    detectedAt: kstIso(row.detectedAt),
    modifiedTime: row.modifiedTime,
    // FR-MO-058 — 지문 비교값. 조건 2·3 은 지문 이력이 없어 둘 다 null 이다
    fingerprint: { from: row.hashFrom, to: row.hashTo },
    /*
     * FR-MO-006 — 판독 결과 기준 변화. 재검수가 돌아 지문이 두 번 이상 쌓인 콘텐츠에만
     * 있다. 없으면 빈 배열이고, 화면은 「판독 결과 비교 없음」으로 적어야 한다.
     * 비어 있는 것을 「바뀐 것 없음」으로 읽으면 안 된다.
     */
    readableChanges: readable,
    hasReadableDiff: row.normalizedBefore !== null && row.normalizedAfter !== null,
  };
}
