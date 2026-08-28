import {
  CONTENT_TYPE_ID, INTRO_FIELDS, SEVERITY_WEIGHT_DEFAULT,
  type ConceptKey, type TargetKey,
  type ContentTypeId, type EndTimeSource, type ExceptionReasonCode, type ItemType, type MatchStatus, type Severity,
  type Transport,
} from '@tourlint/shared';
import { KOREAN_HOLIDAYS } from '../engine/calendar/holidays';
import { addDays, formatIsoDate, parseIsoDate } from '../engine/calendar/dates';
import {
  buildContentFingerprint, buildRunFingerprint, compareFingerprint, isSupportedContentTypeId,
} from '../engine/fingerprint';
import type { ChangeVerdict, FingerprintSnapshot } from '../engine/fingerprint/types';
import { resolveEndTime } from '../engine/itinerary/dwell';
import { parseOperatingInfo } from '../engine/normalize/parse';
import type { NormalizedOperatingInfo } from '../engine/normalize/types';
import { DEFAULT_AUDIT_SETTINGS } from '../engine/rules/types';
import type { AuditItem, AuditSettings, Finding, ItineraryContext, MatchedContent } from '../engine/rules/types';
import { calculateReadiness, type ScoreResult } from '../engine/score';
import { isKtoError, type KtoClient } from '../external/kto';
import type { FingerprintToSave } from '../persistence/audit-result.repository';
import { segmentKey, segmentsOf, type TravelSegment } from '../engine/rules/r08-travel';
import type { DailyRainOutlook } from '../engine/rules/r09-rain';
import type { TargetProfileContext } from '../engine/rules/r10-target';
import type { KakaoMobilityClient } from '../external/kakao';
import { isKakaoError } from '../external/kakao';
import {
  chooseMidPublication, chooseShortPublication, isKmaError, kstToday, midLandRegionOf,
  representativePoint, toGrid, type KmaClient,
} from '../external/kma';
import { proposeLocalPatches } from './patch-local';
import { proposeReplacements } from './patch-remote';
import { MAX_PATCHES_PER_FINDING, type Patch } from './patch-types';
import { RULESET_VERSION, evaluateAll } from './rule-registry';

/**
 * 검수 파이프라인 (API 설계 6-1).
 *
 *   1) 대상 수집          CONFIRMED 항목의 고유 contentid
 *   2) 공사 데이터 조회    ★ 관광지 단위 병렬 · 실행 내 캐시
 *   3) 지문 생성 + 정규화
 *   4) 외부 데이터 조회    ★ 구간 단위 병렬. 카카오모빌리티(R08) · 기상청(R09)
 *   5) ItineraryContext 조립   ← 여기까지가 I/O
 *   6) 규칙 평가          ★ 메모리 상에서만
 *   7) 등급 · 출시 준비도
 *   8) 수정안 생성        ★ 판정 이후. 대체 관광지 탐색에만 외부 호출
 *   9) 저장               — 호출자가 한 트랜잭션으로
 *
 * **5단계에서 I/O 가 끝난다.** 6단계를 메모리 전용으로 못 박은 것은 성능뿐 아니라
 * 결정론성 때문이다 — 규칙이 개별적으로 외부를 부르면 같은 입력에 다른 결과가 나온다
 * (NF-MT-001 · NF-PF-014).
 */

export interface ItineraryItemRow {
  readonly id: number;
  readonly dayNo: number;
  readonly seq: number;
  readonly startTime: string;
  readonly endTime: string | null;
  readonly endTimeSource: EndTimeSource;
  readonly placeLabel: string;
  readonly itemType: ItemType;
  readonly ktoContentId: string | null;
  readonly contentTypeId: number | null;
  readonly lclsSystm1: string | null;
  readonly lclsSystm2: string | null;
  readonly lclsSystm3: string | null;
  readonly mapX: number | null;
  readonly mapY: number | null;
  readonly matchStatus: MatchStatus;
}

export interface ProductRow {
  readonly id: number;
  /** `YYYY-MM-DD` */
  readonly startDate: string;
  readonly nights: number;
  /** 이동수단. 대중교통이면 R08 을 판정하지 않는다 (FR-RU-086) */
  readonly transport: Transport;
  /** 법정동 시도 코드. 중기 예보구역과 평년 테이블이 쓴다. 길이를 가정하지 않는다 (DR-IN-010) */
  readonly ldongRegnCd?: string | null;
  /** 시군구 코드. 강원은 이것으로 영서 · 영동이 갈린다 */
  readonly ldongSignguCd?: string | null;
  /** 상품 성격. 선택 입력이라 없을 수 있고, 없으면 R10 이 물러난다 (FR-RU-100) */
  readonly targetKey?: string | null;
  readonly conceptKey?: string | null;
  /** 상품 소유자. 기대 프로파일이 계정 설정이라 필요하다 */
  readonly accountId?: number;
}

