import Link from "next/link";

// 화면 3 · 검수 결과 (진단) (UI-S3 · F04~F07). 특정 상품에 종속된 흐름 —
// 대시보드에서 상품 선택, 또는 등록 화면에서 관광지 확정 후 검수 실행으로 들어온다.
// 골격만 — 요약 영역, finding 목록, 확인 필요 목록, 검수 근거 영역은 후속 작업.
export default async function ProductAuditPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  const { productId } = await params;

  return (
    <>
      <nav className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        <Link href="/" className="hover:underline">
          대시보드
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-700 dark:text-slate-300">상품 #{productId}</span>
      </nav>

      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">검수 결과</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        상품 #{productId} 의 진단 결과입니다. (F04~F07)
      </p>

      <div className="mt-10 rounded-2xl border border-dashed border-slate-300 py-16 text-center text-sm text-slate-400 dark:border-slate-700 dark:text-slate-500">
        요약 · finding 목록 · 검수 근거 영역은 다음 단계에서 붙습니다.
      </div>
    </>
  );
}
