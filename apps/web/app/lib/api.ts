/**
 * 브라우저용 API 헬퍼.
 *
 * 항상 같은 오리진 `/api/*` 를 부르고(next.config 의 rewrite 가 API 서버로 넘긴다)
 * `credentials: "include"` 로 세션 쿠키를 함께 보낸다. 외부 API 를 브라우저에서 직접
 * 부르지 않는다 — 인증키는 서버에만 있다 (PM-SC-002).
 */
/**
 * 외부 서비스 장애 안내 (EX-MS-003 · UI-ST-004).
 *
 * 서버가 같은 문구를 내려주므로 보통은 그것을 쓴다. 여기 것은 응답 자체가 못 온 경우의
 * 기본값이다. 정본은 `@tourlint/shared` 의 `EXTERNAL_UNAVAILABLE_MESSAGE` — 웹은 그
 * 패키지를 의존하지 않아 문자열만 옮겨 둔다 (ITEM_TYPE · TRANSPORT 와 같은 방식).
 */
export const EXTERNAL_UNAVAILABLE = "일시적으로 조회할 수 없습니다.";

export interface ApiError {
  status: number;
  reasonCode?: string;
  message: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });

  if (res.status === 204) return undefined as T;

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const b = (body ?? {}) as { reasonCode?: string; message?: string };
    const err: ApiError = {
      status: res.status,
      reasonCode: b.reasonCode,
      // 서버가 준 단일 문구를 그대로 쓴다 — 화면이 사유를 지어내지 않는다 (EX-SY-004)
      message: b.message ?? "요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    };
    throw err;
  }
  return body as T;
}

export interface AccountView {
  email: string;
  isDemo: boolean;
}

