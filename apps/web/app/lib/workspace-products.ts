import type { WorkspaceProduct } from "./workspace";

/** Read every page before calculating stage totals. The API defaults to only 20 products. */
export async function loadWorkspaceProducts(
  signal: AbortSignal,
): Promise<WorkspaceProduct[]> {
  const products = new Map<number, WorkspaceProduct>();
  let pages = 1;
  for (let page = 0; page < pages; page += 1) {
    const res = await fetch(`/api/v1/products?page=${page}&size=100`, {
      credentials: "include",
      signal,
    });
    if (!res.ok)
      throw {
        status: res.status,
        message: "상품을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.",
      };
    const data = (await res.json()) as {
      content?: WorkspaceProduct[];
      totalPages?: number;
    };
    if (!Array.isArray(data.content))
      throw new Error("상품 목록을 확인할 수 없어요. 다시 시도해 주세요.");
    pages = data.totalPages ?? 1;
    for (const product of data.content)
      products.set(product.productId, product);
  }
  return [...products.values()];
}
