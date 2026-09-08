import { EditForm } from "./edit-form";

export default async function Page({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  return <EditForm productId={Number(productId)} />;
}
