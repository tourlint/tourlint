import type { NextConfig } from "next";

/**
 * 브라우저는 `/api/*` 를 **같은 오리진**으로 부르고, Next 가 그걸 API 서버로 프록시한다.
 * 이렇게 해야 세션 쿠키가 `SameSite=Lax` 로도 그대로 실린다 (NF-SC-002) — 웹과 API 를
 * 서로 다른 오리진으로 직접 부르면 Lax 쿠키가 fetch 에 붙지 않는다.
 */
const API_ORIGIN = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` }];
  },
};

export default nextConfig;
