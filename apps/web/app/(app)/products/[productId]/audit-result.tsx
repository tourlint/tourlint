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
  isApiError,
  matchApi,
  patchApi,
  productApi,
  type ContentCandidate,
  type Finding,
  type Patch,
  type PatchItem,
  type PatchPreview,
  type PatchSelection,
  type ProductDetail,
  type ProductItem,
  type RunSummary,
  type Severity,
  type UnverifiedItem,
} from "../../../lib/api";
import { GradeBadge, GradeCounts, SourceBadge, StatusBadge } from "../../../components/badges";

const CONTENT_TYPE_LABEL: Record<number, string> = {
  12: "관광지",
  14: "문화시설",
  15: "축제",
  25: "여행코스",
  28: "레포츠",
  32: "숙박",
  38: "쇼핑",
  39: "음식점",
};

// 배지·건수·라벨은 공통 컴포넌트(components/badges)가 등급 토큰으로 그린다.
// 여기서는 finding 카드의 좌측 테두리 색과 정렬 순서만 등급별로 둔다.
const SEVERITY_META: Record<Severity, { order: number; bar: string }> = {
  BLOCKER: { order: 0, bar: "border-l-rose-500" },
  ERROR: { order: 1, bar: "border-l-orange-500" },
  WARNING: { order: 2, bar: "border-l-amber-500" },
  UNVERIFIED: { order: 3, bar: "border-l-slate-400" },
};

