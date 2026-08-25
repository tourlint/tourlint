/**
 * 브라우저용 API 헬퍼.
 *
 * 항상 같은 오리진 `/api/*` 를 부르고(next.config 의 rewrite 가 API 서버로 넘긴다)
 * `credentials: "include"` 로 세션 쿠키를 함께 보낸다. 외부 API 를 브라우저에서 직접
 * 부르지 않는다 — 인증키는 서버에만 있다 (PM-SC-002).
 */
export interface ApiError {
  status: number;
  reasonCode?: string;
  message: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });

  if (res.status === 204) return undefined as T;

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const b = (body ?? {}) as { reasonCode?: string; message?: string };
    const err: ApiError = {
      status: res.status,
      reasonCode: b.reasonCode,
      // 서버가 준 단일 문구를 그대로 쓴다 — 화면이 사유를 지어내지 않는다 (EX-SY-004)
      message: b.message ?? "요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    };
    throw err;
  }
  return body as T;
}

export interface AccountView {
  email: string;
  isDemo: boolean;
}

export const authApi = {
  signup: (email: string, password: string) =>
    request<AccountView>("/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string) =>
    request<AccountView>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  me: () => request<AccountView>("/auth/me"),
};

export function isApiError(e: unknown): e is ApiError {
  return typeof e === "object" && e !== null && "status" in e && "message" in e;
}
