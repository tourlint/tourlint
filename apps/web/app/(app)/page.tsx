import { redirect } from "next/navigation";
import { ProductWorkspace } from "../components/product-workspace";

// 이전 북마크도 독립 화면으로 연결한다. 홈 자체에는 단계 필터가 없다.
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string }>;
}) {
  const { stage } = await searchParams;
  if (stage === "planning") redirect("/planning");
  if (stage === "review") redirect("/review");
  return <ProductWorkspace workspace="home" />;
}
