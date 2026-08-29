/**
 * 브라우저용 API 헬퍼.
 *
 * 항상 같은 오리진 `/api/*` 를 부르고(next.config 의 rewrite 가 API 서버로 넘긴다)
 * `credentials: "include"` 로 세션 쿠키를 함께 보낸다. 외부 API 를 브라우저에서 직접
 * 부르지 않는다 — 인증키는 서버에만 있다 (PM-SC-002).
 */
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
  days: { day: number; items: ProductItem[] }[];
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
  evidence: {
    fetchedAt: string;
    dataFingerprint: string | null;
    rulesetVersion: string;
    delayNotice: string;
    source: string;
  };
}

export interface Finding {
  findingId: number;
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
  reason: string;
  reasonCode: string;
  confirmedAt: true | null;
  excludedFromScore: boolean;
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
};

export function isApiError(e: unknown): e is ApiError {
  return typeof e === "object" && e !== null && "status" in e && "message" in e;
}