/**
 * 기대 콘텐츠 프로파일 조회 (`target_profile` · FR-RU-100).
 *
 * 계정 설정이라 계정마다 다르다. **없으면 `null`** 이고 R10 은 그 상품을 확인 불가로
 * 남긴다 — 비슷한 조합으로 대신 판정하지 않는다 (FR-RU-051).
 */
export interface TargetProfileLookup {
  find(accountId: number, targetKey: string, conceptKey: string): Promise<TargetProfileRow | null>;
}

export interface TargetProfileRow {
  readonly expectedLcls2: readonly string[];
  readonly expectsNight: boolean;
}

/**
 * 평년 강수일수 조회 (EI-WX-004 · FR-RU-091 D+11 이상).
 *
 * 파일로 배포되는 통계라 고정 테이블이 정상 구현이다. **테이블이 비어 있으면 `null` 이고
 * 그 날짜는 확인 불가가 된다** — 정보가 없다는 이유로 정상 판정을 하지 않는다 (FR-RU-051).
 */
export interface ClimateNormalLookup {
  find(ldongRegnCd: string, month: number): Promise<ClimateNormal | null>;
}

export interface ClimateNormal {
  readonly rainDays: number;
  /** 그 달의 강수일수 비율 */
  readonly rainRatio: number;
  /** 화면 문장에 들어가는 지역명 (FR-RU-092) */
  readonly regionName: string;
}

export interface AuditRunnerOptions {
  readonly kto: KtoClient;
  /** 관광지 단위 동시 조회 수. 기본 8 (NF-PF-010) */
  /**
   * 공사 상세 조회 동시 실행 수 (NF-PF-010). 기본 8.
   *
   * 안 넘기면 `AUDIT_CONCURRENCY` 를 본다 — 명세가 환경변수로 조정 가능할 것을 요구한다.
   */
  readonly concurrency?: number;
  readonly weights?: Readonly<Record<Severity, number>>;
  /** 계정 설정. 주지 않으면 기본값을 쓴다 (FR-RU-072 · FR-OP-026) */
  readonly settings?: AuditSettings;
  readonly clock?: () => Date;
  /** 폴링 응답에 반영할 진행률 */
  readonly onProgress?: (done: number, total: number) => void | Promise<void>;
  /**
   * 그 상품의 **직전 검수**에서 만든 지문. `kto_content_id` 로 찾는다 (FR-MO-004).
   * 없으면 최초 검수로 본다.
   */
  readonly previousFingerprints?: ReadonlyMap<string, FingerprintSnapshot>;
  /**
   * 대체 관광지 탐색(`locationBasedList2`) 호출 상한. 기본 3콜.
   *
   * 수정안은 판정이 아니라 **거들기**다. 여기서 예산을 많이 쓰면 정작 검수할 몫이 줄어든다
   * (API 설계 6-1 8단계 "약 3콜").
   */
  readonly maxReplacementCalls?: number;
  /** 길찾기 클라이언트. 없으면 R08 을 판정하지 않는다 */
  readonly kakao?: KakaoMobilityClient;
  /** 기상청 클라이언트. 없으면 R09 를 확인 불가로 남긴다 */
  readonly kma?: KmaClient;
  /** 평년 강수일수. 없으면 D+11 이상이 확인 불가로 남는다 (이슈 #7) */
  readonly climate?: ClimateNormalLookup;
  /** 기대 콘텐츠 프로파일. 없으면 R10 을 판정하지 않는다 */
  readonly profiles?: TargetProfileLookup;
  /** 프로파일을 찾을 계정. 상품 소유자다 */
  readonly accountId?: number;
}

export interface AuditRunResult {
  readonly findings: readonly Finding[];
  readonly fingerprints: readonly FingerprintToSave[];
  readonly score: ScoreResult;
  readonly targetCount: number;
  readonly failedCount: number;
  readonly rulesetVersion: string;
  readonly weights: Readonly<Record<Severity, number>>;
  readonly executedAt: Date;
  /** 실행 대표 지문. 화면에는 앞 8자리를 쓴다 (DR-FP-008 · UI-CM-032) */
  readonly runFingerprint: string | null;
  readonly failedRules: readonly string[];
  /** 상품 단위 총 이동시간·거리 (FR-RU-084). F10 전후 비교의 입력이다 */
  readonly travelTotals: { readonly durationSeconds: number; readonly distanceMeters: number };
}

/** 한 콘텐츠의 조회 결과. 실패해도 버리지 않고 사유와 함께 남긴다 */
interface FetchedContent {
  readonly contentTypeId: ContentTypeId;
  readonly intro: Record<string, unknown>;
  readonly common: Record<string, unknown>;
  readonly normalized: NormalizedOperatingInfo;
}

interface FetchFailure {
  /** 어댑터가 준 예외 사유 그대로다. 문자열로 두면 finding 에 실을 때 좁혀야 한다 */
  readonly reasonCode: ExceptionReasonCode;
  readonly message: string;
}

