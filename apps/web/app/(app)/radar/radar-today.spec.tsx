import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuietProducts, TodoRow, todoSubject } from "./page";
import type { TodayItem } from "../../lib/api";

const names = {
  regns: new Map([["51", "강원특별자치도"]]),
  signgus: new Map([["51:210", "속초시"]]),
};
const products = new Map([[48, "경주 신라 역사기행 1박 2일"]]);

const news: TodayItem = {
  kind: "NEWS", productId: null, region: { regnCd: "51", signguCd: "210", month: "2026-11" },
  reason: "최근 새로 등록된 곳이 1곳 있습니다.", action: "NEW_PLAN",
};
const change: TodayItem = {
  kind: "CHANGE", productId: 48, region: null, reason: "담은 곳 1곳의 관광정보가 바뀌었습니다.", action: "REAUDIT",
};

describe("오늘 할 일 — 줄 머리 (#724)", () => {
  it("🔴 관심 지역 할 일은 지역 이름과 달을 줄 머리에 적는다 — 서버는 코드만 안다", () => {
    expect(todoSubject(news, products, names)).toBe("강원특별자치도 속초시 · 11월");
    const html = renderToStaticMarkup(<TodoRow item={news} subject={todoSubject(news, products, names)} />);
    expect(html).toContain("강원특별자치도 속초시 · 11월");
    expect(html).toContain("이 지역으로 새 상품 기획");
  });

  it("상품 할 일은 상품 이름을 적는다. 목록에 없는 상품이면 비운다 — 번호를 보이지 않는다", () => {
    expect(todoSubject(change, products, names)).toBe("경주 신라 역사기행 1박 2일");
    expect(todoSubject({ ...change, productId: 999 }, products, names)).toBeNull();
    const html = renderToStaticMarkup(<TodoRow item={{ ...change, productId: 999 }} subject={null} />);
    expect(html).not.toContain("data-todo-subject");
  });
});

describe("오늘 할 일 — 버튼 (#735)", () => {
  it("🔴 이미 다시 검수한 상품은 「검수 결과 보기」 다 — 레이더 카드와 같은 이름, 가는 곳은 상품 화면", () => {
    const html = renderToStaticMarkup(<TodoRow item={{ ...change, action: "VIEW_RESULT" }} subject="경주 신라 역사기행 1박 2일" />);
    expect(html).toContain("검수 결과 보기");
    expect(html).not.toContain("다시 검수");
    expect(html).toContain('href="/products/48"');
  });

  it("아직 다시 검수하지 않았으면 「다시 검수」 다", () => {
    const html = renderToStaticMarkup(<TodoRow item={change} subject={null} />);
    expect(html).toContain("다시 검수");
    expect(html).toContain('href="/products/48"');
  });
});

describe("바뀐 정보가 없는 상품 (FR-AG-031 · #724)", () => {
  it("🔴 접어 두고 몇 개인지만 먼저 보인다", () => {
    const lines = [1, 2, 3].map((id) => ({ productId: id, text: `상품 ${String(id)}은 바뀐 정보가 없어요.` }));
    const html = renderToStaticMarkup(<QuietProducts lines={lines} />);
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("바뀐 정보가 없는 상품 3개");
    expect(html).toContain("상품 2은 바뀐 정보가 없어요.");
  });

  it("없으면 아무것도 그리지 않는다", () => {
    expect(renderToStaticMarkup(<QuietProducts lines={[]} />)).toBe("");
  });
});
