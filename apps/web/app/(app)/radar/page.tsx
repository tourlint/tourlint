"use client";

// 화면 7 · 수요 · 변경 레이더 (UI-S7 · FR-MO-050~058). 배치가 쌓아 둔 위험 · 기회
// 알림과 수요 신호(T1 · T2)를 읽어 보여 준다. 이 화면에서 일정을 직접 바꾸지 않는다 —
// 반영은 수정안(패치) 흐름을 경유한다 (UI-S7-009). 판매량 · 흥행 · 예측을 말하지 않는다
// (UI-S7-011).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  agentApi,
  isApiError,
  notificationApi,
  radarApi,
  settingsApi,
  type DemandSignal,
  type NotificationKind,
  type RadarNotification,
  type RadarSignals,
  type RadarSummary,
  type RegionSignal,
  type SignalDetail,
  type TodayBrief,
  type TodayItem,
} from "../../lib/api";
import { loadWorkspaceProducts } from "../../lib/workspace-products";
import { isPastTrip } from "../../lib/workspace";
import { WorkspaceIcon } from "../../components/workspace-icon";
import { StatusBadge } from "../../components/badges";
import { AuditBasis } from "../../components/audit-basis";
import { addKeyword, removeKeyword } from "../../lib/radar-keywords";
import { hasRegionNews, regionPlanHref } from "../../lib/region-news";
import { announceNotificationsChanged, markShownRead } from "../../lib/notification-badge";
import { lastCheckedText, nextCheckText, zeroMeaning } from "../../lib/radar-time";
import { EMPTY_REGION_NAMES, regionLabel, type RegionNameMaps } from "../../lib/region-names";
import { RegionSelect, type RegionValue } from "../products/new/region-select";
import type { CodeItem } from "../products/new/types";

/** 오늘(로컬) 날짜 YYYY-MM-DD. 확인 시각 문구가 오늘/어제를 가르는 데만 쓴다. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function loadCodes(url: string): Promise<CodeItem[]> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("지역 코드를 불러오지 못했습니다.");
  const json = (await res.json()) as { items?: CodeItem[] };
  return json.items ?? [];
}

/**
 * 관심 지역 · 새 소식에 나온 코드를 이름으로 (UI-S7-014). 시도 목록을 한 번, 나온 시도별로
 * 시군구를 읽어 이름 지도를 만든다. 조회 실패는 조용히 둔다 — 이름을 못 찾은 코드는 그대로 뜬다.
 */
function useRegionNames(pairs: { regnCd: string; signguCd: string | null }[]): RegionNameMaps {
  const [maps, setMaps] = useState<RegionNameMaps>(EMPTY_REGION_NAMES);
  // 필요한 시도 집합을 안정된 문자열 키로 — 배열 새 참조로 매번 다시 읽지 않는다
  const regnKey = Array.from(new Set(pairs.map((p) => p.regnCd).filter((c) => c !== ""))).sort().join(",");

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (regnKey === "") {
        if (alive) setMaps(EMPTY_REGION_NAMES);
        return;
      }
      try {
        const regnList = regnKey.split(",");
        const [allRegns, ...perRegn] = await Promise.all([
          loadCodes("/api/v1/ldong-codes"),
          ...regnList.map((c) => loadCodes(`/api/v1/ldong-codes?regnCd=${encodeURIComponent(c)}`)),
        ]);
        if (!alive) return;
        const regns = new Map(allRegns.map((r) => [r.code, r.name]));
        const signgus = new Map<string, string>();
        regnList.forEach((c, i) => {
          for (const s of perRegn[i] ?? []) signgus.set(`${c}:${s.code}`, s.name);
        });
        setMaps({ regns, signgus });
      } catch {
        // 이름 조회 실패는 조용히 둔다 — regionLabel 이 코드를 그대로 보인다
      }
    })();
    return () => {
      alive = false;
    };
  }, [regnKey]);

  return maps;
}

interface ProductLite {
  productId: number;
  name: string;
  region?: { regnName?: string; signguName?: string };
  // 알림 뒤에 다시 검수했는지 · 지금 결과가 어떤지를 카드가 말할 때 쓴다 (#703)
  latestAudit?: AuditNow | null;
}

/** 상품의 지금 검수 결과. 목록 응답의 `latestAudit` 에서 카드가 쓰는 것만 */
export interface AuditNow {
  executedAt: string;
  readinessScore: number | null;
  counts: { blocker: number; error: number; warning: number; unverified: number };
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