export class AuditRunner {
  private readonly kto: KtoClient;
  private readonly concurrency: number;
  private readonly weights: Readonly<Record<Severity, number>>;
  private readonly settings: AuditSettings;
  private readonly previous: ReadonlyMap<string, FingerprintSnapshot>;
  private readonly maxReplacementCalls: number;
  private readonly kakao: KakaoMobilityClient | null;
  private readonly kma: KmaClient | null;
  private readonly climate: ClimateNormalLookup | null;
  private readonly profiles: TargetProfileLookup | null;
  private readonly accountId: number | null;
  private readonly clock: () => Date;
  private readonly onProgress: (done: number, total: number) => void | Promise<void>;

  constructor(options: AuditRunnerOptions) {
    this.kto = options.kto;
    this.concurrency = options.concurrency ?? concurrencyFromEnv();
    this.weights = options.weights ?? SEVERITY_WEIGHT_DEFAULT;
    this.settings = options.settings ?? DEFAULT_AUDIT_SETTINGS;
    this.previous = options.previousFingerprints ?? new Map();
    this.maxReplacementCalls = options.maxReplacementCalls ?? 3;
    this.kakao = options.kakao ?? null;
    this.kma = options.kma ?? null;
    this.climate = options.climate ?? null;
    this.profiles = options.profiles ?? null;
    this.accountId = options.accountId ?? null;
    this.clock = options.clock ?? ((): Date => new Date());
    this.onProgress = options.onProgress ?? ((): void => undefined);
  }

  async run(product: ProductRow, items: readonly ItineraryItemRow[]): Promise<AuditRunResult> {
    const executedAt = this.clock();

    // ── 1) 대상 수집 — 같은 관광지가 여러 번 나와도 한 번만 조회한다 ──
    const targets = uniqueContentIds(items);
    await this.onProgress(0, targets.length);

    // ── 2) 공사 데이터 조회 (관광지 단위 병렬) ──
    const fetched = new Map<string, FetchedContent>();
    const failures = new Map<string, FetchFailure>();
    let done = 0;

    await withConcurrency(targets, this.concurrency, async (target) => {
      try {
        fetched.set(target.contentId, await this.fetchOne(target.contentId, target.contentTypeId));
      } catch (e) {
        // 콘텐츠 단위 격리 — 한 곳이 실패해도 나머지는 계속 판정한다 (EX-CM 원칙 ①)
        failures.set(target.contentId, {
          reasonCode: isKtoError(e) ? e.reasonCode : 'KTO_FETCH_FAILED',
          message: isKtoError(e) ? '공사 데이터를 가져오지 못했습니다' : '알 수 없는 오류',
        });
      } finally {
        done++;
        await this.onProgress(done, targets.length);
      }
    });

    // ── 3) 지문 생성 + 정규화 + 직전 지문 비교 ──
    const fingerprints: FingerprintToSave[] = [];
    const verdicts = new Map<string, ChangeVerdict>();
    for (const [contentId, content] of fetched) {
      const fp = buildContentFingerprint({ contentTypeId: content.contentTypeId, raw: content.intro });
      const showFlag: 0 | 1 = content.common.showflag === '0' ? 0 : 1;
      // 직전 지문과 비교한다. 비표출 전환이 여기서 잡힌다 (FR-MO-004 · R06-b)
      verdicts.set(contentId, compareFingerprint(this.previous.get(contentId) ?? null, {
        fieldNames: fp.fieldNames,
        fieldHash: fp.fieldHash,
        showFlag,
        ktoModifiedTime: String(content.common.modifiedtime ?? ''),
      }));
      fingerprints.push({
        ktoContentId: contentId,
        contentTypeId: content.contentTypeId,
        fetchedAt: executedAt,
        // 원본 문자열 그대로 보관한다. 비교 목적이라 변환하지 않는다 (DR-PR-008)
        ktoModifiedTime: String(content.common.modifiedtime ?? ''),
        // `detailCommon2` 에는 showflag 가 없다(실측). 비표출 감지는 배치가 맡는다 (EI-KT-012)
        showFlag: content.common.showflag === '0' ? 0 : 1,
        fieldNames: fp.fieldNames,
        fieldHash: fp.fieldHash,
        normalizedJson: content.normalized,
        parseConfidence: content.normalized.confidence.overall,
      });
    }

    // ── 4) 외부 데이터 조회 (구간 단위 병렬) ──
    const [travelTimes, rainOutlooks, targetProfile] = await Promise.all([
      this.fetchTravelTimes(product, items),
      this.fetchRainOutlooks(product, items, executedAt),
      this.fetchTargetProfile(product),
    ]);

    // ── 5) ItineraryContext 조립 (I/O 끝) ──
    const ctx = this.buildContext(product, items, fetched, verdicts, travelTimes, rainOutlooks, targetProfile);

    // ── 6) 규칙 평가 (메모리 전용) ──
    const { findings, failedRules } = evaluateAll(ctx);

    // 조회에 실패한 콘텐츠는 "정상" 이 아니라 "확인 불가" 다 (FR-AU-009 · FR-AU-027)
    const isolated = isolationFindings(items, failures);

    // ── 8) 수정안 생성 (판정 이후 별도 단계) ──
    const all = await this.attachPatches([...findings, ...isolated], ctx, fetched);

    // ── 7) 등급 · 출시 준비도 ──
    const score = calculateReadiness({
      findings: all.map((f) => ({
        severity: f.severity, reasonCode: f.reasonCode,
        dismissed: false, needsConfirmation: f.needsConfirmation,
      })),
      weights: this.weights,
      targetCount: targets.length,
      failedCount: failures.size,
    });

    return {
      findings: all,
      fingerprints,
      score,
      targetCount: targets.length,
      failedCount: failures.size,
      rulesetVersion: RULESET_VERSION,
      weights: this.weights,
      executedAt,
      travelTotals: totalTravel(travelTimes),
      runFingerprint: fingerprints.length === 0
        ? null
        : buildRunFingerprint(fingerprints.map((f) => ({ ktoContentId: f.ktoContentId, fieldHash: f.fieldHash }))),
      failedRules,
    };
  }