export const authApi = {
  signup: (email: string, password: string) =>
    request<AccountView>("/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string) =>
    request<AccountView>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  me: () => request<AccountView>("/auth/me"),
};

// ── 상품 · 검수 결과 (S3 · F04~F07) ───────────────────────────────────────────

export type Severity = "BLOCKER" | "ERROR" | "WARNING" | "UNVERIFIED";

export interface ProductItem {
  itemId: number;
  seq: number;
  start: string;
  end: string | null;
  place: string;
  itemType: string;
  ktoContentId: string | null;
  matchStatus: string;
}

export interface ProductDetail {
  productId: number;
  name: string;
  region: { regnName: string; signguName: string | null };
  ldongRegnCd: string;
  ldongSignguCd: string | null;
  startDate: string;
  nights: number;
  dayCount: number;
  targetKey: string | null;
  conceptKey: string | null;
  headCount: number | null;
  transport: string;
  releasedAt: string | null;
  days: { day: number; items: ProductItem[] }[];
}

/** PATCH 가 받는 것만. 지역·박수는 못 바꾼다 — 확정된 contentid 와 일차 제약이 걸려 있다 */
export interface ProductUpdate {
  name?: string;
  startDate?: string;
  targetKey?: string | null;
  conceptKey?: string | null;
  headCount?: number | null;
  transport?: string;
}

export interface ItemInput {
  dayNo: number;
  startTime: string;
  endTime: string;
  placeLabel: string;
  itemType: string;
}

export interface ContentCandidate {
  contentid: string;
  title: string | null;
  addr1: string | null;
  contenttypeid: number | null;
  cpyrhtDivCd: string | null;
}

export interface ContentSearchResult {
  regionFilterApplied: boolean;
  fetchedAt: string;
  candidates: ContentCandidate[];
  totalCount: number;
  source: string;
}

export interface RunSummary {
  auditRunId: number;
  productId: number;
  executedAt: string;
  rulesetVersion: string;
  isPartial: boolean;
  readinessScore: number | null;
  scoreBreakdown: { formula: string | null; deduction: number | null; weights: Record<string, number> };
  counts: { blocker: number; error: number; warning: number; unverified: number; dismissed: number };
  needsConfirmationCount: number;
  targetCount: number;
  failedCount: number;
  releasable: boolean;
  releaseBlockedReason: string | null;
  evidence: AuditEvidence;
}

/** 판정 근거 2단. 공사 원문은 여기 없다 — 펼칠 때 contentApi 로 조달한다 (5-6 · 5-12) */
export interface EvidenceView {
  aiNormalized: Record<string, unknown> | null;
  verdict: unknown;
}

/** 검수 근거 영역 재료 (UI-CM-031). 화면 3 · 4 · 5 가 같은 것을 쓴다 */
export interface AuditEvidence {
  fetchedAt: string;
  targetContentCount: number;
  dataFingerprint: string | null;
  /** 축약 옆에서 전체를 확인할 수 있어야 한다 (UI-CM-032) */
  dataFingerprintFull: string | null;
  rulesetVersion: string;
  /** 공사 데이터 최종 수정일 원문 `YYYYMMDDHHmmss` */
  ktoModifiedAt: string | null;
  delayNotice: string;
  source: string;
}

export interface Finding {
  findingId: number;
  evidenceView: EvidenceView;
  ruleCode: string;
  severity: Severity;
  reasonCode: string;
  message: string;
  target: { itemId: number | null };
  targetSecondary: { itemId: number } | null;
  requiresExternal: boolean;
  externalSource: string | null;
  sourceBadge: "TOURLINT_VERDICT" | "EXTERNAL_REFERENCE";
  needsConfirmation: boolean;
  dismissed: boolean;
  dismissReason: string | null;
  confirmed: boolean;
  patches: Patch[];
}

export type PatchType = "TIME_SHIFT" | "REORDER" | "REPLACE_CONTENT" | "INSERT_ITEM" | "REMOVE_ITEM";

export interface Patch {
  patchId: string;
  type: PatchType;
  targetItemId: number;
  /**
   * 대체 · 추가할 관광지 이름.
   *
   * 수정안에는 명칭이 저장돼 있지 않다 — 공사 원문이라 저장할 수 없다 (DR-PR-001).
   * 서버가 **표시할 때 조회해** 여기에 실어 준다. 못 읽었으면 없다.
   */
  placeName?: string;
  payload: {
    newDayNo?: number;
    newStartTime?: string;
    newEndTime?: string;
    swapWithItemId?: number;
    dayNo?: number;
    startTime?: string;
    endTime?: string;
    itemType?: string;
    distanceMeters?: number;
  };
}

export interface PatchItem {
  id: number;
  dayNo: number;
  seq: number;
  startTime: string;
  endTime: string | null;
  placeLabel: string;
  itemType: string;
}

export interface PatchConflict {
  kind: string;
  a: { findingId: number; patchId: string };
  b: { findingId: number; patchId: string };
  message: string;
}

export interface PatchPreview {
  previewToken: string;
  conflict: { hasConflict: boolean; pairs: PatchConflict[] };
  before: PatchItem[];
  after: PatchItem[];
  skipped: { patchId: string; reason: string }[];
}

export interface PatchApplied {
  patchApplicationId: number;
  beforeAuditRunId: number | null;
  reauditJobId: number;
  pollIntervalMs: number;
}

export interface PatchSelection {
  findingId: number;
  patchId: string;
}

export interface UnverifiedItem {
  findingId: number;
  /** 확정된 콘텐츠가 없으면 null (검수 제외 · 상품 전체 판정) */
  contentid: string | null;
  /** 사용자가 입력한 장소명. 공사 원문이 아니다 */
  placeLabel: string | null;
  reason: string;
  reasonCode: string;
  location: { dayNo: number; seq: number; startTime: string } | null;
  confirmedAt: true | null;
  excludedFromScore: boolean;
  /** 출발 전 확인 항목에만 붙는 안내 */
  note: string | null;
  targetItemId: number | null;
}

export interface RunListItem {
  auditRunId: number;
  executedAt: string;
  isPartial: boolean;
  readinessScore: number | null;
}

export interface AuditJob {
  jobId: number;
  status: string;
  productId: number;
  progress: { done: number; total: number; label: string };
  auditRunId: number | null;
  errorCode?: string;
  pollIntervalMs?: number;
}

export const productApi = {
  detail: (productId: number) => request<ProductDetail>(`/products/${productId}`),
  update: (productId: number, body: ProductUpdate) =>
    request<void>(`/products/${productId}`, { method: "PATCH", body: JSON.stringify(body) }),
  remove: (productId: number) => request<void>(`/products/${productId}`, { method: "DELETE" }),
  /** 출시 승인. 차단이 1건이라도 있으면 서버가 403 으로 막는다 (PM-NG-002) */
  release: (productId: number) =>
    request<{ productId: number; releasedAt: string }>(`/products/${productId}/release`, { method: "POST" }),
};

/** 일정 항목 편집 (FR-IN-014). 등록 이후에도 추가·삭제·시간 변경·순서 변경을 한다 */
export const itemApi = {
  add: (productId: number, item: ItemInput) =>
    request<ProductItem>(`/products/${productId}/items`, { method: "POST", body: JSON.stringify(item) }),
  patch: (itemId: number, patch: Partial<Omit<ItemInput, "dayNo">>) =>
    request<ProductItem>(`/items/${itemId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (itemId: number) => request<void>(`/items/${itemId}`, { method: "DELETE" }),
  reorder: (productId: number, items: readonly { itemId: number; dayNo: number; seq: number }[]) =>
    request<void>(`/products/${productId}/items/order`, { method: "PUT", body: JSON.stringify({ items }) }),
};

export const auditApi = {
  listRuns: (productId: number) =>
    request<{ totalCount: number; runs: RunListItem[] }>(`/products/${productId}/audit-runs`),
  getRun: (runId: number) => request<RunSummary>(`/audit-runs/${runId}`),
  getFindings: (runId: number) =>
    request<{ content: Finding[]; totalElements: number }>(`/audit-runs/${runId}/findings`),
  getUnverified: (runId: number) =>
    request<{ totalCount: number; items: UnverifiedItem[] }>(`/audit-runs/${runId}/unverified`),
  runAudit: (productId: number, triggerType = "MANUAL") =>
    request<AuditJob>(`/products/${productId}/audit-jobs`, {
      method: "POST",
      body: JSON.stringify({ triggerType }),
    }),
  getJob: (jobId: number) => request<AuditJob>(`/audit-jobs/${jobId}`),
  dismissFinding: (findingId: number, reason?: string) =>
    request<void>(`/findings/${findingId}/dismiss`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  undismissFinding: (findingId: number) =>
    request<void>(`/findings/${findingId}/dismiss`, { method: "DELETE" }),
  confirmFinding: (findingId: number) =>
    request<void>(`/findings/${findingId}/confirm`, { method: "POST" }),
};

export const matchApi = {
  // 장소명으로 공사 콘텐츠 검색 (F02). 지역 코드로 좁힌다
  search: (keyword: string, regnCd?: string | null, signguCd?: string | null, size = 8) => {
    const q = new URLSearchParams({ keyword, size: String(size) });
    if (regnCd) q.set("regnCd", regnCd);
    if (signguCd) q.set("signguCd", signguCd);
    return request<ContentSearchResult>(`/contents/search?${q.toString()}`);
  },
  // contentid 확정 → 항목이 CONFIRMED 가 되고 좌표·분류가 붙는다
  match: (itemId: number, contentid: string) =>
    request<{ itemId: number; matchStatus: string; content: ContentCandidate & { mapx: number | null } }>(
      `/items/${itemId}/match`,
      { method: "POST", body: JSON.stringify({ contentid }) },
    ),
  // 해당 없음 → 검수 제외
  exclude: (itemId: number) =>
    request<{ itemId: number; matchStatus: string }>(`/items/${itemId}/exclude`, { method: "POST" }),
};

export const patchApi = {
  // 고른 수정안을 반영하면 어떻게 되는지 미리 본다. 저장하지 않는다 (F08)
  preview: (productId: number, selections: PatchSelection[]) =>
    request<PatchPreview>(`/products/${productId}/patch-preview`, {
      method: "POST",
      body: JSON.stringify({ selections }),
    }),
  // 확정 → 일정 반영 + 자동 재검수. reauditJobId 로 진행을 따라간다 (F09)
  apply: (productId: number, selections: PatchSelection[], previewToken: string) =>
    request<PatchApplied>(`/products/${productId}/patch-applications`, {
      method: "POST",
      body: JSON.stringify({ selections, previewToken }),
    }),
  // 반영 이력 상세 — 경고 배너·되돌리기 가능 여부 (FR-PA-027/028)
  application: (id: number) => request<PatchApplicationDetail>(`/patch-applications/${id}`),
  // 되돌리기. 직전 1건이 아니면 409 UNDO_UNAVAILABLE (EX-PA-006)
  revert: (id: number) => request<RevertResult>(`/patch-applications/${id}/revert`, { method: "POST" }),
};

export interface PatchSideSummary {
  auditRunId: number;
  executedAt?: string;
  readinessScore?: number | null;
  counts?: { blocker: number; error: number; warning: number; unverified: number };
}

export interface PatchApplicationDetail {
  patchApplicationId: number;
  productId: number;
  appliedAt: string;
  itemCount: { before: number; after: number };
  before: PatchSideSummary | null;
  after: PatchSideSummary | null;
  reauditStatus: "PENDING" | "DONE";
  // 점수 하락·차단 증가 시 서버가 만든 문구. 아니면 null (EX-PA-005)
  warningBanner: string | null;
  revertible: boolean;
  revertedAt: string | null;
}

export interface RevertResult {
  patchApplicationId: number;
  productId: number;
  revertedAt: string;
  restoredAuditRunId: number | null;
}

// ── 호출 예산 위젯 (F15 · FR-OP-005) ──────────────────────────────────────────

export type BudgetState = "NORMAL" | "WARN" | "EXHAUSTED";

export interface BudgetView {
  quotaDate: string;
  dailyQuota: number;
  used: number;
  usageRatio: number;
  state: BudgetState;
  batchAutoStopped: boolean;
  topOperations: { operation: string; count: number }[];
  resetAt: string;
}

export const usageApi = {
  // 오늘 공사 호출 소진 상태. 헤더 위젯이 2분마다 폴링한다 (FR-OP-005)
  budget: () => request<BudgetView>("/usage/budget"),
};

// ── 레이더 · 알림 (S7 · FR-MO-050~058) ────────────────────────────────────────

export interface RadarSummary {
  risk: number;
  opportunity: number;
  unread: number;
  affectedProducts: number;
  changedContents: number;
  lastBatch: null | { runAt: string | null; covered: string | null; status: string; itemCount: number };
}

/** 신호 하나. 산출 전이면 t1·t2 가 null 이다 — 0(세어 보니 없음)과 구분한다. */
export interface DemandSignal {
  count: number;
  byType: Record<string, number>;
  window: { from: string; to: string };
  computedAt: string;
}

export interface RadarSignals {
  productId: number;
  t1: DemandSignal | null;
  t2: DemandSignal | null;
  notice: string;
}

export type NotificationKind = "RISK" | "OPPORTUNITY";

export interface RadarNotification {
  notificationId: number;
  kind: NotificationKind;
  condition: number;
  productId: number;
  productName: string;
  startDate: string;
  ktoContentId: string;
  what: string;
  impact: string;
  action: string;
  hidden: boolean;
  // 지문 비교값. 조건 2·3 은 지문 이력이 없어 from·to 가 둘 다 null 이다 (FR-MO-058)
  fingerprint: { from: string | null; to: string | null };
  dismissable: boolean;
  readAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  content: RadarNotification[];
  page: number;
  size: number;
  totalElements: number;
  unreadCount: number;
}

export const radarApi = {
  summary: () => request<RadarSummary>("/radar/summary"),
  // signals 는 productId 가 필수다 — T2(행사 밀도) 창이 그 상품의 여행일에서 나온다
  signals: (productId: number) => request<RadarSignals>(`/radar/signals?productId=${productId}`),
};

export const notificationApi = {
  list: (kind?: NotificationKind) =>
    request<NotificationPage>(`/notifications${kind ? `?kind=${kind}` : ""}`),
  read: (id: number) => request<{ id: number; readAt: string }>(`/notifications/${id}/read`, { method: "POST" }),
  dismiss: (id: number) =>
    request<{ id: number; dismissedAt: string }>(`/notifications/${id}/dismiss`, { method: "POST" }),
};

// ── 수정 전후 비교 (S5 · FR-PA-040~045) ───────────────────────────────────────

/**
 * 대조 지표 한 줄. 대부분 before·after 숫자지만 몇은 다르다 — 총 감점은 계산식을,
 * 이동시간·거리는 출처를, 수요 적합성은 텍스트를 함께 준다.
 */
export interface ComparisonMetric {
  key: string;
  label: string;
  before?: number | null;
  after?: number | null;
  beforeText?: string;
  afterText?: string;
  formulaBefore?: string;
  formulaAfter?: string;
  sourceBadge?: string;
  externalSource?: string;
}

export interface ComparisonResult {
  patchApplicationId: number;
  before: { auditRunId: number; executedAt: string };
  after: { auditRunId: number; executedAt: string };
  metrics: ComparisonMetric[];
  warningBanner: string | null;
  /** 화면 5 도 근거 영역을 고정 표시한다 (UI-CM-030). 반영 후 실행이 기준이다 */
  evidence: AuditEvidence;
  revertible: boolean;
}

export const comparisonApi = {
  // 직전 패치의 전후 한 쌍. 수정 이력이 없거나 재검수가 안 끝났으면 404 (UI-S5-006)
  get: (productId: number) => request<ComparisonResult>(`/products/${productId}/comparison`),
};

// ── 리포트 (F11 · UI-S5-004 진입점) ───────────────────────────────────────────

/** 관광지 1건 실시간 조회 (DR-PR-004). 저장하지 않으므로 볼 때 부른다 */
export interface ContentDetail {
  contentId: string;
  fetchedAt: string;
  hidden: boolean;
  officialName: string | null;
  homepageUrl: string | null;
  contact: { tel: string | null };
  /** 판정 필드 원문. 키는 공사 필드명 그대로다 */
  ktoRaw: Record<string, string>;
  ktoModifiedTime: string | null;
  unavailableReason: string | null;
}

export const contentApi = {
  detail: (contentId: string) => request<ContentDetail>(`/contents/${contentId}`),
};

export const reportApi = {
  // 렌더까지 끝내고 reportId 를 준다 (가장 최근 실행만, 아니면 409)
  generate: (runId: number) => request<{ reportId: string }>(`/audit-runs/${runId}/reports`, { method: "POST" }),
  // 다운로드는 브라우저 내비게이션으로 — 세션 쿠키가 실려 PDF 를 그대로 받는다.
  // 공통 fetch 래퍼는 .json() 이라 바이너리에 못 쓴다.
  downloadUrl: (reportId: string) => `/api/v1/reports/${reportId}/download`,
};

// ── 관리자 설정 (F16 · UI-S8 · FR-OP-020~027) ────────────────────────────────

export interface WeightSettings {
  BLOCKER: number;
  ERROR: number;
  WARNING: number;
  UNVERIFIED: number;
}

export interface AccountSettings {
  weights: WeightSettings;
  r07SpanHours: number;
  r07MealMinutes: number;
  r04Threshold: number;
  watchKeywords: string[];
}

export interface GlobalSettings {
  batchTime: string;
  batchEnabled: boolean;
  dailyQuota: number;
}

export interface SettingsView {
  account: AccountSettings;
  global: GlobalSettings;
  defaults: { account: AccountSettings; global: GlobalSettings };
  // 전역 편집 권한·예산 상한 (UI-S8-006). 데모 계정은 전역을 못 바꾼다.
  globalEditable: boolean;
  quotaCap: number;
}

export const settingsApi = {
  get: () => request<SettingsView>("/settings"),
  // 계정 설정만 저장한다. 전역 값은 이 경로로 바꾸지 않는다.
  update: (account: AccountSettings) =>
    request<SettingsView>("/settings", { method: "PUT", body: JSON.stringify(account) }),
  // 전역 설정 저장(배치 시각·일일 예산). 데모 계정이면 서버가 403 을 준다.
  updateGlobal: (global: GlobalSettings) =>
    request<SettingsView>("/settings/global", { method: "PUT", body: JSON.stringify(global) }),
};

// ── 계정 기준표 (F16 · UI-S8-005) ────────────────────────────────────────────

export type IndoorOutdoor = "INDOOR" | "OUTDOOR" | "MIXED";

export interface DwellEntry {
  lcls2: string;
  name: string;
  minutes: number;
  defaultMinutes: number;
}

export interface IoEntry {
  lcls2: string;
  name: string;
  spaceType: IndoorOutdoor;
  defaultSpaceType: IndoorOutdoor;
}

export interface ProfileEntry {
  targetKey: string;
  conceptKey: string;
  expectedLcls2: string[];
  expectsNight: boolean;
}

export interface LclsItem {
  code: string;
  name: string;
}

export const settingsTablesApi = {
  dwell: () => request<{ entries: DwellEntry[] }>("/settings/dwell"),
  saveDwell: (entries: { lcls2: string; minutes: number }[]) =>
    request<{ entries: DwellEntry[] }>("/settings/dwell", { method: "PUT", body: JSON.stringify({ entries }) }),
  indoorOutdoor: () => request<{ entries: IoEntry[] }>("/settings/indoor-outdoor"),
  saveIndoorOutdoor: (entries: { lcls2: string; spaceType: IndoorOutdoor }[]) =>
    request<{ entries: IoEntry[] }>("/settings/indoor-outdoor", {
      method: "PUT",
      body: JSON.stringify({ entries }),
    }),
  // R10 기대 콘텐츠 프로파일. 저장은 전체 교체다.
  profiles: () => request<{ entries: ProfileEntry[] }>("/settings/profiles"),
  saveProfiles: (entries: ProfileEntry[]) =>
    request<{ entries: ProfileEntry[] }>("/settings/profiles", { method: "PUT", body: JSON.stringify({ entries }) }),
  // 중분류 카탈로그(코드→이름). 프로파일 편집기의 기대 중분류 선택에 쓴다.
  lcls: () => request<{ entries: LclsItem[] }>("/settings/lcls"),
};

export function isApiError(e: unknown): e is ApiError {
  return typeof e === "object" && e !== null && "status" in e && "message" in e;
}