  // 요약과 신호 선택도 종료되지 않은 여행만 표시한다.
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const [s, res] = await Promise.all([
          radarApi.summary(),
          loadWorkspaceProducts(controller.signal),
        ]);
        if (!alive) return;
        setSummary(s);
        setProducts(res.filter((p) => !isPastTrip(p)));
      } catch (err) {
        if (!onAuthError(err)) setError(isApiError(err) ? err.message : "레이더를 불러오지 못했습니다.");
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [onAuthError]);

  // 탭이 바뀌면 그 종류의 알림을 다시 읽는다.
  useEffect(() => {
    let alive = true;
    void (async () => {
      setListLoading(true);
      try {
        const page = await notificationApi.list(tab);
        if (!alive) return;
        setItems(page.content);
        /*
         * 보인 카드는 확인한 것으로 한다 (UI-CM-008 · #804). 확인 처리를 부르는 곳이 없어 헤더 · 상품 목록의
         * 미확인 건수가 줄지 않았다. 이번에 보는 동안은 처음 본 카드에 「새로」가 남는다 — 목록을 다시 읽지 않는다.
         */
        void markShownRead(page.content, notificationApi.read);
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
      announceNotificationsChanged();
      await refreshSummary();
    } catch (err) {
      if (!onAuthError(err)) setError(isApiError(err) ? err.message : "무시 처리에 실패했습니다.");
    }
  }

  const batch = summary?.lastBatch ?? null;

  return (
    <>
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">KEEP YOUR JOURNEYS UP TO DATE</p>
          <h1>여행의 변화에, 한발 먼저</h1>
          <p className="page-description">여행이 끝나지 않은 상품의 변화와 관심 지역의 새로운 기회를 살펴보세요.</p>
        </div>
        {/* 언제 확인했고 다음은 언제인지 (UI-S7-010) */}
        <div className="shrink-0 text-right text-xs text-slate-500 dark:text-slate-400">
          <p>{lastCheckedText(summary?.lastBatchAt ?? null, todayIso())}</p>
          <p>{nextCheckText(summary?.nextBatchAt ?? null, todayIso())}</p>
        </div>
      </div>

      {error && (
        <div className="mt-6 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
          {error}
        </div>
      )}

      <section className="radar-overview" aria-label="레이더 현황">
        <div className="radar-overview-intro"><WorkspaceIcon name="radar" width="32" height="32" /><div><h2>수요 · 변경 레이더</h2><p>내 상품에 생긴 변화를 여기서 먼저 봅니다. 아래 수요 신호는 그 지역 · 기간을 관측한 값입니다.</p></div></div>
        <button type="button" className="radar-metric" onClick={() => { setTab("RISK"); document.getElementById("notifications")?.scrollIntoView({ behavior: "smooth" }); }}><span>바뀐 정보</span><strong>{summary?.risk ?? "—"}<small>건</small></strong>{summary?.risk === 0 && <em>{zeroMeaning(summary.lastBatch?.covered ?? null, todayIso())}</em>}</button>
        <button type="button" className="radar-metric" onClick={() => { setTab("OPPORTUNITY"); document.getElementById("notifications")?.scrollIntoView({ behavior: "smooth" }); }}><span>새 소식</span><strong>{summary?.opportunity ?? "—"}<small>건</small></strong>{summary?.opportunity === 0 && <em>{zeroMeaning(summary.lastBatch?.covered ?? null, todayIso())}</em>}</button>
      </section>

      {/* 레이더 에이전트 — 오늘 할 일 정리 (FR-AG-030 · 031) */}
      <TodayAgentCard products={products} />

      {/* 관심 키워드 · 관심 지역 새 소식 (FR-MO-059~061 · UI-S7-012~018) */}
      <WatchAndNews onError={setError} automatic={summary?.nextBatchAt != null}
        checkedText={lastCheckedText(summary?.lastBatchAt ?? null, todayIso())} />

      {/* 바뀐 정보 · 새 소식 탭 (UI-S7-003). 검수 등급 색 마커를 쓰지 않는다. */}
      <div id="notifications" className="mt-6 flex gap-2 border-b border-slate-200 dark:border-slate-800">
        <TabButton active={tab === "RISK"} onClick={() => setTab("RISK")} label="바뀐 정보" count={summary?.risk} />
        <TabButton
          active={tab === "OPPORTUNITY"}
          onClick={() => setTab("OPPORTUNITY")}
          label="새 소식"
          count={summary?.opportunity}
        />
      </div>

      {listLoading ? (
        <p className="mt-8 text-sm text-slate-400">불러오는 중…</p>
      ) : items.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed border-slate-300 py-14 text-center text-sm text-slate-400 dark:border-slate-700 dark:text-slate-500">
          <p>{tab === "RISK" ? "현재 여행에 확인할 바뀐 정보가 없습니다." : "현재 여행에 확인할 새 소식이 없습니다."}</p>
          <p className="mt-2">여행이 끝난 상품의 알림은 표시하지 않아요.</p>
          <Link href="/review" className="mt-3 inline-block text-emerald-700 underline">검수에서 지난 상품 보기</Link>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((n) => (
            <NotificationCard
              key={n.notificationId}
              notification={n}
              audit={products.find((p) => p.productId === n.productId)?.latestAudit ?? null}
              onDismiss={() => dismiss(n.notificationId)}
            />
          ))}
        </ul>
      )}

      <DemandSignalSection products={products} onAuthError={onAuthError} />

      {/*
       * 화면 7 의 근거 영역 (UI-CM-030). 여기 표시되는 것은 검수 실행이 아니라 배치가
       * 모은 변경이라, 규칙셋·지문·대상 건수 대신 그 배치가 무엇을 언제 봤는지를 적는다.
       * 없는 값을 채워 넣지 않는다.
       */}
      <AuditBasis
        rows={[
          { label: "마지막 배치", value: batch?.runAt ? formatStamp(batch.runAt) : "실행 없음" },
          { label: "처리 기준일", value: batch?.covered ?? "—" },
          { label: "상태", value: batch?.status ?? "—" },
        ]}
      />
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

// 바뀐 정보 · 새 소식 텍스트 배지. 검수 등급(적·주황·황·회) 색을 재사용하지 않는다 (UI-S7-003).
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
      {risk ? "바뀐 정보" : "새 소식"}
    </span>
  );
}

