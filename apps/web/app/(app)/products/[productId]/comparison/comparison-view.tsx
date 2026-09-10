"use client";

// UI-S5 본체. 직전 패치의 전후를 9개 지표로 대조하고(FR-PA-040), 총 감점은 계산식과
// 함께 보여 검산 가능하게 한다(UI-S5-002). 점수가 내려갔으면 경고 배너와 되돌리기를,
// 차단이 0 이 되면 출시 가능 상태와 리포트 생성 진입점을 준다(UI-S5-004·005).

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  comparisonApi,
  isApiError,
  patchApi,
  reportApi,
  type ComparisonMetric,
  type ComparisonResult,
} from "../../../../lib/api";
import { SourceBadge } from "../../../../components/badges";
import { AuditBasis, basisRows } from "../../../../components/audit-basis";

// 대부분의 지표는 낮을수록 좋다. 출시 준비도만 반대다.
const HIGHER_BETTER = new Set(["readinessScore"]);

export function ComparisonView({ productId }: { productId: number }) {
  const router = useRouter();
  const [data, setData] = useState<ComparisonResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [undoConfirm, setUndoConfirm] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await comparisonApi.get(productId);
        if (alive) setData(res);
      } catch (err) {
        if (isApiError(err) && err.status === 401) {
          router.replace("/login");
          return;
        }
        // 수정 이력이 없거나 재검수가 안 끝났으면 서버가 404 문구를 준다 — 그대로 안내한다
        if (alive) setError(isApiError(err) ? err.message : "비교를 불러오지 못했습니다.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [productId, router]);

  async function doRevert() {
    if (data === null) return;
    setUndoBusy(true);
    setActionMsg(null);
    try {
      await patchApi.revert(data.patchApplicationId);
      // 되돌리면 비교 대상이 사라진다 — 검수 결과로 돌아간다
      router.push(`/products/${productId}`);
    } catch (err) {
      setActionMsg(isApiError(err) ? err.message : "되돌리기에 실패했습니다.");
      setUndoBusy(false);
    }
  }

  async function generateReport(runId: number) {
    setReportBusy(true);
    setActionMsg(null);
    try {
      const { reportId } = await reportApi.generate(runId);
      // 다운로드는 브라우저 내비게이션으로 — 쿠키가 실려 PDF 를 그대로 받는다
      window.location.href = reportApi.downloadUrl(reportId);
    } catch (err) {
      setActionMsg(isApiError(err) ? err.message : "리포트를 만들지 못했습니다.");
    } finally {
      setReportBusy(false);
    }
  }

  const blockerAfter = data?.metrics.find((m) => m.key === "blocker")?.after ?? null;
  const releasable = blockerAfter === 0;

  return (
    <>
      <nav className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        <Link href="/" className="hover:underline">
          대시보드
        </Link>
        <span className="mx-2">/</span>
        <Link href={`/products/${productId}`} className="hover:underline">
          검수 결과
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-700 dark:text-slate-300">수정 전후 비교</span>
      </nav>

      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">수정 전후 비교</h1>

      {loading ? (
        <p className="mt-8 text-sm text-slate-400">불러오는 중…</p>
      ) : error || data === null ? (
        <div className="mt-8 rounded-2xl border border-dashed border-slate-300 py-14 text-center dark:border-slate-700">
          <p className="text-sm text-slate-500 dark:text-slate-400">{error ?? "비교할 내용이 없습니다."}</p>
          <Link
            href={`/products/${productId}`}
            className="mt-4 inline-block rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            검수 결과로
          </Link>
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            반영 전 {formatStamp(data.before.executedAt)} · 반영 후 {formatStamp(data.after.executedAt)}
          </p>

          {/* 경고 배너 + 되돌리기 (UI-S5-005). 자동 롤백하지 않는다. */}
          {data.warningBanner && (
            <section className="rounded-2xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-800 dark:bg-amber-950/30">
              <p className="text-sm text-slate-800 dark:text-slate-200">{data.warningBanner}</p>
              {actionMsg && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{actionMsg}</p>}
              {data.revertible && (
                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                  {undoConfirm ? (
                    <>
                      <span className="mr-auto text-xs text-slate-500 dark:text-slate-400">
                        반영 전 일정으로 되돌립니다. 계속할까요?
                      </span>
                      <button
                        type="button"
                        onClick={() => setUndoConfirm(false)}
                        disabled={undoBusy}
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                      >
                        취소
                      </button>
                      <button
                        type="button"
                        onClick={doRevert}
                        disabled={undoBusy}
                        className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-500 disabled:opacity-60"
                      >
                        {undoBusy ? "되돌리는 중…" : "되돌리기"}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setUndoConfirm(true)}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      되돌리기
                    </button>
                  )}
                </div>
              )}
            </section>
          )}

          {/* 차단 0 → 출시 가능 + 리포트 진입점 (UI-S5-004) */}
          {releasable && (
            <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-300 bg-emerald-50/60 p-5 dark:border-emerald-800 dark:bg-emerald-950/20">
              <div>
                <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">출시 가능</p>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">차단 항목이 없습니다. 리포트를 만들 수 있습니다.</p>
                {actionMsg && !data.warningBanner && (
                  <p className="mt-1 text-sm text-rose-600 dark:text-rose-400">{actionMsg}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => generateReport(data.after.auditRunId)}
                disabled={reportBusy}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-60"
              >
                {reportBusy ? "만드는 중…" : "리포트 생성"}
              </button>
            </section>
          )}

          <MetricTable metrics={data.metrics} />

          <AuditBasis
            rows={basisRows(data.evidence)}
            notice={data.evidence.delayNotice}
            source={data.evidence.source}
          />
        </div>
      )}
    </>
  );
}

function MetricTable({ metrics }: { metrics: ComparisonMetric[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <th className="p-3 font-medium">지표</th>
            <th className="p-3 font-medium">반영 전</th>
            <th className="p-3 font-medium">반영 후</th>
            <th className="p-3 font-medium">변화</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((m) => (
            <MetricRow key={m.key} metric={m} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetricRow({ metric: m }: { metric: ComparisonMetric }) {
  const isText = m.beforeText !== undefined || m.afterText !== undefined;
  return (
    <tr className="border-b border-slate-100 align-top dark:border-slate-800/60">
      <td className="p-3">
        <span className="text-slate-700 dark:text-slate-200">{m.label}</span>
        {m.externalSource && (
          <span className="ml-2 inline-block align-middle">
            <SourceBadge source="EXTERNAL_REFERENCE" externalName={m.externalSource} />
          </span>
        )}
        {/* 총 감점은 계산식을 함께 노출해 검산 가능하게 한다 (UI-S5-002) */}
        {(m.formulaBefore || m.formulaAfter) && (
          <p className="mt-1 font-mono text-xs text-slate-400">
            {m.formulaBefore ?? "-"} → {m.formulaAfter ?? "-"}
          </p>
        )}
      </td>
      {isText ? (
        <>
          <td className="p-3 text-slate-600 dark:text-slate-300">{m.beforeText ?? "-"}</td>
          <td className="p-3 text-slate-600 dark:text-slate-300">{m.afterText ?? "-"}</td>
          <td className="p-3 text-slate-400">-</td>
        </>
      ) : (
        <>
          <td className="p-3 tabular-nums text-slate-600 dark:text-slate-300">{fmt(m.before)}</td>
          <td className="p-3 tabular-nums font-medium text-slate-900 dark:text-slate-100">{fmt(m.after)}</td>
          <td className="p-3">
            <Delta metric={m} />
          </td>
        </>
      )}
    </tr>
  );
}

function Delta({ metric: m }: { metric: ComparisonMetric }) {
  if (m.before == null || m.after == null) return <span className="text-slate-400">-</span>;
  const diff = m.after - m.before;
  if (diff === 0) return <span className="text-slate-400 tabular-nums">변화 없음</span>;
  const higherBetter = HIGHER_BETTER.has(m.key);
  const good = higherBetter ? diff > 0 : diff < 0;
  const cls = good
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  return (
    <span className={`tabular-nums font-medium ${cls}`}>
      {diff > 0 ? "▲" : "▼"} {Math.abs(diff)}
    </span>
  );
}

function fmt(v: number | null | undefined): string {
  return v == null ? "-" : String(v);
}

function formatStamp(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}
