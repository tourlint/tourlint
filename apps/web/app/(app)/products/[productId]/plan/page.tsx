import { PlanEditor } from "./plan-editor";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  // "자주 넣는 곳" 칩에서 넘어오면 그 종류로 장소 담기를 연다 (UI-S2-030)
  searchParams: Promise<{ openType?: string }>;
}) {
  const { productId } = await params;
  const { openType } = await searchParams;
  return <PlanEditor productId={Number(productId)} openType={openType ?? null} />;
}