const ITEM_TYPE_LABEL: Record<string, string> = {
  SIGHT: "관광",
  MEAL: "식사",
  LODGING: "숙박",
  REST: "휴식",
  MOVE: "이동",
  FREE: "자유",
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
  const [progress, setProgress] = useState<string | null>(null);
  // 수정안 선택: findingId → patchId (finding 당 하나)
  const [selected, setSelected] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<PatchPreview | null>(null);
  const [patchBusy, setPatchBusy] = useState<"preview" | "apply" | null>(null);
  const [patchMsg, setPatchMsg] = useState<string | null>(null);
  const alive = useRef(true);

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
        const latest = [...runs.runs].sort((a, b) => b.executedAt.localeCompare(a.executedAt))[0];
        if (latest) await loadRun(latest.auditRunId);
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
    try {
      const job = await auditApi.runAudit(productId, "MANUAL");
      const runId = await pollJob(job.jobId);
      if (runId !== null) {
        resetPatchState();
        await loadRun(runId);
      }
    } catch (err) {
      setError(isApiError(err) ? err.message : err instanceof Error ? err.message : "검수 실행에 실패했습니다.");
    } finally {
      if (alive.current) {
        setRunning(false);
        setProgress(null);
      }
    }
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
    try {
      const applied = await patchApi.apply(productId, selections(), preview.previewToken);
      const runId = await pollJob(applied.reauditJobId);
      if (runId !== null) {
        resetPatchState();
        await loadRun(runId);
      }
    } catch (err) {
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

  async function refresh() {
    if (data) await loadRun(data.run.auditRunId);
  }

  const labelOf = itemLabeler(product);
  const selectedCount = Object.keys(selected).length;
  const pendingItems: ProductItem[] = product
    ? product.days.flatMap((d) => d.items).filter((it) => it.matchStatus === "PENDING")
    : [];

  return (
    <>
      <nav className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        <Link href="/" className="hover:underline">
          대시보드
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-700 dark:text-slate-300">{product?.name ?? `상품 #${productId}`}</span>
      </nav>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">검수 결과</h1>
          {product && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {product.name} · {[product.region.regnName, product.region.signguName].filter(Boolean).join(" ")} ·{" "}
              {product.startDate}
            </p>
          )}
        </div>
        {data && (
          <button
            type="button"
            onClick={runAudit}
            disabled={running || patchBusy !== null}
            className="shrink-0 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {running ? "검수 중…" : "지금 재검수"}
          </button>
        )}
      </div>

      {loading ? (
        <p className="mt-8 text-sm text-slate-400">불러오는 중…</p>
      ) : error ? (
        <div className="mt-8 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
          {error}
        </div>
      ) : product && pendingItems.length > 0 ? (
        <MatchStage product={product} items={pendingItems} onResolved={refetchProduct} />
      ) : data === null ? (
        <EmptyState running={running} progress={progress} onRun={runAudit} />
      ) : (
        <div className="mt-6 space-y-8 pb-28">
          <SummaryCard run={data.run} />
          <FindingsSection
            findings={data.findings}
            itemLabel={labelOf}
            selected={selected}
            onSelectPatch={selectPatch}
            onChanged={refresh}
            busy={patchBusy !== null || running}
          />
          <UnverifiedSection items={data.unverified} itemLabel={labelOf} onChanged={refresh} />

          {preview && (
            <PatchPreviewPanel
              preview={preview}
              applying={patchBusy === "apply"}
              progress={progress}
              onApply={doApply}
              onClose={() => setPreview(null)}
            />
          )}
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
    </>
  );
}

function EmptyState({ running, progress, onRun }: { running: boolean; progress: string | null; onRun: () => void }) {
  return (
    <div className="mt-10 rounded-2xl border border-dashed border-slate-300 py-16 text-center dark:border-slate-700">
      <p className="text-sm text-slate-500 dark:text-slate-400">아직 검수하지 않았습니다.</p>
      {running ? (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">{progress ?? "검수를 시작하는 중…"}</p>
      ) : (
        <button
          type="button"
          onClick={onRun}
          className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
        >
          검수 실행
        </button>
      )}
    </div>
  );
}

function MatchStage({
  product,
  items,
  onResolved,
}: {
  product: ProductDetail;
  items: ProductItem[];
  onResolved: () => Promise<void>;
}) {
  return (
    <div className="mt-6 space-y-4 pb-10">
      <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        관광지 <strong>{items.length}</strong>곳을 확정해야 검수할 수 있습니다. 장소마다 공사 콘텐츠를 선택하거나 검수에서 제외하세요.
      </div>
      <ul className="space-y-3">
        {items.map((it) => (
          <MatchItemRow
            key={it.itemId}
            item={it}
            regnCd={product.ldongRegnCd}
            signguCd={product.ldongSignguCd}
            onResolved={onResolved}
          />
        ))}
      </ul>
    </div>
  );
}

function MatchItemRow({
  item,
  regnCd,
  signguCd,
  onResolved,
}: {
  item: ProductItem;
  regnCd: string;
  signguCd: string | null;
  onResolved: () => Promise<void>;
}) {
  const [keyword, setKeyword] = useState(item.place);
  const [candidates, setCandidates] = useState<ContentCandidate[] | null>(null);
  const [regionFilter, setRegionFilter] = useState(true);
  const [searching, setSearching] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function runSearch(kw: string, useRegion: boolean) {
    setSearching(true);
    setErr(null);
    try {
      const res = await matchApi.search(kw, useRegion ? regnCd : null, useRegion ? signguCd : null);
      setCandidates(res.candidates);
    } catch (e) {
      setErr(isApiError(e) ? e.message : "검색에 실패했습니다.");
    } finally {
      setSearching(false);
    }
  }

  // 장소명으로 1회 자동 검색. setState 는 await 뒤에서만 (effect 안 동기 setState 금지)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await matchApi.search(item.place, regnCd, signguCd);
        if (!cancelled) setCandidates(res.candidates);
      } catch {
        if (!cancelled) setCandidates([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.place, regnCd, signguCd]);

  async function confirm(contentid: string) {
    setBusy(true);
    setErr(null);
    try {
      await matchApi.match(item.itemId, contentid);
      await onResolved();
    } catch (e) {
      setErr(isApiError(e) ? e.message : "확정에 실패했습니다.");
      setBusy(false);
    }
  }

  async function exclude() {
    setBusy(true);
    setErr(null);
    try {
      await matchApi.exclude(item.itemId);
      await onResolved();
    } catch (e) {
      setErr(isApiError(e) ? e.message : "제외에 실패했습니다.");
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{item.place}</span>
          <span className="ml-2 text-xs text-slate-400">
            {item.start}
            {item.end ? `~${item.end}` : ""} · {ITEM_TYPE_LABEL[item.itemType] ?? item.itemType}
          </span>
        </div>
        <button
          type="button"
          onClick={exclude}
          disabled={busy}
          className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          검수 제외
        </button>
      </div>

      <div className="mt-3 flex gap-2">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch(keyword, regionFilter);
          }}
          placeholder="장소명으로 검색"
          className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
        <button
          type="button"
          onClick={() => void runSearch(keyword, regionFilter)}
          disabled={searching}
          className="rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-200 disabled:opacity-60 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          {searching ? "검색 중…" : "검색"}
        </button>
      </div>
      <label className="mt-1.5 flex w-fit cursor-pointer items-center gap-1.5 text-xs text-slate-400">
        <input
          type="checkbox"
          checked={regionFilter}
          onChange={(e) => {
            setRegionFilter(e.target.checked);
            void runSearch(keyword, e.target.checked);
          }}
        />
        이 상품 지역으로 좁히기
      </label>

      {err && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{err}</p>}

      {candidates &&
        (candidates.length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">검색 결과가 없습니다. 검색어를 바꾸거나 검수에서 제외하세요.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {candidates.map((c) => (
              <li
                key={c.contentid}
                className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/50"
              >
                <div className="min-w-0">
                  <span className="text-sm text-slate-800 dark:text-slate-100">{c.title}</span>
                  {c.contenttypeid !== null && (
                    <span className="ml-2 text-xs text-slate-400">{CONTENT_TYPE_LABEL[c.contenttypeid] ?? ""}</span>
                  )}
                  {c.addr1 && <p className="truncate text-xs text-slate-400">{c.addr1}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => void confirm(c.contentid)}
                  disabled={busy}
                  className="shrink-0 rounded-md bg-indigo-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
                >
                  확정
                </button>
              </li>
            ))}
          </ul>
        ))}
    </li>
  );
}