  /**
   * [4단계] 구간별 이동시간을 모은다 (FR-RU-080 · EI-KM-006).
   *
   * 호출 단위는 **연속한 두 일정 항목의 구간**이다. 8곳이면 7구간, 12곳이면 11구간.
   * 같은 구간을 같은 출발 시각으로 두 번 부르지 않도록 실행 안에서 캐시한다.
   *
   * **대중교통은 아예 부르지 않는다** (FR-RU-086 · EI-KM-007). 자동차 시간을 대중교통
   * 시간으로 대체해 제시하면 손님이 그 시간표로 움직이다 못 간다.
   *
   * 조회에 실패해도 검수를 세우지 않는다. 그 구간만 확인 불가로 남는다 (EI-KM-009).
   * 직선거리 추정으로 대체하지 않는다 — 지어낸 값으로 오류를 내는 것이 더 나쁘다.
   */
  private async fetchTravelTimes(
    product: ProductRow,
    items: readonly ItineraryItemRow[],
  ): Promise<ReadonlyMap<string, TravelSegment>> {
    const out = new Map<string, TravelSegment>();
    const segments = segmentsOf(items.map(toAuditShape));
    if (segments.length === 0) return out;

    if (product.transport === 'PUBLIC_TRANSIT') {
      for (const { from, to } of segments) {
        out.set(segmentKey(from.id, to.id), { ok: false, reasonCode: 'TRANSIT_NOT_SUPPORTED' });
      }
      return out;
    }
    if (this.kakao === null) {
      // 키가 없거나 클라이언트를 못 만든 경우다. 조용히 넘기면 "이동시간 문제 없음" 으로
      // 읽힌다 — 판정하지 못한 것은 정상이 아니라 확인 불가다 (FR-AU-009 · EI-KM-009)
      for (const { from, to } of segments) {
        out.set(segmentKey(from.id, to.id), { ok: false, reasonCode: 'ROUTE_PROVIDER_FAILED' });
      }
      return out;
    }

    const start = parseIsoDate(product.startDate);
    const cache = new Map<string, TravelSegment>();

    await withConcurrency(segments, this.concurrency, async ({ from, to }) => {
      const key = segmentKey(from.id, to.id);
      if (from.mapX === null || from.mapY === null || to.mapX === null || to.mapY === null) {
        out.set(key, { ok: false, reasonCode: 'COORD_MISSING' });
        return;
      }

      // 여행 날짜와 출발 시각 기준으로 부른다. 현재 시각 기준은 미래 상품의 근거가 못 된다
      const departureAt =
        start === null || from.endTime === null
          ? null
          : departureStamp(formatIsoDate(addDays(start, from.dayNo - 1)), from.endTime);

      const cacheKey = `${String(from.mapX)},${String(from.mapY)}>${String(to.mapX)},${String(to.mapY)}@${departureAt ?? ''}`;
      const hit = cache.get(cacheKey);
      if (hit !== undefined) {
        out.set(key, hit);
        return;
      }

      let segment: TravelSegment;
      try {
        const route = await (this.kakao as KakaoMobilityClient).route(
          { x: from.mapX, y: from.mapY },
          { x: to.mapX, y: to.mapY },
          departureAt,
        );
        segment = {
          ok: true,
          durationSeconds: route.durationSeconds,
          distanceMeters: route.distanceMeters,
          futureBased: route.futureBased,
        };
      } catch (e) {
        segment = { ok: false, reasonCode: isKakaoError(e) ? e.reasonCode : 'ROUTE_PROVIDER_FAILED' };
      }
      cache.set(cacheKey, segment);
      out.set(key, segment);
    });

    return out;
  }

