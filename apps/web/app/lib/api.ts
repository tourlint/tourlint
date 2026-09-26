/**
 * 브라우저용 API 헬퍼.
 *
 * 항상 같은 오리진 `/api/*` 를 부르고(next.config 의 rewrite 가 API 서버로 넘긴다)
 * `credentials: "include"` 로 세션 쿠키를 함께 보낸다. 외부 API 를 브라우저에서 직접
 * 부르지 않는다 — 인증키는 서버에만 있다 (PM-SC-002).
 */
import { EXTERNAL_UNAVAILABLE_MESSAGE } from "@tourlint/shared";

/**
 * 외부 서비스 장애 안내 (EX-MS-003 · UI-ST-004).
 *
 * 서버가 같은 문구를 내려주므로 보통은 그것을 쓴다. 여기 것은 응답 자체가 못 온 경우의
 * 기본값이다. 정본은 `@tourlint/shared` 의 `EXTERNAL_UNAVAILABLE_MESSAGE` — 이제 웹이 그
 * 패키지를 직접 의존하므로 문자열을 옮겨 적지 않고 시드를 그대로 쓴다.
 */
export const EXTERNAL_UNAVAILABLE = EXTERNAL_UNAVAILABLE_MESSAGE;

export interface ApiError {
  status: number;
  retryAfterSeconds?: number;
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
      ...(res.status === 429 && res.headers.has("Retry-After")
        ? { retryAfterSeconds: Number(res.headers.get("Retry-After")) }
        : {}),
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

export interface SignupChallenge {
  verificationId: string;
  expiresAt: string;
  resendAfterSeconds: number;
}

export const authApi = {
  requestSignupCode: (email: string) =>
    request<SignupChallenge>("/auth/signup-code", { method: "POST", body: JSON.stringify({ email }) }),
  signup: (email: string, password: string, verificationId: string, code: string) =>
    request<AccountView>("/auth/signup", { method: "POST", body: JSON.stringify({ email, password, verificationId, code }) }),
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
  /** 근처 3km 담기의 앵커로 쓴다. 확정 전이면 null */
  mapx: number | null;
  mapy: number | null;
  /**
   * 중분류 · 끝 시각 출처 (FR-IN-011). 끝 시간을 비운 줄에 채워질 시각과 「기본값 적용 · N분」 을
   * 엔진과 같은 표로 보이는 데만 쓴다. 옛 응답에는 없다 — 없으면 짓지 않는다
   */
  lcls2?: string | null;
  endTimeSource?: "INPUT" | "DWELL_DEFAULT" | "DWELL_FALLBACK";
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
  /** 검수 시작을 누른 시각. null 이면 기획 중 (DR-IN-014) */
  plannedAt: string | null;
  planOrigin: PlanOrigin | null;
  /** 직접 입력 · 장소 담기로 넣음 · 직접 정한 곳(검수 제외) 항목 수 */
  composition: { manual: number; picker: number; excluded: number };
  /**
   * 지금 일정과 검수 결과의 관계 (#710). `STALE` + `EDIT` 이면 화면의 결과는 고치기 전 일정의 것이라
   * 출시 · 리포트를 잠그고 다시 검수하게 한다. 옛 서버 응답에는 없을 수 있다
   */
  auditState?: { kind: "NONE" | "LATEST" | "RESTORED" | "STALE"; reason: "PATCH" | "EDIT" | null };
  days: { day: number; items: ProductItem[] }[];
}

export interface PlanOrigin {
  startedBy: "MANUAL" | "UPLOAD" | "TEXT" | "CLONE" | "SIGNAL";
  signal?: { type: string; regnCd: string; signguCd: string | null; from: string; to: string; contentId?: string };
}

/** 검수 시작 응답 (202 · FR-PL-020) */
export interface HandoffResult {
  productId: number;
  plannedAt: string;
  jobId: number;
  excludedCount: number;
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
  /** 들어온 경로 — MANUAL · UPLOAD · TEXT (FR-PL-020). 없으면 서버가 MANUAL 로 둔다 */
  origin?: string;
  /** 「직접 정한 곳으로 두기」를 고른 새 줄 — 직접 정한 곳(EXCLUDED)으로 넣는다 (UI-S2-021) */
  excluded?: boolean;
}

export interface ContentCandidate {
  contentid: string;
  title: string | null;
  addr1: string | null;
  contenttypeid: number | null;
  cpyrhtDivCd: string | null;
}

/** 예산이 다 되면 검수를 미리 막는다 — 다시 열리는 때는 한국 시간 다음 날 0시 (EX-QT-002) */
export interface AuditAvailability {
  available: boolean;
  reasonCode: "BUDGET_EXHAUSTED" | null;
  resumesAt: string | null;
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
  /** `scoredCounts` 는 감점에 쓴 건수다 — 무시한 것과 감점하지 않는 출발 임박 확인을 뺀다 (#819) */
  scoreBreakdown: {
    formula: string | null; deduction: number | null; weights: Record<string, number>;
    scoredCounts?: { blocker: number; error: number; warning: number; unverified: number };
  };
  /** 등급별 건수는 무시한 것을 빼고 센다. 무시한 건수는 `dismissed` (FR-AU-046) */
  counts: { blocker: number; error: number; warning: number; unverified: number; dismissed: number };
  needsConfirmationCount: number;
  targetCount: number;
  failedCount: number;
  releasable: boolean;
  releaseBlockedReason: string | null;
  evidence: AuditEvidence;
  /** 이 검수에 적용한 기준 (A1 · API 5-5). 회사 기준 배지 · 리포트 머리글이 쓴다. 옛 검수는 null */
  settingSnapshot: { standardVersion: string; r07SpanHours: number; r07MealMinutes: number } | null;
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
  ruleVersion: string;
  severity: Severity;
  reasonCode: string;
  message: string;
  target: FindingTarget;
  targetSecondary: FindingTarget | null;
  requiresExternal: boolean;
  externalSource: string | null;
  sourceBadge: "TOURLINT_VERDICT" | "EXTERNAL_REFERENCE";
  needsConfirmation: boolean;
  /** 차단은 무시할 수 없다. 버튼 제어용이며 API · DB 가 각각 다시 막는다 */
  dismissible: boolean;
  dismissedAt: string | null;
  dismissReason: string | null;
  confirmedAt: string | null;
  patches: Patch[];
  /** 표출이 중단된 곳이면 contentid 와 감지 시각만 온다 — 명칭 · 주소는 다시 내보내지 않는다 (FR-AU-071 · API 설계 5-6) */
  hiddenContent?: { contentid: string; detectedAt: string } | null;
}

/** 항목이 사라졌거나 상품 전체 판정이면 `itemId` 만 온다 (API 설계 5-6) */
export interface FindingTarget {
  itemId: number | null;
  dayNo?: number;
  seq?: number;
  startTime?: string;
  placeLabel?: string;
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
    /** R03 — 이동시간을 몰라 겹침만 푼 안 (#877) */
    travelUnchecked?: boolean;
    swapWithItemId?: number;
    dayNo?: number;
    startTime?: string;
    endTime?: string;
    itemType?: string;
    distanceMeters?: number;
    /** 거리를 잰 기준 일정. 없으면 바꿀 장소 자리에서 잰 것이다 (#728) */
    fromItemId?: number;
    /** 대체 관광지 — 고르면 그곳의 운영 조건을 부른다 (UI-S3-016 · #880) */
    ktoContentId?: string;
    contentTypeId?: number;
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
  /** 지금 일정의 결과. 수정안을 되돌렸으면 가장 최근이 아니라 반영 전 실행이다 (#551) */
  isCurrent?: boolean;
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
  /**
   * 검수 시작 (FR-PL-020 · D7). 미확정이 남으면 422 PLACE_UNRESOLVED,
   * `excludePending:true` 면 제외하고 넘긴다. 예산 100% 면 429 로 되돌아가 기획 중에 남는다.
   */
  handoff: (productId: number, excludePending = false) =>
    request<HandoffResult>(`/products/${productId}/handoff`, {
      method: "POST",
      body: JSON.stringify(excludePending ? { excludePending: true } : {}),
    }),
};

/** 일정 항목 편집 (FR-IN-014). 등록 이후에도 추가·삭제·시간 변경·순서 변경을 한다 */
export const itemApi = {
  add: (productId: number, item: ItemInput) =>
    request<ProductItem>(`/products/${productId}/items`, { method: "POST", body: JSON.stringify(item) }),
  patch: (itemId: number, patch: Partial<Omit<ItemInput, "dayNo" | "origin" | "excluded">>) =>
    request<ProductItem>(`/items/${itemId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (itemId: number) => request<void>(`/items/${itemId}`, { method: "DELETE" }),
  reorder: (productId: number, items: readonly { itemId: number; dayNo: number; seq: number }[]) =>
    request<void>(`/products/${productId}/items/order`, { method: "PUT", body: JSON.stringify({ items }) }),
  // 장소 담기로 넣기 (FR-PL-013 · 4-3). 넣을 위치(afterItemId) 다음에 끼운다 — 시각 · 좌표는 서버가 채운다
  addPicked: (productId: number, input: { dayNo: number; itemType: string; content: PlanContentRef; afterItemId?: number | null }) =>
    request<ProductItem>(`/products/${productId}/items`, {
      method: "POST",
      body: JSON.stringify({ dayNo: input.dayNo, itemType: input.itemType, origin: "PICKER", afterItemId: input.afterItemId ?? null, content: input.content }),
    }),
  // 걷기 길로 넣기 (D9). 코스 식별자만 보낸다 — 이름은 보내지도 저장하지도 않는다. 시각을 주면 그 시각으로
  // 넣고(편집 화면 · UI-S2-048), 안 주면 그 날 끝에 붙는다
  addWalk: (productId: number, input: { dayNo: number; walkId: string; startTime?: string; endTime?: string }) =>
    request<ProductItem>(`/products/${productId}/items`, {
      method: "POST",
      body: JSON.stringify({
        dayNo: input.dayNo, itemType: "SIGHT", origin: "PICKER", excluded: { walkId: input.walkId },
        ...(input.startTime ? { startTime: input.startTime } : {}),
        ...(input.startTime && input.endTime ? { endTime: input.endTime } : {}),
      }),
    }),
};

/** 장소 담기로 넣을 때 서버에 보내는 콘텐츠 참조 — 제목 · 주소(원문)는 보내지 않는다 */
export interface PlanContentRef {
  contentId: string;
  contentTypeId: number;
  lcls1: string;
  lcls2: string;
  mapx: number | null;
  mapy: number | null;
}

/** GET /rules 한 규칙 (검수 기준 탭 규칙 설명 · FR-OP-025 · API 5-10). */
export interface RuleView {
  code: string;
  name: string;
  version: string;
  defaultSeverity: string | null;
  requiresExternal: boolean;
  basis: string;
  /** 쓰는 데이터 코드 — 화면은 코드 대신 사용자 말로 적는다 (KTO·KAKAO 노출 금지) */
  dataSources: string[];
  threshold: string;
  example: string;
  /** R07 만 회사 기준으로 조일 수 있다 */
  companyAdjustable: boolean;
}

export const auditApi = {
  /** `activeJobId` — 지금 도는 검수 작업. 결과 화면이 다시 열려도 이어 폴링한다 (UI-ST-003) */
  listRuns: (productId: number) =>
    request<{ totalCount: number; runs: RunListItem[]; activeJobId?: number | null }>(`/products/${productId}/audit-runs`),
  /** 규칙 목록과 설명 (검수 기준 탭). 계정과 무관한 표준이라 캐시해도 된다. */
  rules: () => request<{ rulesetVersion: string; rules: RuleView[] }>(`/rules`),
  getRun: (runId: number) => request<RunSummary>(`/audit-runs/${runId}`),
  getFindings: (runId: number) =>
    request<{ content: Finding[]; totalElements: number }>(`/audit-runs/${runId}/findings`),
  getUnverified: (runId: number) =>
    request<{ totalCount: number; items: UnverifiedItem[] }>(`/audit-runs/${runId}/unverified`),
  /** 지금 검수를 시작할 수 있는가 (UI-ST-007 · #838). 숫자는 오지 않는다 */
  availability: () => request<AuditAvailability>("/audit-availability"),
  runAudit: (productId: number, triggerType = "MANUAL") =>
    request<AuditJob>(`/products/${productId}/audit-jobs`, {
      method: "POST",
      body: JSON.stringify({ triggerType }),
    }),
  getJob: (jobId: number) => request<AuditJob>(`/audit-jobs/${jobId}`),
  // 무시 사유는 필수다 (FR-AU-068) — 서버도 400 DISMISS_REASON_REQUIRED 로 막는다.
  dismissFinding: (findingId: number, reason: string) =>
    request<void>(`/findings/${findingId}/dismiss`, {
      method: "POST",
      body: JSON.stringify({ reason }),
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
  // contentid 확정 → 항목이 CONFIRMED 가 되고 좌표·분류가 붙는다. matchedBy 로 누가 골랐는지
  // 남긴다 (D8): AUTO(1곳 자동) · USER(직접) · AGENT(에이전트 카드). 기본은 USER.
  match: (itemId: number, contentid: string, matchedBy: "AUTO" | "USER" | "AGENT" = "USER") =>
    request<{ itemId: number; matchStatus: string; content: ContentCandidate & { mapx: number | null } }>(
      `/items/${itemId}/match`,
      { method: "POST", body: JSON.stringify({ contentid, matchedBy }) },
    ),
  // 해당 없음 → 검수 제외
  exclude: (itemId: number) =>
    request<{ itemId: number; matchStatus: string }>(`/items/${itemId}/exclude`, { method: "POST" }),
};

// ── 기획 조회 (F17 · FR-PL-005). 규칙 판정 없음 · 저장 없음 ────────────────────

/** 장소 정보 한 줄 (place-facts). 공사 원문 표시값 — 응답으로만 흐르고 저장하지 않는다 */
export interface PlaceFacts {
  itemId: number;
  name: string;
  kindName: string;
  hours: string | null;
  restDays: string | null;
  fee: string | null;
  parking: string | null;
  eventPeriod: string | null;
  travelFromPrevMinutes: number | null;
  matchedBy: "AUTO" | "USER" | "AGENT" | null;
  origin: string | null;
}

/** 종류 칩 한 개 (기획 4-3). count null = 아직 안 셈(근처 3km) 또는 그 서비스 불가 */
export interface PlanTypeChip {
  kind: "LCLS2" | "EVENT" | "WALK" | "NEAR";
  lcls2: string | null;
  nearKind: "MEAL" | "CAFE" | "STAY" | null;
  name: string;
  count: number | null;
  disabled: "ANCHOR_REQUIRED" | null;
}

export interface PlanBriefing {
  region: { regnCd: string; signguCd: string | null; name: string };
  types: PlanTypeChip[];
  events: { count: number; from: string; to: string } | null;
  accessible: { count: number } | null;
  pet: { count: number } | null;
  walks: { count: number } | null;
  budget: "OK" | "WARN" | "PAUSED";
}

/** 장소 카드 한 곳. 제목 · 주소 · 사진은 공사 원문 — 응답으로만 흐르고 저장하지 않는다 */
export interface PlanPlace {
  contentId: string;
  contentTypeId: number;
  lcls1: string;
  lcls2: string;
  lcls2Name: string;
  title: string;
  addr1: string | null;
  firstImage: string | null;
  mapx: number | null;
  mapy: number | null;
  distanceM: number | null;
  togetherRank: number | null;
  wheelchair: boolean | null;
  pet: boolean | null;
  indoorOutdoor: string | null;
}

export interface PlanPlaces {
  scope: { kind: string; label: string };
  totalCount: number;
  items: PlanPlace[];
  notice: string | null;
}

/** 카드 「자세히」 값 — 공사 원문 표시값. 저장하지 않는다 (DB 명세서 6-4) */
export interface PlanPlaceDetail {
  contentId: string;
  hours: string | null;
  restDays: string | null;
  fee: string | null;
  parking: string | null;
  eventPeriod: string | null;
  /** 소개정보의 문의처 */
  contact?: string | null;
  /** 요청한 축만 온다. 못 받았으면 null (EX-PL-004) */
  accessible?: Record<string, unknown> | null;
  pet?: Record<string, unknown> | null;
}

export interface PlanEvent {
  contentId: string;
  contentTypeId: number;
  title: string;
  eventStart: string;
  eventEnd: string;
  relation: "BEFORE" | "IN" | "AFTER";
  suggestedStartDate: string | null;
  firstImage: string | null;
  mapx: number | null;
  mapy: number | null;
}

export interface PlanWalk {
  walkId: string;
  name: string;
  lengthKm: number | null;
  minutes: number | null;
  level: 1 | 2 | 3 | null;
}

export interface BriefingQuery {
  regnCd: string;
  signguCd?: string | null;
  startDate: string;
  nights: number;
}

export const planApi = {
  // 첫째 줄 종류 칩 · 행사 · 걷기 길 요약 (지역이 바뀔 때만 다시 센다 · 10분 캐시)
  briefing: (q: BriefingQuery) => {
    const p = new URLSearchParams({ regnCd: q.regnCd, startDate: q.startDate, nights: String(q.nights) });
    if (q.signguCd) p.set("signguCd", q.signguCd);
    return request<PlanBriefing>(`/plan/briefing?${p.toString()}`);
  },
  // 종류(중분류)로 시군구 장소 목록, 또는 근처 3km(앵커 기준) 식당 · 카페 · 숙소.
  // 필터(휠체어 · 반려동물 · 실내만)와 정렬을 얹는다.
  places: (q: {
    regnCd: string;
    signguCd?: string | null;
    lcls2?: string;
    scope?: "SIGNGU" | "NEAR3KM";
    nearKind?: "MEAL" | "CAFE" | "STAY";
    anchor?: { mapx: number; mapy: number };
    anchorContentId?: string;
    sort?: "near" | "together";
    wheelchair?: boolean;
    pet?: boolean;
    indoor?: boolean;
    page?: number;
  }) => {
    const p = new URLSearchParams({ regnCd: q.regnCd });
    if (q.signguCd) p.set("signguCd", q.signguCd);
    if (q.lcls2) p.set("lcls2", q.lcls2);
    if (q.scope) p.set("scope", q.scope);
    if (q.nearKind) p.set("nearKind", q.nearKind);
    if (q.anchor) p.set("anchor", `${q.anchor.mapx},${q.anchor.mapy}`);
    if (q.anchorContentId) p.set("anchorContentId", q.anchorContentId);
    if (q.sort) p.set("sort", q.sort);
    if (q.wheelchair) p.set("wheelchair", "1");
    if (q.pet) p.set("pet", "1");
    if (q.indoor) p.set("indoor", "1");
    if (q.page) p.set("page", String(q.page));
    return request<PlanPlaces>(`/plan/places?${p.toString()}`);
  },
  // 여행 기간과 겹치거나 앞뒤에 있는 행사 · 공연
  events: (q: BriefingQuery) => {
    const p = new URLSearchParams({ regnCd: q.regnCd, startDate: q.startDate, nights: String(q.nights) });
    if (q.signguCd) p.set("signguCd", q.signguCd);
    return request<{ window: { from: string; to: string }; items: PlanEvent[] }>(`/plan/events?${p.toString()}`);
  },
  // 걷기 길 (넣으면 직접 정한 곳으로 들어간다). 좌표가 없어 앵커가 되지 않는다
  walks: (q: { regnCd: string; signguCd?: string | null }) => {
    const p = new URLSearchParams({ regnCd: q.regnCd });
    if (q.signguCd) p.set("signguCd", q.signguCd);
    return request<{ items: PlanWalk[]; notice: string }>(`/plan/walks?${p.toString()}`);
  },
  // 고른 직후 그 항목만(또는 고른 항목 전부). 규칙엔진 · audit_run 없음
  placeFacts: (productId: number, itemIds?: number[]) =>
    request<{ items: PlaceFacts[] }>(`/products/${productId}/place-facts`, {
      method: "POST",
      body: JSON.stringify(itemIds ? { itemIds } : {}),
    }),
  // 카드 「자세히」 — 이용시간 · 쉬는 날 · 요금 · 주차 (detailIntro2 실호출 · 캐시 없음)
  // 목록에서 무장애 · 반려동물로 표시된 축만 상세를 함께 부른다 (UI-S2-040 · #850)
  placeDetail: (contentId: string, contentTypeId: number, want: { accessible: boolean; pet: boolean } = { accessible: false, pet: false }) => {
    const axes = [want.accessible ? "accessible" : "", want.pet ? "pet" : ""].filter((a) => a !== "");
    const withAxes = axes.length === 0 ? "" : `&with=${axes.join(",")}`;
    return request<PlanPlaceDetail>(`/plan/place-detail?contentId=${encodeURIComponent(contentId)}&contentTypeId=${contentTypeId}${withAxes}`);
  },
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

// ── 레이더 · 알림 (S7 · FR-MO-050~058) ────────────────────────────────────────

export interface RadarSummary {
  risk: number;
  opportunity: number;
  unread: number;
  affectedProducts: number;
  changedContents: number;
  /** 마지막 확인 시각 · 다음 확인 시각 (UI-S7-010). 배치가 꺼져 있으면 nextBatchAt 이 null */
  lastBatchAt: string | null;
  nextBatchAt: string | null;
  /**
   * 배치 상태 행은 한 번도 돌기 전에도 있다 — 그때 결과 · 조회 건수는 null 이다 (`batch_state('sync_list')`
   * 는 `last_item_count` NULL 로 만들어진다)
   */
  lastBatch: null | { runAt: string | null; covered: string | null; status: string | null; itemCount: number | null };
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
  // 바뀐 곳 · 새로 생긴 곳의 이름. 서버가 볼 때 읽어 준다 — 못 읽었거나 표출이 중단된 곳은 null (UI-S7-003)
  placeName: string | null;
  // 그 곳이 일정에 든 줄. 일정에 없는 곳이면 null (UI-S7-003 「해당 일정」)
  schedule: { dayNo: number; startTime: string } | null;
  // 판독 결과 전 → 후 (UI-S7-004). 견줄 검수가 둘 다 있을 때만 채워진다
  changes: { label: string; before: string; after: string }[];
  // 견줄 이전 검수가 없을 때의 지금 판독값
  current: { label: string; value: string }[];
  // 공사가 그 관광정보를 고친 날 (YYYY-MM-DD)
  modifiedOn: string | null;
  eventPeriod: { start: string; end: string } | null;
  overlapDays: number[];
  what: string;
  impact: string;
  action: string;
  hidden: boolean;
  // 새 소식의 넣을 자리 · 사전 확인 (UI-S7-008). 배치가 남기기 전 알림 · 바뀐 정보는 null
  opportunity?: OpportunityView | null;
  // 알림 직전 검수와 알림 뒤 첫 검수에서 그 곳의 판정 차이 (FR-RU-061). 견줄 두 검수가 없으면 null
  verdictDiff?: VerdictDiff | null;
  // 지문 비교값. 조건 2·3 은 지문 이력이 없어 from·to 가 둘 다 null 이다 (FR-MO-058)
  fingerprint: { from: string | null; to: string | null };
  dismissable: boolean;
  readAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
}

export interface OpportunityView {
  slot: { dayNo: number; from: string; to: string | null; minutes: number; dwellMinutes: number } | null;
  slotMissing: "NO_GAP" | "DWELL_UNKNOWN" | null;
  precheck: {
    travel: "FITS" | "SHORT" | "UNKNOWN";
    inMinutes: number | null;
    outMinutes: number | null;
    addedMinutes: number | null;
    shortMinutes: number | null;
    currentTimeBased: boolean;
  } | null;
  /** 이동시간을 잰 곳. 잰 값이 없으면 null */
  travelSource: string | null;
}

export interface VerdictDiff {
  added: { ruleCode: string; severity: Severity }[];
  removed: { ruleCode: string; severity: Severity }[];
  changed: { ruleCode: string; from: Severity; to: Severity }[];
}

export interface NotificationPage {
  content: RadarNotification[];
  page: number;
  size: number;
  totalElements: number;
  unreadCount: number;
}

/** 키워드별 맞는 곳. contentIds null = 등록한 뒤 배치가 아직 안 봄, [] = 세어 보니 없음 */
export interface KeywordHit {
  keyword: string;
  contentIds: string[] | null;
}

export interface RegionDemandSignal extends DemandSignal {
  keywordHits: KeywordHit[];
}

/** 관심 지역 한 곳의 새 소식 (FR-MO-059~061). t3 는 관측된 방문자 수 · 기준 기간뿐 — 인기·예측 없음 */
export interface RegionSignal {
  region: { regnCd: string; signguCd: string | null };
  month: string;
  t1: RegionDemandSignal | null;
  t2: RegionDemandSignal | null;
  t3: { count: number; basisMonth: string; source: string; computedAt: string } | null;
}

/** 수요 신호 한 줄이 가리키는 곳 (#644). 이름은 서버가 표시용으로 조달한 값이다 */
export interface SignalDetailItem {
  contentId: string;
  title: string;
  contentTypeId: string;
  createdDate: string | null;
  eventStart: string | null;
  eventEnd: string | null;
}

export interface SignalDetail {
  productId: number;
  type: "T1" | "T2";
  window: { from: string; to: string } | null;
  items: SignalDetailItem[];
  /** 목록을 못 보여 주는 이유. 건수는 저장된 값이라 그대로다 */
  unavailable: "BUDGET" | "FETCH_FAILED" | "NO_REGION" | null;
}

export const radarApi = {
  summary: () => request<RadarSummary>("/radar/summary"),
  // signals 는 productId 가 필수다 — T2(행사 밀도) 창이 그 상품의 여행일에서 나온다
  signals: (productId: number) => request<RadarSignals>(`/radar/signals?productId=${productId}`),
  // 건수 옆 「무엇인지 보기」 — 누를 때만 조회한다 (#644)
  signalDetail: (productId: number, type: "T1" | "T2") =>
    request<SignalDetail>(`/radar/signals/detail?productId=${productId}&type=${type}`),
  // 관심 지역 카드의 「무엇인지 보기」 (#650)
  regionSignalDetail: (regnCd: string, signguCd: string | null, month: string, type: "T1" | "T2") =>
    request<SignalDetail>(
      `/radar/region-signals/detail?regnCd=${regnCd}&signguCd=${signguCd ?? ""}&month=${month}&type=${type}`,
    ),
  regionSignals: () => request<RegionSignal[]>("/radar/region-signals"),
  // 배치가 꺼진 기간에만. 켜져 있으면 서버가 403 이다
  refreshRegionSignals: () => request<RegionSignal[]>("/radar/region-signals/refresh", { method: "POST" }),
};

// ── 레이더 에이전트 · 오늘 할 일 (F18 · FR-AG-030 · 031) ──────────────────────

export interface TodayItem {
  kind: "CHANGE" | "NEWS";
  productId: number | null;
  region: { regnCd: string; signguCd: string | null; month: string } | null;
  reason: string;
  action: "REAUDIT" | "VIEW_RESULT" | "NEW_PLAN";
}

export interface TodayBrief {
  basisAt: string;
  todos: TodayItem[];
  quiet: { productId: number; text: string }[];
  incomplete: { reasonCode: string; itemIds: number[] } | null;
}

/** 직접 확인할 곳 하나 · 전화로 물어볼 내용 (FR-AG-020~022 · API 4-11) */
export interface CheckQuestionPlace {
  findingIds: number[];
  itemId: number;
  visit: { dayNo: number; date: string; start: string | null };
  tel: string | null;
  questions: string[];
}

export interface CheckQuestions {
  places: CheckQuestionPlace[];
  incomplete: { reasonCode: string; itemIds: number[] } | null;
}

/** 고르지 않은 줄의 장소 찾기 제안 (FR-AG-010~012). 고르는 것은 match(AGENT)로 한다 */
export interface PlaceSuggestion {
  itemId: number;
  kind: "FOUND" | "NOT_FOUND" | "NO_NAME";
  place: { contentId: string; contentTypeId: number; title: string; kindName: string; addr: string | null } | null;
  alternatives: { contentId: string; title: string; kindName: string; distanceM: number | null }[];
  reason: string;
}

export interface PlaceSuggestions {
  items: PlaceSuggestion[];
  summary: { found: number; notFound: number; noName: number };
  incomplete: { reasonCode: string; itemIds: number[] } | null;
}

export const agentApi = {
  // 사람이 누를 때만 돈다. 서버가 정한 순서를 화면이 다시 정렬하지 않는다 (FR-AG-031)
  today: () => request<TodayBrief>("/radar/today", { method: "POST" }),
  // 아직 고르지 않은 줄의 장소를 한 번에 찾아 준다. 고르는 것은 사람이 누른다 (FR-AG-012)
  placeSuggestions: (productId: number, itemIds?: number[]) =>
    request<PlaceSuggestions>(`/products/${productId}/place-suggestions`, {
      method: "POST",
      body: JSON.stringify(itemIds ? { itemIds } : {}),
    }),
  // 직접 확인할 곳의 전화로 물어볼 내용. 판정하지 않는다 — 확인은 사람이 누른다 (FR-AG-022)
  checkQuestions: (runId: number) => request<CheckQuestions>(`/audit-runs/${runId}/check-questions`, { method: "POST" }),
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
  /** 반영이 바꾼 일정 — 반영 기록의 전후 스냅샷 (UI-S5-003 · #806) */
  schedule?: { before: PatchItem[]; after: PatchItem[] };
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
  /** 좌표 · 분류 · 유형 — 등록 인라인 매칭이 pick 시 잡아 저장에 싣는다 (UI-S2-020) */
  contentTypeId: number | null;
  mapx: number | null;
  mapy: number | null;
  lclsSystm1: string | null;
  lclsSystm2: string | null;
  lclsSystm3: string | null;
  /** 저작권 유형 `Type1` · `Type3`. Type3 이면 공사 원문 배지에 「변경금지」 (FR-CM-011). 없으면 표기 생략 */
  cpyrhtDivCd?: string | null;
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
  /**
   * PDF 를 바이트로 받는다 — 화면 안 미리보기(UI-S6-007)에 쓴다.
   *
   * 공통 래퍼를 못 쓴다. 그쪽은 무조건 `.json()` 이라 바이너리에서 터진다.
   * 오류 응답은 JSON 이므로 그때만 읽어 사유를 꺼낸다.
   */
  async fetchPdf(reportId: string): Promise<Blob> {
    const res = await fetch(`/api/v1/reports/${reportId}/download`, { credentials: "include" });
    if (!res.ok) {
      let body: { reasonCode?: string; message?: string } = {};
      try {
        body = (await res.json()) as { reasonCode?: string; message?: string };
      } catch {
        body = {};
      }
      const err: ApiError = {
        status: res.status,
        reasonCode: body.reasonCode,
        message: body.message ?? "리포트를 불러오지 못했습니다. 다시 만들어 주세요.",
      };
      throw err;
    }
    return res.blob();
  },
};

// ── 검수 기준 (F16 · UI-S8 · FR-OP-020~027) ──────────────────────────────────
//
// 표준(가중치 · R04 임계치 · 표 3종)은 모든 계정에 같아 화면이 @tourlint/shared 시드를
// 직접 읽는다(0콜). 계정이 바꾸는 것은 회사 기준 R07 두 값과 관심 키워드 · 관심 지역뿐이다.

export interface WeightSettings {
  BLOCKER: number;
  ERROR: number;
  WARNING: number;
  UNVERIFIED: number;
}

export interface WatchRegion {
  regnCd: string;
  signguCd: string | null;
  month: string;
}

export interface R07HistoryEntry {
  at: string;
  field: "r07SpanHours" | "r07MealMinutes";
  from: number;
  to: number;
}

/** 표준 요약 — 읽기만 한다 (UI-S8). 표 3종은 shared 시드를 직접 읽으므로 여기 없다. */
export interface StandardView {
  version: string;
  weights: WeightSettings;
  r04Threshold: number;
  r07SpanHours: number;
  r07MealMinutes: number;
}

export interface CompanyView {
  r07SpanHours: number;
  r07MealMinutes: number;
  updatedAt: string | null;
  history: R07HistoryEntry[];
}

export interface SettingsView {
  standard: StandardView;
  company: CompanyView;
  watchKeywords: string[];
  watchRegions: WatchRegion[];
  ops: { batchTime: string; nextBatchAt: string | null };
}

/** PUT /settings 본문 — 회사 기준 두 값과 관심 2종만. 안 보낸 것은 그대로 둔다. */
export interface CompanyUpdate {
  r07SpanHours?: number;
  r07MealMinutes?: number;
  watchKeywords?: string[];
  watchRegions?: WatchRegion[];
}

export const settingsApi = {
  get: () => request<SettingsView>("/settings"),
  // 회사 기준(엄격하게만) · 관심 키워드 · 관심 지역만 저장한다. 느슨하면 서버가 400
  // SETTING_NOT_STRICTER 를 준다 (FR-OP-022).
  update: (patch: CompanyUpdate) =>
    request<SettingsView>("/settings", { method: "PUT", body: JSON.stringify(patch) }),
};

export function isApiError(e: unknown): e is ApiError {
  return typeof e === "object" && e !== null && "status" in e && "message" in e;
}
