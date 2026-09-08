import {
  CONTENT_TYPE_ID,
  LOCATION_RADIUS_MAX_METERS,
  type ContentTypeId,
  type KtoOperation,
} from '@tourlint/shared';
import type { ApiCallLogEntry, ApiCallLogger, CallStatus } from '../api-call-log';
import { parseKtoResponse, type KtoEnvelope } from './envelope';
import { ContentNotFoundError, KtoError, KtoFetchError, KtoTimeoutError } from './kto.errors';
import type { KtoParams, KtoTransport } from './transport';

/**
 * 공사 OpenAPI 어댑터 (EI-CM-003).
 *
 * 규칙엔진·화면은 이 클래스만 본다. HTTP·재시도·봉투 해석·호출 로깅이 전부 여기 모여 있다.
 * 오퍼레이션은 **허용된 9종 중 검수에 쓰는 5종**만 노출한다 (EI-KT-001).
 *
 * 호출 1건 = 로그 1행이다. 실패도 남긴다 — 증빙이자 예산 카운트의 근거다 (EI-CM-006 · FR-OP-001).
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

  // ── 오퍼레이션 5종 ──────────────────────────────────────────────

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

  /** 위치기반 목록 — 수정안 후보를 고를 때 쓴다. 반경 상한 20km (EI-KT-008 · SC-DT-013) */
  async locationBasedList(params: {
    mapX: number;
    mapY: number;
    radius: number;
    contentTypeId?: ContentTypeId;
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
    arrange?: AreaListArrange;
    numOfRows?: number;
    pageNo?: number;
  }): Promise<KtoListPage> {
    return this.list('areaBasedList2', {
      ...optional('lDongRegnCd', params.lDongRegnCd),
      ...optional('lDongSignguCd', params.lDongSignguCd),
      ...optional('contentTypeId', params.contentTypeId),
      ...optional('arrange', params.arrange),
      numOfRows: clampRows(params.numOfRows),
      pageNo: params.pageNo ?? 1,
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
      provider: 'KTO',
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

/** 값이 없으면 파라미터를 아예 보내지 않는다 — 빈 문자열을 보내면 공사가 다르게 해석한다 */
function optional(key: string, value: string | number | undefined): Record<string, string | number> {
  return value === undefined ? {} : { [key]: value };
}

function clampRows(rows: number | undefined): number {
  return Math.min(rows ?? KTO_MAX_ROWS, KTO_MAX_ROWS);
}