  /**
   * [8단계] 수정안을 붙인다.
   *
   * 규칙이 만들지 않는 이유는 대체 관광지 탐색에 외부 호출이 필요해서다. 규칙 평가는
   * 메모리 전용이라야 결정론적이다 (NF-PF-014 · NF-MT-001).
   *
   * 로컬 수정안은 전부 만들고, 외부 호출이 필요한 대체 관광지는 **호출 상한 안에서만**
   * 만든다. 수정안을 못 붙이는 것은 판정 실패가 아니다 — 없으면 사용자가 직접 고치면 된다.
   */
  private async attachPatches(
    findings: readonly Finding[],
    ctx: ItineraryContext,
    fetched: ReadonlyMap<string, FetchedContent>,
  ): Promise<readonly Finding[]> {
    const knownConfidence = new Map(
      [...fetched].map(([id, c]) => [id, c.normalized.confidence.overall] as const),
    );
    let calls = 0;

    const out: Finding[] = [];
    for (const finding of findings) {
      const local = proposeLocalPatches({ finding, items: ctx.items, holidays: ctx.holidays });
      let patches: Patch[] = [...local];

      // 대체 관광지는 R01 과 R06-b 만 낸다 (FR-RU-013③ · FR-RU-067)
      const wantsReplacement =
        (finding.ruleCode === 'R01' || finding.ruleCode === 'R06') && finding.targetItemId !== null;
      const target = ctx.items.find((i) => i.id === finding.targetItemId);

      if (wantsReplacement && target !== undefined && calls < this.maxReplacementCalls) {
        calls++;
        patches = [
          ...patches,
          ...(await proposeReplacements(target, { kto: this.kto, knownConfidence }, patches.length)),
        ];
      }

      out.push(patches.length === 0 ? finding : { ...finding, patches: patches.slice(0, MAX_PATCHES_PER_FINDING) });
    }
    return out;
  }

  /**
   * [4단계] 여행 일자별 강수 판정 근거를 모은다 (FR-RU-091 · EI-WX-002 · 003).
   *
   * 호출은 최대 둘이다 — 단기 1회 · 중기 1회. 격자도 예보구역도 **상품당 하나**라서
   * 일정 항목마다 부르지 않는다 (EI-WX-002). 대상 일자가 여럿이어도 한 발표분이 다 덮는다.
   *
   * 구간은 각 일정의 날짜 기준이다. 출발일이 아니다 — 출발 D+2 인 2박 3일 상품의 3일차는
   * D+4 라 중기로 간다.
   *
   * 조회에 실패해도 검수를 세우지 않는다. **그 날짜만** 확인 불가로 남는다 (EI-WX-006).
   */
  private async fetchRainOutlooks(
    product: ProductRow,
    items: readonly ItineraryItemRow[],
    now: Date,
  ): Promise<ReadonlyMap<string, DailyRainOutlook>> {
    const out = new Map<string, DailyRainOutlook>();
    const dates = travelDates(product, items);
    if (dates.length === 0) return out;

    const fail = (reasonCode: ExceptionReasonCode): ReadonlyMap<string, DailyRainOutlook> => {
      for (const d of dates) out.set(d, { ok: false, reasonCode });
      return out;
    };

    // 키가 없거나 클라이언트를 못 만든 경우다. 조용히 넘기면 "우천 위험 없음" 으로 읽힌다
    if (this.kma === null) return fail('FORECAST_UNAVAILABLE');

    const point = representativePoint(items);
    const grid = point === null ? null : toGrid(point.lon, point.lat);
    if (grid === null) return fail('COORD_MISSING');

    const today = kstToday(now);
    const buckets = { short: [] as string[], mid: [] as string[], climate: [] as string[] };
    for (const date of dates) {
      const offset = daysUntil(today, date);
      if (offset === null || offset < 0) out.set(date, { ok: false, reasonCode: 'FORECAST_UNAVAILABLE' });
      else if (offset <= SHORT_TERM_MAX_OFFSET) buckets.short.push(date);
      else if (offset <= MID_TERM_MAX_OFFSET) buckets.mid.push(date);
      else buckets.climate.push(date);
    }

    await Promise.all([
      this.fillShortTerm(buckets.short, grid, now, out),
      this.fillMidTerm(buckets.mid, product, now, out),
      this.fillClimate(buckets.climate, product, out),
    ]);
    return out;
  }

  /** D+0 ~ D+3. 시간대별 값을 그대로 넘긴다 — 야외 시간대를 덮는지는 규칙이 본다 */
  private async fillShortTerm(
    dates: readonly string[],
    grid: { nx: number; ny: number },
    now: Date,
    out: Map<string, DailyRainOutlook>,
  ): Promise<void> {
    if (dates.length === 0 || this.kma === null) return;
    try {
      const forecast = await this.kma.shortTermPop(grid, chooseShortPublication(now));
      for (const date of dates) {
        const slots = forecast.pop.get(date);
        // 예보에 없는 날짜를 0% 로 읽지 않는다
        if (slots === undefined) out.set(date, { ok: false, reasonCode: 'FORECAST_UNAVAILABLE' });
        else out.set(date, { ok: true, source: 'SHORT', slots });
      }
    } catch (e) {
      for (const date of dates) {
        out.set(date, { ok: false, reasonCode: isKmaError(e) ? e.reasonCode : 'FORECAST_UNAVAILABLE' });
      }
    }
  }

