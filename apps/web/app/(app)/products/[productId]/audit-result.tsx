"use client";

// 화면 3 본체 (UI-S3 · F04~F09). 요약 · finding 목록 · 확인 필요 목록을 실 검수 데이터로
// 렌더하고, finding 이 제안한 수정안을 골라 미리보기(F08) → 확정하면 자동 재검수(F09)한다.
//
// 판정 문구·점수·사유는 서버가 준 값을 그대로 쓴다 — 화면이 지어내지 않는다 (FR-RU-051 · EX-SY-004).

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  auditApi,
  contentApi,
  EXTERNAL_UNAVAILABLE,
  isApiError,
  patchApi,
  productApi,
  reportApi,
  type ContentDetail,
  type EvidenceView,
  type Finding,
  type PatchApplicationDetail,
  type PatchPreview,
  type PatchSelection,
  type ProductDetail,
  type ProductItem,
  type RunSummary,
  type Severity,
  type UnverifiedItem,
} from "../../../lib/api";
import { DISMISS_REASON_PRESET, SETTING_DEFAULTS, ktoFieldLabel } from "@tourlint/shared";
import { AuditBasis, basisRows } from "../../../components/audit-basis";
import { GradeBadge, GradeCounts, SourceBadge, StatusBadge, type SourceKind } from "../../../components/badges";
import { contactText, readNormalized, readVerdict, ruleLine } from "../../../lib/evidence";
import { ruleName } from "../../../lib/rule-names";
import { scoreSentence } from "../../../lib/score-sentence";
import { WorkspaceIcon } from "../../../components/workspace-icon";
import { FINDING_FILTERS, filterFindings, type FindingFilter } from "./finding-filter";
import { ReviewPlaceDrawer } from "./review-place-drawer";
import { ScheduleComparison } from "./schedule-compare";
import { placeAction, reviewPlaceContext } from "./review-place-context";
import type { PickerContext } from "./plan/place-picker";
import { CurrentSchedule, hiddenItemIdsOf } from "./current-schedule";
import { PatchDescription } from "./patch-description";
import { CheckQuestionsCard } from "./check-questions-card";
import { AuditBudgetNotice, useAuditAvailability } from "../../../lib/audit-availability";

// 배지·건수·라벨은 공통 컴포넌트(components/badges)가 등급 토큰으로 그린다.
// 여기서는 finding 카드의 좌측 테두리 색과 정렬 순서만 등급별로 둔다.
const SEVERITY_META: Record<Severity, { order: number; bar: string }> = {
  BLOCKER: { order: 0, bar: "border-l-rose-500" },
  ERROR: { order: 1, bar: "border-l-orange-500" },
  WARNING: { order: 2, bar: "border-l-amber-500" },
  UNVERIFIED: { order: 3, bar: "border-l-slate-400" },
};

interface Loaded {
  run: RunSummary;
  findings: Finding[];
  unverified: UnverifiedItem[];
}

