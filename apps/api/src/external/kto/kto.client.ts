import {
  CONTENT_TYPE_ID,
  KTO_PROVIDER_OF,
  KTO_SERVICE_OF,
  LOCATION_RADIUS_MAX_METERS,
  type ContentTypeId,
  type KtoOperation,
} from '@tourlint/shared';
import type { ApiCallLogEntry, ApiCallLogger, CallStatus } from '../api-call-log';
import { parseKtoResponse, type KtoEnvelope } from './envelope';
import {
  ContentNotFoundError, KtoAuthError, KtoError, KtoFetchError, KtoInvalidRequestError, KtoQuotaExceededError, KtoTimeoutError,
} from './kto.errors';
import type { KtoParams, KtoTransport } from './transport';

/**
 * 공사 OpenAPI 어댑터 (EI-CM-003).
 *
 * 규칙엔진·화면은 이 클래스만 본다. HTTP·재시도·봉투 해석·호출 로깅이 전부 여기 모여 있다.
 * 오퍼레이션은 **허용된 16종**(국문 관광정보 9 · 새 서비스 5종의 7)만 노출한다 (EI-KT-001).
 *
 * 호출 1건 = 로그 1행이다. 실패도 남긴다 — 증빙이자 예산 카운트의 근거다 (EI-CM-006 · FR-OP-001).
 * 제공자는 서비스마다 따로 적는다. 활용신청과 하루 한도가 서비스마다 따로다 (외부 연동 3-1).
 */

export interface KtoListPage {
  readonly items: readonly Record<string, unknown>[];
  readonly pageNo: number | null;
  readonly numOfRows: number | null;
  readonly totalCount: number | null;
}

export interface KtoClientOptions {
  readonly transport: KtoTransport;
  readonly logger: ApiCallLogger;
  /** 실패 시 재시도 횟수. EI-CM-005 는 **최대 2회**로 정한다 */
  readonly maxRetries?: number;
  /** 지수 백오프 기준. n 번째 재시도 = baseDelayMs × 2^(n-1) */
  readonly baseDelayMs?: number;
  /** 테스트 주입용 — 실제 대기 없이 재시도를 검증한다 */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => Date;
  /** 이 클라이언트가 낸 호출을 어느 검수 실행에 귀속시킬지. 배치는 null */
  readonly auditRunId?: number | null;
  /**
   * 증빙 로깅이 실패했을 때 알릴 곳. 기본은 무시다.
   * 로그 유실은 조용해도 되지만 **검수는 계속돼야** 한다 (DR-LC-004 vs 서비스 가용성).
   */
  readonly onLogFailure?: (error: unknown) => void;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 300;
/** `numOfRows` 상한 — 2000까지 동작하지만 안전 마진으로 1000 (EI-KT-013) */
export const KTO_MAX_ROWS = 1000;

/**
 * 방문자수 `numOfRows` — 지역 조건이 없어 기간의 전국 시군구가 한 번에 온다 (EI-KT-026).
 * 한 달치 전국이 2만 4천 행 안팎이라(2025년 9월 23,760행) 1콜에 받으려면 이만큼 필요하다.
 */
export const KTO_VISITOR_ROWS = 30_000;
/** 방문자수 조회 기간 상한(일). 한 달을 넘기면 `KTO_VISITOR_ROWS` 1콜에 다 오지 않는다 */
export const KTO_VISITOR_MAX_DAYS = 31;

/**
 * `areaBasedList2` 정렬 코드 (EI-KT-021 실측).
 *
 * `D` 생성일 내림차순 · `C` 수정일 내림차순. 안 주면 정렬되지 않는다.
 * 이미지 유무까지 거르는 `O` · `Q` · `R` 은 쓰지 않는다 — 사진이 없다고 신규가 아닌 것이 아니다.
 */
export const AREA_LIST_ARRANGE = { CREATED_DESC: 'D', MODIFIED_DESC: 'C' } as const;
export type AreaListArrange = (typeof AREA_LIST_ARRANGE)[keyof typeof AREA_LIST_ARRANGE];

export class KtoClient {
  private readonly transport: KtoTransport;
  private readonly logger: ApiCallLogger;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => Date;
  private readonly auditRunId: number | null;
  private readonly onLogFailure: (error: unknown) => void;