  /**
   * D+4 ~ D+10. 발표분은 **가장 이른 대상 일자**로 고른다.
   *
   * 오프셋 범위의 끝이 항상 +10 이라 이른 쪽을 덮는 발표분이 늦은 쪽도 덮는다.
   * 저녁에 최신 18시 발표분을 쓰면 그날의 D+4 가 창 밖으로 밀린다 (EI-WX-003).
   */
  private async fillMidTerm(
    dates: readonly string[],
    product: ProductRow,
    now: Date,
    out: Map<string, DailyRainOutlook>,
  ): Promise<void> {
    if (dates.length === 0 || this.kma === null) return;

    const regId = midLandRegionOf(product.ldongRegnCd ?? null, product.ldongSignguCd ?? null);
    const earliest = [...dates].sort()[0] as string;
    const publication = regId === null ? null : chooseMidPublication(now, earliest);
    if (regId === null || publication === null) {
      for (const date of dates) out.set(date, { ok: false, reasonCode: 'FORECAST_UNAVAILABLE' });
      return;
    }

    try {
      const forecast = await this.kma.midLandRain(regId, publication);
      for (const date of dates) {
        const probability = forecast.byDate.get(date);
        if (probability === undefined) out.set(date, { ok: false, reasonCode: 'FORECAST_UNAVAILABLE' });
        else out.set(date, { ok: true, source: 'MID', probability });
      }
    } catch (e) {
      for (const date of dates) {
        out.set(date, { ok: false, reasonCode: isKmaError(e) ? e.reasonCode : 'FORECAST_UNAVAILABLE' });
      }
    }
  }

  /** D+11 이상. 사전 구축 고정 테이블이며 실시간 호출 의무와 무관하다 (EI-WX-004 · SC-DT-014) */
  private async fillClimate(
    dates: readonly string[],
    product: ProductRow,
    out: Map<string, DailyRainOutlook>,
  ): Promise<void> {
    if (dates.length === 0) return;
    const regnCd = product.ldongRegnCd ?? null;

    for (const date of dates) {
      const month = Number(date.slice(5, 7));
      if (this.climate === null || regnCd === null || !Number.isFinite(month)) {
        out.set(date, { ok: false, reasonCode: 'CLIMATE_DATA_MISSING' });
        continue;
      }
      try {
        const normal = await this.climate.find(regnCd, month);
        if (normal === null) out.set(date, { ok: false, reasonCode: 'CLIMATE_DATA_MISSING' });
        else {
          out.set(date, {
            ok: true, source: 'CLIMATE',
            probability: normal.rainRatio, rainDays: normal.rainDays,
            regionName: normal.regionName, month,
          });
        }
      } catch {
        out.set(date, { ok: false, reasonCode: 'CLIMATE_DATA_MISSING' });
      }
    }
  }

  /**
   * [4단계] 기대 콘텐츠 프로파일을 읽는다 (FR-RU-100).
   *
   * 타깃 · 콘셉트는 **선택 입력**이라 안 적은 상품이 있다. 그때는 `undefined` 를 주고
   * R10 이 조용히 물러난다 — 안 적은 것을 결함이라 말할 근거가 없다.
   *
   * 적었는데 그 조합의 프로파일이 없으면 확인 불가로 남긴다. 비슷한 조합으로 대신
   * 판정하지 않는다 (FR-RU-051).
   */
  private async fetchTargetProfile(product: ProductRow): Promise<TargetProfileContext | undefined> {
    const targetKey = product.targetKey ?? null;
    const conceptKey = product.conceptKey ?? null;
    if (targetKey === null || conceptKey === null || targetKey === '' || conceptKey === '') return undefined;
    if (this.profiles === null || this.accountId === null) return { ok: false, targetKey, conceptKey };

    try {
      const row = await this.profiles.find(this.accountId, targetKey, conceptKey);
      if (row === null) return { ok: false, targetKey, conceptKey };
      return {
        ok: true,
        targetKey: targetKey as TargetKey,
        conceptKey: conceptKey as ConceptKey,
        expectedLcls2: row.expectedLcls2,
        expectsNight: row.expectsNight,
      };
    } catch {
      return { ok: false, targetKey, conceptKey };
    }
  }

  /**
   * 상세 조회 2종. 같은 콘텐츠를 두 번 부르지 않도록 호출자가 중복을 미리 걷어낸다.
   *
   * **`detailIntro2` 가 필수고 `detailCommon2` 는 보조다.** 판정 근거(운영시간 · 휴무일 ·
   * 행사 기간)는 전부 소개정보에 있다. 공통정보는 `modifiedtime` 을 주는데, 그건 변경 감지의
   * 보조 신호일 뿐 판정에는 쓰이지 않는다 — 지문(`field_hash`)이 판정 필드의 변경을 이미
   * 빠짐없이 잡는다 (DR-FP-002).
   *
   * 그래서 공통정보가 실패해도 검수를 접지 않는다. 한 엔드포인트의 장애가 전체를 세우는
   * 구조를 만들지 않는 게 낫다.
   */
  private async fetchOne(contentId: string, contentTypeId: ContentTypeId): Promise<FetchedContent> {
    const [commonResult, intro] = await Promise.all([
      this.kto.detailCommon(contentId).then(
        (v) => v,
        (): Record<string, unknown> => ({}),
      ),
      this.kto.detailIntro(contentId, contentTypeId),
    ]);
    return {
      contentTypeId,
      intro,
      common: commonResult,
      normalized: parseOperatingInfo({ contentTypeId, raw: intro }),
    };
  }

