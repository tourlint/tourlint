"use client";

// 화면 3 본체 (UI-S3 · F04~F07). 요약 · finding 목록 · 확인 필요 목록을 실 검수 데이터로
// 렌더한다. 검수가 아직 없으면 실행을 걸고 진행률을 폴링한다 (EX-AU-003).
//
// 판정 문구·점수·사유는 서버가 준 값을 그대로 쓴다 — 화면이 지어내지 않는다 (FR-RU-051 · EX-SY-004).

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  auditApi,
  isApiError,
  productApi,
  type Finding,
  type ProductDetail,
  type RunSummary,
  type Severity,
  type UnverifiedItem,
} from "../../../lib/api";

const SEVERITY_META: Record<Severity, { label: string; order: number; badge: string; bar: string }> = {
  BLOCKER: {
    label: "차단",
    order: 0,
    badge: "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300",
    bar: "border-l-rose-500",
  },
  ERROR: {
    label: "오류",
    order: 1,
    badge: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300",
    bar: "border-l-orange-500",
  },
  WARNING: {
    label: "주의",
    order: 2,
    badge: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
    bar: "border-l-amber-500",
  },
  UNVERIFIED: {
    label: "확인불가",
    order: 3,
    badge: "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
    bar: "border-l-slate-400",
  },
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

  async function runAudit() {
    setRunning(true);
    setError(null);
    setProgress(null);
    try {
      const job = await auditApi.runAudit(productId, "MANUAL");
      const interval = job.pollIntervalMs ?? 1500;
      let current = job;
      // 검수는 뒤에서 돈다. auditRunId 가 채워지면 끝, errorCode 면 실패 (EX-AU-003)
      while (current.auditRunId === null && current.errorCode === undefined) {
        await sleep(interval);
        if (!alive.current) return;
        current = await auditApi.getJob(job.jobId);
        setProgress(current.progress.label);
      }
      if (current.errorCode !== undefined) {
        setError(`검수를 마치지 못했습니다 (${current.errorCode}).`);
      } else if (current.auditRunId !== null) {
        await loadRun(current.auditRunId);
      }
    } catch (err) {
      setError(isApiError(err) ? err.message : "검수 실행에 실패했습니다.");
    } finally {
      if (alive.current) {
        setRunning(false);
        setProgress(null);
      }
    }
  }

  // 무시·확정은 점수·건수를 바꾸므로 요약과 목록을 함께 다시 읽는다 (FR-AU-046)
  async function refresh() {
    if (data) await loadRun(data.run.auditRunId);
  }

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
            disabled={running}
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
      ) : data === null ? (
        <EmptyState running={running} progress={progress} onRun={runAudit} />
      ) : (
        <div className="mt-6 space-y-8">
          <SummaryCard run={data.run} />
          <FindingsSection
            findings={data.findings}
            itemLabel={itemLabeler(product)}
            onChanged={refresh}
          />
          <UnverifiedSection items={data.unverified} itemLabel={itemLabeler(product)} onChanged={refresh} />
        </div>
      )}
    </>
  );
}

function EmptyState({
  running,
  progress,
  onRun,
}: {
  running: boolean;
  progress: string | null;
  onRun: () => void;
}) {
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

function SummaryCard({ run }: { run: RunSummary }) {
  const counts: { key: Severity; n: number }[] = [
    { key: "BLOCKER", n: run.counts.blocker },
    { key: "ERROR", n: run.counts.error },
    { key: "WARNING", n: run.counts.warning },
    { key: "UNVERIFIED", n: run.counts.unverified },
  ];
  return (
    <section className="rounded-2xl border border-slate-200 p-6 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm text-slate-500 dark:text-slate-400">출시 준비도</p>
          {run.isPartial ? (
            // 부분 검수는 점수를 매기지 않는다 (DR-IN-005 · EX-AU-007)
            <span className="mt-1 inline-block rounded bg-slate-200 px-3 py-1 text-sm font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-200">
              부분 검수
            </span>
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
        <div className="flex gap-2">
          {counts.map(({ key, n }) => (
            <div
              key={key}
              className={`min-w-[64px] rounded-lg px-3 py-2 text-center ${SEVERITY_META[key].badge}`}
            >
              <div className="text-lg font-bold tabular-nums">{n}</div>
              <div className="text-xs">{SEVERITY_META[key].label}</div>
            </div>
          ))}
        </div>
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
  onChanged,
}: {
  findings: Finding[];
  itemLabel: (itemId: number | null) => string;
  onChanged: () => Promise<void>;
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
            <FindingCard key={f.findingId} finding={f} itemLabel={itemLabel} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FindingCard({
  finding,
  itemLabel,
  onChanged,
}: {
  finding: Finding;
  itemLabel: (itemId: number | null) => string;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const meta = SEVERITY_META[finding.severity];
  // 차단은 무시할 수 없다 (PM-NG-001) — 버튼을 아예 내지 않는다
  const canDismiss = finding.severity !== "BLOCKER";

  async function toggleDismiss() {
    setBusy(true);
    setErr(null);
    try {
      if (finding.dismissed) await auditApi.undismissFinding(finding.findingId);
      else await auditApi.dismissFinding(finding.findingId);
      await onChanged();
    } catch (e) {
      setErr(isApiError(e) ? e.message : "처리하지 못했습니다.");
    } finally {
      setBusy(false);
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
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${meta.badge}`}>{meta.label}</span>
            <span className="text-xs text-slate-400">{finding.ruleCode}</span>
            <SourceBadge finding={finding} />
            {finding.dismissed && (
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                무시됨
              </span>
            )}
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
            disabled={busy}
            className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {finding.dismissed ? "무시 해제" : "무시"}
          </button>
        )}
      </div>
    </li>
  );
}

function SourceBadge({ finding }: { finding: Finding }) {
  // 4종 출처 배지 중 finding 이 쓰는 둘 (FR-CM-010 · UI-CM-011)
  const isExternal = finding.sourceBadge === "EXTERNAL_REFERENCE";
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs ${
        isExternal
          ? "bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300"
          : "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
      }`}
    >
      {isExternal ? "외부 참고" : "판정"}
    </span>
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