  constructor(options: KtoClientOptions) {
    this.transport = options.transport;
    this.logger = options.logger;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.clock = options.clock ?? (() => new Date());
    this.auditRunId = options.auditRunId ?? null;
    this.onLogFailure = options.onLogFailure ?? ((): void => undefined);
  }

  // ── 국문 관광정보 ──────────────────────────────────────────────

  /** 키워드로 관광지를 찾는다. 일정 항목 ↔ 콘텐츠 매칭의 출발점이다 */
  async searchKeyword(params: {
    keyword: string;
    contentTypeId?: ContentTypeId;
    lDongRegnCd?: string;
    lDongSignguCd?: string;
    numOfRows?: number;
    pageNo?: number;
  }): Promise<KtoListPage> {
    return this.list('searchKeyword2', {
      keyword: params.keyword,
      ...optional('contentTypeId', params.contentTypeId),
      ...optional('lDongRegnCd', params.lDongRegnCd),
      ...optional('lDongSignguCd', params.lDongSignguCd),
      numOfRows: clampRows(params.numOfRows),
      pageNo: params.pageNo ?? 1,
    });
  }

  /** 공통정보 — 좌표 · 주소 · `lclsSystm1/2/3` · `cpyrhtDivCd` · `showflag` */
  async detailCommon(contentId: string): Promise<Record<string, unknown>> {
    return this.detail('detailCommon2', contentId, { contentId });
  }

  /**
   * 소개정보 — **운영시간 · 휴무일 원문이 여기 있다.** 검수 지문의 판정 필드 출처다.
   *
   * `contentTypeId` 를 함께 넘겨야 유형별 필드가 채워져 온다.
   */
  async detailIntro(contentId: string, contentTypeId: ContentTypeId): Promise<Record<string, unknown>> {
    if (!(CONTENT_TYPE_ID as readonly number[]).includes(contentTypeId)) {
      throw new KtoFetchError('detailIntro2', `지원하지 않는 contentTypeId: ${contentTypeId}`);
    }
    return this.detail('detailIntro2', contentId, { contentId, contentTypeId });
  }

  /**
   * 행사 목록.
   *
   * `eventStartDate` 는 "그 날짜 이후 시작" 이 아니라 **"그 날짜에 아직 끝나지 않은 행사"** 를
   * 돌려준다 (EI-KT-010 실측). 그래서 여행기간 겹침 조회는 여행 **시작일** 하나로 충분하고,
   * 추가 보정 로직을 넣지 않는다 — 넣으면 이미 진행 중인 행사를 놓친다.
   */
  async searchFestival(params: {
    eventStartDate: string;
    lDongRegnCd?: string;
    lDongSignguCd?: string;
    numOfRows?: number;
    pageNo?: number;
  }): Promise<KtoListPage> {
    return this.list('searchFestival2', {
      eventStartDate: params.eventStartDate,
      ...optional('lDongRegnCd', params.lDongRegnCd),
      ...optional('lDongSignguCd', params.lDongSignguCd),
      numOfRows: clampRows(params.numOfRows),
      pageNo: params.pageNo ?? 1,
    });
  }

  /**
   * 위치기반 목록 — 수정안 후보를 고를 때 쓴다. 반경 상한 20km (EI-KT-008 · SC-DT-013).
   *
   * 기획 화면의 식당 · 숙소 3km 칩은 `lclsSystm1`(FD · AC)로 거른다. 응답은 거리순이 아니다 —
   * 거리순이 필요하면 `dist` 로 정렬한다 (외부 연동 3-4).
   */
  async locationBasedList(params: {
    mapX: number;
    mapY: number;
    radius: number;
    contentTypeId?: ContentTypeId;
    lclsSystm1?: string;
    lclsSystm2?: string;
    lclsSystm3?: string;
    numOfRows?: number;
    pageNo?: number;
  }): Promise<KtoListPage> {
    if (params.radius > LOCATION_RADIUS_MAX_METERS) {
      // 조용히 잘라내면 화면에 표시된 반경과 실제 조회 반경이 어긋난다
      throw new KtoFetchError(
        'locationBasedList2',
        `반경 상한 초과: ${params.radius}m (상한 ${LOCATION_RADIUS_MAX_METERS}m)`,
      );
    }
    return this.list('locationBasedList2', {
      mapX: params.mapX,
      mapY: params.mapY,
      radius: params.radius,
      ...optional('contentTypeId', params.contentTypeId),
      ...optional('lclsSystm1', params.lclsSystm1),
      ...optional('lclsSystm2', params.lclsSystm2),
      ...optional('lclsSystm3', params.lclsSystm3),
      numOfRows: clampRows(params.numOfRows),
      pageNo: params.pageNo ?? 1,
    });
  }