export function AuditResult({ productId }: { productId: number }) {
  const router = useRouter();
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // 예산이 다 되면 검수 버튼을 미리 막고 다시 열리는 때를 적는다 (UI-ST-007 · #838)
  const budget = useAuditAvailability();
  const [progress, setProgress] = useState<string | null>(null);
  // 수정안 선택: findingId → patchId (finding 당 하나)
  const [selected, setSelected] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<PatchPreview | null>(null);
  const [patchBusy, setPatchBusy] = useState<"preview" | "apply" | null>(null);
  const [patchMsg, setPatchMsg] = useState<string | null>(null);
  // 확정 직후 반영 이력 — 경고 배너·되돌리기 (F09). 되돌리기는 확인 단계를 거친다.
  const [application, setApplication] = useState<PatchApplicationDetail | null>(null);
  const [undoConfirm, setUndoConfirm] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoMsg, setUndoMsg] = useState<string | null>(null);
  const [placeContext, setPlaceContext] = useState<PickerContext | null>(null);
  const [scheduleChanged, setScheduleChanged] = useState(false);
  const alive = useRef(true);
  const previewRegion = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (preview !== null) {
      previewRegion.current?.scrollIntoView({ behavior: "instant", block: "start" });
      previewRegion.current?.focus({ preventScroll: true });
    }
  }, [preview]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadRun = useCallback(async (runId: number) => {
    const [run, findings, unverified] = await Promise.all([
      auditApi.getRun(runId),
      auditApi.getFindings(runId),
      auditApi.getUnverified(runId),
    ]);
    if (!alive.current) return;
    setData({ run, findings: findings.content, unverified: unverified.items });
  }, []);

  // 관광지 확정 뒤 상품을 다시 읽는다 — 미확정이 0 이 되면 검수 진입점이 열린다
  const refetchProduct = useCallback(async () => {
    const detail = await productApi.detail(productId);
    if (alive.current) setProduct(detail);
  }, [productId]);

  // 초기 로드. setState 는 전부 await 뒤에서 한다 (effect 안 동기 setState 금지)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [detail, runs] = await Promise.all([productApi.detail(productId), auditApi.listRuns(productId)]);
        if (cancelled) return;
        setProduct(detail);
        // 지금 일정의 결과부터 연다. 되돌린 뒤 새로고침해도 반영 전 결과가 보여야 한다 (#551)
        const latest = runs.runs.find((r) => r.isCurrent === true)
          ?? [...runs.runs].sort((a, b) => b.executedAt.localeCompare(a.executedAt))[0];
        if (latest) {
          // 검수한 뒤에 일정을 고쳤는지는 서버가 말한다 — 브라우저 기억만으로는 새로 고치거나 편집 화면을
          // 다녀오면 잊는다. 그 틈에 고치기 전 결과로 출시가 통과했다 (#710)
          let remembered = false;
          try { remembered = sessionStorage.getItem(`review-changed:${productId}`) === String(latest.auditRunId); } catch { /* 저장소 사용 불가 */ }
          setScheduleChanged(remembered || isEditedSinceAudit(detail));
          await loadRun(latest.auditRunId);
        } else if (detail.plannedAt !== null) {
          /*
           * 검수 시작(handoff)이 건 작업이 아직 도는 중이다 (#711). 여기서 「아직 검수하지 않았습니다 ·
           * 검수 실행」 을 그리면 사용자가 눌러 같은 일정을 한 번 더 검수한다 — 가이드 10단계가 그랬다.
           */
          setRunning(true);
          // 기다리는 동안 「불러오는 중…」 이 아니라 검수 중임을 보인다
          setLoading(false);
          const runId = await waitForFirstRun(productId, () => cancelled);
          if (cancelled) return;
          setRunning(false);
          if (runId !== null) await loadRun(runId);
          else setData(null);
        }
        else setData(null);
      } catch (err) {
        if (isApiError(err) && err.status === 401) {
          router.replace("/login");
          return;
        }
        if (!cancelled) setError(isApiError(err) ? err.message : "결과를 불러오지 못했습니다.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [productId, loadRun, router]);

  function resetPatchState() {
    setSelected({});
    setPreview(null);
    setPatchMsg(null);
  }

  async function pollJob(jobId: number): Promise<number | null> {
    let job = await auditApi.getJob(jobId);
    const interval = job.pollIntervalMs ?? 1500;
    while (job.auditRunId === null && job.errorCode === undefined) {
      await sleep(interval);
      if (!alive.current) return null;
      job = await auditApi.getJob(jobId);
      setProgress(job.progress.label);
    }
    if (job.errorCode !== undefined) throw new Error(`검수를 마치지 못했습니다 (${job.errorCode}).`);
    return job.auditRunId;
  }

  async function runAudit() {
    setRunning(true);
    setError(null);
    setProgress(null);
    setApplication(null); // 수동 재검수는 직전 반영 배너를 무효화한다
    setUndoMsg(null);
    try {
      const job = await auditApi.runAudit(productId, "MANUAL");
      const runId = await pollJob(job.jobId);
      if (runId !== null) {
        resetPatchState();
        await Promise.all([loadRun(runId), refetchProduct()]);
        setScheduleChanged(false);
        try { sessionStorage.removeItem(`review-changed:${productId}`); } catch { /* 저장소 사용 불가 */ }
      }
    } catch (err) {
      if (isApiError(err) && err.status === 429) budget.refresh();
      setError(isApiError(err) ? err.message : err instanceof Error ? err.message : "검수 실행에 실패했습니다.");
    } finally {
      if (alive.current) {
        setRunning(false);
        setProgress(null);
      }
    }
  }

  async function onPlaceInserted() {
    resetPatchState();
    setApplication(null);
    setScheduleChanged(true);
    try { if (data) sessionStorage.setItem(`review-changed:${productId}`, String(data.run.auditRunId)); } catch { /* 저장소 사용 불가 */ }
    await refetchProduct();
  }

  function selectPatch(findingId: number, patchId: string | null) {
    setPreview(null); // 선택이 바뀌면 이전 미리보기는 무효다
    setPatchMsg(null);
    setSelected((prev) => {
      const next = { ...prev };
      if (patchId === null) delete next[findingId];
      else next[findingId] = patchId;
      return next;
    });
  }

  function selections(): PatchSelection[] {
    return Object.entries(selected).map(([findingId, patchId]) => ({ findingId: Number(findingId), patchId }));
  }

  async function doPreview() {
    setPatchBusy("preview");
    setPatchMsg(null);
    try {
      const p = await patchApi.preview(productId, selections());
      if (alive.current) setPreview(p);
    } catch (err) {
      setPatchMsg(isApiError(err) ? err.message : "미리보기에 실패했습니다.");
    } finally {
      if (alive.current) setPatchBusy(null);
    }
  }

  async function doApply() {
    if (preview === null) return;
    setPatchBusy("apply");
    setPatchMsg(null);
    setProgress(null);
    setApplication(null);
    setUndoMsg(null);
    try {
      const applied = await patchApi.apply(productId, selections(), preview.previewToken);
      const runId = await pollJob(applied.reauditJobId);
      if (runId !== null) {
        resetPatchState();
        await Promise.all([loadRun(runId), refetchProduct()]);
        // 재검수가 끝난 뒤 반영 상세를 읽어 경고 배너·되돌리기 가능 여부를 받는다.
        // 이 조회가 실패해도 반영 자체는 이미 성공했으므로 배너 없이 진행한다.
        try {
          const detail = await patchApi.application(applied.patchApplicationId);
          if (alive.current) {
            setApplication(detail);
            setUndoConfirm(false);
          }
        } catch {
          /* 배너 생략 */
        }
      }
    } catch (err) {
      if (isApiError(err) && err.status === 429) budget.refresh();
      // PATCH_CONFLICT · PATCH_STALE 는 서버 문구를 그대로 보여준다. stale 이면 다시 미리보기해야 한다
      setPatchMsg(isApiError(err) ? err.message : err instanceof Error ? err.message : "확정에 실패했습니다.");
      setPreview(null);
    } finally {
      if (alive.current) {
        setPatchBusy(null);
        setProgress(null);
      }
    }
  }

  // 되돌리기 (EX-PA-005 · EX-MS-006). 직전 1건이 아니면 서버가 409 UNDO_UNAVAILABLE 을
  // 준다 — 그 문구를 그대로 보여 준다 (EX-PA-006).
  async function doRevert() {
    if (application === null) return;
    setUndoBusy(true);
    setUndoMsg(null);
    try {
      const res = await patchApi.revert(application.patchApplicationId);
      if (res.restoredAuditRunId !== null) await loadRun(res.restoredAuditRunId);
      await refetchProduct();
      if (alive.current) {
        setApplication(null);
        setUndoConfirm(false);
      }
    } catch (err) {
      setUndoMsg(isApiError(err) ? err.message : err instanceof Error ? err.message : "되돌리기에 실패했습니다.");
    } finally {
      if (alive.current) setUndoBusy(false);
    }
  }

  async function refresh() {
    if (data) await loadRun(data.run.auditRunId);
  }

  const labelOf = itemLabeler(product);
  const contentOf = contentIdOf(product);
  const selectedCount = Object.keys(selected).length;
  const pendingItems: ProductItem[] = product
    ? product.days.flatMap((d) => d.items).filter((it) => it.matchStatus === "PENDING")
    : [];

  return (
    <div className="audit-page">
      <nav aria-label="현재 위치" className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        <Link href="/review" className="hover:underline">
          검수
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-700 dark:text-slate-300">{product?.name ?? `상품 #${productId}`}</span>
      </nav>

      <div className="audit-heading">
        <div>
          <p className="eyebrow">검수 결과</p>
          <h1>{product?.name ?? "검수 결과"}</h1>
          {product && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {[product.region.regnName, product.region.signguName].filter(Boolean).join(" ")} ·{" "}
              {product.startDate}
            </p>
          )}
        </div>
        <div className="audit-header-actions">
          <button type="button" className="button-secondary" disabled={!product || running || patchBusy !== null}
            onClick={() => product && setPlaceContext(reviewPlaceContext(product))}>장소 담기</button>
          <Link
            href={`/products/${productId}/edit`}
            className="button-secondary"
          >
            <WorkspaceIcon name="plan" width="16" height="16" /> 일정 편집
          </Link>
          {data && (
            <button
              type="button"
              onClick={runAudit}
              disabled={running || patchBusy !== null || budget.blocked}
              className="button-primary disabled:opacity-60"
            >
              {running ? "검수 중…" : "지금 재검수"}
            </button>
          )}
        </div>
      </div>

      {budget.blocked && <AuditBudgetNotice resumesAt={budget.resumesAt} className="mt-5" />}

      {scheduleChanged && <div role="status" className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        검수한 뒤에 일정이 바뀌었어요. 아래 결과는 바뀌기 전 결과입니다. ‘지금 재검수’를 눌러 새 일정의 문제와 수정안을 확인하세요.
      </div>}
      {placeContext && product && <ReviewPlaceDrawer product={product} context={placeContext} changed={scheduleChanged}
        onInserted={onPlaceInserted} onClose={() => setPlaceContext(null)} reauditBlocked={budget.blocked} resumesAt={budget.resumesAt}
        onReaudit={() => { setPlaceContext(null); void runAudit(); }} />}
      {loading ? (
        <p className="mt-8 text-sm text-slate-400">불러오는 중…</p>
      ) : error ? (
        <div className="mt-8 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
          {error}
        </div>
      ) : product && pendingItems.length > 0 ? (
        <PendingNotice productId={productId} count={pendingItems.length} />
      ) : data === null ? (
        <EmptyState running={running} progress={progress} onRun={runAudit} blocked={budget.blocked} />
      ) : (
        <div className="mt-6 space-y-8 pb-28">
          {application && (
            <ApplyResultBanner
              application={application}
              undoConfirm={undoConfirm}
              undoBusy={undoBusy}
              undoMsg={undoMsg}
              onAskUndo={() => setUndoConfirm(true)}
              onCancelUndo={() => setUndoConfirm(false)}
              onConfirmUndo={doRevert}
              onDismiss={() => {
                setApplication(null);
                setUndoMsg(null);
              }}
            />
          )}
          {product && <LifecycleBar product={product} run={data.run} />}
          <SummaryCard run={data.run} confirmationCount={data.unverified.length} />
          <nav className="audit-section-nav" aria-label="검수 결과 바로 가기">
            <a href="#audit-findings"><span>01</span> 문제와 수정안 <b>{data.findings.length}</b></a>
            <a href="#audit-confirmations"><span>02</span> 직접 확인할 곳 <b>{data.unverified.length}</b></a>
            <a href="#audit-release"><span>03</span> 출시 · 리포트 <WorkspaceIcon name="arrow" width="16" height="16" /></a>
          </nav>
          {running && <p role="status" className="audit-progress">{progress ?? "최신 정보로 다시 검수하고 있습니다…"}</p>}
          {preview && (
            <div ref={previewRegion} tabIndex={-1} className="audit-anchor" aria-label="수정안 미리보기">
              <PatchPreviewPanel preview={preview} applying={patchBusy === "apply"} progress={progress}
                budgetBlocked={budget.blocked} resumesAt={budget.resumesAt}
                onApply={doApply} onClose={() => setPreview(null)} />
            </div>
          )}
          <FindingsSection key={data.run.auditRunId}
            findings={data.findings}
            product={product}
            itemLabel={labelOf}
            contentOf={contentOf}
            selected={selected}
            onSelectPatch={selectPatch}
            onChanged={refresh}
            onOpenPlaces={running || patchBusy !== null ? undefined : f => product && setPlaceContext(reviewPlaceContext(product, f))}
            busy={patchBusy !== null || running || scheduleChanged}
          />
          <UnverifiedSection items={data.unverified} itemLabel={labelOf} onChanged={refresh} runId={data.run.auditRunId} />

          <section id="audit-release" className="audit-tools audit-anchor">
            <div className="audit-section-title"><span className="audit-step">03</span><div>
              <h2>준비를 마쳤다면, 출시하기</h2>
              <p>출시하면 출발일까지 바뀐 정보를 레이더에서 알려 드려요.</p>
            </div></div>
            <div className="audit-tool-grid">
              <div><WorkspaceIcon name="check" /><h3>출시 승인</h3>
                <p>{data.run.releasable ? "검수 결과와 직접 확인할 내용을 살펴본 뒤 출시를 결정하세요." : data.run.releaseBlockedReason ?? "검수를 완료하고 차단 항목을 해결해 주세요."}</p>
                <ReleaseButton productId={productId} releasable={data.run.releasable && !running && patchBusy === null && !scheduleChanged}
                  blockedReason={scheduleChanged ? "일정이 바뀌어 재검수가 필요합니다." : data.run.releaseBlockedReason} releasedAt={product?.releasedAt ?? null} />
              </div>
              <div><WorkspaceIcon name="file" /><h3>검수 리포트</h3>
                <p>최신 검수 결과와 판정 근거를 PDF로 확인하고 내려받으세요.</p>
                <ReportButton key={data.run.auditRunId} runId={data.run.auditRunId} releasable={data.run.releasable && !running && patchBusy === null && !scheduleChanged} />
                {!data.run.releasable && <p className="audit-tool-note">출시 가능한 검수 결과가 준비되면 리포트를 만들 수 있어요.</p>}
              </div>
            </div>
          </section>
        </div>
      )}

      {data && selectedCount > 0 && (
        <PatchBar
          count={selectedCount}
          busy={patchBusy}
          message={patchMsg}
          hasPreview={preview !== null}
          onPreview={doPreview}
          onClear={() => resetPatchState()}
        />
      )}
    </div>
  );
}