function SummaryCard({ run }: { run: RunSummary }) {
  return (
    <section className="rounded-2xl border border-slate-200 p-6 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm text-slate-500 dark:text-slate-400">출시 준비도</p>
          {run.isPartial ? (
            <StatusBadge status="PARTIAL" className="mt-1" />
          ) : (
            <p className="mt-1 text-3xl font-bold text-slate-900 dark:text-slate-50">
              {run.readinessScore ?? "-"}
              <span className="ml-1 text-base font-normal text-slate-400">점</span>
            </p>
          )}
          {!run.isPartial && run.scoreBreakdown.formula && (
            <p className="mt-1 font-mono text-xs text-slate-400">{run.scoreBreakdown.formula}</p>
          )}
        </div>
        <GradeCounts counts={run.counts} variant="tile" />
      </div>

      {!run.releasable && run.releaseBlockedReason && (
        <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
          출시 불가 — {run.releaseBlockedReason}
        </p>
      )}

      <dl className="mt-4 grid gap-1 border-t border-slate-100 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        <div className="flex gap-2">
          <dt>규칙셋</dt>
          <dd className="text-slate-600 dark:text-slate-300">{run.evidence.rulesetVersion}</dd>
          <dt className="ml-3">조회 시각</dt>
          <dd className="text-slate-600 dark:text-slate-300">{formatStamp(run.evidence.fetchedAt)}</dd>
        </div>
        <p className="mt-1">{run.evidence.delayNotice}</p>
        <p>{run.evidence.source}</p>
      </dl>
    </section>
  );
}