  private buildContext(
    product: ProductRow,
    items: readonly ItineraryItemRow[],
    fetched: ReadonlyMap<string, FetchedContent>,
    verdicts: ReadonlyMap<string, ChangeVerdict>,
    travelTimes: ReadonlyMap<string, TravelSegment>,
    rainOutlooks: ReadonlyMap<string, DailyRainOutlook>,
    targetProfile: TargetProfileContext | undefined,
  ): ItineraryContext {
    const start = parseIsoDate(product.startDate);

    const auditItems: AuditItem[] = items.map((item) => {
      const date = start === null ? product.startDate : formatIsoDate(addDays(start, item.dayNo - 1));
      // 종료시간 보완은 판정 전에 끝난다 (FR-RU-031)
      const resolved = resolveEndTime({
        startTime: item.startTime, endTime: item.endTime,
        itemType: item.itemType, lclsSystm2: item.lclsSystm2,
      // 계정 설정의 체류시간 표를 쓴다. 규칙이 상수를 직접 읽지 않는 것과 같은 이유다
      }, this.settings.dwellMinutes);

      return {
        id: item.id, dayNo: item.dayNo, seq: item.seq, date,
        startTime: item.startTime,
        endTime: resolved.endTime,
        endTimeSource: item.endTime === null ? resolved.source : item.endTimeSource,
        itemType: item.itemType, placeLabel: item.placeLabel,
        lclsSystm1: item.lclsSystm1,
        lclsSystm2: item.lclsSystm2,
        lclsSystm3: item.lclsSystm3,
        mapX: item.mapX,
        mapY: item.mapY,
        matchStatus: item.matchStatus,
        content: toMatchedContent(item, fetched, verdicts),
      };
    });

    return {
      productId: product.id, items: auditItems, holidays: KOREAN_HOLIDAYS,
      settings: this.settings, travelTimes, rainOutlooks, targetProfile,
    };
  }
}

function toMatchedContent(
  item: ItineraryItemRow,
  fetched: ReadonlyMap<string, FetchedContent>,
  verdicts: ReadonlyMap<string, ChangeVerdict>,
): MatchedContent | null {
  if (item.ktoContentId === null) return null;
  const content = fetched.get(item.ktoContentId);
  if (content === undefined) return null;

  return {
    ktoContentId: item.ktoContentId,
    contentTypeId: content.contentTypeId,
    normalized: content.normalized,
    showFlag: content.common.showflag === '0' ? 0 : 1,
    eventPeriod: content.contentTypeId === 15 ? readEventPeriod(content.intro) : null,
    changeVerdict: verdicts.get(item.ktoContentId) ?? null,
  };
}

/**
 * 강수 판정 근거가 갈리는 경계 (FR-RU-091).
 *
 * D+3 을 단기에 두는 것은 중기육상예보에 `rnSt3` 이 없어서다. 중기로 보내면 빈 값을 받고
 * 그걸 0% 로 읽으면 비 오는 날이 정상 판정된다 (EI-WX-003).
 */
const SHORT_TERM_MAX_OFFSET = 3;
const MID_TERM_MAX_OFFSET = 10;

/** 상품이 덮는 여행 일자. 항목이 없는 일차도 출발일 + 박수로 채운다 */
function travelDates(product: ProductRow, items: readonly ItineraryItemRow[]): readonly string[] {
  const start = parseIsoDate(product.startDate);
  if (start === null) return [];
  const dates = new Set<string>();
  for (const item of items) dates.add(formatIsoDate(addDays(start, item.dayNo - 1)));
  return [...dates].sort();
}

