// 화면 3 · 검수 결과 (진단) (UI-S3 · F04~F07). 대시보드에서 상품 선택, 또는 등록 화면에서
// 저장 후 들어온다. 실제 렌더·데이터 로드는 클라이언트 컴포넌트가 한다 — 세션 쿠키로
// 같은 오리진 API 를 부르고, 검수 실행·무시/확정 같은 상호작용이 있기 때문이다.
import { AuditResult } from "./audit-result";

export default async function ProductAuditPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  const { productId } = await params;
  return <AuditResult productId={Number(productId)} />;
}