/** `2026-09-18` → `9월 18일` */
function koreanDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m === null ? iso : `${Number(m[2])}월 ${Number(m[3])}일`;
}

/**
 * 알림 뒤에 다시 검수했으면 지금 결과를 말한다 (#703). 「다시 검수하세요」 를 이미 다시 검수한
 * 상품에도 똑같이 적으면 할 일이 남은 것처럼 읽힌다. 조건 1 은 배치가 자동으로 다시 검수한다.
 */
export function reauditLine(createdAt: string, audit: AuditNow | null): string | null {
  if (audit === null) return null;
  const alerted = Date.parse(createdAt);
  const audited = Date.parse(audit.executedAt);
  if (Number.isNaN(alerted) || Number.isNaN(audited) || audited < alerted) return null;
  const score = audit.readinessScore === null ? "점수 없음(부분 검수)" : `지금 ${audit.readinessScore}점`;
  return `알림 뒤에 다시 검수했어요 · ${score} · 차단 ${audit.counts.blocker} · 오류 ${audit.counts.error}`;
}

export function NotificationCard({
  notification: n, audit = null, onDismiss,
}: { notification: RadarNotification; audit?: AuditNow | null; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const hasFingerprint = n.fingerprint.from !== null && n.fingerprint.to !== null;
  const reaudited = n.kind === "RISK" ? reauditLine(n.createdAt, audit) : null;

  async function handleDismiss() {
    setBusy(true);
    await onDismiss();
  }

  return (
    <li className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-2">
        <KindBadge kind={n.kind} />
        {/* 처음 보는 알림 (UI-CM-008 · #804) */}
        {n.readAt === null && (
          <span className="rounded-md bg-fuchsia-700 px-1.5 py-0.5 text-[11px] font-semibold text-white dark:bg-fuchsia-300 dark:text-fuchsia-950" data-new>
            새로
          </span>
        )}
        {/* 비표출 전환 콘텐츠 (show_flag=0) — 상태 배지 재사용 (UI-CM-013) */}
        {n.hidden && <StatusBadge status="DISPLAY_STOPPED" />}
        <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{n.productName}</span>
        <span className="text-xs text-slate-400">{n.startDate} 출발</span>
      </div>

      {/* 바뀐 것과 해당 일정을 먼저 보인다 (UI-S7-003). 이름이 없으면 어느 곳 이야기인지 알 수 없다 (#685) */}
      {n.placeName && (
        <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-slate-50" data-place-name>
          <span className="mr-1.5 text-xs font-medium text-slate-400">{n.kind === "RISK" ? "바뀐 곳" : "새로 생긴 곳"}</span>
          {n.placeName}
        </p>
      )}
      <p className="mt-2 text-sm text-slate-800 dark:text-slate-200">{n.what}</p>

      {/* 판독 결과 전 → 후 (UI-S7-004). 문장만으로는 무엇이 어떻게 바뀌었는지 모른다 (#703) */}
      {n.changes.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-sm" data-changes>
          {n.changes.map((c) => (
            <li key={c.label} className="text-slate-700 dark:text-slate-200">
              <span className="mr-2 text-xs text-slate-400">{c.label}</span>
              <span className="text-slate-500 line-through decoration-slate-300 dark:text-slate-400">{c.before}</span>
              <span className="mx-1.5 text-slate-400">→</span>
              <span className="font-medium">{c.after}</span>
            </li>
          ))}
        </ul>
      )}
      {/* 견줄 이전 검수가 없으면 지금 값을 보인다 — 검수한 뒤에 담은 곳 */}
      {n.changes.length === 0 && n.current.length > 0 && (
        <p className="mt-1.5 text-sm text-slate-700 dark:text-slate-200" data-current>
          <span className="mr-2 text-xs text-slate-400">지금 관광정보</span>
          {n.current.map((c) => `${c.label} ${c.value}`).join(" · ")}
        </p>
      )}

      <dl className="mt-2 space-y-1 text-xs">
        {n.impact && <Row label="영향">{n.impact}</Row>}
        {(reaudited ?? n.action) && <Row label="조치">{reaudited ?? n.action}</Row>}
        {n.modifiedOn && <Row label="수정일">관광정보가 {koreanDay(n.modifiedOn)}에 수정됐어요</Row>}
      </dl>

      {/* 지문 비교값은 접힌 근거 칸 안에만 둔다 (UI-CM-030 · UI-S7-003). 밖에 두면 만드는 쪽 말이 샌다 */}
      {hasFingerprint && (
        <details className="mt-2" data-evidence>
          <summary className="cursor-pointer text-xs text-slate-400">근거 보기</summary>
          <p className="mt-1 font-mono text-xs text-slate-500 dark:text-slate-400">
            지문 {shortHash(n.fingerprint.from)} → {shortHash(n.fingerprint.to)}
          </p>
        </details>
      )}

      <div className="mt-3 flex justify-end gap-2">
        {/* 바뀐 정보는 [다시 검수], 새 소식은 [수정안 보기]로 상품으로 보낸다 — 여기서 직접 바꾸지 않는다 (UI-S7-005 · 009) */}
        <Link
          href={`/products/${n.productId}`}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
        >
          {/* 이미 다시 검수했으면 할 일은 결과를 보는 것이다 — 홈 보드와 같은 이름을 쓴다 (#703) */}
          {n.kind === "RISK" ? (reaudited === null ? "다시 검수" : "검수 결과 보기") : "수정안 보기"}
        </Link>
        {/* 비표출 전환 알림에는 미루기 수단을 노출하지 않는다 (UI-S7-005) */}
        {n.dismissable && (
          <button
            type="button"
            onClick={handleDismiss}
            disabled={busy}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            나중에
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
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">수요 신호</h2>
          {/* 위(알림)와 다른 축이라는 것을 여기서 말한다 (#644) */}
          <p className="mt-0.5 text-xs text-slate-400">고른 상품의 지역 · 기간을 관광정보로 관측한 값입니다. 위의 알림과는 다른 이야기예요.</p>
        </div>
        <select
          aria-label="수요 신호를 확인할 상품"
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
            <SignalCard title="새로 등록된 곳" region={regionLabel} signal={signals.t1}
              productId={productId} type="T1" what="이 기간에 관광정보에 새로 올라온 곳입니다." />
            <SignalCard title="여행일에 열리는 행사" region={regionLabel} signal={signals.t2}
              productId={productId} type="T2" what="출발일 앞뒤로 이 지역에서 열리는 행사입니다." />
          </div>
          <p className="mt-3 text-xs text-slate-400">{signals.notice}</p>
        </>
      )}
    </section>
  );
}