/** `target − today` (일). 못 읽으면 null */
function daysUntil(today: string, target: string): number | null {
  const a = parseIsoDate(today);
  const b = parseIsoDate(target);
  if (a === null || b === null) return null;
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

/** 공사는 `YYYYMMDD` 로 준다. 스키마 표기 `YYYY-MM-DD` 로 옮긴다 */
function readEventPeriod(intro: Record<string, unknown>): { start: string | null; end: string | null } {
  return { start: toIsoDate(intro.eventstartdate), end: toIsoDate(intro.eventenddate) };
}

function toIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

/**
 * 조회에 실패한 콘텐츠를 **확인 불가로 남긴다.**
 *
 * 실패한 항목을 결과에서 지우면 사용자는 그 관광지가 검수된 줄 안다. 삭제하지 않고
 * 확인 불가로 결과에 남기는 것이 원칙이다 (EX-CM-003).
 */
function isolationFindings(
  items: readonly ItineraryItemRow[],
  failures: ReadonlyMap<string, FetchFailure>,
): readonly Finding[] {
  const out: Finding[] = [];
  for (const item of items) {
    if (item.ktoContentId === null) continue;
    const failure = failures.get(item.ktoContentId);
    if (failure === undefined) continue;

    out.push({
      // 조회 자체가 안 된 것이라 휴무 판정과 무관하다. 사유는 실패한 이유 그대로 단다
      ruleCode: 'R05',
      ruleVersion: RULESET_VERSION,
      severity: 'UNVERIFIED',
      reasonCode: failure.reasonCode,
      targetItemId: item.id,
      message: `${item.placeLabel} — ${failure.message}`,
      evidence: { isolated: true, exceptionReasonCode: failure.reasonCode, unit: 'CONTENT' },
      requiresExternal: false,
      externalSource: null,
      needsConfirmation: true,
    });
  }
  return out;
}

/** 구간 계산에 필요한 만큼만 옮긴 얕은 형태 */
function toAuditShape(item: ItineraryItemRow): AuditItem {
  return {
    id: item.id, dayNo: item.dayNo, seq: item.seq, date: '',
    startTime: item.startTime, endTime: item.endTime, endTimeSource: item.endTimeSource,
    lclsSystm1: item.lclsSystm1, lclsSystm2: item.lclsSystm2, lclsSystm3: item.lclsSystm3,
    mapX: item.mapX, mapY: item.mapY, itemType: item.itemType, placeLabel: item.placeLabel,
    matchStatus: item.matchStatus, content: null,
  };
}

/**
 * 카카오가 받는 출발시각 `YYYYMMDDHHMM` 을 만든다 (EI-KM-003).
 *
 * 시각이 `HH:MM` 으로 올지 `HH:MM:SS` 로 올지는 위층 사정이라, 숫자만 남기고 12자리로
 * 자른다. `13:00:00` 에 `replace(':','')` 를 쓰면 `1300:00` 이 나가고 카카오는 그걸
 * 조용히 무시한다 — 틀린 시간대의 소요시간으로 오류를 내게 된다.
 */
export function departureStamp(isoDate: string, time: string): string | null {
  const digits = `${isoDate}${time}`.replace(/\D/g, '');
  return digits.length < 12 ? null : digits.slice(0, 12);
}

/** 상품 단위 총 이동시간·거리 (FR-RU-084). 조회 못 한 구간은 빼고 센다 */
function totalTravel(
  travelTimes: ReadonlyMap<string, TravelSegment>,
): { durationSeconds: number; distanceMeters: number } {
  let durationSeconds = 0;
  let distanceMeters = 0;
  for (const s of travelTimes.values()) {
    if (!s.ok) continue;
    durationSeconds += s.durationSeconds;
    distanceMeters += s.distanceMeters;
  }
  return { durationSeconds, distanceMeters };
}

interface Target {
  readonly contentId: string;
  readonly contentTypeId: ContentTypeId;
}

/** 확정 매칭된 항목의 **고유** contentid. 같은 곳을 두 번 조회하면 예산만 태운다 */
export function uniqueContentIds(items: readonly ItineraryItemRow[]): readonly Target[] {
  const seen = new Map<string, Target>();
  for (const item of items) {
    if (item.matchStatus !== 'CONFIRMED' || item.ktoContentId === null) continue;
    if (item.contentTypeId === null || !isSupportedContentTypeId(item.contentTypeId)) continue;
    if (seen.has(item.ktoContentId)) continue;
    seen.set(item.ktoContentId, { contentId: item.ktoContentId, contentTypeId: item.contentTypeId });
  }
  // 조회 순서를 고정한다 — 순서가 흔들리면 호출 로그와 진행률이 실행마다 달라진다
  return [...seen.values()].sort((a, b) => (a.contentId < b.contentId ? -1 : 1));
}

/** 기본 동시 실행 수 (NF-PF-010) */
export const DEFAULT_AUDIT_CONCURRENCY = 8;

/**
 * `AUDIT_CONCURRENCY` 를 읽는다. 값이 없거나 말이 안 되면 기본값으로 간다.
 *
 * 0 이나 음수를 그대로 받으면 조회가 한 건도 안 나가고 검수가 멈춘 것처럼 보인다.
 */
export function concurrencyFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AUDIT_CONCURRENCY);
  if (!Number.isInteger(raw) || raw < 1) return DEFAULT_AUDIT_CONCURRENCY;
  return raw;
}

/**
 * 동시 실행 수를 `limit` 로 제한해 돌린다 (NF-PF-010). 순서는 보장하지 않고 완료만 기다린다.
 *
 * **묶음이 아니라 미끄러지는 창이다.** `limit` 개씩 잘라 `Promise.all` 로 기다리면 한 묶음의
 * 가장 느린 호출이 끝날 때까지 나머지 일꾼이 논다 — 12곳이면 두 묶음이라 느린 꼬리를 두 번
 * 문다. p95 목표에서 꼬리 지연은 그대로 비용이다 (NF-PF-001).
 */
export async function withConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    // 인덱스를 하나씩 집어 간다. 끝나는 즉시 다음 것을 잡으므로 노는 일꾼이 없다
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
}

export { CONTENT_TYPE_ID, INTRO_FIELDS };
