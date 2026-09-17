import { PlanEditor } from "./plan-editor";

export default async function Page({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  return <PlanEditor productId={Number(productId)} />;
}