  /**
   * 법정동 지역 코드 (EI-KT-001). 인자가 없으면 시도, `lDongRegnCd` 를 주면 그 시도의
   * 시군구를 돌려준다. 상품 지역 드롭다운(UI-S2-004)의 출처다.
   */
  async ldongCode(lDongRegnCd?: string): Promise<KtoListPage> {
    return this.list('ldongCode2', {
      ...optional('lDongRegnCd', lDongRegnCd),
      numOfRows: KTO_MAX_ROWS,
      pageNo: 1,
    });
  }

  /**
   * 분류체계 코드 (신 `lclsSystm` · EI-KT-001). 인자가 없으면 대분류(lv1)를 돌려준다.
   * 일정 항목 유형 선택의 출처다.
   */
  async lclsSystmCode(params: { lclsSystm1?: string; lclsSystm2?: string } = {}): Promise<KtoListPage> {
    return this.list('lclsSystmCode2', {
      ...optional('lclsSystm1', params.lclsSystm1),
      ...optional('lclsSystm2', params.lclsSystm2),
      numOfRows: KTO_MAX_ROWS,
      pageNo: 1,
    });
  }

  /**
   * 동기화 목록 (`areaBasedSyncList2` · EI-KT-011 · 012 · F12 배치 1단계).
   *
   * ⚠️ **`modifiedtime` 은 해당일 분만 준다. 누적되지 않는다.** 그래서 배치가 직전 성공일
   *    다음 날부터 어제까지 **하루씩 순회**한다 (FR-MO-011). 한 번 부르고 끝내면 그 사이
   *    날짜의 변경을 통째로 놓친다.
   *
   * ⚠️ **건수를 상수로 가정하지 않는다.** 같은 일자인데 새벽 02시 11건, 오후 3시 177건이
   *    돌아왔다 (2026.08.20 실측). 공사가 하루 종일 갱신하기 때문이다. 동기화 지연 판단은
   *    0건 조건으로만 한다 (FR-MO-015).
   *
   * `showflag` 를 지정하지 않는다 — 그래야 표출 · 비표출이 **함께** 온다. 비표출 감지를
   * 위한 별도 호출을 하지 않는 이유다 (EI-KT-012 · FR-MO-012).
   */
  async areaBasedSyncList(params: { modifiedDate: string; pageNo?: number }): Promise<KtoListPage> {
    return this.list('areaBasedSyncList2', {
      modifiedtime: params.modifiedDate,
      numOfRows: KTO_MAX_ROWS,
      pageNo: params.pageNo ?? 1,
    });
  }

  /**
   * 지역기반 목록 — T1 신규 등록 신호와 수정안 후보 보강에 쓴다.
   *
   * `arrange` 는 **`D` = 생성일 내림차순 · `C` = 수정일 내림차순**이고 지정하지 않으면
   * 정렬되지 않는다 (EI-KT-021 실측). T1 은 `D` 로 첫 페이지부터 읽다가 `createdtime` 이
   * 기준일보다 이르면 멈춘다 — 정렬 없이 훑으면 한 지역 1,005건이라 상품당 열 콜이 넘는다.
   */
  async areaBasedList(params: {
    lDongRegnCd?: string;
    lDongSignguCd?: string;
    contentTypeId?: ContentTypeId;
    /** 기획 화면 종류 칩의 등록 수는 분류로 거른 `totalCount` 다 (외부 연동 3-3 6행) */
    lclsSystm1?: string;
    lclsSystm2?: string;
    lclsSystm3?: string;
    arrange?: AreaListArrange;
    numOfRows?: number;
    pageNo?: number;
  }): Promise<KtoListPage> {
    return this.list('areaBasedList2', {
      ...optional('lDongRegnCd', params.lDongRegnCd),
      ...optional('lDongSignguCd', params.lDongSignguCd),
      ...optional('contentTypeId', params.contentTypeId),
      ...optional('lclsSystm1', params.lclsSystm1),
      ...optional('lclsSystm2', params.lclsSystm2),
      ...optional('lclsSystm3', params.lclsSystm3),
      ...optional('arrange', params.arrange),
      numOfRows: clampRows(params.numOfRows),
      pageNo: params.pageNo ?? 1,
    });
  }