function FindingsSection({
  findings,
  itemLabel,
  selected,
  onSelectPatch,
  onChanged,
  busy,
}: {
  findings: Finding[];
  itemLabel: (itemId: number | null) => string;
  selected: Record<number, string>;
  onSelectPatch: (findingId: number, patchId: string | null) => void;
  onChanged: () => Promise<void>;
  busy: boolean;
}) {
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_META[a.severity].order - SEVERITY_META[b.severity].order || a.findingId - b.findingId,
  );
  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
        발견 항목 <span className="text-slate-400">{findings.length}</span>
      </h2>
      {sorted.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">발견된 문제가 없습니다.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {sorted.map((f) => (
            <FindingCard
              key={f.findingId}
              finding={f}
              itemLabel={itemLabel}
              selectedPatchId={selected[f.findingId] ?? null}
              onSelectPatch={onSelectPatch}
              onChanged={onChanged}
              busy={busy}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function FindingCard({
  finding,
  itemLabel,
  selectedPatchId,
  onSelectPatch,
  onChanged,
  busy,
}: {
  finding: Finding;
  itemLabel: (itemId: number | null) => string;
  selectedPatchId: string | null;
  onSelectPatch: (findingId: number, patchId: string | null) => void;
  onChanged: () => Promise<void>;
  busy: boolean;
}) {
  const [dismissBusy, setDismissBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const meta = SEVERITY_META[finding.severity];
  const canDismiss = finding.severity !== "BLOCKER";
  const hasPatches = finding.patches.length > 0 && !finding.dismissed;

  async function toggleDismiss() {
    setDismissBusy(true);
    setErr(null);
    try {
      if (finding.dismissed) await auditApi.undismissFinding(finding.findingId);
      else await auditApi.dismissFinding(finding.findingId);
      await onChanged();
    } catch (e) {
      setErr(isApiError(e) ? e.message : "처리하지 못했습니다.");
    } finally {
      setDismissBusy(false);
    }
  }

  return (
    <li
      className={`rounded-xl border border-l-4 border-slate-200 p-4 dark:border-slate-800 ${meta.bar} ${
        finding.dismissed ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <GradeBadge grade={finding.severity} />
            <span className="text-xs text-slate-400">{finding.ruleCode}</span>
            <SourceBadge source={finding.sourceBadge} externalName={finding.externalSource} />
            {finding.dismissed && <StatusBadge status="DISMISSED" />}
          </div>
          <p className="mt-2 text-sm text-slate-800 dark:text-slate-200">{finding.message}</p>
          <p className="mt-1 text-xs text-slate-400">
            대상: {itemLabel(finding.target.itemId)}
            {finding.targetSecondary && ` ↔ ${itemLabel(finding.targetSecondary.itemId)}`}
          </p>
          {finding.requiresExternal && finding.externalSource && (
            <p className="mt-1 text-xs text-slate-400">외부 참고: {finding.externalSource}</p>
          )}
          {err && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{err}</p>}
        </div>
        {canDismiss && (
          <button
            type="button"
            onClick={toggleDismiss}
            disabled={dismissBusy}
            className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {finding.dismissed ? "무시 해제" : "무시"}
          </button>
        )}
      </div>

      {hasPatches && (
        <fieldset className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800" disabled={busy}>
          <legend className="text-xs font-medium text-slate-500 dark:text-slate-400">수정안 (골라서 미리보기)</legend>
          <div className="mt-2 space-y-1.5">
            {finding.patches.map((p) => (
              <label key={p.patchId} className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="radio"
                  name={`patch-${finding.findingId}`}
                  className="mt-0.5"
                  checked={selectedPatchId === p.patchId}
                  onChange={() => onSelectPatch(finding.findingId, p.patchId)}
                />
                <span className="text-slate-700 dark:text-slate-300">{patchLabel(p, itemLabel)}</span>
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
  onApply,
  onClose,
}: {
  preview: PatchPreview;
  applying: boolean;
  progress: string | null;
  onApply: () => void;
  onClose: () => void;
}) {
  const cmp = compareSchedules(preview.before, preview.after);
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

      {!cmp.anyChange && (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">바뀌는 일정이 없습니다.</p>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <ScheduleColumn title="기존 일정" days={groupByDay(preview.before)} statusOf={(id) => cmp.beforeStatus.get(id) ?? "same"} />
        <ScheduleColumn title="수정 후 일정" days={groupByDay(preview.after)} statusOf={(id) => cmp.afterStatus.get(id) ?? "same"} />
      </div>

      <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-amber-300" />변경</span>
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-300" />추가</span>
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-rose-300" />제거</span>
      </div>

      {preview.skipped.length > 0 && (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          반영하지 못한 수정안 {preview.skipped.length}건 — {preview.skipped.map((s) => s.reason).join(" / ")}
        </p>
      )}

      <div className="mt-5 flex items-center justify-end gap-3">
        {applying && <span className="text-sm text-slate-500 dark:text-slate-400">{progress ?? "재검수 중…"}</span>}
        <button
          type="button"
          onClick={onApply}
          disabled={blocked || applying}
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
}: {
  items: UnverifiedItem[];
  itemLabel: (itemId: number | null) => string;
  onChanged: () => Promise<void>;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
        확인 필요 <span className="text-slate-400">{items.length}</span>
      </h2>
      <p className="mt-1 text-xs text-slate-400">
        정보가 없어 판정하지 못한 항목입니다. 운영기관에 확인한 뒤 체크하세요.
      </p>
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
          대상: {itemLabel(item.targetItemId)}
          {item.excludedFromScore && " · 감점 제외(출발 전 확인)"}
        </p>
      </div>
      <button
        type="button"
        onClick={confirm}
        disabled={busy || confirmed}
        className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        {confirmed ? "확인함" : "확인"}
      </button>
    </li>
  );
}

/**
 * 「~으로 / ~로」 조사를 붙인다.
 *
 * 관광지 이름은 공사 원문이라 무엇이 올지 모른다. 받침이 있으면 `으로`, 없거나 ㄹ 받침이면
 * `로` 다 — 「자료 동읫 로 대체」처럼 어색하게 보이지 않게 한다.
 */
function euro(name: string): string {
  const last = name.trim().slice(-1);
  const code = last.charCodeAt(0);
  // 한글 음절이 아니면 판단할 근거가 없다. 안전한 쪽(로)으로 둔다
  if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) return "로";
  const jong = (code - 0xac00) % 28;
  return jong === 0 || jong === 8 ? "로" : "으로";
}

/** 수정안 표시 문구를 payload·대상 항목으로 조합한다 — 서버는 문구를 저장하지 않는다 (DR-PR-001) */
function patchLabel(patch: Patch, itemLabel: (itemId: number | null) => string): string {
  const p = patch.payload;
  switch (patch.type) {
    case "TIME_SHIFT": {
      const parts: string[] = [];
      if (p.newDayNo !== undefined) parts.push(`${p.newDayNo}일차로 이동`);
      if (p.newStartTime !== undefined || p.newEndTime !== undefined) {
        parts.push(`${p.newStartTime ?? "그대로"}~${p.newEndTime ?? "그대로"} 로 시간 조정`);
      }
      return parts.length > 0 ? parts.join(" · ") : "시간 조정";
    }
    case "REORDER":
      return `${itemLabel(patch.targetItemId)} ↔ ${itemLabel(p.swapWithItemId ?? null)} 순서 바꾸기`;
    case "REPLACE_CONTENT": {
      // 이름은 서버가 표시 시점에 조회해 실어 준다. 없으면 거리로만 안내한다
      const near = p.distanceMeters !== undefined
        ? ` (약 ${Math.round(p.distanceMeters / 100) / 10}km)`
        : "";
      return patch.placeName !== undefined
        ? `${patch.placeName}${euro(patch.placeName)} 대체${near}`
        : `가까운 다른 관광지로 대체${near}`;
    }
    case "INSERT_ITEM": {
      const what = patch.placeName ?? ITEM_TYPE_LABEL[p.itemType ?? ""] ?? "항목";
      return `${p.dayNo}일차에 ${what} 추가 (${p.startTime ?? ""}~${p.endTime ?? ""})`;
    }
    case "REMOVE_ITEM":
      return "일정에서 제거";
    default:
      return "수정안";
  }
}

type ChangeStatus = "same" | "changed" | "added" | "removed";

interface DayGroup {
  day: number;
  items: PatchItem[];
}

/** 항목의 상태를 정하는 지문 — 하나라도 다르면 '변경'으로 본다 */
function signature(it: PatchItem): string {
  return `${it.dayNo}|${it.seq}|${it.startTime}|${it.endTime ?? ""}|${it.itemType}|${it.placeLabel}`;
}

/** 좌(기존)·우(수정 후) 각 항목의 상태를 id 기준으로 계산한다 */
function compareSchedules(
  before: PatchItem[],
  after: PatchItem[],
): { beforeStatus: Map<number, ChangeStatus>; afterStatus: Map<number, ChangeStatus>; anyChange: boolean } {
  const beforeById = new Map(before.map((it) => [it.id, it]));
  const afterById = new Map(after.map((it) => [it.id, it]));
  const beforeStatus = new Map<number, ChangeStatus>();
  const afterStatus = new Map<number, ChangeStatus>();
  let anyChange = false;

  for (const it of before) {
    const a = afterById.get(it.id);
    if (a === undefined) {
      beforeStatus.set(it.id, "removed");
      anyChange = true;
    } else if (signature(it) !== signature(a)) {
      beforeStatus.set(it.id, "changed");
      anyChange = true;
    } else {
      beforeStatus.set(it.id, "same");
    }
  }
  for (const it of after) {
    const b = beforeById.get(it.id);
    if (b === undefined) {
      afterStatus.set(it.id, "added");
      anyChange = true;
    } else if (signature(it) !== signature(b)) {
      afterStatus.set(it.id, "changed");
    } else {
      afterStatus.set(it.id, "same");
    }
  }
  return { beforeStatus, afterStatus, anyChange };
}

/** 항목을 일차별로 묶고 seq 로 정렬한다 */
function groupByDay(items: PatchItem[]): DayGroup[] {
  const byDay = new Map<number, PatchItem[]>();
  for (const it of items) {
    const list = byDay.get(it.dayNo) ?? [];
    list.push(it);
    byDay.set(it.dayNo, list);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, list]) => ({ day, items: [...list].sort((a, b) => a.seq - b.seq) }));
}

const STATUS_ROW: Record<ChangeStatus, string> = {
  same: "border-slate-200 dark:border-slate-800",
  changed: "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30",
  added: "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30",
  removed: "border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/30",
};

/** 한쪽 일정 전체를 일차별로 그린다. 변경/추가/제거 항목은 색으로 강조한다 */
function ScheduleColumn({
  title,
  days,
  statusOf,
}: {
  title: string;
  days: DayGroup[];
  statusOf: (itemId: number) => ChangeStatus;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h3>
      <div className="mt-3 space-y-4">
        {days.map((d) => (
          <div key={d.day}>
            <p className="text-xs font-medium text-slate-400">{d.day}일차</p>
            <ul className="mt-1.5 space-y-1.5">
              {d.items.map((it) => {
                const status = statusOf(it.id);
                return (
                  <li
                    key={it.id}
                    className={`rounded-lg border px-3 py-2 text-sm ${STATUS_ROW[status]} ${
                      status === "removed" ? "line-through opacity-70" : ""
                    }`}
                  >
                    <span className="tabular-nums text-slate-500 dark:text-slate-400">
                      {it.startTime}
                      {it.endTime ? `~${it.endTime}` : ""}
                    </span>
                    <span className="ml-2 text-slate-800 dark:text-slate-100">{it.placeLabel}</span>
                    <span className="ml-2 text-xs text-slate-400">{ITEM_TYPE_LABEL[it.itemType] ?? it.itemType}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/** itemId 를 "1일차 · 강릉 경포대" 형태로. 대상이 없으면 상품 전체 판정이다 */
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