function EmptyState({ running, progress, onRun, blocked }: { running: boolean; progress: string | null; onRun: () => void; blocked: boolean }) {
  return (
    <div className="mt-10 rounded-2xl border border-dashed border-slate-300 py-16 text-center dark:border-slate-700">
      {/* 도는 중에 「아직 검수하지 않았습니다」 를 보이면 멈춘 화면으로 읽힌다 (#711) */}
      <p className="text-sm text-slate-500 dark:text-slate-400">{running ? "검수하고 있어요. 끝나면 결과가 여기에 나와요." : "아직 검수하지 않았습니다."}</p>
      {running ? (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">{progress ?? "검수를 시작하는 중…"}</p>
      ) : (
        <button
          type="button"
          onClick={onRun}
          disabled={blocked}
          className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          검수 실행
        </button>
      )}
    </div>
  );
}

function PendingNotice({ productId, count }: { productId: number; count: number }) {
  return (
    <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
      <p>아직 고르지 않은 장소가 {count}곳 있어요. 기획 화면에서 장소를 고른 뒤 검수할 수 있어요.</p>
      <Link
        href={`/products/${productId}/plan`}
        className="mt-3 inline-block rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
      >
        기획 화면으로
      </Link>
    </div>
  );
}

/**
 * 확정 직후 배너 (F09). 재검수로 준비도가 내려갔으면 경고 문구를 보여 주고(EX-PA-005),
 * 되돌리기 수단을 준다. 되돌리기는 파괴적이라 확인 단계를 한 번 거친다 (EX-MS-006).
 */