  // ── 새 서비스 5종 (EI-KT-022 ~ 026 · 2026.09.15 실호출 확정) ─────────────

  /**
   * 무장애 여행 정보 지역 목록 — 휠체어 가능 필터의 `contentid` 집합 (EI-KT-022).
   *
   * 목록의 `contentid` 는 국문 관광정보와 같다. 시군구 하나가 1콜에 온다(강릉 729건).
   * 경로는 국문과 같은 `areaBasedList2` 이고 서비스(`KorWithService2`)만 다르다.
   */
  async withAreaBasedList(params: RegionListParams): Promise<KtoListPage> {
    return this.list('withAreaBasedList2', regionListParams(params));
  }

  /** 무장애 상세 — 카드를 펼칠 때만 부른다. 필터에는 목록 값만 쓴다 (EI-KT-022) */
  async detailWithTour(contentId: string): Promise<Record<string, unknown>> {
    return this.detail('detailWithTour2', contentId, { contentId });
  }

  /** 반려동물 동반여행정보 지역 목록 — 국문과 다른 서비스(`KorPetTourService2`)다 (EI-KT-023) */
  async petAreaBasedList(params: RegionListParams): Promise<KtoListPage> {
    return this.list('petAreaBasedList2', regionListParams(params));
  }

  /** 반려동물 동반 조건 상세 — 카드를 펼칠 때만 부른다 (EI-KT-023) */
  async detailPetTour(contentId: string): Promise<Record<string, unknown>> {
    return this.detail('detailPetTour2', contentId, { contentId });
  }

  /**
   * 연관 관광지 — 기준 관광지 이름으로 찾는다 (EI-KT-024).
   *
   * 응답에 국문 `contentid` 가 없다. 이름 · 시군구로 대조하는 것은 호출자 몫이다.
   * `areaCd` 는 시도 2자리, `signguCd` 는 시도를 앞에 붙인 5자리다(강릉 `51` · `51150`).
   * 모양이 틀리면 공사가 0건을 돌려줘 순위가 조용히 사라지므로 부르기 전에 막는다.
   */
  async relatedSearchKeyword(params: {
    keyword: string;
    baseYm: string;
    areaCd: string;
    signguCd: string;
    numOfRows?: number;
    pageNo?: number;
  }): Promise<KtoListPage> {
    const problem =
      params.keyword.trim() === '' ? '기준 관광지 이름이 비어 있다'
        : !/^\d{6}$/.test(params.baseYm) ? `baseYm 은 YYYYMM: ${params.baseYm}`
          : !/^\d{2}$/.test(params.areaCd) ? `areaCd 는 2자리: ${params.areaCd}`
            : !/^\d{5}$/.test(params.signguCd) || !params.signguCd.startsWith(params.areaCd)
              ? `signguCd 는 areaCd 로 시작하는 5자리: ${params.signguCd}`
              : null;
    if (problem !== null) throw new KtoInvalidRequestError('searchKeyword1', problem);
    return this.list('searchKeyword1', {
      keyword: params.keyword,
      baseYm: params.baseYm,
      areaCd: params.areaCd,
      signguCd: params.signguCd,
      numOfRows: clampRows(params.numOfRows ?? 100),
      pageNo: params.pageNo ?? 1,
    });
  }

