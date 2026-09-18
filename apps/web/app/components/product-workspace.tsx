"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isApiError } from "../lib/api";
import { loadWorkspaceProducts } from "../lib/workspace-products";
import { DeleteProductDialog } from "./delete-product-dialog";
import { GradeCounts, StatusBadge } from "./badges";
import { WorkspaceIcon, type IconName } from "./workspace-icon";
import { STAGE_LABEL, STAGE_ORDER, type Stage } from "../lib/stage-of";
import {
  belongsTo,
  productHref,
  productHint,
  productStage,
  regionText,
  sortProducts,
  type SortKey,
  type Workspace,
  type WorkspaceProduct,
} from "../lib/workspace";

const NIGHTS = ["당일", "1박 2일", "2박 3일"];
const STAGE_ICON: Record<Stage, IconName> = {
  PLANNING: "plan",
  REVIEW: "check",
  RELEASABLE: "check",
  RELEASED: "radar",
};
const COPY = {
  home: {
    eyebrow: "MY WORKSPACE",
    title: "오늘의 여행 업무, 한눈에",
    description: "아이디어부터 출시 이후까지, 모든 상품의 흐름을 이어보세요.",
  },
  planning: {
    eyebrow: "PLAN YOUR NEXT JOURNEY",
    title: "여행의 아이디어를 일정으로",
    description: "새 상품을 기획하고, 작성 중인 일정을 이어서 완성하세요.",
  },
  review: {
    eyebrow: "READY FOR DEPARTURE",
    title: "출시 전, 한 번 더 꼼꼼하게",
    description:
      "운영 정보와 일정의 빈틈을 확인하고, 준비된 상품을 출시하세요.",
  },
};

