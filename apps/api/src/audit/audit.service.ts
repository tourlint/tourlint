import { HttpStatus, Inject, Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  findingMessage, kstIso, SEVERITY, withPlaceName, type Severity,
} from '@tourlint/shared';
import { DomainException } from '../common/domain.exception';
import { AuditOwnershipRepository } from '../persistence/audit-ownership.repository';
import { LlmParseCacheRepository } from '../persistence/llm-parse-cache.repository';
import { BatchStateRepository } from '../persistence/batch-state.repository';
import { applyNormalizeFallback } from './normalize-fallback';
import { buildRunFingerprint, shortFingerprint } from '../engine/fingerprint';
import { ktoBudgetGuard } from '../external/budget-guard';
import type { CallIntent } from '../external/budget-guard';
import { KakaoMobilityClient, createKakaoTransport } from '../external/kakao';
import { KmaClient, createKmaTransport } from '../external/kma';
import { createKtoClient } from '../external/kto';
import { LlmClient, createProvider, readLlmConfig } from '../external/llm';
import { DB_POOL } from '../persistence/db';
import { PgApiCallLogger, RunScopedCallLogger } from '../persistence/api-call-log.repository';
import type { ApiCallLogger } from '../external/api-call-log';
import { AuditResultRepository, type StoredAuditRun } from '../persistence/audit-result.repository';
import { NotificationRepository } from '../persistence/notification.repository';
import { ClimateNormalRepository } from '../persistence/climate-normal.repository';
import { UserSettingRepository } from '../persistence/user-setting.repository';
import {
  PatchApplicationRepository,
  type StoredPatchApplication,
} from '../persistence/patch-application.repository';
import { AuditJobRepository, isStale, type AuditJob, type TriggerType } from './audit-job.repository';
import { AuditRunner, type ItineraryItemRow, type ProductRow } from './audit-runner';
import { PlaceNameResolver, applyNames, collectPatchContentIds, replacedContentIds } from './place-name';
import { WalkNameResolver } from '../plan/walk-names';
import { RULES, RULESET_VERSION, RULE_EXPLANATIONS } from './rule-registry';
import type { AuditSettings } from '../engine/rules/types';
import type { NormalizedOperatingInfo } from '../engine/normalize/types';
import { applyPatches } from './patch-apply';
import { checkConflicts, type Conflict, type PatchRef } from './patch-conflict';
import { fromSnapshot, snapshotToken, toSnapshot } from './patch-snapshot';
import { comparisonMetrics } from './comparison-metrics';
import { selectionKey, type SelectedPatch } from './patch-types';
import { ProductRepository } from './product.repository';
import { currentRunOf } from '../persistence/current-run';

/**
 * 검수 실행 조율 (API 설계 6-1).
 *
 * 사전 검증 → 큐 적재 → 202 응답까지가 요청 경로다 (p95 500ms). 실제 검수는 그 뒤에서 돈다.
 * 검수는 8곳에 15초가 걸리므로 요청을 붙잡고 있을 수 없다.
 */

/** 동시에 도는 검수 수. 초과분은 큐에서 기다린다 (API 설계 6-1) */
const MAX_RUNNING = 3;
/** `waitForIdle` 이 큐가 비기를 기다리는 간격과 횟수 — 30초까지 본다 */
const IDLE_POLL_MS = 25;
const IDLE_POLL_MAX = 1_200;
/** 폴링 간격 안내값 */
const POLL_INTERVAL_MS = 2000;

/**
 * 미리보기 응답.
 *
 * `previewToken` 은 저장된 표의 열쇠가 아니라 **본 일정 그 자체의 해시**다. 확정 요청이
 * 이 값을 되돌려주면 그 사이 일정이 바뀌었는지 서버가 다시 계산해 맞춰 볼 수 있다
 * (EX-PA-002). 미리보기는 여전히 아무것도 쓰지 않는다.
 */
export interface PatchPreview {
  readonly previewToken: string;
  readonly conflict: { readonly hasConflict: boolean; readonly pairs: readonly Conflict[] };
  readonly before: readonly ItineraryItemRow[];
  readonly after: readonly ItineraryItemRow[];
  /** 대상이 이미 없어 반영하지 못한 선택. 조용히 삼키지 않는다 */
  readonly skipped: readonly { readonly patchId: string; readonly reason: string }[];
}

/** 확정 응답 (API 설계 5-8). 재검수는 뒤에서 돌고 `reauditJobId` 로 따라간다 */
export interface PatchApplied {
  readonly patchApplicationId: number;
  readonly beforeAuditRunId: number | null;
  readonly reauditJobId: number;
  readonly pollIntervalMs: number;
}

/** 리소스별 404 문구. 무엇을 찾다 실패했는지는 알려 주되 존재 여부는 말하지 않는다 */
type OwnedKind = 'product' | 'run' | 'job' | 'finding' | 'patchApplication';

const NOT_FOUND_MESSAGE: Readonly<Record<OwnedKind, string>> = {
  product: '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.',
  run: '검수 결과를 찾을 수 없습니다. 목록에서 다시 선택해 주세요.',
  job: '검수 작업을 찾을 수 없습니다. 다시 요청해 주세요.',
  finding: '발견 항목을 찾을 수 없습니다. 목록을 새로 고쳐 주세요.',
  patchApplication: '수정 이력을 찾을 수 없습니다. 목록을 새로 고쳐 주세요.',
};

/** 이름을 못 찾은 걷기 길의 표시 이름. 현재 일정표(`ProductService.detail`)와 같은 말이다 */
export const WALK_FALLBACK_LABEL = '걷기 길';