  /**
   * 두루누비 걷기 길 코스 — 지역 조건 없이 전국이 1콜에 온다 (EI-KT-025, 141건).
   *
   * 좌표가 없고 코스 하나만 부르는 조회도 없다. 상품 지역은 호출자가 `sigun` 글자로 거른다.
   */
  async courseList(): Promise<KtoListPage> {
    return this.listWhole('courseList', { numOfRows: KTO_MAX_ROWS, pageNo: 1 });
  }

  /**
   * 기초 지자체 방문자 수 — 기간의 전국 시군구가 한 번에 온다 (EI-KT-026). 레이더 T3 배치 전용.
   *
   * 지역 조건 파라미터가 없다(`signguCode` 를 주면 오류). 응답의 `signguCode` 는
   * `lDongRegnCd` + `lDongSignguCd` 다. 기간이 한 달을 넘으면 1콜에 다 오지 않으므로 막는다.
   */
  async locgoRegnVisitrDDList(params: { startYmd: string; endYmd: string }): Promise<KtoListPage> {
    const days = daysInclusive(params.startYmd, params.endYmd);
    if (days === null || days < 1 || days > KTO_VISITOR_MAX_DAYS) {
      throw new KtoInvalidRequestError(
        'locgoRegnVisitrDDList',
        `기간은 YYYYMMDD 로 1 – ${KTO_VISITOR_MAX_DAYS}일: ${params.startYmd} – ${params.endYmd}`,
      );
    }
    return this.listWhole('locgoRegnVisitrDDList', {
      startYmd: params.startYmd,
      endYmd: params.endYmd,
      numOfRows: KTO_VISITOR_ROWS,
      pageNo: 1,
    });
  }

  // ── 내부 ────────────────────────────────────────────────────────

  private async list(operation: KtoOperation, params: KtoParams): Promise<KtoListPage> {
    const envelope = await this.call(operation, params);
    return {
      items: envelope.items,
      pageNo: envelope.pageNo,
      numOfRows: envelope.numOfRows,
      totalCount: envelope.totalCount,
    };
  }

  /**
   * 한 번에 다 온다고 보고 페이지를 넘기지 않는 목록. 잘려 왔으면 던진다 — 잘린 전국 목록으로
   * 거르면 있는 걷기 길 · 방문자 수가 없다고 나온다 (설계 원칙 3).
   */
  private async listWhole(operation: KtoOperation, params: KtoParams): Promise<KtoListPage> {
    const page = await this.list(operation, params);
    if (page.totalCount !== null && page.totalCount > page.items.length) {
      throw new KtoFetchError(operation, `한 번에 다 오지 않았다: ${page.items.length} / ${page.totalCount}건`);
    }
    return page;
  }

  private async detail(
    operation: KtoOperation,
    contentId: string,
    params: KtoParams,
  ): Promise<Record<string, unknown>> {
    const envelope = await this.call(operation, params);
    const first = envelope.items[0];
    // 0건은 오류가 아니라 "없음" 이다. 확인 불가로 격리되도록 전용 예외로 확정한다
    if (first === undefined) throw new ContentNotFoundError(operation, contentId);
    return first;
  }

  /**
   * 한 번의 논리적 호출 — 재시도 · 로깅 · 봉투 해석을 묶는다.
   *
   * **재시도 1회마다 로그 1행**이다. 예산은 실제 나간 호출 수로 세야 하므로
   * 합쳐서 1행으로 줄이지 않는다.
   */
  private async call(operation: KtoOperation, params: KtoParams): Promise<KtoEnvelope> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const startedAt = this.clock();
      let status: CallStatus = 'FAIL';
      let httpStatus: number | null = null;
      let resultCode: string | null = null;

      try {
        const result = await this.transport.request(operation, params);
        httpStatus = result.httpStatus;
        const envelope = parseKtoResponse(operation, result.body, result.httpStatus);
        status = 'OK';
        resultCode = envelope.resultCode;
        return envelope;
      } catch (e) {
        lastError = e;
        status = e instanceof KtoTimeoutError ? 'TIMEOUT' : 'FAIL';
        if (e instanceof KtoFetchError) {
          httpStatus = e.httpStatus ?? httpStatus;
          resultCode = e.resultCode;
        }
        // 인증 오류 · 한도 초과도 코드를 남긴다. 예산 문이 「오늘 공사가 한도 초과라고 답했다」 를
        // 이 기록으로 안다 (EX-QT-005 · #793). 전에는 KtoFetchError 만 남겨 둘 다 null 이었다
        if (e instanceof KtoAuthError || e instanceof KtoQuotaExceededError) resultCode = e.logCode;

        // 인증 오류·쿼터 초과·미존재 콘텐츠는 재시도해도 같다. 남은 예산만 태운다
        if (e instanceof KtoError && !e.retryable) throw e;
        if (attempt === this.maxRetries) throw e;

        await this.sleep(this.baseDelayMs * 2 ** attempt);
      } finally {
        this.record(operation, startedAt, status, httpStatus, resultCode);
      }
    }