function ApplyResultBanner({
  application,
  undoConfirm,
  undoBusy,
  undoMsg,
  onAskUndo,
  onCancelUndo,
  onConfirmUndo,
  onDismiss,
}: {
  application: PatchApplicationDetail;
  undoConfirm: boolean;
  undoBusy: boolean;
  undoMsg: string | null;
  onAskUndo: () => void;
  onCancelUndo: () => void;
  onConfirmUndo: () => void;
  onDismiss: () => void;
}) {
  const warn = application.warningBanner;
  const before = application.before?.readinessScore;
  const after = application.after?.readinessScore;
  const box = warn
    ? "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"
    : "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/20";

  return (
    <section className={`rounded-2xl border p-5 ${box}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">
            {warn ? "재검수 결과 확인" : "수정안을 반영했습니다"}
          </p>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
            {warn ?? "일정에 수정안을 반영하고 다시 검수했습니다."}
          </p>
          {before != null && after != null && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              준비도 {before} → {after}
            </p>
          )}
          {undoMsg && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{undoMsg}</p>}
        </div>
        <button type="button" onClick={onDismiss} className="shrink-0 text-sm text-slate-400 hover:text-slate-600">
          닫기
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Link
          href={`/products/${application.productId}/comparison`}
          className="mr-auto rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          전후 비교
        </Link>
        {application.revertible ? (
          undoConfirm ? (
            <>
              <span className="mr-auto text-xs text-slate-500 dark:text-slate-400">
                반영 전 일정으로 되돌립니다. 계속할까요?
              </span>
              <button
                type="button"
                onClick={onCancelUndo}
                disabled={undoBusy}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                취소
              </button>
              <button
                type="button"
                onClick={onConfirmUndo}
                disabled={undoBusy}
                className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-500 disabled:opacity-60"
              >
                {undoBusy ? "되돌리는 중…" : "되돌리기"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onAskUndo}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              되돌리기
            </button>
          )
        ) : (
          <span className="text-xs text-slate-400">직전에 반영한 것만 되돌릴 수 있습니다.</span>
        )}
      </div>
    </section>
  );
}

// 상단 라이프사이클 바 (UI-S1-011 · 기획 → 검수 → 레이더). 기획 출처 · 구성, 검수 요약,
// 출시 후 레이더 안내를 한 줄로 보여 준다. 출시 버튼은 아래 요약 카드에 있다.
const STARTED_BY_LABEL: Record<string, string> = {
  MANUAL: "직접 입력으로 시작",
  UPLOAD: "엑셀로 시작",
  TEXT: "메모 붙여넣기로 시작",
  CLONE: "복제로 시작",
  SIGNAL: "레이더 소식으로 시작",
};

function planCell(product: ProductDetail): string {
  const started = product.planOrigin ? (STARTED_BY_LABEL[product.planOrigin.startedBy] ?? "기획으로 시작") : "직접 기획";
  const c = product.composition;
  const total = c.manual + c.picker + c.excluded;
  const places = c.excluded > 0 ? `장소 ${total}곳 (직접 정한 곳 ${c.excluded})` : `장소 ${total}곳`;
  return `${started} · ${places}`;
}

function reviewCell(run: RunSummary): string {
  if (run.isPartial) return "부분 검수";
  if (run.readinessScore === null) return "검수 전";
  return `${run.readinessScore}점 · ${run.releasable ? "출시할 수 있어요" : `차단 ${run.counts.blocker}건`}`;
}

function LifecycleBar({ product, run }: { product: ProductDetail; run: RunSummary }) {
  const released = product.releasedAt !== null;
  const cells: { title: string; text: string }[] = [
    { title: "기획", text: planCell(product) },
    { title: "검수", text: reviewCell(run) },
    { title: "레이더", text: released ? "바뀐 정보를 알려 드려요" : "출시하면 바뀐 정보를 알려 드려요" },
  ];
  return (
    <div className="audit-lifecycle grid gap-2 sm:grid-cols-3">
      {cells.map((c) => (
        <div key={c.title} className="rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-800">
          <p className="text-xs text-slate-400">{c.title}</p>
          <p className="mt-0.5 text-sm text-slate-700 dark:text-slate-200">{c.text}</p>
        </div>
      ))}
    </div>
  );
}

// 이 검수에 적용한 회사 기준이 표준과 다른 값만 짧게. 없으면 빈 문자열이라 배지를 숨긴다.
function companyBasisText(snapshot: RunSummary["settingSnapshot"]): string {
  if (snapshot === null) return "";
  const parts: string[] = [];
  if (snapshot.r07SpanHours !== SETTING_DEFAULTS.r07SpanHours) parts.push(`연속 일정 ${snapshot.r07SpanHours}시간`);
  if (snapshot.r07MealMinutes !== SETTING_DEFAULTS.r07MealMinutes) parts.push(`식사 ${snapshot.r07MealMinutes}분`);
  return parts.join(" · ");
}

export function SummaryCard({ run, confirmationCount }: { run: RunSummary; confirmationCount: number }) {
  const status = run.isPartial ? "검수가 일부 완료됐어요" : run.releasable ? "출시할 수 있는 상품이에요" : "출시 전, 해결할 항목이 있어요";
  return (
    <section className="audit-overview" aria-label="검수 결과 요약">
      <div className="audit-overview-main">
        <div className="audit-score">
          <p>출시 준비도</p>
          {run.isPartial ? <StatusBadge status="PARTIAL" /> : <div><strong>{run.readinessScore ?? "—"}</strong><span> / 100점</span></div>}
          <span>검수 대상 {run.targetCount}곳</span>
        </div>
        <div className="audit-verdict">
          <span className={`audit-verdict-label ${run.isPartial ? "is-partial" : run.releasable ? "is-ready" : "needs-work"}`}>
            {run.isPartial ? "부분 검수" : run.releasable ? "출시 가능" : "출시 불가"}
          </span>
          <h2>{status}</h2>
          <p>{run.isPartial ? `조회하지 못한 콘텐츠 ${run.failedCount}곳이 있어요. 다시 검수해 주세요.`
            : run.releasable ? "남은 주의 사항과 직접 확인할 곳도 함께 살펴보세요."
            : run.releaseBlockedReason ?? "아래 발견 항목에서 필요한 조치를 확인해 주세요."}</p>
          <GradeCounts counts={run.counts} variant="tile" />
        </div>
      </div>
      <div className="audit-summary-notes">
        {/* 감점에 쓴 건수로 적는다 — 점수와 더해서 맞아야 한다 (#819). 옛 응답에는 없다 */}
        <p>{!run.isPartial && run.readinessScore !== null && scoreSentence(run.scoreBreakdown.scoredCounts ?? run.counts, run.scoreBreakdown.weights as never)}</p>
        <p><a href="#audit-confirmations">직접 확인 필요 <strong>{confirmationCount}건</strong></a><span> · 확인 표시는 점수를 바꾸지 않아요.</span></p>
        {companyBasisText(run.settingSnapshot) && <p>회사 기준: {companyBasisText(run.settingSnapshot)}</p>}
        {run.counts.dismissed > 0 && <p>무시 {run.counts.dismissed}건은 감점에서 제외됐어요.</p>}
      </div>
      <AuditBasis rows={basisRows(run.evidence)} notice={run.evidence.delayNotice} source={run.evidence.source} />
    </section>
  );
}

export function FindingsSection({
  product,
  findings,
  itemLabel,
  contentOf,
  selected,
  onSelectPatch,
  onChanged,
  busy,
  onOpenPlaces,
}: {
  findings: Finding[];
  product: ProductDetail | null;
  itemLabel: (itemId: number | null) => string;
  contentOf: (itemId: number | null) => string | null;
  selected: Record<number, string>;
  onSelectPatch: (findingId: number, patchId: string | null) => void;
  onChanged: () => Promise<void>;
  busy: boolean;
  onOpenPlaces?: (finding: Finding) => void;
}) {
  const [filter, setFilter] = useState<FindingFilter>("ALL");
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [scheduleExpanded, setScheduleExpanded] = useState(true);
  const focused = findings.find(f => f.findingId === focusedId) ?? null;
  const focusedPatch = focused?.patches.find(p => p.patchId === selected[focused.findingId]);
  const sorted = filterFindings(findings, filter);
  return (
    <section id="audit-findings" className="audit-findings audit-anchor">
      <div className="audit-section-title"><span className="audit-step">01</span><div>
        <h2>문제를 확인하고, 수정안을 골라보세요</h2>
        <p>판단 근거를 확인한 뒤 수정안을 선택하세요. 미리보기에서 비교하고 확정해야 일정에 반영됩니다.</p>
      </div></div>
      <div className="audit-workbench">
        <CurrentSchedule product={product} finding={focused} patch={focusedPatch} expanded={scheduleExpanded} onToggle={() => setScheduleExpanded(v => !v)} hiddenItemIds={hiddenItemIdsOf(findings)} />
        <div className="audit-findings-list">
      <div className="finding-filters" role="group" aria-label="발견 항목 필터">
        {FINDING_FILTERS.map(({ value, label }) => <button key={value} type="button" aria-pressed={filter === value}
          onClick={() => setFilter(value)}>{label}<span>{filterFindings(findings, value).length}</span></button>)}
      </div>
      <p className="finding-result-count" role="status">{sorted.length}건 표시 · 수정안 {Object.keys(selected).length}개 선택됨</p>
      {sorted.length === 0 ? (
        <p className="audit-empty">{filter === "ALL" ? "발견된 문제가 없습니다." : "이 분류에 해당하는 항목이 없습니다. 다른 분류도 확인해 주세요."}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {sorted.map((f) => (
            <FindingCard
              key={f.findingId}
              finding={f}
              product={product}
              itemLabel={itemLabel}
              contentId={contentOf(f.target.itemId)}
              selectedPatchId={selected[f.findingId] ?? null}
              onOpenPlaces={onOpenPlaces}
              onFocusFinding={() => setFocusedId(f.findingId)}
              onSelectPatch={(findingId, patchId) => { setFocusedId(findingId); onSelectPatch(findingId, patchId); }}
              onChanged={onChanged}
              busy={busy}
            />
          ))}
        </ul>
      )}
        </div>
      </div>
    </section>
  );
}

function FindingCard({
  onOpenPlaces,
  onFocusFinding,
  product,
  finding,
  itemLabel,
  contentId,
  selectedPatchId,
  onSelectPatch,
  onChanged,
  busy,
}: {
  onOpenPlaces?: (finding: Finding) => void;
  onFocusFinding: () => void;
  finding: Finding;
  product: ProductDetail | null;
  itemLabel: (itemId: number | null) => string;
  contentId: string | null;
  selectedPatchId: string | null;
  onSelectPatch: (findingId: number, patchId: string | null) => void;
  onChanged: () => Promise<void>;
  busy: boolean;
}) {
  const [dismissBusy, setDismissBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 무시하려면 사유를 골라야 한다 (FR-AU-068). 무시 버튼을 누르면 사유 창을 편다.
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reasonChoice, setReasonChoice] = useState<string | null>(null);
  const [customReason, setCustomReason] = useState("");
  const meta = SEVERITY_META[finding.severity];
  // 차단은 무시할 수 없다 — 서버가 판단해 `dismissible` 로 준다 (API 설계 5-6)
  const canDismiss = finding.dismissible;
  const dismissed = finding.dismissedAt !== null;
  const hasPatches = finding.patches.length > 0 && !dismissed;

  const isCustom = reasonChoice === "__custom__";
  const finalReason = (isCustom ? customReason : (reasonChoice ?? "")).trim();

  async function confirmDismiss() {
    if (finalReason === "") return;
    setDismissBusy(true);
    setErr(null);
    try {
      await auditApi.dismissFinding(finding.findingId, finalReason);
      setDismissOpen(false);
      setReasonChoice(null);
      setCustomReason("");
      await onChanged();
    } catch (e) {
      setErr(isApiError(e) ? e.message : "처리하지 못했습니다.");
    } finally {
      setDismissBusy(false);
    }
  }

  async function undismiss() {
    setDismissBusy(true);
    setErr(null);
    try {
      await auditApi.undismissFinding(finding.findingId);
      await onChanged();
    } catch (e) {
      setErr(isApiError(e) ? e.message : "처리하지 못했습니다.");
    } finally {
      setDismissBusy(false);
    }
  }

  return (
    <li
      onFocusCapture={onFocusFinding}
      className={`finding-card rounded-xl border border-l-4 border-slate-200 p-4 dark:border-slate-800 ${meta.bar} ${
        dismissed ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* 머리는 등급 · 규칙 이름 — 규칙 번호는 근거 보기 안으로 (UI-S3-013 · CM-031) */}
          <div className="flex flex-wrap items-center gap-2">
            <GradeBadge grade={finding.severity} />
            <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{ruleName(finding.ruleCode)}</span>
            <SourceBadge source={finding.sourceBadge} externalName={finding.externalSource} />
            {dismissed && <StatusBadge status="DISMISSED" />}
          </div>
          <p className="mt-2 text-sm text-slate-800 dark:text-slate-200">{finding.message}</p>
          <p className="mt-1 text-xs text-slate-400">
            대상: {itemLabel(finding.target.itemId)}
            {finding.targetSecondary && ` ↔ ${itemLabel(finding.targetSecondary.itemId)}`}
          </p>
          {finding.requiresExternal && finding.externalSource && (
            <p className="mt-1 text-xs text-slate-400">외부 참고: {finding.externalSource}</p>
          )}
          {dismissed && finding.dismissReason && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">무시 사유: {finding.dismissReason}</p>
          )}
          <EvidencePanel contentId={contentId} view={finding.evidenceView} ruleCode={finding.ruleCode} ruleVersion={finding.ruleVersion} />
          {!dismissed && finding.severity !== "UNVERIFIED" && onOpenPlaces && placeAction(finding.ruleCode) && <button type="button" className="button-secondary mt-3"
            onClick={() => onOpenPlaces(finding)}>{placeAction(finding.ruleCode)}</button>}
          {err && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{err}</p>}
        </div>
        {canDismiss &&
          (dismissed ? (
            <button
              type="button"
              onClick={undismiss}
              disabled={dismissBusy}
              className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              무시 해제
            </button>
          ) : (
            !dismissOpen && (
              <button
                type="button"
                onClick={() => setDismissOpen(true)}
                disabled={dismissBusy}
                className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                무시
              </button>
            )
          ))}
      </div>

      {canDismiss && !dismissed && dismissOpen && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40">
          <p className="text-xs font-medium text-slate-600 dark:text-slate-300">무시 사유를 골라 주세요</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {DISMISS_REASON_PRESET.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setReasonChoice(preset)}
                className={`rounded-md border px-2 py-1 text-xs transition ${
                  reasonChoice === preset
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300"
                    : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                }`}
              >
                {preset}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setReasonChoice("__custom__")}
              className={`rounded-md border px-2 py-1 text-xs transition ${
                isCustom
                  ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300"
                  : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              기타
            </button>
          </div>
          {isCustom && (
            <input
              type="text"
              value={customReason}
              maxLength={200}
              onChange={(e) => setCustomReason(e.target.value)}
              placeholder="사유를 적어 주세요"
              className="mt-2 w-full rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
            />
          )}
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setDismissOpen(false);
                setReasonChoice(null);
                setCustomReason("");
              }}
              className="rounded-md px-2.5 py-1 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400"
            >
              취소
            </button>
            <button
              type="button"
              onClick={confirmDismiss}
              disabled={dismissBusy || finalReason === ""}
              className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              무시
            </button>
          </div>
        </div>
      )}

      {hasPatches && (
        <fieldset className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800" disabled={busy}>
          <legend className="text-xs font-medium text-slate-500 dark:text-slate-400">수정안 선택 · 미리보기 후 반영</legend>
          <div className="mt-2 space-y-1.5">
            {finding.patches.map((p) => (
              <label key={p.patchId} className={`patch-option ${selectedPatchId === p.patchId ? "is-selected" : ""}`}>
                <input
                  type="radio"
                  name={`patch-${finding.findingId}`}
                  className="mt-0.5"
                  checked={selectedPatchId === p.patchId}
                  onChange={() => onSelectPatch(finding.findingId, p.patchId)}
                />
                <PatchDescription patch={p} product={product} />
              </label>
            ))}
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-400">
              <input
                type="radio"
                name={`patch-${finding.findingId}`}
                className="mt-0.5"
                checked={selectedPatchId === null}
                onChange={() => onSelectPatch(finding.findingId, null)}
              />
              선택 안 함
            </label>
          </div>
        </fieldset>
      )}
    </li>
  );
}

function PatchBar({
  count,
  busy,
  message,
  hasPreview,
  onPreview,
  onClear,
}: {
  count: number;
  busy: "preview" | "apply" | null;
  message: string | null;
  hasPreview: boolean;
  onPreview: () => void;
  onClear: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
        <div className="text-sm text-slate-600 dark:text-slate-300">
          수정안 <strong>{count}</strong>개 선택됨
          {message && <span className="ml-3 text-rose-600 dark:text-rose-400">{message}</span>}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClear}
            disabled={busy !== null}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            선택 해제
          </button>
          <button
            type="button"
            onClick={onPreview}
            disabled={busy !== null}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
          >
            {busy === "preview" ? "미리보는 중…" : hasPreview ? "다시 미리보기" : "미리보기"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PatchPreviewPanel({
  preview,
  applying,
  progress,
  budgetBlocked,
  resumesAt,
  onApply,
  onClose,
}: {
  preview: PatchPreview;
  applying: boolean;
  progress: string | null;
  /** 확정하면 재검수가 돈다 — 예산이 다 되면 막는다 (#838) */
  budgetBlocked: boolean;
  resumesAt: string | null;
  onApply: () => void;
  onClose: () => void;
}) {
  const blocked = preview.conflict.hasConflict;
  return (
    <section className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-6 dark:border-indigo-900 dark:bg-indigo-950/20">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">수정안 미리보기</h2>
        <button type="button" onClick={onClose} className="text-sm text-slate-400 hover:text-slate-600">
          닫기
        </button>
      </div>

      {blocked && (
        <div className="mt-3 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
          <p className="font-medium">선택한 수정안 사이에 충돌이 있습니다. 하나를 해제해 주세요.</p>
          <ul className="mt-1 list-disc pl-5">
            {preview.conflict.pairs.map((c, i) => (
              <li key={i}>{c.message}</li>
            ))}
          </ul>
        </div>
      )}

      <ScheduleComparison
        before={preview.before}
        after={preview.after}
        beforeTitle="기존 일정"
        afterTitle="수정 후 일정"
        emptyText="바뀌는 일정이 없습니다."
      />

      {preview.skipped.length > 0 && (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          반영하지 못한 수정안 {preview.skipped.length}건 — {preview.skipped.map((s) => s.reason).join(" / ")}
        </p>
      )}

      {budgetBlocked && <AuditBudgetNotice resumesAt={resumesAt} className="mt-5" />}
      <div className="mt-5 flex items-center justify-end gap-3">
        {applying && <span className="text-sm text-slate-500 dark:text-slate-400">{progress ?? "재검수 중…"}</span>}
        <button
          type="button"
          onClick={onApply}
          disabled={blocked || applying || budgetBlocked}
          className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
        >
          {applying ? "확정 중…" : "확정하고 재검수"}
        </button>
      </div>
    </section>
  );
}

function UnverifiedSection({
  items,
  itemLabel,
  onChanged,
  runId,
}: {
  items: UnverifiedItem[];
  itemLabel: (itemId: number | null) => string;
  onChanged: () => Promise<void>;
  runId: number;
}) {
  return (
    <section id="audit-confirmations" className="audit-confirmations audit-anchor">
      <div className="audit-section-title"><span className="audit-step">02</span><div>
        <h2>직접 확인할 곳 <span>{items.length}건</span></h2>
        <p>정보가 부족하거나 운영기관 확인이 필요한 항목이에요. 확인 표시는 점수를 바꾸지 않습니다.</p>
      </div></div>
      {items.length === 0 && <p className="audit-empty">이번 검수에서 별도로 확인할 항목이 없습니다.</p>}
      {/* 전화로 물어볼 내용 정리 (FR-AG-020~022) */}
      {items.length > 0 && <CheckQuestionsCard runId={runId} itemLabel={itemLabel} />}
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <UnverifiedRow key={item.findingId} item={item} itemLabel={itemLabel} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  );
}

function UnverifiedRow({
  item,
  itemLabel,
  onChanged,
}: {
  item: UnverifiedItem;
  itemLabel: (itemId: number | null) => string;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const confirmed = item.confirmedAt !== null;

  async function confirm() {
    if (confirmed) return;
    setBusy(true);
    try {
      await auditApi.confirmFinding(item.findingId);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="min-w-0">
        <p className="text-sm text-slate-800 dark:text-slate-200">{item.reason}</p>
        <p className="mt-1 text-xs text-slate-400">
          대상: {item.placeLabel ?? itemLabel(item.targetItemId)}
          {item.location !== null && ` · ${item.location.dayNo}일차 ${item.location.startTime}`}
          {item.excludedFromScore && " · 감점 제외"}
        </p>
        {item.note !== null && (
          <p className="mt-1 text-xs text-slate-400">{item.note}</p>
        )}
        {/* 붙일 관광정보가 없는 줄(상품 전체 · 아직 고르지 않은 곳)은 펼쳐도 「대상 콘텐츠가 없습니다」 뿐이다 (#808) */}
        {item.contentid !== null && <EvidencePanel contentId={item.contentid} extra />}
      </div>
      <button
        type="button"
        onClick={confirm}
        disabled={busy || confirmed}
        className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        {confirmed ? "확인함" : "확인했어요"}
      </button>
    </li>
  );
}

/** itemId 를 "1일차 · 강릉 경포대" 형태로. 대상이 없으면 상품 전체 판정이다 */
/**
 * 한 번 펼친 콘텐츠는 다시 부르지 않는다 (5-12). 새로고침하면 비는 것이 맞다 —
 * 오래 들고 있으면 그건 저장이다 (DR-PR-004).
 */
const contentCache = new Map<string, ContentDetail>();

/** 항목 id → 확정된 콘텐츠 번호. 없으면 검수 제외이거나 상품 전체 판정이다 */
function contentIdOf(product: ProductDetail | null): (itemId: number | null) => string | null {
  const map = new Map<number, string | null>();
  if (product) {
    for (const day of product.days) {
      for (const it of day.items) map.set(it.itemId, it.ktoContentId);
    }
  }
  return (itemId) => (itemId === null ? null : (map.get(itemId) ?? null));
}

/**
 * 판단 근거 — 공사 원문 · AI 해석 · 판정 3단 병기 (FR-AU-013 · 061).
 *
 * **기본은 접힘이다** (UI-S3-011). 8건을 한꺼번에 펼치면 화면에 들어올 때마다 공사 호출이
 * 그만큼 나간다. 펼친 그 1건만 부른다 (5-12).
 *
 * 원문은 한 글자도 고치지 않는다. 관광지 개요는 요약·재작성하지 않으므로 애초에 받지 않는다
 * (FR-AU-062).
 */
function EvidencePanel({
  contentId,
  view,
  extra,
  ruleCode,
  ruleVersion,
}: {
  contentId: string | null;
  view?: EvidenceView;
  /** 확인 필요 목록은 문의처·홈페이지를 함께 보인다 (FR-AU-081 · 082) */
  extra?: boolean;
  /** 규칙 번호는 머리에 두지 않고 이 근거 칸 안에서만 보인다 (UI-CM-031) */
  ruleCode?: string;
  /** 그 판정을 낸 규칙의 버전 — 기능설명서의 「판정마다 규칙 버전 병기」 (#848) */
  ruleVersion?: string;
}) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<ContentDetail | null>(
    contentId === null ? null : (contentCache.get(contentId) ?? null),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ai = readNormalized(view?.aiNormalized);
  const verdict = readVerdict(view?.verdict);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || contentId === null || content !== null || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const got = await contentApi.detail(contentId);
      contentCache.set(contentId, got);
      setContent(got);
    } catch (e) {
      setErr(isApiError(e) ? e.message : EXTERNAL_UNAVAILABLE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="evidence-toggle text-xs font-medium text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
      >
        {open ? "판단 근거 접기" : "판단 근거 보기"}
      </button>

      {open && (
        <div className="mt-2 space-y-3 rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-900/60">
          {ruleCode !== undefined && <p className="text-slate-400">{ruleLine(ruleCode, ruleVersion)}</p>}
          <EvidenceBlock label="공사 원문" badge="KTO_ORIGINAL">
            {busy && <p className="text-slate-400">불러오는 중…</p>}
            {err !== null && <p className="text-slate-500 dark:text-slate-400">{err}</p>}
            {!busy && err === null && content === null && (
              <p className="text-slate-400">{contentId === null ? "대상 콘텐츠가 없습니다." : "정보 없음"}</p>
            )}
            {content !== null && content.hidden && (
              <p className="text-slate-500 dark:text-slate-400">
                공사에서 표출이 중단된 콘텐츠입니다 ({content.contentId})
              </p>
            )}
            {content !== null && !content.hidden && (
              <dl className="grid gap-1">
                {Object.entries(content.ktoRaw).map(([name, value]) => (
                  <div key={name} className="flex gap-2">
                    <dt className="shrink-0 text-slate-400">{ktoFieldLabel(name)}</dt>
                    {/* 원문 그대로 — 다듬지 않는다 */}
                    <dd className="whitespace-pre-wrap text-slate-700 dark:text-slate-200">{value || "—"}</dd>
                  </div>
                ))}
                {content.unavailableReason !== null && (
                  <p className="text-slate-400">조회하지 못했습니다 ({content.unavailableReason})</p>
                )}
              </dl>
            )}
          </EvidenceBlock>

          {/* 확인 필요 목록은 판정이 없어서 온 항목이라 2단을 그리지 않는다 */}
          {view !== undefined && (
            <>
              <EvidenceBlock label="AI 해석" badge="AI_NORMALIZED">
                {ai.length === 0 ? <p className="text-slate-400">해석 결과가 없습니다.</p> : <Rows rows={ai} />}
              </EvidenceBlock>

              <EvidenceBlock label="판정" badge="TOURLINT_VERDICT">
                {verdict.length === 0 ? <p className="text-slate-400">판정 입력값이 없습니다.</p> : <Rows rows={verdict} />}
              </EvidenceBlock>
            </>
          )}

          {extra === true && (
            <EvidenceBlock label="확인처" badge="KTO_ORIGINAL">
              <div className="grid gap-1">
                <div className="flex gap-2">
                  <span className="shrink-0 text-slate-400">문의처</span>
                  {content?.contact.tel != null && content.contact.tel !== "" ? (
                    <a className="text-indigo-600 hover:underline dark:text-indigo-400" href={`tel:${content.contact.tel}`}>
                      {content.contact.tel}
                    </a>
                  ) : (
                    <span className="text-slate-500 dark:text-slate-400">{contactText(content?.contact.tel)}</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <span className="shrink-0 text-slate-400">홈페이지</span>
                  {content?.homepageUrl != null && content.homepageUrl !== "" ? (
                    <a
                      className="truncate text-indigo-600 hover:underline dark:text-indigo-400"
                      href={content.homepageUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {content.homepageUrl}
                    </a>
                  ) : (
                    <span className="text-slate-500 dark:text-slate-400">정보 없음</span>
                  )}
                </div>
              </div>
            </EvidenceBlock>
          )}
        </div>
      )}
    </div>
  );
}

function EvidenceBlock({
  label,
  badge,
  children,
}: {
  label: string;
  badge: SourceKind;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium text-slate-600 dark:text-slate-300">{label}</span>
        <SourceBadge source={badge} externalName={null} />
      </div>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <dl className="grid gap-1">
      {rows.map((r) => (
        <div key={r.label} className="flex gap-2">
          <dt className="shrink-0 text-slate-400">{r.label}</dt>
          <dd className="text-slate-700 dark:text-slate-200">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 출시 승인 (FR-AU-042 · PM-NG-002).
 *
 * 차단이 있으면 버튼을 비활성화한다. **그것만으로는 충족하지 않아서** 서버가 403 으로
 * 한 번 더 막고 DB 트리거가 마지막으로 막는다 — 세 곳이 각각 막는다 (EX-AU-008).
 */
function ReleaseButton({
  productId,
  releasable,
  blockedReason,
  releasedAt,
}: {
  productId: number;
  releasable: boolean;
  blockedReason: string | null;
  releasedAt: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(releasedAt);
  const [err, setErr] = useState<string | null>(null);

  async function release() {
    setBusy(true);
    setErr(null);
    try {
      const r = await productApi.release(productId);
      setDone(r.releasedAt);
    } catch (e) {
      setErr(isApiError(e) ? e.message : "출시 승인을 처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  if (done !== null) {
    return (
      <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
        출시 승인됨 · {formatStamp(done)}
      </p>
    );
  }

  return (
    <div className="mt-4 flex items-center gap-3">
      <button
        type="button"
        onClick={release}
        disabled={!releasable || busy}
        title={releasable ? undefined : (blockedReason ?? "차단을 해결해야 출시할 수 있습니다.")}
        className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "처리 중…" : "출시 승인"}
      </button>
      {err !== null && <span className="text-xs text-rose-600 dark:text-rose-400">{err}</span>}
    </div>
  );
}

/**
 * 리포트 생성 (F11 · UI-S5-004 와 같은 조건).
 *
 * 종전에는 진입점이 전후 비교 화면에만 있어서 **수정안을 한 번도 반영하지 않은 상품은
 * 리포트를 만들 수 없었다** (이슈 #349). 고칠 것이 없어 패치를 안 한 상품이야말로
 * 리포트를 뽑고 싶은 대상이다.
 *
 * 조건은 화면 5 와 같다 — 차단 0건일 때만 연다. 리포트 대상은 **가장 최근 검수 실행**이라
 * 화면이 보고 있는 그 실행이 곧 대상이다 (아니면 서버가 409 로 막는다).
 */
function ReportButton({ runId, releasable }: { runId: number; releasable: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; reportId: string } | null>(null);

  /*
   * blob URL 은 이 문서가 들고 있는 동안만 유효하다. 다시 만들거나 화면을 뜨면 놓아준다 —
   * 안 놓으면 탭이 살아 있는 내내 PDF 가 메모리에 남는다.
   */
  useEffect(() => {
    if (preview === null) return undefined;
    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);

  async function generate() {
    setBusy(true);
    setErr(null);
    try {
      const { reportId } = await reportApi.generate(runId);
      // 화면 안에서 보여주려면 바이트가 필요하다. 내려받기는 아래에서 별도 링크로 건다
      const blob = await reportApi.fetchPdf(reportId);
      setPreview({ url: URL.createObjectURL(blob), reportId });
    } catch (e) {
      setErr(isApiError(e) ? e.message : "리포트를 만들지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  if (!releasable) return null;

  return (
    <>
      <button
        type="button"
        onClick={generate}
        disabled={busy}
        aria-busy={busy}
        className="rounded-lg border border-emerald-300 px-4 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-50 disabled:opacity-60 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
      >
        {busy ? "만드는 중…" : preview === null ? "리포트 생성" : "다시 만들기"}
      </button>
      {/*
        진행 상태는 부정형이다 (UI-S6-007). 몇 퍼센트인지는 만들 수 없다 — PDF 를 서버에
        못 두니(DB 명세서 6-4) 작업 행이 없고, 생성이 1초 안쪽이라 단계를 쪼개도 연출이다.
      */}
      {busy && (
        <span role="status" className="text-xs text-slate-500 dark:text-slate-400">
          리포트를 만들고 있습니다…
        </span>
      )}
      {err !== null && <span className="text-xs text-rose-600 dark:text-rose-400">{err}</span>}

      {preview !== null && (
        <div className="mt-2 w-full">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200">리포트 미리보기</h3>
            <div className="flex items-center gap-2">
              {/* 내려받기는 브라우저 내비게이션으로 — 서버가 준 한글 파일명이 그대로 붙는다 */}
              <a
                href={reportApi.downloadUrl(preview.reportId)}
                className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                내려받기
              </a>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                닫기
              </button>
            </div>
          </div>
          <object
            data={preview.url}
            type="application/pdf"
            aria-label="리포트 미리보기"
            className="mt-2 h-[70vh] w-full rounded-lg border border-slate-200 dark:border-slate-800"
          >
            <p className="p-4 text-sm text-slate-600 dark:text-slate-300">
              이 브라우저는 PDF 미리보기를 지원하지 않습니다. 내려받아 확인해 주세요.
            </p>
          </object>
        </div>
      )}
    </>
  );
}

function itemLabeler(product: ProductDetail | null): (itemId: number | null) => string {
  const map = new Map<number, string>();
  if (product) {
    for (const day of product.days) {
      for (const it of day.items) map.set(it.itemId, `${day.day}일차 · ${it.place}`);
    }
  }
  return (itemId) => (itemId === null ? "상품 전체" : (map.get(itemId) ?? `항목 #${itemId}`));
}

function formatStamp(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 검수한 뒤에 사람이 일정을 고쳤는가. 서버가 상품 상세로 알려 준다 (#710) */
export function isEditedSinceAudit(detail: ProductDetail | null): boolean {
  return detail?.auditState?.kind === "STALE" && detail.auditState.reason === "EDIT";
}

/** 첫 검수 결과를 기다리는 간격과 한도 (#711). 15곳 검수가 5 ~ 15초라 1분이면 넉넉하다 */
export const FIRST_RUN_POLL_MS = 1500;
export const FIRST_RUN_POLL_TRIES = 40;

/**
 * 검수 시작이 건 작업이 끝나 첫 결과가 생길 때까지 기다린다 (#711). 한도를 넘기면 null —
 * 그때는 지금처럼 「검수 실행」 을 보인다.
 */
export async function waitForFirstRun(
  productId: number,
  cancelled: () => boolean,
  listRuns: (id: number) => Promise<{ runs: { auditRunId: number }[] }> = auditApi.listRuns,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<number | null> {
  for (let i = 0; i < FIRST_RUN_POLL_TRIES; i += 1) {
    await wait(FIRST_RUN_POLL_MS);
    if (cancelled()) return null;
    const first = (await listRuns(productId)).runs[0];
    if (first !== undefined) return first.auditRunId;
  }
  return null;
}
