import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductCard, ProductTable } from "./product-workspace";
import { DeleteProductDialog } from "./delete-product-dialog";
import type { WorkspaceProduct } from "../lib/workspace";

const draft: WorkspaceProduct = { productId: 42, name: "강릉 일정", startDate: "2027-01-01", nights: 1, plannedAt: null };
const review = { ...draft, plannedAt: "2026-09-18" };
const noop = () => undefined;
describe("상품 작업 진입점", () => {
  it("기획 카드의 이동과 삭제는 별도 요소이며 링크 안에 버튼을 넣지 않는다", () => {
    const html = renderToStaticMarkup(<ProductCard product={draft} onDelete={noop} />);
    expect(html).toContain('href="/products/42/edit"');
    expect(html).toContain('aria-label="강릉 일정 기획 이어하기"');
    expect(html).toContain('aria-label="강릉 일정 삭제"');
    for (const anchor of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)) expect(anchor[0]).not.toContain('<button');
  });
  it("검수 카드와 표 모두 명시적 결과 버튼을 제공한다", () => {
    for (const html of [renderToStaticMarkup(<ProductCard product={review} onDelete={noop} />),
      renderToStaticMarkup(<ProductTable products={[review]} onDelete={noop} />)]) {
      expect(html).toContain('aria-label="강릉 일정 검수 결과 보기"');
      expect(html).toContain('href="/products/42"');
      expect(html).toContain('aria-label="강릉 일정 삭제"');
    }
  });
  it("삭제 확인은 대상 상품과 복구 불가를 알리고 취소에 초점을 둔다", () => {
    const html = renderToStaticMarkup(<DeleteProductDialog product={draft} onClose={noop} onDeleted={noop} />);
    expect(html).toContain("강릉 일정");
    expect(html).toContain("복구할 수 없습니다");
    expect(html).toMatch(/<button[^>]*autofocus=""[^>]*>취소/);
    expect(html).toContain('aria-describedby="delete-product-description"');
  });
});