@Injectable()
export class AuditService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuditService.name);
  private readonly jobs: AuditJobRepository;
  private readonly products: ProductRepository;
  private readonly results: AuditResultRepository;
  private readonly patchApplications: PatchApplicationRepository;
  private readonly callLogger: PgApiCallLogger;
  private readonly owns: AuditOwnershipRepository;
  private readonly parseCache: LlmParseCacheRepository;
  /** 그 날의 국문 예산을 읽는다 — 예산 게이트 · 배치 · 호출량 화면과 같은 출처 (#777) */
  private readonly state: BatchStateRepository;
  /**
   * 대체 관광지 이름 조회 (DR-PR-001).
   *
   * **생성자에서 만들지 않는다.** 인증키가 비면 `HttpKtoTransport` 가 생성자에서 던져
   * 앱 전체가 못 뜬다 — 배치에서 한 번 겪고 `app-boot.spec` 이 잡아 줬는데 여기서 또 했다.
   */
  private nameResolver: PlaceNameResolver | null = null;
  private running = 0;
  /** 상한에 걸려 돌아간 요청이 있었는가. 슬롯이 나면 대신 집는다 */
  private pendingDrain = false;
  /** 돌고 있는 검수들. 테스트가 완료를 기다릴 수 있게 붙잡아 둔다 */
  private readonly inFlight = new Set<Promise<void>>();
  /** 이 프로세스가 지금 돌리는 작업 번호. 종료 신호에 닫는다 (#772) */
  private readonly runningJobs = new Set<number>();

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    /** 걷기 길의 표시 이름. 상품 응답 · 리포트와 같은 것을 쓴다 — 10분 캐시를 나눠 쓰려고 주입받는다 (#739) */
    @Optional() @Inject(WalkNameResolver) private readonly walkNames?: WalkNameResolver,
  ) {
    this.jobs = new AuditJobRepository(pool);
    this.products = new ProductRepository(pool);
    this.results = new AuditResultRepository(pool);
    this.patchApplications = new PatchApplicationRepository(pool);
    this.callLogger = new PgApiCallLogger(pool);
    this.owns = new AuditOwnershipRepository(pool);
    this.parseCache = new LlmParseCacheRepository(pool);
    this.state = new BatchStateRepository(pool);
  }

  /**
   * 정규화 폴백 (F03). LLM 설정이 없으면 `null` — 폴백 없이 검수한다 (FR-AU-010).
   *
   * **생성자에서 만들지 않는다.** 설정이 비면 생성자가 던져 앱 전체가 못 뜬다 —
   * 공사 클라이언트에서 두 번 겪은 실수다.
   */
  private normalizeFallback(logger: ApiCallLogger = this.callLogger): ((n: NormalizedOperatingInfo) => Promise<NormalizedOperatingInfo>) {
    const config = readLlmConfig();
    const llm = config === null ? null : new LlmClient({
      provider: createProvider(config), config, logger,
    });
    return async (n) => applyNormalizeFallback(n, { llm, cache: this.parseCache });
  }

  /**
   * 검수를 요청한다.
   *
   * 사전 검증 순서가 곧 사용자에게 보이는 우선순위다 —
   * 상품이 없으면 404, 미확정이 남았으면 422, 예산이 없으면 429, 이미 돌고 있으면 기존 작업.
   */
  async requestAudit(productId: number, triggerType: TriggerType): Promise<{ job: AuditJob; created: boolean }> {
    const product = await this.products.findProduct(productId);
    if (product === null) {
      throw new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.', 'PRODUCT');
    }

    // FR-PL-001 — 검수는 「검수 시작」을 지난 상품만 돈다.
    //
    // 화면은 검수 시작 버튼이 `handoff` 를 부르므로 보통 여기 걸리지 않는다. 다만 API 가
    // 관문을 강제하지 않으면 보드는 「검수 시작 전」인데 상세는 점수를 보이는 상태가
    // 만들어진다 — 2026-09-17 리허설이 실제로 그렇게 만들었다 (이슈 #469).
    // `handoff` 는 `applyHandoff` 로 `planned_at` 을 먼저 쓰므로 그대로 지난다.
    if ((await this.products.plannedAtOf(productId)) === null) {
      throw new DomainException(
        HttpStatus.FORBIDDEN, 'FORBIDDEN_ACTION',
        '기획 중인 상품입니다. 검수 시작을 먼저 눌러 주세요.', 'REQUEST',
      );
    }

    // EX-AU-001 — 미확정 관광지가 남아 있으면 검수를 시작하지 않는다
    const unresolved = await this.products.findUnresolvedItems(productId);
    if (unresolved.length > 0) {
      throw new DomainException(
        HttpStatus.UNPROCESSABLE_ENTITY, 'PLACE_UNRESOLVED',
        `관광지 ${unresolved.length}곳이 아직 확정되지 않았습니다. 일정 편집에서 관광지를 선택하거나 검수 대상에서 제외한 뒤 다시 요청해 주세요.`,
        'PRODUCT',
        unresolved.map((u) => ({ field: `items[${u.id}]`, message: `${u.placeLabel} 미확정` })),
      );
    }

    await this.assertBudget(triggerType === 'BATCH' ? 'BATCH' : 'USER_AUDIT');

    // EX-AU-002 — 기한을 넘겨 멈춘 작업을 먼저 닫는다. 안 닫으면 아래가 그것을 돌려준다 (#772)
    await this.closeStaleJobs();
    // EX-AU-004 — 진행 중인 작업이 있으면 새로 만들지 않고 그것을 돌려준다
    const enqueued = await this.jobs.enqueue(productId, triggerType);
    if (enqueued.created) this.track(this.drain());
    return enqueued;
  }

  async getJob(jobId: number): Promise<AuditJob> {
    const job = await this.jobs.findById(jobId);
    if (job === null) {
      throw new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', '검수 작업을 찾을 수 없습니다. 다시 요청해 주세요.', 'REQUEST');
    }
    // 폴링하던 작업이 기한을 넘겼으면 닫은 상태를 준다 — 화면이 끝없이 기다리지 않는다 (#772)
    if (isStale(job, new Date())) {
      await this.closeStaleJobs();
      return (await this.jobs.findById(jobId)) ?? job;
    }
    return job;
  }

  /**
   * 그 리소스가 이 계정 것인지 확인하고, 아니면 404 로 끊는다 (PM-DA-002 · EX-SY-003).
   *
   * **없는 것과 남의 것을 구분하지 않는다.** 403 을 내면 그 자체가 「존재한다」는 답이
   * 된다 (PM-DA-003).
   *
   * 진입점에서만 막는다 — 서비스 내부와 배치는 계정이 없다. 배치는 전 계정을 돈다.
   */
  async assertOwns(kind: OwnedKind, id: number, accountId: number): Promise<void> {
    const check = {
      product: async (): Promise<boolean> => this.owns.product(id, accountId),
      run: async (): Promise<boolean> => this.owns.run(id, accountId),
      job: async (): Promise<boolean> => this.owns.job(id, accountId),
      finding: async (): Promise<boolean> => this.owns.finding(id, accountId),
      patchApplication: async (): Promise<boolean> => this.owns.patchApplication(id, accountId),
    }[kind];
    if (await check()) return;
    throw new DomainException(
      HttpStatus.NOT_FOUND, 'NOT_FOUND', NOT_FOUND_MESSAGE[kind], 'REQUEST',
    );
  }

  async getRun(auditRunId: number): Promise<StoredAuditRun> {
    const run = await this.results.findById(auditRunId);
    if (run === null) {
      throw new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', '검수 결과를 찾을 수 없습니다. 목록에서 다시 선택해 주세요.', 'REQUEST');
    }
    return run;
  }

  /**
   * finding 이 가리키는 항목의 표시 정보 (API 설계 5-6 `target`).
   *
   * 화면은 「2일차 3번째 · 14:00 · 오죽헌」처럼 어디를 말하는지 보여줘야 하는데 finding 은
   * `target_item_id` 만 들고 있다. 그래서 항목을 한 번 읽어 얹는다.
   *
   * `placeLabel` 은 **사용자 입력**이라 응답에 담아도 무저장 원칙과 무관하다 — DB 명세서
   * 6-4 검증 ① 이 명시적으로 제외한 값이다.
   */
  async targetsByItem(run: StoredAuditRun): Promise<ReadonlyMap<number, FindingTarget>> {
    const items = await this.products.findItems(run.productId);
    const labels = await this.displayLabels(items);
    const out = new Map<number, FindingTarget>();
    for (const item of items) {
      out.set(item.id, {
        dayNo: item.dayNo,
        seq: item.seq,
        startTime: item.startTime,
        placeLabel: labels.get(item.id) ?? '',
      });
    }
    return out;
  }

  /**
   * 항목의 표시 이름 (#606).
   *
   * 사용자가 적은 이름이 있으면 그것이다. **장소 담기 · 수정안 삽입으로 들어온 항목만** 비어
   * 있어(명칭은 공사 원문이라 저장하지 않는다 — DR-PR-001) 그 항목만 표시 시점에 조회한다.
   * 이름을 못 읽으면 비워 둔다 — 지어내지 않는다.
   */
  async displayLabels(items: readonly ItineraryItemRow[]): Promise<ReadonlyMap<number, string>> {
    const unnamed = items.filter((i) => i.placeLabel.trim() === '');
    const missing = unnamed.filter((i) => i.ktoContentId !== null);
    // 걷기 길은 `walk_id` 만 가진 행이다 — 코스 이름은 공사 원문이라 저장하지 않는다 (DR-MD-005 · #739)
    const walks = unnamed.filter((i) => i.ktoContentId === null && (i.walkId ?? null) !== null);
    const [found, walkFound] = await Promise.all([
      missing.length === 0
        ? Promise.resolve(new Map<string, string>())
        : this.placeNames().resolve(missing.map((i) => i.ktoContentId ?? '')),
      walks.length === 0 || this.walkNames === undefined
        ? Promise.resolve(new Map<string, string>())
        : this.walkNames.resolve(walks.map((i) => i.walkId ?? '')),
    ]);
    const out = new Map<number, string>();
    for (const item of items) {
      let label = item.placeLabel;
      if (label.trim() === '') {
        label = item.ktoContentId !== null
          ? found.get(item.ktoContentId) ?? ''
          // 이름을 못 찾은 걷기 길은 현재 일정표와 같이 적는다 (`ProductService.detail`)
          : (item.walkId ?? null) !== null ? walkFound.get(item.walkId ?? '') ?? WALK_FALLBACK_LABEL : '';
      }
      if (label !== '') out.set(item.id, label);
    }
    return out;
  }

  /**
   * 판정 근거 3단 중 **AI 해석** (FR-AU-013 · 061).
   *
   * 해석은 콘텐츠 단위로 저장돼 있고 화면은 항목 단위로 그리므로 여기서 이어 붙인다.
   * 자체 산출물이라 공사 호출이 없다 (5-12).
   */
  async normalizedByItem(run: StoredAuditRun): Promise<ReadonlyMap<number, Record<string, unknown>>> {
    const [items, byContent] = await Promise.all([
      this.products.findItems(run.productId),
      this.results.normalizedOf(run.id),
    ]);
    const out = new Map<number, Record<string, unknown>>();
    for (const item of items) {
      if (item.ktoContentId === null) continue;
      const view = byContent.get(item.ktoContentId);
      if (view === undefined) continue;
      const body = typeof view.normalized === 'object' && view.normalized !== null
        ? (view.normalized as Record<string, unknown>)
        : {};
      // 해석하지 못한 조각도 신뢰도는 말해 준다 (FR-AU-006 · 007)
      out.set(item.id, { ...body, confidence: view.confidence });
    }
    return out;
  }

  /** 일정 항목. 확인 필요 목록이 관광지명·위치를 채우는 데 쓴다 — DB 만 읽는다 (0콜) */
  async itemsOf(productId: number): Promise<readonly ItineraryItemRow[]> {
    return this.products.findItems(productId);
  }

  /** 상품 한 줄. 검수 에이전트가 방문 날짜를 출발일 + 일차로 적는 데 쓴다 (FR-AG-020) */
  async productOf(productId: number): Promise<ProductRow | null> {
    return this.products.findProduct(productId);
  }

  /**
   * 검수 근거 영역에 실을 대표 지문 (DR-FP-008 · FR-PA-062).
   *
   * `toRunResponse` 가 인자로 받도록 돼 있었는데 아무도 넘기지 않아 `dataFingerprint` 가
   * 늘 `null` 이었다. PDF 리포트가 같은 값을 싣기 때문에 여기서 한 곳으로 모은다.
   */
  async runFingerprint(auditRunId: number): Promise<string | undefined> {
    const parts = await this.results.fingerprintHashesOf(auditRunId);
    return parts.length === 0 ? undefined : buildRunFingerprint([...parts]);
  }

  /**
   * 검수 근거 영역에 실을 값 (UI-CM-030 · 031).
   *
   * 화면 3 · 4 · 5 와 PDF 가 같은 것을 보여야 해서 한 자리에서 모은다.
   */
  async runBasis(auditRunId: number): Promise<RunBasis> {
    const [fingerprint, ktoModifiedAt] = await Promise.all([
      this.runFingerprint(auditRunId),
      this.results.latestKtoModifiedOf(auditRunId),
    ]);
    return { fingerprint, ktoModifiedAt };
  }

  /**
   * 고른 수정안을 반영하면 어떻게 되는지 미리 본다 (F08 · FR-PA-004 ~ 007).
   *
   * **아무것도 저장하지 않는다.** 확정은 별도 요청이고, 여기서는 충돌 여부와 반영 후
   * 일정표만 돌려준다. `FR-PA-008` 이 "전체 자동 선택" 을 금지하므로 선택 목록은 항상
   * 사용자가 보낸 그대로다 — 우리가 더하거나 빼지 않는다.
   */
  async previewPatches(
    productId: number,
    selections: readonly PatchRef[],
  ): Promise<PatchPreview> {
    const { items, selected } = await this.resolveSelections(productId, selections);
    const conflict = checkConflicts(items, selected);
    const applied = applyPatches(items, selected);
    return {
      // 확정 요청이 이 값을 되돌려주면 그 사이 일정이 바뀌었는지 알 수 있다 (EX-PA-002)
      previewToken: snapshotToken(items),
      conflict: { hasConflict: conflict.hasConflict, pairs: conflict.conflicts },
      before: await this.withMissingNames(items),
      after: await this.withMissingNames(await this.withReplacedNames(items, applied.items)),
      skipped: applied.skipped,
    };
  }

  /**
   * 이름이 빈 항목의 이름을 **응답에만** 채운다 (#713).
   *
   * 장소 담기 · 수정안 삽입으로 들어온 항목은 `place_label` 이 비어 있다(DR-PR-001). 현재 일정표와
   * 직접 확인할 곳은 `displayLabels` 로 채우는데 미리보기만 빠져 `18:00 숙박` · `12:05~13:35 관광`
   * 처럼 이름 없는 줄이 나왔다. `previewToken` 은 채우기 전 항목으로 만든다 — 표시용 이름이
   * 「일정이 바뀌었는가」 판정에 섞이면 안 된다.
   */
  private async withMissingNames(items: readonly ItineraryItemRow[]): Promise<readonly ItineraryItemRow[]> {
    if (!items.some((i) => i.placeLabel.trim() === '' && (i.ktoContentId !== null || (i.walkId ?? null) !== null))) return items;
    const labels = await this.displayLabels(items);
    return items.map((i) => (i.placeLabel.trim() === '' ? { ...i, placeLabel: labels.get(i.id) ?? '' } : i));
  }

  /**
   * 대체된 항목의 이름을 **응답에만** 채운다 (DR-PR-001).
   *
   * `REPLACE_CONTENT` 는 자리를 두고 콘텐츠만 바꾸며 `placeLabel` 은 건드리지 않는다 —
   * 대체 후보의 명칭이 공사 원문이라 저장할 수 없기 때문이다. 그래서 전후 비교가 **같아
   * 보였다.** 표시용으로만 이름을 얹는다. 저장된 `place_label` 은 그대로다.
   *
   * 이름을 못 읽으면 원래 이름을 둔다. 지어내지 않는다.
   */
  private async withReplacedNames(
    before: readonly ItineraryItemRow[],
    after: readonly ItineraryItemRow[],
  ): Promise<readonly ItineraryItemRow[]> {
    const ids = replacedContentIds(before, after);
    if (ids.length === 0) return after;
    return applyNames(before, after, await this.placeNames().resolve(ids));
  }

  /** 첫 조회 때 만든다. 캐시를 살리려고 한 번 만든 것을 계속 쓴다 */
  private placeNames(): PlaceNameResolver {
    this.nameResolver ??= new PlaceNameResolver({ kto: () => createKtoClient(this.callLogger) });
    return this.nameResolver;
  }

  /**
   * 수정안에 실을 관광지 이름 (FR-PA-003). 저장하지 않고 표시할 때만 채운다.
   *
   * **대체(`REPLACE_CONTENT`)와 추가(`INSERT_ITEM`) 둘 다다.** 추가 수정안도 무엇을 넣는지가
   * 전부라, 이름이 없으면 후보 둘이 화면에 똑같이 보인다 — 「2일차에 관광 추가」가 두 줄.
   */
  async replacementNames(run: StoredAuditRun): Promise<ReadonlyMap<string, string>> {
    const ids = collectPatchContentIds(run);
    return ids.length === 0 ? new Map() : this.placeNames().resolve(ids);
  }

  /**
   * 고른 수정안을 확정한다 (F09 · FR-PA-020 ~ 025 · 028).
   *
   * ## 거절이 먼저다
   *
   * 일정을 쓰고 나서 거절할 일이 생기면 되돌릴 방법이 없다. 그래서 **거절 사유를 전부 앞에
   * 모아** 둔다 — 충돌(EX-PA-001) · 일정 변경(EX-PA-002) · 대상 소실 · 예산 · 진행 중인
   * 검수. 여기를 통과하면 남은 것은 트랜잭션 하나뿐이다 (EX-PA-003).
   *
   * ## 재검수는 정확히 한 번이다
   *
   * 수정안을 넷 골랐든 하나 골랐든 `audit_job` 하나만 만든다 (FR-PA-022). 수정안마다
   * 돌리면 8곳짜리 상품에 공사 호출이 네 배로 들고, 중간 상태를 검수한 결과가 사용자에게
   * 보인다.
   */
  async confirmPatches(
    productId: number,
    selections: readonly PatchRef[],
    previewToken: string | null,
  ): Promise<PatchApplied> {
    const { items, selected } = await this.resolveSelections(productId, selections);

    /*
     * 미리보기 이후 일정이 바뀌었으면 거절한다 (EX-PA-002). 토큰은 일정 자체의 해시라
     * 여기서 다시 계산해 맞춰 본다. 화면이 토큰을 안 보내면 이 검사를 건너뛴다 — 없는
     * 값을 틀렸다고 할 수는 없고, 아래 충돌·대상 소실 검사가 그대로 남는다.
     */
    if (previewToken !== null && previewToken !== snapshotToken(items)) {
      throw new DomainException(
        HttpStatus.CONFLICT, 'PATCH_STALE',
        '미리 본 뒤 일정이 변경되었습니다. 다시 검토한 뒤 확정해 주세요.', 'REQUEST',
      );
    }

    const conflict = checkConflicts(items, selected);
    if (conflict.hasConflict) {
      // 시스템이 하나를 골라 해제하지 않는다. 어느 쪽을 살릴지는 사용자만 안다 (FR-PA-006)
      throw new DomainException(
        HttpStatus.CONFLICT, 'PATCH_CONFLICT',
        '선택한 수정안 사이에 충돌이 있어 확정할 수 없습니다. 충돌하는 수정안 중 하나를 해제해 주세요.',
        'REQUEST',
        conflict.conflicts.map((c) => ({
          field: `${selectionKey(c.a)} ↔ ${selectionKey(c.b)}`,
          message: c.message,
        })),
      );
    }

    const applied = applyPatches(items, selected);
    if (applied.skipped.length > 0) {
      /*
       * 대상이 사라진 수정안이 하나라도 있으면 통째로 거절한다. 미리보기는 못 넣은 것을
       * 알려 주기만 하면 되지만, 확정은 나머지만 반영하는 순간 사용자가 고르지 않은
       * 조합이 일정이 된다 — 부분 반영을 남기지 않는다 (EX-PA-003).
       */
      throw new DomainException(
        HttpStatus.CONFLICT, 'PATCH_STALE',
        '선택한 수정안의 대상 일정이 이미 변경되었습니다. 다시 검토한 뒤 확정해 주세요.', 'REQUEST',
        applied.skipped.map((s) => ({ field: s.patchId, message: s.reason })),
      );
    }

    /*
     * 검수가 돌고 있으면 확정을 받지 않는다.
     *
     * `enqueue` 는 진행 중인 작업이 있으면 그것을 돌려준다 (EX-AU-004). 그대로 두면 확정
     * 응답이 **패치 전 일정을 보고 있는** 작업 번호를 재검수라며 내주고, 정작 바뀐 일정의
     * 재검수는 영영 돌지 않는다. 사유코드 39종에 "진행 중" 이 없어, 확정의 전제가 흔들린
     * 경우로 묶어 `PATCH_STALE` 로 답한다.
     */
    // 기한을 넘겨 멈춘 작업은 진행 중이 아니다. 닫지 않으면 확정이 영영 409 다 (#772)
    await this.closeStaleJobs();
    const active = await this.jobs.findActive(productId);
    if (active !== null) {
      throw new DomainException(
        HttpStatus.CONFLICT, 'PATCH_STALE',
        '검수가 진행 중입니다. 끝난 뒤 결과를 확인하고 확정해 주세요.', 'REQUEST',
      );
    }

    // 예산은 쓰기 전에 본다. 다 쓴 뒤 재검수를 못 돌리면 검수 결과 없는 일정만 남는다
    await this.assertBudget('USER_AUDIT');

    const owner = await this.products.findOwner(productId);
    if (owner === null) {
      throw new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.', 'PRODUCT');
    }

    const appliedAt = new Date();
    const beforeAuditRunId = await this.results.currentRunIdOf(productId);
    const saved = await this.patchApplications.apply({
      productId,
      appliedBy: owner,
      appliedAt,
      selections: selected.map((s) => ({ findingId: s.findingId, patchId: s.patchId })),
      before: toSnapshot(productId, items, appliedAt),
      afterItems: applied.items,
      beforeAuditRunId,
    });

    // 반영 뒤 전 규칙 재검수 1회 (FR-PA-022 · 024). 새 `audit_run` 이 생기고 이전 것은 남는다
    const { job } = await this.jobs.enqueue(productId, 'PATCH');
    this.track(this.drain());

    return {
      patchApplicationId: saved.id,
      beforeAuditRunId,
      reauditJobId: job.id,
      pollIntervalMs: POLL_INTERVAL_MS,
    };
  }

  /**
   * 무시 처리 (FR-AU-045 · PM-NG-001).
   *
   * **차단 등급은 무시할 수 없다.** 화면이 버튼을 감추더라도 API 가 독립적으로 막는다 —
   * 그 판정을 없앤 채로 출시하면 손님이 문 닫은 곳 앞에 선다 (PM-NG-001 · 탈락 사유).
   */
  async dismissFinding(findingId: number, reason: string | null): Promise<void> {
    const result = await this.results.dismiss(findingId, reason);
    if (result === 'NOT_FOUND') {
      throw new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', '판정을 찾을 수 없습니다.', 'REQUEST');
    }
    if (result === 'BLOCKER') {
      throw new DomainException(
        HttpStatus.FORBIDDEN, 'FORBIDDEN_ACTION',
        '차단 등급은 무시할 수 없습니다. 일정을 고치거나 해당 항목을 검수에서 제외해 주세요.',
        'REQUEST',
      );
    }
  }

  /** 무시 해제 (FR-AU-047) */
  async undismissFinding(findingId: number): Promise<void> {
    if (!(await this.results.undismiss(findingId))) {
      throw new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', '판정을 찾을 수 없습니다.', 'REQUEST');
    }
  }

  /** 확인 필요 목록 체크 (FR-AU-008). 점수에서 빠지지 않는다 — 무시와 다르다 */
  async confirmFinding(findingId: number): Promise<void> {
    if (!(await this.results.confirm(findingId))) {
      throw new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', '판정을 찾을 수 없습니다.', 'REQUEST');
    }
  }

  /**
   * 전후 비교의 재료 (F10 · API 설계 5-9).
   *
   * 대상은 **되돌리지 않은 가장 최근 이력**이다. 되돌린 이력을 빼는 이유는 그 「적용 후
   * 일정」이 더는 존재하지 않기 때문이다 — 지금 일정은 되돌아간 쪽이라, 오른쪽에 놓으면
   * 있지도 않은 상태를 견주게 된다.
   *
   * 오른쪽(`after_audit_run_id`)이 비어 있으면 재검수가 아직 안 끝났거나 실패한 것이라
   * 비교할 것이 없다 (EX-PA-004).
   */
  async getComparison(productId: number): Promise<{
    application: StoredPatchApplication;
    before: StoredAuditRun;
    after: StoredAuditRun;
  }> {
    const application = await this.patchApplications.latestOf(productId);
    if (application === null || application.revertedAt !== null) {
      throw new DomainException(
        HttpStatus.NOT_FOUND, 'NOT_FOUND',
        '비교할 수정 이력이 없습니다. 수정안을 반영하면 전후를 비교할 수 있습니다.', 'REQUEST',
      );
    }

    const before = await this.findRun(application.beforeAuditRunId);
    const after = await this.findRun(application.afterAuditRunId);
    if (before === null || after === null) {
      throw new DomainException(
        HttpStatus.NOT_FOUND, 'NOT_FOUND',
        '반영 후 재검수가 아직 끝나지 않았습니다. 검수가 끝나면 전후를 비교할 수 있습니다.', 'REQUEST',
      );
    }
    return { application, before, after };
  }

  /**
   * 전후 비교의 일정표 (UI-S5-003 · FR-PA-042 · #806).
   *
   * 반영 기록에 남은 스냅샷 둘이다 — 지금 일정이 아니다. 반영 뒤 사람이 일정을 고쳤어도 이
   * 비교는 그 반영이 무엇을 바꿨는지를 보인다. 이름은 미리보기처럼 **응답에만** 채운다 —
   * 대체 · 추가한 곳의 이름은 공사 명칭이라 저장하지 않는다 (DR-PR-001).
   */
  async comparisonSchedule(
    application: StoredPatchApplication,
  ): Promise<{ readonly before: readonly ScheduleRow[]; readonly after: readonly ScheduleRow[] }> {
    const before = fromSnapshot(application.before);
    const after = fromSnapshot(application.after);
    const [named, namedAfter] = await Promise.all([
      this.withMissingNames(before),
      this.withReplacedNames(before, after).then((rows) => this.withMissingNames(rows)),
    ]);
    return { before: named.map(toScheduleRow), after: namedAfter.map(toScheduleRow) };
  }

  /** 그 상품의 검수 이력 (F13) */
  async listRuns(productId: number): Promise<readonly StoredAuditRun[]> {
    return this.results.runsOfProduct(productId);
  }

  /**
   * 지금 일정에 대응하는 실행 (#551). 결과 화면이 처음 여는 실행이다 — 되돌린 뒤 새로고침해도
   * 되돌린 일정의 결과가 보여야 한다. 반영 뒤 재검수 전이면 `null` 이다.
   */
  async currentRunIdOf(productId: number): Promise<number | null> {
    return (await currentRunOf(this.pool, productId))?.runId ?? null;
  }

  /**
   * 있으면 주고 없으면 `null`.
   *
   * `getRun` 과 달리 던지지 않는다 — 재검수가 아직 안 끝났거나 실패한 이력은
   * `after_audit_run_id` 가 비어 있는 것이 정상이고(EX-PA-004), 그걸 404 로 만들면
   * 이력 조회 자체가 막힌다.
   */
  async findRun(auditRunId: number | null): Promise<StoredAuditRun | null> {
    return auditRunId === null ? null : this.results.findById(auditRunId);
  }

  async latestPatchApplication(productId: number): Promise<StoredPatchApplication | null> {
    return this.patchApplications.latestOf(productId);
  }

  async getPatchApplication(id: number): Promise<StoredPatchApplication> {
    const application = await this.patchApplications.findById(id);
    if (application === null) {
      throw new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', '패치 이력을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.', 'REQUEST');
    }
    return application;
  }

  /**
   * 되돌린다 (FR-PA-026 · EX-PA-006).
   *
   * **직전 1건만** 받는다. 두 단계 전으로 돌아가려면 그 사이 이력의 `after_snapshot` 을
   * 건너뛰어야 하는데, 그러면 중간 확정에서 사용자가 고른 선택이 소리 없이 사라진다.
   *
   * 준비도가 떨어졌다는 이유로 여기를 자동으로 부르지 않는다. 되돌릴지는 사용자가
   * 결정한다 (FR-PA-027).
   */
  async revertPatch(id: number): Promise<{ application: StoredPatchApplication; revertedAt: Date }> {
    const application = await this.getPatchApplication(id);

    if (application.revertedAt !== null) {
      throw new DomainException(
        HttpStatus.CONFLICT, 'UNDO_UNAVAILABLE',
        '이미 되돌린 패치입니다. 되돌리기는 한 번만 할 수 있습니다.', 'REQUEST',
      );
    }

    const latest = await this.patchApplications.latestOf(application.productId);
    if (latest === null || latest.id !== application.id) {
      throw new DomainException(
        HttpStatus.CONFLICT, 'UNDO_UNAVAILABLE',
        '직전에 반영한 패치만 되돌릴 수 있습니다. 이후 반영한 패치를 먼저 확인해 주세요.', 'REQUEST',
      );
    }

    const revertedAt = new Date();
    await this.patchApplications.revert(application, revertedAt);
    return { application, revertedAt };
  }

  /**
   * 선택 목록을 실제 수정안으로 바꾼다. 미리보기와 확정이 **같은 문**을 쓴다.
   *
   * 두 경로가 각자 확인하면 한쪽에만 조건이 붙는 날이 온다 — 미리보기에서 막히던 것이
   * 확정에서는 통과하는 식이다.
   */
  private async resolveSelections(
    productId: number,
    selections: readonly PatchRef[],
  ): Promise<{ items: readonly ItineraryItemRow[]; selected: readonly SelectedPatch[] }> {
    const product = await this.products.findProduct(productId);
    if (product === null) {
      throw new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.', 'PRODUCT');
    }
    if (selections.length === 0) {
      throw new DomainException(HttpStatus.BAD_REQUEST, 'PATCH_STALE', '반영할 수정안을 선택해 주세요.', 'REQUEST');
    }

    const items = await this.products.findItems(productId);
    const byFinding = await this.results.patchesOfProduct(productId, [...new Set(selections.map((s) => s.findingId))]);

    const selected: SelectedPatch[] = [];
    for (const s of selections) {
      const patch = byFinding.get(s.findingId)?.find((p) => p.patchId === s.patchId);
      if (patch === undefined) {
        /*
         * 재검수가 돌면 finding 이 새로 만들어져 이전 id 는 사라진다. 화면이 오래된
         * 목록을 들고 있었다는 뜻이라 `PATCH_STALE` 이다 — 없는 걸 조용히 빼고 나머지만
         * 반영하면 사용자는 고르지 않은 결과를 받는다.
         */
        throw new DomainException(
          HttpStatus.CONFLICT, 'PATCH_STALE',
          '검수 결과가 갱신되어 선택한 수정안을 찾을 수 없습니다. 새로 고친 뒤 다시 선택해 주세요.', 'REQUEST',
        );
      }
      selected.push({ ...patch, findingId: s.findingId });
    }
    return { items, selected };
  }

  /**
   * 돌고 있는 검수가 모두 끝날 때까지 기다린다.
   *
   * 요청 경로는 202 를 즉시 돌려주고 검수는 뒤에서 돈다. 테스트가 그 끝을 기다릴 방법이
   * 없으면 "완료 후 조회" 를 검증할 수 없다.
   */
  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
    /*
     * 약속이 다 끝나도 **내 작업이 끝났다는 뜻은 아니다.** 상한에 걸려 돌아간 요청의
     * 작업은 다른 소비자가 집어 가는데, 그쪽 약속은 이 인스턴스의 `inFlight` 에 없다.
     * 테스트 DB 를 스펙 파일들이 함께 쓰면 실제로 갈린다 — 큐가 빌 때까지 본다.
     */
    for (let i = 0; i < IDLE_POLL_MAX; i += 1) {
      const { rows } = await this.pool.query<{ n: string }>(
        `SELECT count(*)::text n FROM audit_job WHERE status IN ('QUEUED','RUNNING')`,
      );
      if (Number(rows[0]?.n ?? '0') === 0) return;
      await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
      while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
    }
  }

  /**
   * 예산 게이트 (FR-OP-003 · 004).
   *
   * 사용자가 누른 검수는 100% 까지 허용한다 — 자동 배치와 달리 미룰 수 없기 때문이다.
   * 패치 확정도 사용자가 누른 것이라 같은 문을 쓴다.
   */
  private async assertBudget(intent: CallIntent): Promise<void> {
    // 예산 화면 · 배치와 같은 값이다. 코드 기본값을 쓰던 때는 DB 값도 증설 종료도 안 먹었다 (#777)
    const { dailyQuota } = await this.state.setting();
    const guard = ktoBudgetGuard('KOR', { counter: this.callLogger, dailyQuota });
    const decision = await guard.check(intent);
    if (!decision.allowed) {
      throw new DomainException(
        HttpStatus.TOO_MANY_REQUESTS, decision.reasonCode ?? 'BUDGET_EXHAUSTED',
        '오늘 사용할 수 있는 공사 데이터 조회량을 모두 썼습니다. 내일 다시 시도하거나 관리자에게 예산 상향을 요청해 주세요.',
        'REQUEST',
      );
    }
  }

  private track(promise: Promise<void>): void {
    const wrapped = promise.finally(() => this.inFlight.delete(wrapped));
    this.inFlight.add(wrapped);
  }

  /** 지난 컨테이너가 남긴 작업을 부팅 때 닫는다 (#772). 기다리지 않는다 — 부팅을 늦출 일이 아니다 */
  onApplicationBootstrap(): void {
    void this.closeStaleJobs();
  }

  /**
   * 기한을 넘긴 작업을 닫는다 (EX-AU-002 · #772).
   *
   * **던지지 않는다.** 정리를 못 했다고 검수 요청까지 막을 일이 아니다 — DB 가 문제면 이어지는
   * 조회가 따로 드러낸다.
   */
  private async closeStaleJobs(): Promise<void> {
    try {
      const closed = await this.jobs.closeStale(new Date());
      if (closed.length > 0) {
        this.logger.warn(`기한을 넘긴 검수 작업 ${closed.length}건을 AUDIT_TIMEOUT 으로 닫았다: ${closed.join(', ')}`);
      }
    } catch (e) {
      this.logger.warn(`멈춘 검수 작업을 정리하지 못했다: ${(e as Error).message}`);
    }
  }

  /**
   * 종료 신호를 받으면 이 프로세스가 돌리던 작업을 닫는다 (NF-AV-008 · #772).
   *
   * 재배포는 곧 이 프로세스를 끝낸다. 닫지 않고 죽으면 그 행이 `RUNNING` 으로 남아 30분
   * 정리 전까지 그 상품이 막힌다. 끊긴 것이지 기한을 넘긴 것이 아니라 `INTERNAL_ERROR` 다.
   */
  async failRunningJobs(): Promise<number> {
    const ids = [...this.runningJobs];
    const now = new Date();
    await Promise.all(ids.map((id) => this.jobs.markFailed(id, 'INTERNAL_ERROR', now).catch(() => undefined)));
    return ids.length;
  }

  /**
   * 길찾기 클라이언트를 만든다. **실패해도 던지지 않는다.**
   *
   * 카카오 키가 없다고 검수 전체가 죽으면 안 된다. R08 만 확인 불가로 남고 나머지 규칙은
   * 그대로 판정한다 (EI-KM-009). 대신 무슨 일이 있었는지는 로그에 남긴다.
   */
  private buildKakaoClient(logger: ApiCallLogger = this.callLogger): KakaoMobilityClient | undefined {
    try {
      return new KakaoMobilityClient({ transport: createKakaoTransport(), logger });
    } catch (e) {
      this.logger.warn(`길찾기 클라이언트를 만들지 못했다. R08 은 확인 불가로 처리된다: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * 계정 설정을 읽는다. **실패해도 던지지 않는다.**
   *
   * 설정을 못 읽었다고 검수를 세우면 DB 가 잠깐 흔들릴 때 검수 전체가 멈춘다. 기본값으로
   * 돌아가되 무엇이 있었는지는 로그에 남긴다 — 조용히 다른 기준으로 판정하면 안 된다.
   */
  private async loadSettings(accountId: number | undefined): Promise<AuditSettings | undefined> {
    if (accountId === undefined) return undefined;
    try {
      return await new UserSettingRepository(this.pool).find(accountId);
    } catch (e) {
      this.logger.warn(`계정 설정을 읽지 못했다. 기본값으로 판정한다: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * 기상청 클라이언트를 만든다. **실패해도 던지지 않는다.**
   *
   * 길찾기와 같은 이유다 — 예보 키가 없다고 검수 전체가 죽으면 안 된다. R09 만 확인
   * 불가로 남는다 (EI-WX-006).
   */
  private buildKmaClient(logger: ApiCallLogger = this.callLogger): KmaClient | undefined {
    try {
      return new KmaClient({ transport: createKmaTransport(), logger });
    } catch (e) {
      this.logger.warn(`기상청 클라이언트를 만들지 못했다. R09 는 확인 불가로 처리된다: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * 큐를 **빌 때까지** 비운다. 동시 실행 상한은 넘지 않는다 (NF-CP-004).
   *
   * 한 건만 집고 끝내면 상한에 걸려 돌아간 요청이 영영 안 풀린다. 호출처가 검수 요청과
   * 수정안 반영 두 곳뿐이고 주기 실행이 없어서, 앞의 작업이 끝나도 **다시 집으러 오는
   * 코드가 없었다** — 4건을 연속으로 넣으면 3건만 돌고 4번째가 `QUEUED` 로 남았다
   * (이슈 #353). 슬롯을 잡은 쪽이 큐가 빌 때까지 계속 집는다.
   *
   * `execute` 는 자기 예외를 스스로 삼키고 작업을 `FAILED` 로 남긴다. 한 건이 실패해도
   * 루프는 그대로 다음 건으로 간다.
   */
  private async drain(): Promise<void> {
    if (this.running >= MAX_RUNNING) {
      /*
       * 상한에 걸려 돌아간다. **돌아갔다는 사실을 남긴다** — 지금 도는 소비자가 큐를
       * 다 비우고 나가는 순간과 이 검사 사이에 틈이 있어서, 그 틈에 들어온 요청은
       * 아무도 집지 않은 채 남는다. #353 을 고치고도 좁게 남아 있던 자리다.
       */
      this.pendingDrain = true;
      return;
    }
    this.running++;
    try {
      for (;;) {
        const job = await this.jobs.claimNext();
        if (job === null) return;
        await this.execute(job.id, job.productId);
      }
    } catch (e) {
      // 큐 소비 실패가 요청 경로로 새어 나가면 안 된다. 202 는 이미 나갔다
      this.logger.error('검수 큐 소비 실패', e);
    } finally {
      this.running--;
      // 슬롯을 놓는 사이에 돌아간 요청이 있었으면 그것을 대신 집는다
      if (this.pendingDrain) {
        this.pendingDrain = false;
        this.track(this.drain());
      }
    }
  }

  /** 파이프라인 1~9단계를 돌리고 결과를 저장한다 */
  private async execute(jobId: number, productId: number): Promise<void> {
    this.runningJobs.add(jobId);
    try {
      const product = await this.products.findProduct(productId);
      const items = await this.products.findItems(productId);
      if (product === null) throw new Error(`상품이 사라졌다: ${productId}`);

      await this.jobs.markRunning(jobId, items.length);

      // 이 검수가 낸 호출만 모은다. 저장이 끝나면 `audit_run` 에 이어 붙인다 (#466)
      const callLog = new RunScopedCallLogger(this.callLogger);

      const runner = new AuditRunner({
        kto: createKtoClient(callLog),
        // 동시 실행 수는 AUDIT_CONCURRENCY 로 조정한다 (NF-PF-010). 안 넘기면 러너가 환경을 본다
        onProgress: (done, total) => this.jobs.updateProgress(jobId, done, total),
        // 직전 검수의 지문. 비표출 전환과 판정 필드 변경이 여기서 잡힌다 (FR-MO-004)
        previousFingerprints: await this.results.previousFingerprints(productId),
        // 배치가 표출 중단으로 기록한 곳. 상세 조회로는 볼 수 없다 (#745 · EI-KT-012)
        hiddenContentIds: await new NotificationRepository(this.pool).hiddenContentIds(productId),
        // 이동시간 판정. 키가 없어도 검수는 돈다 — R08 만 확인 불가로 남는다 (EI-KM-009)
        kakao: this.buildKakaoClient(callLog),
        // 우천 리스크. 평년 표가 비어 있으면 D+11 이상만 확인 불가로 남는다 (이슈 #7)
        kma: this.buildKmaClient(callLog),
        climate: new ClimateNormalRepository(this.pool),
        // 사전 파서가 못 읽은 조각의 LLM 해석. 캐시가 먼저다 (F03 · NF-MT-001)
        normalizeFallback: this.normalizeFallback(callLog),
        // 계정 설정. 못 읽으면 기본값으로 돌아간다 — 설정 조회 실패가 검수를 멈추면 안 된다
        settings: await this.loadSettings(product.accountId),
      });
      const result = await runner.run(product, items);
      if (result.failedRules.length > 0) {
        // 결과에는 확인 불가로 남는다(#774). 왜 깨졌는지는 여기서만 본다
        this.logger.error(`규칙 평가 실패 (job ${jobId}): ${result.failedRules.join(', ')}`);
      }
      // 공사가 멈추라고 답했다 (EX-EI-002 · 003 · #793). 사용자 화면에는 확인 불가 문장으로 보인다
      if (result.ktoHalt === 'KTO_AUTH_ERROR') {
        // 운영자 알림 — 인증키(인코딩 · 디코딩 혼동)나 활용신청 문제라 사용자는 할 수 있는 일이 없다
        this.logger.error(`공사 인증 오류로 검수를 멈췄다 (job ${jobId}) — KTO_SERVICE_KEY 와 활용신청 상태를 확인할 것`);
      } else if (result.ktoHalt === 'KTO_QUOTA_EXCEEDED') {
        this.logger.warn(`공사가 오늘 한도 초과라고 답해 검수를 멈췄다 (job ${jobId}) — 한국 시간 자정까지 공사 호출은 예산 문이 막는다`);
      }

      const auditRunId = await this.results.save({
        productId,
        executedAt: result.executedAt,
        rulesetVersion: result.rulesetVersion,
        targetCount: result.targetCount,
        failedCount: result.failedCount,
        // 실행 시점에 남기지 않으면 F10 이 영영 이 지표를 못 보여준다 (FR-RU-084)
        travelTotals: result.travelTotals,
        findings: result.findings,
        fingerprints: result.fingerprints,
        weights: result.weights,
        score: result.score,
        // 적용 기준. 회사 기준을 나중에 바꿔도 이 실행의 리포트 머리글은 그대로다 (DR-CF-009)
        settingSnapshot: result.settingSnapshot,
      });

      /*
       * 재검수 결과를 이력의 오른쪽에 붙인다 (FR-PA-025 · 전후 비교).
       *
       * 확정이 부른 검수만 붙이도록 좁히지 않는다. 자동 재검수가 실패하면 이력의 오른쪽이
       * 빈 채로 남는데(EX-PA-004), 그 상태를 푸는 수단이 바로 사용자가 다시 누르는
       * 검수이기 때문이다. 좁혀 두면 한 번 실패한 이력은 영영 전후 비교를 못 한다.
       *
       * 붙일 자리가 없으면 아무 일도 하지 않는다 — 대상은 오른쪽이 비어 있고 되돌리지
       * 않은 가장 최근 이력 1건뿐이다.
       */
      /*
       * 이 검수가 낸 호출을 실행에 잇는다 (#466). 실패해도 검수를 멈추지 않는다 —
       * 증빙 연결이 끊기는 것과 검수 결과를 못 주는 것은 무게가 다르다.
       */
      await callLog.linkTo(auditRunId).catch((e: unknown) => {
        this.logger.warn(`호출 로그를 실행 ${auditRunId} 에 잇지 못했다: ${(e as Error).message}`);
      });

      await this.patchApplications.attachAfterRun(productId, auditRunId);

      await this.jobs.markDone(jobId, auditRunId, new Date());
    } catch (e) {
      /*
       * 검수가 통째로 실패해도 작업은 상태를 남긴다. 어디까지 갔는지가 사용자에게 정보다.
       * 패치 확정 뒤라면 **일정 변경은 그대로 둔다** — 자동 롤백하지 않고 재실행 수단만
       * 준다 (EX-PA-004). `after_audit_run_id` 는 비어 있고 이력 조회가 그 사실을 말한다.
       */
      this.logger.error(`검수 실행 실패 (job ${jobId})`, e);
      await this.jobs.markFailed(jobId, 'INTERNAL_ERROR', new Date()).catch(() => undefined);
    } finally {
      this.runningJobs.delete(jobId);
    }
  }
}

// ── 응답 조립 ─────────────────────────────────────────────────────────

export function toJobResponse(job: AuditJob, includePollHint = false): Record<string, unknown> {
  return {
    jobId: job.id,
    status: job.status,
    productId: job.productId,
    progress: {
      done: job.progressDone,
      total: job.progressTotal,
      label: `${job.progressTotal}곳 중 ${job.progressDone}곳 조회 완료`,
    },
    auditRunId: job.auditRunId,
    ...(job.errorCode === null ? {} : { errorCode: job.errorCode }),
    createdAt: kstIso(job.createdAt),
    ...(job.finishedAt === null ? {} : { finishedAt: kstIso(job.finishedAt) }),
    ...(includePollHint ? { pollIntervalMs: POLL_INTERVAL_MS } : {}),
  };
}

/**
 * 검수 결과 요약 (API 설계 5-5).
 *
 * `readinessScore` 와 `counts` 는 **조회 시점 재계산 값**이다. `audit_run` 저장값은 실행 시점
 * 기록으로 불변이며, 무시 건수는 `counts.dismissed` 로 병기한다 (FR-AU-046).
 */
/** 근거 영역 재료. 지문은 전체 값이고 축약은 응답에서 한다 (UI-CM-032) */
export interface RunBasis {
  readonly fingerprint: string | undefined;
  readonly ktoModifiedAt: string | null;
}

/** 근거를 못 모은 경우. 없는 것을 지어내지 않고 빈 값으로 둔다 */
const EMPTY_BASIS: RunBasis = { fingerprint: undefined, ktoModifiedAt: null };

export function toRunResponse(run: StoredAuditRun, basis: RunBasis = EMPTY_BASIS): Record<string, unknown> {
  const c = run.current;
  return {
    auditRunId: run.id,
    productId: run.productId,
    executedAt: kstIso(run.executedAt),
    rulesetVersion: run.rulesetVersion,
    isPartial: run.isPartial,
    readinessScore: c.score,
    scoreBreakdown: {
      formula: c.breakdown,
      deduction: c.score === null ? null : 100 - c.score,
      weights: run.weights,
    },
    // 컬럼이 생기기 전 실행은 null 이다 (API 5-5)
    settingSnapshot: run.settingSnapshot ?? null,
    counts: {
      blocker: c.counts.BLOCKER, error: c.counts.ERROR,
      warning: c.counts.WARNING, unverified: c.counts.UNVERIFIED,
      dismissed: c.dismissedCount,
    },
    needsConfirmationCount: c.needsConfirmationCount,
    targetCount: run.targetCount,
    failedCount: run.failedCount,
    releasable: !c.releaseBlocked,
    releaseBlockedReason: c.releaseBlocked ? `차단 ${c.counts.BLOCKER}건` : null,
    evidence: {
      fetchedAt: kstIso(run.executedAt),
      targetContentCount: run.targetCount,
      dataFingerprint: basis.fingerprint === undefined ? null : shortFingerprint(basis.fingerprint),
      /** 축약 표기 옆에서 전체 값을 확인할 수 있어야 한다 (UI-CM-032) */
      dataFingerprintFull: basis.fingerprint ?? null,
      rulesetVersion: run.rulesetVersion,
      ktoModifiedAt: basis.ktoModifiedAt,
      delayNotice: '공사 데이터는 당일 변경분이 익일 반영되므로 출발 임박 시 운영기관 최종 확인을 권장합니다',
      source: '출처: ⓒ한국관광공사',
    },
  };
}

/** finding 이 가리키는 일정 항목의 표시 정보 (API 설계 5-6 `target`) */
export interface FindingTarget {
  readonly dayNo: number;
  readonly seq: number;
  readonly startTime: string;
  readonly placeLabel: string;
}

/**
 * `itemId` 에 항목 정보를 얹는다.
 *
 * 항목이 사라졌거나(수정안 반영으로 삭제) 대상이 없는 판정(R04 · R10 처럼 상품 전체)이면
 * **id 만 준다.** 없는 값을 지어내지 않는다.
 *
 * `hidden` 이면 `placeLabel` 을 뺀다 — 비표출로 전환된 콘텐츠는 명칭을 재출력하지 않고
 * `contentid` 와 감지 시각만 남긴다 (FR-AU-071 · API 설계 5-6).
 */
function targetOf(
  itemId: number | null,
  targets: ReadonlyMap<number, FindingTarget>,
  hidden = false,
): Record<string, unknown> {
  const found = itemId === null ? undefined : targets.get(itemId);
  if (found === undefined) return { itemId };
  const { placeLabel, ...rest } = found;
  return hidden ? { itemId, ...rest } : { itemId, ...rest, placeLabel };
}

export function toFindingsResponse(
  run: StoredAuditRun,
  severity?: string,
  names: ReadonlyMap<string, string> = new Map(),
  normalized: ReadonlyMap<number, Record<string, unknown>> = new Map(),
  targets: ReadonlyMap<number, FindingTarget> = new Map(),
): Record<string, unknown> {
  const wanted = SEVERITY.includes(severity as Severity) ? (severity as Severity) : null;
  const placeLabels = new Map([...targets].map(([id, target]) => [id, target.placeLabel]));
  const content = run.findings
    .filter((f) => wanted === null || f.severity === wanted)
    .map((f) => ({
      findingId: f.id,
      ruleCode: f.ruleCode,
      ruleVersion: f.ruleVersion,
      severity: f.severity,
      reasonCode: f.reasonCode,
      // 이름이 빈 항목은 표시할 때 채운다 — 저장된 문장은 앞이 비어 있다 (#606)
      message: findingMessage(f.ruleCode, f.message, f.evidence, placeLabels,
        f.targetItemId === null ? null : placeLabels.get(f.targetItemId) ?? null),
      target: targetOf(f.targetItemId, targets, f.reasonCode === 'CONTENT_HIDDEN'),
      targetSecondary: f.targetItemId2 === null ? null : targetOf(f.targetItemId2, targets),
      /*
       * 비표출 콘텐츠는 **명칭·주소를 다시 내보내지 않는다** — `contentid` 와 감지 시각만
       * 준다 (FR-AU-071 · PM-NG-009 · API 설계 5-6). 감지 시각은 그 전환을 발견한 검수의
       * 실행 시각이다.
       */
      hiddenContent:
        f.reasonCode === 'CONTENT_HIDDEN'
          ? { contentid: String(f.evidence.ktoContentId ?? ''), detectedAt: kstIso(run.executedAt) }
          : null,
      requiresExternal: f.requiresExternal,
      externalSource: f.externalSource,
      // 외부 참고가 아니면 자체 판정이다 (FR-AU-033 · UI-CM-011)
      sourceBadge: f.requiresExternal ? 'EXTERNAL_REFERENCE' : 'TOURLINT_VERDICT',
      needsConfirmation: f.needsConfirmation,
      /*
       * 차단은 무시할 수 없다 (API 설계 5-6). 화면 버튼 제어용이며 API · DB 가 각각
       * 독립적으로 다시 막는다 — 여기 값이 틀려도 무시가 통과되지는 않는다.
       */
      dismissible: f.severity !== 'BLOCKER',
      dismissedAt: f.dismissedAt == null ? null : kstIso(f.dismissedAt),
      dismissReason: f.dismissReason,
      confirmedAt: f.confirmedAt == null ? null : kstIso(f.confirmedAt),
      /*
       * 판정 근거 2단 (API 설계 5-6). 공사 원문은 여기 없다 — 카드의 「판단 근거 보기」를
       * 펼칠 때 `GET /contents/{contentId}` 로 그 1건만 조달해 3단을 완성한다 (5-12).
       *
       * 대상 콘텐츠가 없는 판정(R04 · R10 처럼 상품 전체)은 해석이 없다. 그 자리에
       * 억지로 무언가를 넣지 않는다 — 모르는 건 모른다고 한다.
       */
      evidenceView: {
        aiNormalized: f.targetItemId === null ? null : normalized.get(f.targetItemId) ?? null,
        verdict: f.evidence,
      },
      /*
       * 수정안 후보 (FR-PA-001 · finding 당 최대 3). 화면이 이걸로 미리보기·확정을 건다.
       *
       * 저장된 수정안에는 문구가 없다 (DR-PR-001). 대체 관광지만 이름이 필요해서 **표시할
       * 때 조회한 것**을 여기서 얹는다 — 없으면 화면이 「가까운 다른 관광지」로만 뜬다.
       */
      patches: f.patches.map((p) => {
        const payload = p.payload as { ktoContentId?: unknown; content?: { ktoContentId?: unknown } };
        const id = p.type === 'REPLACE_CONTENT' ? String(payload.ktoContentId ?? '')
          : p.type === 'INSERT_ITEM' ? String(payload.content?.ktoContentId ?? '')
            : '';
        const name = id === '' ? undefined : names.get(id);
        return name === undefined ? p : { ...p, placeName: name };
      }),
    }));

  return { content, totalElements: content.length };
}

/**
 * 패치 이력 상세 (FR-PA-028) + 경고 배너 (FR-PA-027).
 *
 * 준비도가 떨어지거나 차단이 늘어도 **일정을 되돌리지 않는다.** 무엇이 나빠졌는지 적고
 * 되돌리기가 열려 있다는 것만 알린다 — 결정은 사용자가 한다 (EX-PA-005).
 *
 * 되돌릴 수 있는지는 두 가지로 정해진다. 아직 되돌리지 않았고, 그 상품의 **직전 1건**일
 * 것 (FR-PA-026). 화면이 버튼을 그릴지 판단하는 값이라 서버가 계산해 내려준다.
 */
export function toPatchApplicationResponse(
  application: StoredPatchApplication,
  before: StoredAuditRun | null,
  after: StoredAuditRun | null,
  isLatest: boolean,
): Record<string, unknown> {
  const revertible = application.revertedAt === null && isLatest;
  return {
    patchApplicationId: application.id,
    productId: application.productId,
    appliedAt: kstIso(application.appliedAt),
    selectedPatches: application.selections,
    itemCount: { before: application.before.items.length, after: application.after.items.length },
    before: toSideSummary(application.beforeAuditRunId, before),
    after: toSideSummary(application.afterAuditRunId, after),
    // 재검수가 실패해도 일정 변경은 유지된다. 다시 돌릴 수단은 검수 요청 경로다 (EX-PA-004)
    reauditStatus: application.afterAuditRunId === null ? 'PENDING' : 'DONE',
    warningBanner: warningBanner(before, after),
    revertible,
    revertedAt: application.revertedAt === null ? null : kstIso(application.revertedAt),
  };
}

function toSideSummary(auditRunId: number | null, run: StoredAuditRun | null): Record<string, unknown> | null {
  if (auditRunId === null) return null;
  if (run === null) return { auditRunId };
  return {
    auditRunId,
    executedAt: kstIso(run.executedAt),
    readinessScore: run.current.score,
    counts: {
      blocker: run.current.counts.BLOCKER, error: run.current.counts.ERROR,
      warning: run.current.counts.WARNING, unverified: run.current.counts.UNVERIFIED,
    },
  };
}

/**
 * 나빠졌으면 문구를 만든다. 아니면 `null` — 좋아진 것을 배너로 알릴 이유는 없다.
 *
 * 준비도가 `null` 인 부분 검수는 비교하지 않는다. 점수 없는 실행과 점수 있는 실행을
 * 견주면 "100 → 없음" 같은 하락이 만들어진다 (DR-IN-005).
 */
function warningBanner(before: StoredAuditRun | null, after: StoredAuditRun | null): string | null {
  if (before === null || after === null) return null;

  const reasons: string[] = [];
  const b = before.current;
  const a = after.current;
  if (b.score !== null && a.score !== null && a.score < b.score) {
    reasons.push(`출시 준비도가 ${String(b.score)}점에서 ${String(a.score)}점으로 내려갔습니다`);
  }
  if (a.counts.BLOCKER > b.counts.BLOCKER) {
    reasons.push(`차단이 ${String(b.counts.BLOCKER)}건에서 ${String(a.counts.BLOCKER)}건으로 늘었습니다`);
  }
  if (reasons.length === 0) return null;
  return `${reasons.join('. ')}. 일정은 그대로 두었습니다. 되돌리거나 이대로 진행할지 선택해 주세요.`;
}

export function toRevertResponse(application: StoredPatchApplication, revertedAt: Date): Record<string, unknown> {
  return {
    patchApplicationId: application.id,
    productId: application.productId,
    revertedAt: kstIso(revertedAt),
    /*
     * 되돌린 일정은 `before_audit_run_id` 가 판정한 그 일정이다. 재검수를 다시 돌리지
     * 않고 그 결과를 현재 결과로 가리킨다 — 같은 답을 받으려고 공사 호출을 쓰지 않는다.
     */
    restoredAuditRunId: application.beforeAuditRunId,
  };
}

/**
 * 확인 필요 목록 (API 설계 5-7 · FR-AU-008).
 *
 * 확인 불가 등급과 **확인 필요 표시가 붙은 판정**을 모은다. 둘은 다르다 — 확인 불가는
 * 등급이고, 확인 필요는 「사용자가 직접 알아봐 달라」는 표시다. R08 의 대중교통 구간처럼
 * 등급이 확인 불가면서 확인 필요인 것이 대부분이지만 겹치지 않는 경우가 있다.
 *
 * ⚠️ **관광지명은 `place_label`(사용자 입력)만 쓴다.** 공사 원문은 담지 않는다
 * (DR-PR-001 · API 설계 5-7). 원문이 필요하면 화면이 펼칠 때 1콜로 조달한다.
 */
/**
 * 확인 필요 목록 (API 설계 5-7 · FR-AU-081).
 *
 * 관광지명은 `place_label`, 위치는 `itinerary_item` 에서 온다. 둘 다 저장된 값이라
 * **공사 호출이 0건이다** (5-12 「사용자 입력 · 자체 산출물」).
 *
 * 공사 원문 · 문의처 · 홈페이지는 여기 없다. 항목을 펼칠 때 `GET /contents/{contentId}`
 * 로 그 1건만 조달한다 (5-12 · FR-AU-082).
 */
export function toUnverifiedResponse(
  run: StoredAuditRun,
  itinerary: readonly ItineraryItemRow[] = [],
  /** 표시 이름 (#606). 이름을 저장하지 않는 항목은 여기에만 있다 */
  labels: ReadonlyMap<number, string> = new Map(),
): Record<string, unknown> {
  const byId = new Map(itinerary.map((i) => [i.id, i]));
  const items = run.findings
    .filter((f) => f.severity === 'UNVERIFIED' || f.needsConfirmation)
    .map((f) => {
      const item = f.targetItemId === null ? undefined : byId.get(f.targetItemId);
      /*
       * 출발 전 확인 항목은 공사 데이터의 D+1 구조적 시차로 자동 생성된 것이라
       * 감점 대상이 아니다 (FR-AU-016). 화면이 그 사실을 표기해야 한다.
       */
      const excluded = f.reasonCode === 'PRE_DEPARTURE_CHECK';
      // 사용자가 적은 이름이 먼저다. 이름 없이 들어온 항목만 조회한 값을 쓴다 (#606)
      const label = item === undefined ? null : labels.get(item.id) ?? (item.placeLabel || null);
      return {
        findingId: f.id,
        contentid: item?.ktoContentId ?? null,
        placeLabel: label,
        // 저장된 문장은 이름이 없으면 앞이 비어 있다. 표시할 때 채운다 (#606)
        reason: withPlaceName(f.message, label),
        reasonCode: f.reasonCode,
        location: item === undefined
          ? null
          : { dayNo: item.dayNo, seq: item.seq, startTime: item.startTime },
        confirmedAt: f.confirmed ? true : null,
        excludedFromScore: excluded,
        note: excluded ? PRE_DEPARTURE_NOTE : null,
        targetItemId: f.targetItemId,
      };
    });
  return { totalCount: items.length, items };
}

/** 출발 전 확인 항목에만 붙는 안내 (API 설계 5-7 · FR-AU-085 · 086) */
export const PRE_DEPARTURE_NOTE =
  '공사 데이터의 D+1 구조적 시차로 자동 생성된 항목이며 감점 대상이 아닙니다';

/** 검수 이력 (F13 · API 설계 5-9) */
export function toRunListResponse(
  runs: readonly StoredAuditRun[],
  currentRunId: number | null = null,
): Record<string, unknown> {
  return {
    totalCount: runs.length,
    runs: runs.map((r) => ({
      auditRunId: r.id,
      // 지금 일정의 결과. 되돌렸으면 가장 최근이 아니라 반영 전 실행이다 (#551)
      isCurrent: r.id === currentRunId,
      executedAt: kstIso(r.executedAt),
      rulesetVersion: r.rulesetVersion,
      // 조회 시점 재계산값이다. 무시 처리가 반영돼 있다 (FR-AU-046)
      readinessScore: r.current.score,
      counts: r.current.counts,
      isPartial: r.isPartial,
      targetCount: r.targetCount,
      failedCount: r.failedCount,
    })),
  };
}

/** 규칙 목록 (API 설계 5-10). 레지스트리가 정본이라 여기서 지어내지 않는다 */
export function toRulesResponse(): Record<string, unknown> {
  return {
    rulesetVersion: RULESET_VERSION,
    rules: RULES.map((r) => ({
      code: r.code,
      name: r.name,
      version: r.version,
      defaultSeverity: r.defaultSeverity,
      requiresExternal: r.requiresExternal,
      basis: r.basis,
      // 검수 기준 탭의 규칙 설명 (FR-OP-025 · API 5-10)
      ...RULE_EXPLANATIONS[r.code],
    })),
  };
}

/**
 * 수정 전후 비교 (F10 · FR-PA-040 ~ 044 · API 설계 5-9).
 *
 * 지표는 명세가 정한 아홉이다 — 등급 4종 건수, 총 감점(계산식 포함), 출시 준비도,
 * 총 이동시간 · 거리, 수요 적합성.
 *
 * **건수와 점수는 조회 시점 재계산값을 쓴다** (FR-AU-046). 무시 처리가 반영된 값이라
 * 화면이 보는 것과 같다. `audit_run` 저장값은 실행 기록이라 건드리지 않는다.
 *
 * ⚠️ **준비도가 떨어졌어도 자동으로 되돌리지 않는다** (FR-PA-027 · EX-PA-005).
 *    경고를 띄우고 되돌리기 수단을 준다 — 사용자가 고른 수정을 시스템이 무르지 않는다.
 */
export function toComparisonResponse(
  application: StoredPatchApplication,
  before: StoredAuditRun,
  after: StoredAuditRun,
  afterBasis: RunBasis = EMPTY_BASIS,
): Record<string, unknown> {
  const metrics = comparisonMetrics(before, after);

  return {
    patchApplicationId: application.id,
    before: { auditRunId: before.id, executedAt: kstIso(before.executedAt) },
    after: { auditRunId: after.id, executedAt: kstIso(after.executedAt) },
    metrics,
    warningBanner: warningBannerOf(before, after),
    // 화면 5 도 검수 근거 영역을 고정 표시한다 (UI-CM-030). 반영 후 실행이 기준이다
    evidence: (toRunResponse(after, afterBasis).evidence as Record<string, unknown>),
    // 되돌리기는 직전 1건까지다 (FR-PA-026). 이미 되돌린 이력은 여기 오지 않는다
    revertible: application.revertedAt === null,
  };
}

/** 비교 일정표의 한 줄. 화면이 그리는 데 쓰는 것만 내보낸다 — 좌표 · 분류는 뺀다 */
export interface ScheduleRow {
  readonly id: number;
  readonly dayNo: number;
  readonly seq: number;
  readonly startTime: string;
  readonly endTime: string | null;
  readonly placeLabel: string;
  readonly itemType: string;
}

function toScheduleRow(i: ItineraryItemRow): ScheduleRow {
  return {
    id: i.id, dayNo: i.dayNo, seq: i.seq, startTime: i.startTime, endTime: i.endTime,
    placeLabel: i.placeLabel, itemType: i.itemType,
  };
}

/**
 * 나빠졌으면 경고한다 (FR-PA-027 · EX-PA-005).
 *
 * **자동 롤백하지 않는다.** 사용자가 고른 수정을 시스템이 무르면, 왜 되돌아갔는지
 * 설명할 방법이 없고 사용자는 자기가 한 일이 반영됐는지조차 모른다.
 */
function warningBannerOf(before: StoredAuditRun, after: StoredAuditRun): string | null {
  const blockerUp = after.current.counts.BLOCKER > before.current.counts.BLOCKER;
  const scoreDown =
    before.current.score !== null && after.current.score !== null &&
    after.current.score < before.current.score;

  if (blockerUp) {
    return '수정 후 차단 항목이 늘었습니다. 되돌리거나 일정을 다시 확인해 주세요.';
  }
  if (scoreDown) {
    return '수정 후 출시 준비도가 낮아졌습니다. 되돌리거나 일정을 다시 확인해 주세요.';
  }
  return null;
}