    /* c8 ignore next -- 위 루프는 반드시 return 하거나 throw 한다 */
    throw lastError;
  }

  private record(
    operation: KtoOperation,
    startedAt: Date,
    status: CallStatus,
    httpStatus: number | null,
    resultCode: string | null,
  ): void {
    /*
     * 픽스처 리플레이는 남기지 않는다 (FR-OP-001 · 007).
     *
     * 이 표는 공모전 API 활용 증빙이다. 하지 않은 호출이 섞이면 증빙이 아니게 된다.
     * 예산 카운트도 같은 행을 세므로 리플레이로 개발하다 FR-OP-003 자동 중지에 걸렸다.
     */
    if (this.transport.kind === 'fixture') return;

    const entry: ApiCallLogEntry = {
      // 서비스마다 활용신청 · 한도가 따로라 따로 센다. 한 값이면 새 서비스가 국문 예산을 잠식한다
      provider: KTO_PROVIDER_OF[KTO_SERVICE_OF[operation]],
      operation,
      calledAt: startedAt,
      status,
      httpStatus,
      resultCode,
      latencyMs: Math.max(0, this.clock().getTime() - startedAt.getTime()),
      auditRunId: this.auditRunId,
    };
    // 증빙 로깅이 실패해도 검수를 멈추지 않는다.
    //
    // 이 호출은 `finally` 안에서 일어난다. 여기서 예외가 새어 나가면 원래 실패(쿼터 초과 등)를
    // **덮어써서** 호출자가 엉뚱한 원인을 보게 된다. 동기·비동기 양쪽을 다 막아야 한다.
    try {
      const pending = this.logger.record(entry);
      if (pending instanceof Promise) void pending.catch((e: unknown) => this.onLogFailure(e));
    } catch (e) {
      this.onLogFailure(e);
    }
  }
}

/** 무장애 · 반려동물 지역 목록의 조건 — 시군구 단위로 부른다 (외부 연동 3-3 10 · 11행) */
export interface RegionListParams {
  readonly lDongRegnCd: string;
  readonly lDongSignguCd: string;
  readonly numOfRows?: number;
  readonly pageNo?: number;
}

function regionListParams(params: RegionListParams): KtoParams {
  return {
    lDongRegnCd: params.lDongRegnCd,
    lDongSignguCd: params.lDongSignguCd,
    numOfRows: clampRows(params.numOfRows),
    pageNo: params.pageNo ?? 1,
  };
}

/** `YYYYMMDD` 두 날짜 사이 일수(양 끝 포함). 날짜가 아니면 null */
function daysInclusive(startYmd: string, endYmd: string): number | null {
  const toUtc = (ymd: string): number | null => {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd);
    if (m === null) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const t = Date.UTC(y, mo - 1, d);
    const back = new Date(t);
    // 20250231 같은 없는 날짜는 다음 달로 넘어가므로 되돌려 확인한다
    return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t : null;
  };
  const start = toUtc(startYmd);
  const end = toUtc(endYmd);
  if (start === null || end === null) return null;
  return Math.round((end - start) / 86_400_000) + 1;
}

/** 값이 없으면 파라미터를 아예 보내지 않는다 — 빈 문자열을 보내면 공사가 다르게 해석한다 */
function optional(key: string, value: string | number | undefined): Record<string, string | number> {
  return value === undefined ? {} : { [key]: value };
}

function clampRows(rows: number | undefined): number {
  return Math.min(rows ?? KTO_MAX_ROWS, KTO_MAX_ROWS);
}
