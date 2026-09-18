import { describe, expect, it, vi, afterEach } from "vitest";
import {
  activeSection,
  isPastTrip,
  koreaToday,
  reviewFilter,
  belongsTo,
  productHref,
  productHint,
  sortProducts,
  type WorkspaceProduct,
} from "./workspace";
import { loadWorkspaceProducts } from "./workspace-products";

const draft: WorkspaceProduct = {
  productId: 1,
  name: "새 일정",
  startDate: "2027-01-01",
  nights: 1,
  plannedAt: null,
};
const review: WorkspaceProduct = {
  ...draft,
  productId: 2,
  plannedAt: "2026-09-18",
  latestAudit: {
    executedAt: "2026-09-18",
    readinessScore: 80,
    isPartial: false,
    releasable: false,
    counts: { blocker: 1, error: 0, warning: 0, unverified: 0 },
  },
};
const ready: WorkspaceProduct = {
  ...review,
  productId: 3,
  latestAudit: {
    ...review.latestAudit!,
    releasable: true,
    counts: { blocker: 0, error: 0, warning: 0, unverified: 0 },
  },
};
const released = { ...ready, productId: 4, releasedAt: "2026-09-18" };

describe("workspace navigation and product scope", () => {
  it("keeps home separate and selects the corresponding parent for detail routes", () => {
    for (const [path, section] of [
      ["/", "/"],
      ["/planning", "/planning"],
      ["/review", "/review"],
      ["/products/new", "/planning"],
      ["/products/1/plan", "/planning"],
      ["/products/2", "/review"],
      ["/products/2/edit", "/review"],
      ["/products/2/comparison", "/review"],
      ["/radar", "/radar"],
      ["/standard", null],
    ])
      expect(activeSection(path!)).toBe(section);
  });
  it("shows all stages on home, drafts in planning, and handed-off products in review", () => {
    const all = [draft, review, ready, released];
    expect(all.filter((p) => belongsTo(p, "home"))).toEqual(all);
    expect(all.filter((p) => belongsTo(p, "planning"))).toEqual([draft]);
    expect(all.filter((p) => belongsTo(p, "review"))).toEqual([
      review,
      ready,
      released,
    ]);
  });
  it("opens the selected overview stage and ignores invalid filters", () => {
    expect(reviewFilter("RELEASED")).toBe("RELEASED");
    expect(reviewFilter("RELEASABLE")).toBe("RELEASABLE");
    expect(reviewFilter("REVIEW")).toBe("REVIEW");
    expect(reviewFilter("PLANNING")).toBe("ALL");
    expect(reviewFilter(["REVIEW", "RELEASED"])).toBe("ALL");
  });
  it("opens draft schedules directly and leaves audit routes intact", () => {
    expect(productHref(draft)).toBe("/products/1/plan");
    expect(productHref(review)).toBe("/products/2");
    expect(productHref(released)).toBe("/products/4");
  });
  it("does not describe partial audit results as complete", () => {
    expect(
      productHint({
        ...ready,
        latestAudit: {
          ...ready.latestAudit!,
          readinessScore: null,
          isPartial: true,
        },
      }),
    ).toBe("부분 검수 · 결과를 확인해 주세요");
  });
  it("retains score/date/audit sorting without mutating the input", () => {
    const input = [draft, review];
    expect(sortProducts(input, "readiness")[0]).toBe(review);
    expect(sortProducts(input, "audited")[0]).toBe(review);
    expect(sortProducts(input, "startDate")[0]).toBe(draft);
    expect(input).toEqual([draft, review]);
  });
});

afterEach(() => vi.unstubAllGlobals());
describe("workspace product loading", () => {
  it("includes later pages in totals and filtering", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [draft], totalPages: 2 })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [review], totalPages: 2 })),
      );
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadWorkspaceProducts(new AbortController().signal)).toEqual([
      draft,
      review,
    ]);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/products?page=1&size=100");
  });
  it.each([401, 503])(
    "propagates HTTP %s instead of rendering an empty account",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("{}", { status })),
      );
      await expect(
        loadWorkspaceProducts(new AbortController().signal),
      ).rejects.toMatchObject({ status });
    },
  );
});

describe("여행 종료일 기준의 목록", () => {
  it("한국 자정 전후에만 날짜가 바뀐다", () => {
    expect(koreaToday(new Date("2026-09-18T14:59:59Z"))).toBe("2026-09-18");
    expect(koreaToday(new Date("2026-09-18T15:00:00Z"))).toBe("2026-09-19");
  });
  it("당일 종료 다음 날은 과거지만, 진행 중인 1박 2일은 남는다", () => {
    expect(isPastTrip({ startDate: "2026-09-18", nights: 0 }, "2026-09-19")).toBe(true);
    expect(isPastTrip({ startDate: "2026-09-18", nights: 1 }, "2026-09-19")).toBe(false);
    expect(isPastTrip({ startDate: "2026-09-18", nights: 1 }, "2026-09-20")).toBe(true);
    expect(isPastTrip({ startDate: "2026-12-31", nights: 2 }, "2027-01-02")).toBe(false);
  });
});
