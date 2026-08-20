// apps/web/app/page.tsx — STEP 8: mock API로 상품 목록 렌더링
// 게이트 2번("mock API로 화면 1개 렌더링") 충족용 최소 화면.
// UI-S1(상품 대시보드)의 뼈대이며, W1에서 등급 배지·호출 예산 위젯을 붙여 확장한다.

type Product = {
  productId: number;
  name: string;
  startDate: string;
  nights: number;
  region?: { regnName?: string; signguName?: string };
  latestAudit?: {
    readinessScore: number | null;
    isPartial: boolean;
    counts: { blocker: number; error: number; warning: number; unverified: number };
    executedAt: string;
  };
  unreadNotifications?: number;
};

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

async function getProducts(): Promise<Product[]> {
  const res = await fetch(`${API}/api/v1/products`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const json = await res.json();
  return json.content ?? [];
}

const NIGHTS_LABEL = ['당일', '1박 2일', '2박 3일'];

export default async function Page() {
  let products: Product[] = [];
  let error: string | null = null;
  try {
    products = await getProducts();
  } catch (e) {
    error = e instanceof Error ? e.message : '조회 실패';
  }

  return (
    <main className="mx-auto max-w-5xl p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">TourLint · 상품 대시보드</h1>
        <p className="mt-1 text-sm text-gray-500">
          검수 대상: 당일 ~ 2박 3일 · 최대 구간 12곳 · mock API 연결 확인용 화면
        </p>
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-700">
          API를 조회하지 못했습니다 ({error}). <code>pnpm start:dev</code>로 apps/api가 떠 있는지 확인해 주세요.
        </div>
      )}

      {!error && products.length === 0 && (
        <p className="text-sm text-gray-500">등록된 상품이 없습니다.</p>
      )}

      {products.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="p-3">상품명</th>
              <th className="p-3">지역</th>
              <th className="p-3">출발일</th>
              <th className="p-3">일정</th>
              <th className="p-3">출시 준비도</th>
              <th className="p-3">차단/오류/주의/확인불가</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const a = p.latestAudit;
              return (
                <tr key={p.productId} className="border-b">
                  <td className="p-3 font-medium">{p.name}</td>
                  <td className="p-3">{[p.region?.regnName, p.region?.signguName].filter(Boolean).join(' ') || '-'}</td>
                  <td className="p-3">{p.startDate}</td>
                  <td className="p-3">{NIGHTS_LABEL[p.nights] ?? `${p.nights}박`}</td>
                  <td className="p-3">
                    {a?.isPartial ? <span className="rounded bg-gray-200 px-2 py-0.5">부분 검수</span>
                      : a?.readinessScore != null ? <strong>{a.readinessScore}점</strong> : '-'}
                  </td>
                  <td className="p-3 tabular-nums">
                    {a ? `${a.counts.blocker} / ${a.counts.error} / ${a.counts.warning} / ${a.counts.unverified}` : '-'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <footer className="mt-10 border-t pt-4 text-xs text-gray-500">출처: ⓒ한국관광공사</footer>
    </main>
  );
}
