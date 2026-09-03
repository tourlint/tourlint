"use client";

// 화면 7 · 수요 · 변경 레이더 (UI-S7 · FR-MO-050~058). 배치가 쌓아 둔 위험 · 기회
// 알림과 수요 신호(T1 · T2)를 읽어 보여 준다. 이 화면에서 일정을 직접 바꾸지 않는다 —
// 반영은 수정안(패치) 흐름을 경유한다 (UI-S7-009). 판매량 · 흥행 · 예측을 말하지 않는다
// (UI-S7-011).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  isApiError,
  notificationApi,
  radarApi,
  type DemandSignal,
  type NotificationKind,
  type RadarNotification,
  type RadarSignals,
  type RadarSummary,
} from "../../lib/api";
import { StatusBadge } from "../../components/badges";

interface ProductLite {
  productId: number;
  name: string;
  region?: { regnName?: string; signguName?: string };
}

// 공사 콘텐츠 유형 코드 → 라벨. 신호 유형 분포(byType)에 쓴다.
const CONTENT_TYPE_LABEL: Record<string, string> = {
  "12": "관광지",
  "14": "문화시설",
  "15": "축제",
  "25": "여행코스",
  "28": "레포츠",
  "32": "숙박",
  "38": "쇼핑",
  "39": "음식점",
};

export default function RadarPage() {
  const router = useRouter();
  const [summary, setSummary] = useState<RadarSummary | null>(null);
  const [tab, setTab] = useState<NotificationKind>("RISK");
  const [items, setItems] = useState<RadarNotification[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [error, setError] = useState<string | null>(null);

  const onAuthError = useCallback(
    (err: unknown) => {
      if (isApiError(err) && err.status === 401) {
        router.replace("/login");
        return true;
      }
      return false;
    },
    [router],
  );

  // 요약 · 상품 목록은 진입 시 한 번.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [s, res] = await Promise.all([
          radarApi.summary(),
          fetch("/api/v1/products", { credentials: "include" }),
        ]);
        if (!alive) return;
        setSummary(s);
        if (res.ok) {
          const json = (await res.json()) as { content?: ProductLite[] };
          if (alive) setProducts(json.content ?? []);
        }
      } catch (err) {
        if (!onAuthError(err)) setError(isApiError(err) ? err.message : "레이더를 불러오지 못했습니다.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [onAuthError]);

  // 탭이 바뀌면 그 종류의 알림을 다시 읽는다.
  useEffect(() => {
    let alive = true;
    void (async () => {
      setListLoading(true);
      try {
        const page = await notificationApi.list(tab);
        if (alive) setItems(page.content);
      } catch (err) {
        if (!onAuthError(err) && alive) setError(isApiError(err) ? err.message : "알림을 불러오지 못했습니다.");
      } finally {
        if (alive) setListLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tab, onAuthError]);

  async function refreshSummary() {
    try {
      setSummary(await radarApi.summary());
    } catch {
      // 요약 갱신 실패는 조용히 둔다 — 목록은 이미 최신이다
    }
  }

  async function dismiss(id: number) {
    setItems((prev) => prev.filter((n) => n.notificationId !== id));
    try {
      await notificationApi.dismiss(id);
      await refreshSummary();
    } catch (err) {
      if (!onAuthError(err)) setError(isApiError(err) ? err.message : "무시 처리에 실패했습니다.");
    }
  }

  const batch = summary?.lastBatch ?? null;

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">수요 · 변경 레이더</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            관광정보 변경과 수요 신호를 감시합니다. 반영은 수정안에서 합니다.
          </p>
        </div>
        {/* 마지막 배치 실행 시각 · 처리 기준일 (UI-S7-010) */}
        <div className="shrink-0 text-right text-xs text-slate-500 dark:text-slate-400">
          <p>마지막 배치 {batch?.runAt ? formatStamp(batch.runAt) : "—"}</p>
          <p>처리 기준일 {batch?.covered ?? "—"}</p>
        </div>
      </div>

      {error && (
        <div className="mt-6 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
          {error}
        </div>
      )}

      {/* 위험 · 기회 탭 (UI-S7-001). 검수 등급 색 마커를 쓰지 않는다. */}
      <div className="mt-6 flex gap-2 border-b border-slate-200 dark:border-slate-800">
        <TabButton active={tab === "RISK"} onClick={() => setTab("RISK")} label="위험" count={summary?.risk} />
        <TabButton
          active={tab === "OPPORTUNITY"}
          onClick={() => setTab("OPPORTUNITY")}
          label="기회"
          count={summary?.opportunity}
        />
      </div>

      {listLoading ? (
        <p className="mt-8 text-sm text-slate-400">불러오는 중…</p>
      ) : items.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed border-slate-300 py-14 text-center text-sm text-slate-400 dark:border-slate-700 dark:text-slate-500">
          {tab === "RISK" ? "위험 알림이 없습니다." : "기회 알림이 없습니다."}
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((n) => (
            <NotificationCard key={n.notificationId} notification={n} onDismiss={() => dismiss(n.notificationId)} />
          ))}
        </ul>
      )}

      <DemandSignalSection products={products} onAuthError={onAuthError} />
    </>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
        active
          ? "border-slate-800 text-slate-900 dark:border-slate-200 dark:text-slate-100"
          : "border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
      }`}
    >
      {label}
      {count !== undefined && <span className="ml-1.5 tabular-nums text-slate-400">{count}</span>}
    </button>
  );
}

// 위험 · 기회 텍스트 배지. 검수 등급(적·주황·황·회) 색을 재사용하지 않는다 (UI-S7-001).
function KindBadge({ kind }: { kind: NotificationKind }) {
  const risk = kind === "RISK";
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
        risk
          ? "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950/50 dark:text-fuchsia-300"
          : "bg-teal-100 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300"
      }`}
    >
      {risk ? "위험" : "기회"}
    </span>
  );
}