export function ProductWorkspace({
  workspace,
  initialFilter = "ALL",
}: {
  workspace: Workspace;
  initialFilter?: Stage | "ALL";
}) {
  const router = useRouter();
  const [products, setProducts] = useState<WorkspaceProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"board" | "list">(
    workspace === "review" ? "list" : "board",
  );
  const [sort, setSort] = useState<SortKey>("startDate");
  const [filter, setFilter] = useState<Stage | "ALL">(initialFilter);
  const [deleting, setDeleting] = useState<WorkspaceProduct | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await loadWorkspaceProducts(controller.signal);
        if (!controller.signal.aborted) setProducts(data);
      } catch (e) {
        if (!controller.signal.aborted) {
          if (isApiError(e) && e.status === 401) {
            router.replace("/login");
            return;
          }
          setError(
            isApiError(e)
              ? e.message
              : "상품을 불러오지 못했어요.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [router, retry]);

  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const upcoming = products.filter((p) => p.startDate >= today);
  const scoped = products.filter((p) => belongsTo(p, workspace));
  const current = scoped.filter((p) => p.startDate >= today);
  const past = scoped.filter((p) => p.startDate < today);
  const search = query.trim().toLocaleLowerCase();
  const visible = sortProducts(
    (showPast ? scoped : current).filter(
      (p) =>
        (filter === "ALL" || productStage(p) === filter) &&
        `${p.name} ${regionText(p)}`.toLocaleLowerCase().includes(search),
    ),
    sort,
  );
  const stages =
    workspace === "planning"
      ? (["PLANNING"] as const)
      : workspace === "review"
        ? STAGE_ORDER.filter((s) => s !== "PLANNING")
        : STAGE_ORDER;
  const copy = COPY[workspace];
  const counts = Object.fromEntries(
    STAGE_ORDER.map((s) => [
      s,
      upcoming.filter((p) => productStage(p) === s).length,
    ]),
  ) as Record<Stage, number>;
  const available = !loading && error === null;

  return (
    <div className="workspace-page">
      {notice && <p className="workspace-notice" role="status">{notice}</p>}
      {deleting && <DeleteProductDialog product={deleting} onClose={() => setDeleting(null)} onDeleted={(id) => {
        setProducts((current) => current.filter((product) => product.productId !== id));
        setDeleting(null);
        setNotice("상품을 삭제했습니다.");
      }} /> }
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p className="page-description">{copy.description}</p>
        </div>
        <Link
          href={workspace === "review" ? "/standard" : "/products/new"}
          className={
            workspace === "review" ? "button-secondary" : "button-primary"
          }
        >
          <WorkspaceIcon name={workspace === "review" ? "book" : "plus"} />
          {workspace === "review" ? "검수 기준 보기" : "새 상품 기획"}
        </Link>
      </div>

      {workspace === "home" && (
        <>
          <section className="welcome-panel" aria-label="여행상품 업무 안내">
            <div className="welcome-copy">
              <span className="hero-tag">
                <span />
                여행을 만드는 사람들을 위한 워크스페이스
              </span>
              <h2>
                좋은 여행의 시작,
                <br />
                빈틈없는 준비.
              </h2>
              <p>
                일정을 만들고, 놓친 부분을 확인하고.
                <br />
                여행의 모든 준비를 TourLint에서 함께하세요.
              </p>
              <Link href="/planning" className="hero-link">
                기획하러 가기 <WorkspaceIcon name="arrow" />
              </Link>
            </div>
            <div className="journey-art" aria-hidden="true">
              <div className="map-grid" />
              <div className="map-orbit orbit-one" />
              <div className="map-orbit orbit-two" />
              <svg viewBox="0 0 440 245" className="journey-route">
                <path
                  d="M65 177C90 250 170 196 172 138S223 45 271 96s83 20 110-51"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeDasharray="5 7"
                />
                <circle cx="65" cy="177" r="7" fill="currentColor" />
                <circle cx="381" cy="45" r="7" fill="currentColor" />
              </svg>
              <div className="journey-stop stop-plan">
                <span className="art-icon">
                  <WorkspaceIcon name="plan" />
                </span>
                <div>
                  <small>01 · PLAN</small>
                  <strong>아이디어를 일정으로</strong>
                </div>
                <span className="art-check">✓</span>
              </div>
              <div className="journey-stop stop-review">
                <span className="art-icon">
                  <WorkspaceIcon name="check" />
                </span>
                <div>
                  <small>02 · REVIEW</small>
                  <strong>더 꼼꼼한 출시 준비</strong>
                </div>
                <span className="art-check">✓</span>
              </div>
              <div className="journey-stop stop-radar">
                <span className="art-icon">
                  <WorkspaceIcon name="radar" />
                </span>
                <div>
                  <small>03 · RADAR</small>
                  <strong>여행의 변화까지</strong>
                </div>
                <span className="art-check">↗</span>
              </div>
            </div>
          </section>
          <div className="overview-grid" aria-label="출발 예정 상품 현황">
            {STAGE_ORDER.map((s) => (
              <Link
                key={s}
                href={s === "PLANNING" ? "/planning" : `/review?status=${s}`}
                className={`overview-card stage-${s.toLowerCase()}`}
              >
                <span className="overview-icon">
                  <WorkspaceIcon name={STAGE_ICON[s]} />
                </span>
                <span className="overview-label">
                  {STAGE_LABEL[s]}
                  <strong>
                    {available ? counts[s] : "—"}
                    <small>개 상품</small>
                  </strong>
                </span>
                <WorkspaceIcon name="arrow" className="overview-arrow" />
              </Link>
            ))}
          </div>
        </>
      )}

      {workspace === "planning" && (
        <div className="planning-methods">
          <MethodCard
            icon="plan"
            title="처음부터 차근차근"
            description="지역과 날짜를 정하고 나만의 일정을 만들어 보세요."
            href="/products/new"
            label="직접 입력하기"
          />
          <MethodCard
            icon="upload"
            title="만들어 둔 일정이 있다면"
            description="엑셀·CSV 파일을 가져와 일정을 이어서 다듬으세요."
            href="/products/new?method=upload"
            label="일정 파일 가져오기"
          />
          <MethodCard
            icon="file"
            title="메모 속 아이디어도 일정으로"
            description="여행 메모를 붙여넣고 정리된 일정을 확인하세요."
            href="/products/new?method=nl"
            label="메모로 시작하기"
          />
        </div>
      )}

      {workspace === "review" && (
        <div className="review-intro">
          <div className="intro-symbol">
            <WorkspaceIcon name="check" width="28" height="28" />
          </div>
          <div>
            <h2>확인이 필요한 상품부터 살펴보세요</h2>
            <p>
              상품을 선택하면 검수 결과와 수정 제안을 확인할 수 있어요. 검수
              실행과 출시는 상품 화면에서 직접 결정합니다.
            </p>
          </div>
          <Link href="/planning" className="text-link">
            기획 중인 상품 <WorkspaceIcon name="arrow" />
          </Link>
        </div>
      )}

      <div className={workspace === "home" ? "home-content-grid" : ""}>
        <section
          className="products-panel"
          aria-label={
            workspace === "planning"
              ? "작성 중인 상품"
              : workspace === "review"
                ? "검수 상품"
                : "전체 상품"
          }
        >
          <div className="section-heading">
            <div>
              <h2>
                {workspace === "planning"
                  ? "작성 중인 상품"
                  : workspace === "review"
                    ? "검수 상품"
                    : "내 상품"}
                <span className="count-pill">
                  {available ? (showPast ? scoped : current).length : "—"}
                </span>
              </h2>
              <p>
                {workspace === "planning"
                  ? "저장한 일정부터 다시 시작하세요."
                  : "국내 당일 · 1박 2일 · 2박 3일 상품"}
              </p>
            </div>
            {workspace !== "planning" && (
              <div className="view-switch" aria-label="보기 방식">
                {(["board", "list"] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    aria-pressed={view === v}
                  >
                    <WorkspaceIcon name={v} />
                    <span>{v === "board" ? "보드" : "목록"}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="product-toolbar">
            <label className="product-search">
              <WorkspaceIcon name="search" />
              <input
                aria-label="상품명 또는 지역 검색"
                placeholder="상품명이나 지역을 검색하세요"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <label className="sort-control">
              <span className="sr-only">상품 정렬</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
              >
                <option value="startDate">출발일순</option>
                {workspace !== "planning" && (
                  <>
                    <option value="readiness">준비도순</option>
                    <option value="audited">최근 검수순</option>
                  </>
                )}
              </select>
            </label>
          </div>
          {workspace === "review" && (
            <div className="stage-filters" aria-label="검수 단계 필터">
              {(["ALL", ...stages] as const).map((s) => (
                <button
                  key={s}
                  aria-pressed={filter === s}
                  onClick={() => setFilter(s)}
                >
                  {s === "ALL" ? "전체" : STAGE_LABEL[s]}
                  <span>
                    {available
                      ? (showPast ? scoped : current).filter(
                          (p) => s === "ALL" || productStage(p) === s,
                        ).length
                      : "—"}
                  </span>
                </button>
              ))}
            </div>
          )}
          {loading ? (
            <div className="workspace-loading" role="status">
              <div className="loading-line" />
              <div className="loading-line" />
              <p>상품을 불러오는 중이에요…</p>
            </div>
          ) : error ? (
            <div className="workspace-empty" role="alert">
              <WorkspaceIcon name="file" />
              <h3>상품을 불러오지 못했어요</h3>
              <p>{error}</p>
              <button
                className="button-secondary"
                onClick={() => setRetry((v) => v + 1)}
              >
                다시 시도
              </button>
            </div>
          ) : visible.length === 0 ? (
            <div className="workspace-empty">
              <WorkspaceIcon name={workspace === "review" ? "check" : "plan"} />
              <h3>
                {query || filter !== "ALL"
                  ? "조건에 맞는 상품이 없어요"
                  : workspace === "planning"
                    ? "새로운 여행을 기획해 볼까요?"
                    : workspace === "review"
                      ? "아직 검수할 상품이 없어요"
                      : "첫 여행상품을 만들어 보세요"}
              </h3>
              <p>
                {query || filter !== "ALL"
                  ? "다른 검색어나 단계를 선택해 보세요."
                  : workspace === "review"
                    ? "기획 화면에서 일정을 완성하고 ‘검수 시작’을 눌러주세요."
                    : past.length
                      ? "지난 상품을 펼치거나 새 상품을 기획해 보세요."
                      : "아이디어만 있어도 괜찮아요. 일정은 차근차근 채우면 돼요."}
              </p>
              {query || filter !== "ALL" ? (
                <button
                  className="button-secondary"
                  onClick={() => {
                    setQuery("");
                    setFilter("ALL");
                  }}
                >
                  검색 조건 초기화
                </button>
              ) : (
                <Link
                  className="button-secondary"
                  href={workspace === "review" ? "/planning" : "/products/new"}
                >
                  {workspace === "review" ? "기획으로 이동" : "새 상품 기획"}
                  <WorkspaceIcon name="arrow" />
                </Link>
              )}
            </div>
          ) : workspace === "planning" ? (
            <div className="planning-products">
              {visible.map((p) => (
                <ProductCard key={p.productId} product={p} onDelete={setDeleting} />
              ))}
            </div>
          ) : view === "board" ? (
            <div
              className={`stage-board ${workspace === "home" ? "home-board" : "review-board"}`}
            >
              {stages.map((s) => (
                <div
                  key={s}
                  className={`stage-column stage-${s.toLowerCase()}`}
                >
                  <h3>
                    <span className="stage-dot" />
                    {STAGE_LABEL[s]}
                    <span>
                      {visible.filter((p) => productStage(p) === s).length}
                    </span>
                  </h3>
                  <div className="stage-cards">
                    {visible
                      .filter((p) => productStage(p) === s)
                      .map((p) => (
                        <ProductCard key={p.productId} product={p} onDelete={setDeleting} />
                      ))}
                    {!visible.some((p) => productStage(p) === s) && (
                      <div className="column-empty">
                        <WorkspaceIcon name={STAGE_ICON[s]} />
                        <p>
                          {s === "PLANNING"
                            ? "새 아이디어를 기다려요"
                            : s === "REVIEW"
                              ? "검수 중인 상품이 없어요"
                              : s === "RELEASABLE"
                                ? "준비가 끝나면 이곳에"
                                : "출시한 상품이 모여요"}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <ProductTable products={visible} onDelete={setDeleting} />
          )}
          {available && past.length > 0 && (
            <button
              className="past-toggle"
              aria-expanded={showPast}
              onClick={() => setShowPast((v) => !v)}
            >
              {showPast ? "−" : "+"} 지난 상품 {past.length}개{" "}
              {showPast ? "접기" : "펼치기"}
            </button>
          )}
        </section>
        {workspace === "home" && (
          <aside className="home-aside">
            <section className="next-actions">
              <span className="eyebrow">NEXT STEP</span>
              <h2>이어서 할 일</h2>
              <p className="aside-description">
                지금 챙겨야 할 상품을 모았어요.
              </p>
              {available ? (
                <NextActions products={upcoming} />
              ) : (
                <p className="aside-description">
                  {loading
                    ? "현황을 확인하고 있어요."
                    : "상품을 불러오면 표시돼요."}
                </p>
              )}
            </section>
            <Link href="/radar" className="radar-shortcut">
              <span className="radar-shortcut-icon">
                <WorkspaceIcon name="radar" width="28" height="28" />
              </span>
              <h3>여행 정보는 계속 변하니까</h3>
              <p>
                관심 지역의 새 소식과
                <br />내 상품에 영향을 주는 변화를 살펴보세요.
              </p>
              <span className="text-link">
                레이더 살펴보기 <WorkspaceIcon name="arrow" />
              </span>
            </Link>
          </aside>
        )}
      </div>
      <p className="workspace-footnote">
        <WorkspaceIcon name="book" width="15" height="15" />
        관광정보를 바탕으로 준비를 돕습니다. 출발 전 운영기관의 최신 정보를
        확인해 주세요.
      </p>
    </div>
  );
}

function MethodCard({
  icon,
  title,
  description,
  href,
  label,
}: {
  icon: IconName;
  title: string;
  description: string;
  href: string;
  label: string;
}) {
  return (
    <Link className="method-card" href={href}>
      <span className="method-icon">
        <WorkspaceIcon name={icon} />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      <span className="text-link">
        {label}
        <WorkspaceIcon name="arrow" />
      </span>
    </Link>
  );
}

export function ProductCard({ product: p, onDelete }: { product: WorkspaceProduct; onDelete: (p: WorkspaceProduct) => void }) {
  const stage = productStage(p);
  return (
    <article className={`product-card stage-${stage.toLowerCase()}`}>
      <Link href={productHref(p)} className="product-card-content">
      <span className="product-duration">
        {NIGHTS[p.nights] ?? `${p.nights}박`}
      </span>
      <h4>{p.name}</h4>
      <p className="product-region">
        <WorkspaceIcon name="pin" width="13" height="13" />
        {regionText(p)}
      </p>
      <p className="product-date">
        <WorkspaceIcon name="calendar" width="13" height="13" />
        {p.startDate}
      </p>
      <div className="product-card-bottom">
        <span>{productHint(p)}</span>
      </div>
      </Link>
      <ProductActions product={p} onDelete={onDelete} />
    </article>
  );
}

function NextActions({ products }: { products: WorkspaceProduct[] }) {
  const review = products.filter((p) => productStage(p) === "REVIEW");
  const planning = products.filter((p) => productStage(p) === "PLANNING");
  const ready = products.filter((p) => productStage(p) === "RELEASABLE");
  const next = [
    ...sortProducts(review, "startDate"),
    ...sortProducts(planning, "startDate"),
    ...sortProducts(ready, "startDate"),
  ].slice(0, 3);
  if (next.length === 0)
    return (
      <div className="aside-empty">
        <WorkspaceIcon name="check" />
        <p>
          기다리는 작업이 없어요.
          <br />
          새로운 여행을 시작해 보세요.
        </p>
      </div>
    );
  return (
    <ul className="next-action-list">
      {next.map((p) => (
        <li key={p.productId}>
          <Link href={productHref(p)}>
            <span
              className={`stage-dot stage-${productStage(p).toLowerCase()}`}
            />
            <div>
              <strong>{p.name}</strong>
              <span>{productHint(p)}</span>
            </div>
            <WorkspaceIcon name="arrow" width="16" height="16" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function ProductTable({ products, onDelete }: { products: WorkspaceProduct[]; onDelete: (p: WorkspaceProduct) => void }) {
  return (
    <div
      className="product-table-scroll"
      tabIndex={0}
      role="region"
      aria-label="상품 목록 표"
    >
      <table className="product-table">
        <thead>
          <tr>
            <th>상품 / 지역</th>
            <th>단계</th>
            <th>출발일 / 일정</th>
            <th>출시 준비도</th>
            <th>차단 / 오류 / 주의 / 확인 불가</th>
            <th>최근 검수</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => {
            const a = p.latestAudit;
            return (
              <tr key={p.productId}>
                <td>
                  <Link href={productHref(p)} className="table-product-name">
                    {p.name}
                  </Link>
                  <span className="table-subtext">{regionText(p)}</span>
                  <ProductActions product={p} onDelete={onDelete} />
                </td>
                <td>
                  <span
                    className={`stage-label stage-${productStage(p).toLowerCase()}`}
                  >
                    {STAGE_LABEL[productStage(p)]}
                  </span>
                </td>
                <td>
                  {p.startDate}
                  <span className="table-subtext">
                    {NIGHTS[p.nights] ?? `${p.nights}박`}
                  </span>
                </td>
                <td>
                  {a?.isPartial ? (
                    <StatusBadge status="PARTIAL" />
                  ) : a?.readinessScore != null ? (
                    <div className="table-score">
                      <strong>
                        {a.readinessScore}
                        <small>점</small>
                      </strong>
                      {!a.releasable && <StatusBadge status="NOT_RELEASABLE" />}
                    </div>
                  ) : (
                    <span className="table-subtext">검수 전</span>
                  )}
                </td>
                <td>
                  {a ? <GradeCounts counts={a.counts} variant="chip" /> : "—"}
                </td>
                <td>
                  {a?.executedAt
                    ? a.executedAt.replace("T", " ").slice(5, 16)
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProductActions({ product, onDelete }: { product: WorkspaceProduct; onDelete: (p: WorkspaceProduct) => void }) {
  const label = productStage(product) === "PLANNING" ? "기획 이어하기" : "검수 결과 보기";
  return <div className="product-actions">
    <Link href={productHref(product)} className="product-open" aria-label={`${product.name} ${label}`}>
      {label}<WorkspaceIcon name="arrow" width="15" height="15" />
    </Link>
    <button type="button" className="product-delete" aria-label={`${product.name} 삭제`} onClick={() => onDelete(product)}>
      삭제
    </button>
  </div>;
}
