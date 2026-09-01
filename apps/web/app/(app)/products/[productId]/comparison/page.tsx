// 화면 5 · 수정 전후 비교 (UI-S5 · F10). 직전 패치의 전후 한 쌍을 지표로 대조한다.
// 데이터 로드·되돌리기·리포트 생성이 있어 렌더는 클라이언트가 한다.
import { ComparisonView } from "./comparison-view";

export default async function ComparisonPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  const { productId } = await params;
  return <ComparisonView productId={Number(productId)} />;
}