function NotificationCard({ notification: n, onDismiss }: { notification: RadarNotification; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const hasFingerprint = n.fingerprint.from !== null && n.fingerprint.to !== null;

  async function handleDismiss() {
    setBusy(true);
    await onDismiss();
  }

  return (
    <li className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-2">
        <KindBadge kind={n.kind} />
        {/* 비표출 전환 콘텐츠 (show_flag=0) — 상태 배지 재사용 (UI-CM-013) */}
        {n.hidden && <StatusBadge status="DISPLAY_STOPPED" />}
        <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{n.productName}</span>
        <span className="text-xs text-slate-400">{n.startDate} 출발</span>
      </div>

      <p className="mt-2 text-sm text-slate-800 dark:text-slate-200">{n.what}</p>

      <dl className="mt-2 space-y-1 text-xs">
        {hasFingerprint && (
          <Row label="지문">
            <span className="font-mono text-slate-500 dark:text-slate-400">
              {shortHash(n.fingerprint.from)} → {shortHash(n.fingerprint.to)}
            </span>
          </Row>
        )}
        {n.impact && <Row label="영향">{n.impact}</Row>}
        {n.action && <Row label="조치">{n.action}</Row>}
      </dl>

      <div className="mt-3 flex justify-end gap-2">
        {/* 수정안 화면 이동 (UI-S7-005 · 009 — 여기서 직접 바꾸지 않는다) */}
        <Link
          href={`/products/${n.productId}`}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
        >
          수정안 보기
        </Link>
        {/* 비표출 전환 알림에는 무시 수단을 노출하지 않는다 (UI-S7-005) */}
        {n.dismissable && (
          <button
            type="button"
            onClick={handleDismiss}
            disabled={busy}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            무시
          </button>
        )}
      </div>
    </li>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-8 shrink-0 text-slate-400">{label}</dt>
      <dd className="text-slate-600 dark:text-slate-300">{children}</dd>
    </div>
  );
}

// ── 수요 신호 T1 · T2 (UI-S7-006 · 007) ───────────────────────────────────────

function DemandSignalSection({
  products,
  onAuthError,
}: {
  products: ProductLite[];
  onAuthError: (err: unknown) => boolean;
}) {
  const [productId, setProductId] = useState<number | null>(null);
  const [signals, setSignals] = useState<RadarSignals | null>(null);
  const [loading, setLoading] = useState(false);

  const selected = products.find((p) => p.productId === productId) ?? null;
  const regionLabel = selected
    ? [selected.region?.regnName, selected.region?.signguName].filter(Boolean).join(" ") || "지역 미지정"
    : "";

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (productId === null) {
        setSignals(null);
        return;
      }
      setLoading(true);
      try {
        const s = await radarApi.signals(productId);
        if (alive) setSignals(s);
      } catch (err) {
        if (!onAuthError(err) && alive) setSignals(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [productId, onAuthError]);

  return (
    <section className="mt-10 border-t border-slate-200 pt-8 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">수요 신호</h2>
        <select
          value={productId ?? ""}
          onChange={(e) => setProductId(e.target.value === "" ? null : Number(e.target.value))}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <option value="">상품 선택…</option>
          {products.map((p) => (
            <option key={p.productId} value={p.productId}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {productId === null ? (
        <p className="mt-4 text-sm text-slate-400">상품을 선택하면 그 지역·기간의 수요 신호를 봅니다.</p>
      ) : loading ? (
        <p className="mt-4 text-sm text-slate-400">불러오는 중…</p>
      ) : signals === null ? (
        <p className="mt-4 text-sm text-slate-400">신호를 불러오지 못했습니다.</p>
      ) : (
        <>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <SignalCard title="T1 · 신규 콘텐츠" region={regionLabel} signal={signals.t1} />
            <SignalCard title="T2 · 행사 밀도" region={regionLabel} signal={signals.t2} />
          </div>
          <p className="mt-3 text-xs text-slate-400">{signals.notice}</p>
        </>
      )}
    </section>
  );
}

function SignalCard({ title, region, signal }: { title: string; region: string; signal: DemandSignal | null }) {
  return (
    <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h3>
        {/* null(아직 안 세어 봄)과 0(세어 보니 없음)을 구분한다 */}
        {signal === null ? (
          <span className="text-xs text-slate-400">아직 산출 전</span>
        ) : (
          <span className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-50">
            {signal.count}
            <span className="ml-0.5 text-xs font-normal text-slate-400">건</span>
          </span>
        )}
      </div>

      {signal && (
        <>
          <p className="mt-1 text-xs text-slate-400">
            {region} · {signal.window.from} ~ {signal.window.to}
          </p>
          {Object.keys(signal.byType).length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(signal.byType).map(([type, n]) => (
                <span
                  key={type}
                  className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                >
                  {CONTENT_TYPE_LABEL[type] ?? type}
                  <span className="tabular-nums font-medium">{n}</span>
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-slate-400">유형 분포 없음</p>
          )}
        </>
      )}
    </div>
  );
}

function shortHash(h: string | null): string {
  return h === null ? "—" : h.slice(0, 8);
}

/** ISO 타임스탬프를 "YYYY-MM-DD HH:mm" 로. */
function formatStamp(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}