/**
 * 신호 한 칸 (#644).
 *
 * 건수만 있으면 「그래서 뭘 하라는 건지」가 안 남는다. 0건이 아니면 눌러서 그 기간에 무엇이
 * 새로 생겼는지 · 어떤 행사가 열리는지 본다. 이름은 저장하지 않아 누를 때 조달한다.
 */
function SignalCard({
  title, region, signal, productId, type, what,
}: {
  title: string; region: string; signal: DemandSignal | null;
  productId: number; type: "T1" | "T2"; what: string;
}) {
  const [detail, setDetail] = useState<SignalDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function load() {
    setBusy(true);
    setFailed(false);
    try {
      setDetail(await radarApi.signalDetail(productId, type));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

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
          <p className="mt-2 text-xs text-slate-400">{what}</p>

          {signal.count > 0 && detail === null && (
            <button
              type="button"
              onClick={() => void load()}
              disabled={busy}
              className="mt-2 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {busy ? "불러오는 중…" : "무엇인지 보기"}
            </button>
          )}
          {failed && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">목록을 불러오지 못했습니다. 잠시 뒤 다시 눌러 주세요.</p>}

          {detail !== null && (
            <ul className="mt-2 space-y-1">
              {detail.items.map((item) => (
                <li key={item.contentId} className="text-xs text-slate-600 dark:text-slate-300">
                  {item.title || "이름을 읽지 못한 곳"}
                  <span className="ml-1 text-slate-400">
                    {CONTENT_TYPE_LABEL[item.contentTypeId] ?? item.contentTypeId}
                    {item.eventStart !== null && ` · ${item.eventStart} ~ ${item.eventEnd ?? ""}`}
                    {item.eventStart === null && item.createdDate !== null && ` · ${item.createdDate} 등록`}
                  </span>
                </li>
              ))}
              {detail.items.length === 0 && (
                <li className="text-xs text-slate-400">
                  {detail.unavailable === "BUDGET"
                    ? "오늘 조회량을 다 써서 목록은 내일 볼 수 있어요. 건수는 그대로입니다."
                    : detail.unavailable === "FETCH_FAILED"
                      ? "목록 조회가 실패했습니다. 건수는 세어 둔 값이라 그대로입니다."
                      : "지금 목록에서는 찾지 못했습니다."}
                </li>
              )}
            </ul>
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

// ── 레이더 에이전트 — 오늘 할 일 (FR-AG-030 · 031) ────────────────────────────
// 사람이 누를 때만 돈다. 서버가 정한 순서를 화면이 다시 정렬하지 않는다. 할 일마다 기존 버튼.
function TodayAgentCard({ products }: { products: ProductLite[] }) {
  const [brief, setBrief] = useState<TodayBrief | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      setBrief(await agentApi.today());
    } catch (e) {
      setErr(isApiError(e) ? e.message : "오늘 할 일을 불러오지 못했어요.");
    } finally {
      setBusy(false);
    }
  }

  // 관심 지역 할 일의 줄 머리에 적을 이름. 서버는 코드만 안다 (#724)
  const regionNames = useRegionNames(
    (brief?.todos ?? []).flatMap((t) => (t.region === null ? [] : [{ regnCd: t.region.regnCd, signguCd: t.region.signguCd }])),
  );
  const productNames = new Map(products.map((p) => [p.productId, p.name]));

  return (
    <section className="radar-today mt-6 rounded-2xl border border-slate-200 p-5 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">오늘 할 일</h2><p className="mt-1 text-sm text-slate-500">다시 확인할 상품과 관심 지역 소식을 한 번에 정리해 드려요.</p></div>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
        >
          {busy ? "정리하는 중…" : "오늘 할 일 보기"}
        </button>
      </div>
      {err && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{err}</p>}
      {brief && (
        <div className="mt-3 space-y-2">
          {brief.todos.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">오늘 챙길 일이 없어요.</p>
          ) : (
            <ul className="space-y-2">
              {brief.todos.map((t, i) => (
                <TodoRow key={i} item={t} subject={todoSubject(t, productNames, regionNames)} />
              ))}
            </ul>
          )}
          <QuietProducts lines={brief.quiet} />
          {brief.incomplete && (
            <p className="text-xs text-amber-600 dark:text-amber-400">일부만 정리했어요. 잠시 후 다시 시도해 주세요.</p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * 할 일 줄 머리 — 어느 상품 · 어느 지역의 일인지 (#724).
 *
 * 이유 문장은 AI 가 쓰고 이름은 화면이 적는다. 관심 지역은 서버가 코드만 알아(0콜) 문장에
 * 지역이 빠졌었다. 이름을 못 찾으면 비운다 — 코드나 번호를 그대로 보이지 않는다.
 */
export function todoSubject(
  item: TodayItem,
  productNames: ReadonlyMap<number, string>,
  regionNames: RegionNameMaps,
): string | null {
  if (item.productId !== null) return productNames.get(item.productId) ?? null;
  if (item.region === null) return null;
  const month = Number(item.region.month.slice(5, 7));
  const name = regionLabel(regionNames, item.region.regnCd, item.region.signguCd);
  return Number.isInteger(month) && month >= 1 ? `${name} · ${String(month)}월` : name;
}

/**
 * 바뀐 정보가 없는 상품 (FR-AG-031). 한 줄씩이지만 상품이 많으면 할 일이 묻혀서 접어 둔다.
 */
export function QuietProducts({ lines }: { lines: { productId: number; text: string }[] }) {
  if (lines.length === 0) return null;
  return (
    <details className="text-xs text-slate-400" data-quiet-products>
      <summary className="cursor-pointer select-none">바뀐 정보가 없는 상품 {lines.length}개</summary>
      <div className="mt-1 space-y-1">
        {lines.map((q) => (
          <p key={q.productId}>{q.text}</p>
        ))}
      </div>
    </details>
  );
}

const TODO_LABEL: Record<TodayItem["action"], string> = {
  REAUDIT: "다시 검수",
  VIEW_RESULT: "검수 결과 보기",
  NEW_PLAN: "이 지역으로 새 상품 기획",
};

export function TodoRow({ item, subject }: { item: TodayItem; subject: string | null }) {
  const href =
    item.action !== "NEW_PLAN" && item.productId !== null
      ? `/products/${item.productId}`
      : item.region
        ? `/products/new?regnCd=${item.region.regnCd}&signguCd=${item.region.signguCd ?? ""}&month=${item.region.month}&origin=SIGNAL`
        : "/";
  // 이미 다시 검수한 상품이면 할 일은 결과를 보는 것이다 — 레이더 카드 · 홈 보드와 같은 이름 (#735)
  const label = TODO_LABEL[item.action];
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
      <span className="text-sm text-slate-700 dark:text-slate-200">
        {subject !== null && <span className="mr-2 font-semibold text-slate-900 dark:text-slate-100" data-todo-subject>{subject}</span>}
        {item.reason}
      </span>
      <Link href={href} className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
        {label}
      </Link>
    </li>
  );
}

// ── 관심 키워드 · 관심 지역 새 소식 (FR-MO-059~061 · UI-S7-012~018) ────────────
function WatchAndNews({ onError, automatic, checkedText }: { onError: (m: string | null) => void; automatic: boolean; checkedText: string }) {
  const [keywords, setKeywords] = useState<string[]>([]);
  const [regions, setRegions] = useState<{ regnCd: string; signguCd: string | null; month: string }[]>([]);
  const [signals, setSignals] = useState<RegionSignal[]>([]);
  const [draft, setDraft] = useState("");
  const [kwError, setKwError] = useState<string | null>(null);
  const [regionError, setRegionError] = useState<string | null>(null);
  const [region, setRegion] = useState<RegionValue>({ regnCode: "", regnName: "", signguCode: "", signguName: "" });
  const [month, setMonth] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedNote, setRefreshedNote] = useState<string | null>(null);

  async function refreshNews() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshedNote(null);
    onError(null);
    try {
      // 자동 확인이 켜져 있으면 배치가 저장한 최신 결과를 읽는다.
      // 수동 집계 API는 자동 확인이 꺼진 기간에만 허용된다.
      setSignals(await (automatic ? radarApi.regionSignals() : radarApi.refreshRegionSignals()));
      // 눌러도 화면이 그대로면 고장처럼 보인다 (#715). 무엇을 했고 언제 것인지 한 줄로 말한다
      setRefreshedNote(refreshNote(automatic, checkedText));
    } catch (e) {
      onError(isApiError(e) ? e.message : "새 소식을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [v, s] = await Promise.all([settingsApi.get(), radarApi.regionSignals()]);
        if (!alive) return;
        setKeywords(v.watchKeywords);
        setRegions(v.watchRegions);
        setSignals(s);
      } catch (e) {
        if (alive) onError(isApiError(e) ? e.message : "관심 설정을 불러오지 못했어요.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [onError]);

  async function saveKeywords(next: string[]) {
    const prev = keywords;
    setKeywords(next);
    try {
      const v = await settingsApi.update({ watchKeywords: next });
      setKeywords(v.watchKeywords);
    } catch (e) {
      setKeywords(prev);
      onError(isApiError(e) ? e.message : "키워드를 저장하지 못했어요.");
    }
  }

  function onAdd() {
    const { list, error } = addKeyword(keywords, draft);
    setKwError(error);
    if (error === null) {
      setDraft("");
      void saveKeywords(list);
    }
  }

  async function addRegion() {
    if (region.regnCode === "" || month === "") return;
    const signguCd = region.signguCode === "" ? null : region.signguCode;
    // 키워드처럼 같은 것을 또 넣지 않는다 (#712 · UI-S7-014)
    if (hasRegion(regions, region.regnCode, signguCd, month)) {
      setRegionError("이미 등록한 지역이에요.");
      return;
    }
    setRegionError(null);
    const next = [
      ...regions,
      { regnCd: region.regnCode, signguCd: region.signguCode === "" ? null : region.signguCode, month },
    ];
    setRegions(next);
    setRegion({ regnCode: "", regnName: "", signguCode: "", signguName: "" });
    setMonth("");
    try {
      const v = await settingsApi.update({ watchRegions: next });
      setRegions(v.watchRegions);
    } catch (e) {
      onError(isApiError(e) ? e.message : "관심 지역을 저장하지 못했어요.");
    }
  }

  async function removeRegion(idx: number) {
    const next = regions.filter((_, i) => i !== idx);
    setRegions(next);
    try {
      await settingsApi.update({ watchRegions: next });
    } catch (e) {
      onError(isApiError(e) ? e.message : "관심 지역을 저장하지 못했어요.");
    }
  }

  // 홈 보드 아래 바로 가기가 여기로 보낸다 (UI-S1-012 · #804). 카드는 읽은 뒤에 생겨 브라우저가 스스로 찾지 못한다
  useEffect(() => {
    if (window.location.hash === "#region-news" && signals.some(hasRegionNews)) {
      document.getElementById("region-news")?.scrollIntoView();
    }
  }, [signals]);

  // 관심 지역 · 새 소식에 나온 코드를 이름으로 (UI-S7-014)
  const regionNames = useRegionNames([
    ...regions.map((r) => ({ regnCd: r.regnCd, signguCd: r.signguCd })),
    ...signals.map((s) => ({ regnCd: s.region.regnCd, signguCd: s.region.signguCd })),
  ]);

  return (
    <section className="radar-watch mt-6 rounded-2xl border border-slate-200 p-5 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">관심 키워드 · 관심 지역</h2>
        <button type="button" onClick={() => void refreshNews()} disabled={refreshing || regions.length === 0} aria-busy={refreshing} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">
          {refreshing ? "새 소식 확인 중…" : "새 소식 확인"}
        </button>
      </div>
      {refreshedNote && <p role="status" className="mt-2 text-right text-xs text-slate-500 dark:text-slate-400">{refreshedNote}</p>}

      {/* 관심 키워드 */}
      <div className="mt-3">
        <div className="flex flex-wrap gap-1.5">
          {keywords.map((k) => (
            <span key={k} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-0.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
              {k}
              <button type="button" onClick={() => void saveKeywords(removeKeyword(keywords, k))} className="text-slate-400 hover:text-slate-600">×</button>
            </span>
          ))}
          {keywords.length === 0 && <span className="text-xs text-slate-400">등록한 키워드가 없어요.</span>}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            value={draft}
            onChange={(e) => {
              setKwError(null);
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), onAdd())}
            aria-label="관심 키워드"
            placeholder="예: 온천"
            className="w-48 rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
          <button type="button" onClick={onAdd} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
            추가
          </button>
        </div>
        {kwError && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{kwError}</p>}
      </div>

      {/* 관심 지역 편집 */}
      <div className="mt-5">
        <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200">관심 지역</h3>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {regions.map((r, i) => (
            <span key={`${r.regnCd}-${r.signguCd}-${r.month}`} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-0.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
              {regionLabel(regionNames, r.regnCd, r.signguCd)} · {r.month}
              <button type="button" onClick={() => void removeRegion(i)} className="text-slate-400 hover:text-slate-600">×</button>
            </span>
          ))}
          {regions.length === 0 && <span className="text-xs text-slate-400">등록한 지역이 없어요.</span>}
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <RegionSelect value={region} onChange={setRegion} />
          <input aria-label="관심 지역 기준 월" type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900" />
          <button type="button" onClick={() => void addRegion()} disabled={region.regnCode === "" || month === ""} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
            관심 지역 추가
          </button>
        </div>
        {regionError && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{regionError}</p>}
      </div>

      {/*
        * 관심 지역 새 소식. 소식이 있는 지역을 카드로 먼저, 없는 지역은 아래 한 줄로 (#705) —
        * 「행사 0건 · 새로 등록된 곳 0곳」 카드가 소식 있는 카드와 같은 크기로 섞여 있었다.
        * 등록한 지역을 숨기지는 않는다. 어디 갔는지 찾게 만들면 안 된다.
        */}
      {signals.some(hasRegionNews) && (
        <div id="region-news" className="mt-6 grid gap-3 md:grid-cols-2">
          {signals.filter(hasRegionNews).map((s) => (
            <RegionNewsCard key={`${s.region.regnCd}-${s.region.signguCd}-${s.month}`} signal={s} regionName={regionLabel(regionNames, s.region.regnCd, s.region.signguCd)} />
          ))}
        </div>
      )}
      {signals.some((s) => !hasRegionNews(s)) && (
        <ul className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800" data-quiet-regions>
          {signals.filter((s) => !hasRegionNews(s)).map((s) => (
            <QuietRegionRow key={`${s.region.regnCd}-${s.region.signguCd}-${s.month}`} signal={s} regionName={regionLabel(regionNames, s.region.regnCd, s.region.signguCd)} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 관심 지역 카드 한 줄 (#650).
 *
 * 건수만 있으면 「이 지역으로 새 상품 기획」을 누를지 정할 수 없다 — 어디가 새로 생겼는지
 * 알아야 한다. 이름은 저장하지 않아 누를 때 조달한다. 상품 쪽(#644)과 같은 방식이다.
 */
function RegionSignalLine({
  label, count, region, month, type,
}: {
  label: string; count: number;
  region: { regnCd: string; signguCd: string | null }; month: string; type: "T1" | "T2";
}) {
  const [detail, setDetail] = useState<SignalDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function load() {
    setBusy(true);
    setFailed(false);
    try {
      setDetail(await radarApi.regionSignalDetail(region.regnCd, region.signguCd, month, type));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li>
      {label}
      {count > 0 && detail === null && (
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          className="ml-2 rounded border border-slate-300 px-1.5 py-0.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {busy ? "불러오는 중…" : "무엇인지 보기"}
        </button>
      )}
      {failed && <span className="ml-2 text-xs text-rose-600 dark:text-rose-400">불러오지 못했습니다</span>}
      {detail !== null && (
        <ul className="mt-1 space-y-0.5 pl-3">
          {detail.items.map((item) => (
            <li key={item.contentId} className="text-xs text-slate-500 dark:text-slate-400">
              {item.title || "이름을 읽지 못한 곳"}
              <span className="ml-1 text-slate-400">
                {CONTENT_TYPE_LABEL[item.contentTypeId] ?? item.contentTypeId}
                {item.eventStart !== null && ` · ${item.eventStart} ~ ${item.eventEnd ?? ""}`}
                {item.eventStart === null && item.createdDate !== null && ` · ${item.createdDate} 등록`}
              </span>
            </li>
          ))}
          {detail.items.length === 0 && (
            <li className="text-xs text-slate-400">
              {detail.unavailable === "BUDGET"
                ? "오늘 조회량을 다 써서 목록은 내일 볼 수 있어요. 건수는 그대로입니다."
                : detail.unavailable === "FETCH_FAILED"
                  ? "목록 조회가 실패했습니다. 건수는 세어 둔 값이라 그대로입니다."
                  : "지금 목록에서는 찾지 못했습니다."}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** `2026-10` → 10 */
function monthOf(month: string): number {
  return Number(month.slice(5, 7));
}

/** 새로 등록된 곳을 센 기간 (일). 창이 없으면 null */
export function recentDays(signal: RegionSignal): number | null {
  const w = signal.t1?.window;
  if (w === undefined) return null;
  const days = Math.round((Date.parse(w.to) - Date.parse(w.from)) / 86_400_000) + 1;
  return Number.isFinite(days) && days > 0 ? days : null;
}

/**
 * 소식이 없는 지역을 한 줄로 말한다 (#705). 0 을 늘어놓지 않고 그 뜻을 적는다 (UI-S7-010 과 같은 취지).
 * 아직 세어 보지 않은 지역(방금 추가)은 「없다」 가 아니라 「아직」 이다.
 */
export function quietRegionText(s: RegionSignal): string {
  if (s.t1 === null && s.t2 === null) return "방금 추가한 지역이에요. 다음 확인 때 채워져요.";
  const month = monthOf(s.month);
  const days = recentDays(s);
  return `${month}월 행사와 ${days === null ? "최근" : `최근 ${days}일`} 새로 등록된 곳은 아직 없어요.`;
}

function visitorsText(s: RegionSignal): string | null {
  // 관측된 방문자 수만. null 이면 아예 적지 않는다 (0 으로 적지 않는다)
  return s.t3 === null ? null : `지난해 ${monthOf(s.t3.basisMonth)}월 방문자 ${s.t3.count.toLocaleString()}명`;
}

/**
 * 근거 보기 — 줄에 적은 숫자를 센 기간 · 시각과 출처 (UI-S7-015 · #830).
 * 제출한 기능설명서가 관심 지역에서 「근거 보기」로 출처와 집계 기간을 확인한다고 적었다(8쪽 ③).
 * 줄마다 적는 기간(#705)은 그대로 두고 여기에는 날짜를 적는다. 세부 서비스 이름 · 내부 코드는 두지 않는다(UI-CM-040).
 */
export function RegionEvidence({ signal: s, className = "" }: { signal: RegionSignal; className?: string }) {
  const rows = [
    s.t1 && `새로 등록된 곳 · ${s.t1.window.from} ~ ${s.t1.window.to} 에 관광정보에 새로 올라온 곳`,
    s.t2 && `행사 · ${s.t2.window.from} ~ ${s.t2.window.to} 에 열리는 행사`,
    s.t3 && `방문자 수 · ${s.t3.basisMonth.slice(0, 4)}년 ${monthOf(s.t3.basisMonth)}월 한 달`,
  ].filter((r): r is string => typeof r === "string" && r !== "");
  if (rows.length === 0) return null;
  // 가장 늦게 센 시각. 세지 않은 줄(빈 값)은 건너뛴다
  const counted = [s.t1?.computedAt, s.t2?.computedAt, s.t3?.computedAt].filter((t): t is string => typeof t === "string" && t.length >= 16).sort().pop();
  return (
    <details className={`mt-2 text-xs ${className}`} data-evidence>
      <summary className="cursor-pointer text-slate-400">근거 보기</summary>
      <ul className="mt-1 space-y-0.5 text-slate-500 dark:text-slate-400">
        {rows.map((r) => <li key={r}>{r}</li>)}
        <li>출처: ⓒ한국관광공사{counted !== undefined && ` · ${counted.slice(0, 10)} ${counted.slice(11, 16)}에 셌어요`}</li>
      </ul>
    </details>
  );
}

export function QuietRegionRow({ signal: s, regionName }: { signal: RegionSignal; regionName: string }) {
  const visitors = visitorsText(s);
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
      <span className="text-slate-600 dark:text-slate-300">
        <span className="font-medium text-slate-700 dark:text-slate-200">{regionName} · {s.month}</span>
        <span className="ml-2 text-slate-400">{quietRegionText(s)}</span>
        {visitors !== null && <span className="ml-2 text-xs text-slate-400">{visitors}</span>}
      </span>
      <Link href={regionPlanHref(s)} className="shrink-0 text-xs font-medium text-slate-500 underline-offset-2 hover:underline dark:text-slate-400">
        이 지역으로 새 상품 기획
      </Link>
      <RegionEvidence signal={s} className="mt-0 basis-full" />
    </li>
  );
}

export function RegionNewsCard({ signal: s, regionName }: { signal: RegionSignal; regionName: string }) {
  const newContents = s.t1?.count ?? null;
  const events = s.t2?.count ?? null;
  const hits = (s.t1?.keywordHits ?? []).filter((h) => (h.contentIds?.length ?? 0) > 0);
  const month = monthOf(s.month);
  const days = recentDays(s);
  const visitors = visitorsText(s);
  return (
    <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          {regionName} · {s.month}
        </h3>
        <Link
          href={regionPlanHref(s)}
          className="shrink-0 rounded-md border border-slate-300 px-2 py-0.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          이 지역으로 새 상품 기획
        </Link>
      </div>

      {/*
        * 숫자마다 기준 기간을 사용자 말로 적는다 (UI-S7-015 · #705). 「이달 행사」 는 지금 달로 읽히고,
        * 기간은 「근거 보기」 안에 「새 콘텐츠 기준 기간 …」 같은 만드는 쪽 말로 접혀 있었다.
        * 날짜 · 센 시각 · 출처는 아래 근거 보기에 사용자 말로 둔다 (#830).
        * 0 인 줄은 적지 않는다 — 둘 다 0 인 지역은 아래 한 줄 목록으로 간다.
        */}
      <ul className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300">
        {hits.map((h) => (
          <li key={h.keyword}>‘{h.keyword}’과(와) 맞는 곳 {h.contentIds?.length}곳</li>
        ))}
        {events !== null && events > 0 && (
          <RegionSignalLine label={`${month}월 행사 ${events}건`} count={events} region={s.region} month={s.month} type="T2" />
        )}
        {newContents !== null && newContents > 0 && (
          <RegionSignalLine label={`${days === null ? "최근" : `최근 ${days}일`} 새로 등록된 곳 ${newContents}곳`} count={newContents} region={s.region} month={s.month} type="T1" />
        )}
        {visitors !== null && <li>{visitors}</li>}
      </ul>
      <RegionEvidence signal={s} />
    </div>
  );
}

/** 같은 (시도 · 시군구 · 달)이 이미 있는가 (#712). 서버도 같은 기준으로 접는다 */
export function hasRegion(
  regions: readonly { regnCd: string; signguCd: string | null; month: string }[],
  regnCd: string, signguCd: string | null, month: string,
): boolean {
  return regions.some((r) => r.regnCd === regnCd && (r.signguCd ?? null) === signguCd && r.month === month);
}

/**
 * 「새 소식 확인」 을 누른 뒤의 한 줄 (#715). 자동 확인이 켜져 있으면 아침에 확인해 둔 결과를 다시
 * 읽는 것이라 그 시각을 함께 말한다 — 지금 새로 센 것처럼 읽히면 안 된다.
 */
export function refreshNote(automatic: boolean, checkedText: string): string {
  return automatic
    ? `가장 최근에 확인한 결과를 다시 불러왔어요. ${checkedText}`
    : "지금 다시 확인했어요.";
}
