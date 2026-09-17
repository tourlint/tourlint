import { ProductWorkspace } from "../../components/product-workspace";
import { reviewFilter } from "../../lib/workspace";

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const filter = reviewFilter((await searchParams).status);
  return (
    <ProductWorkspace key={filter} workspace="review" initialFilter={filter} />
  );
}
