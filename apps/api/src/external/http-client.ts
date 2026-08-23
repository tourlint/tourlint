import { Agent, fetch as undiciFetch } from 'undici';

/**
 * 외부 호출용 HTTP 클라이언트 (EI-CM-004 · NF-PF-010).
 *
 * **연결과 응답의 타임아웃을 나눈다.** Node 전역 `fetch` 는 `AbortSignal.timeout()` 하나만
 * 받아 전체 시간만 자를 수 있는데, 그러면 상대 서버가 SYN 에 응답조차 안 하는 상황에서도
 * 10초를 기다린다. 한 번의 검수가 열 번쯤 부르므로 그 차이가 p95 로 그대로 쌓인다.
 *
 * undici 를 직접 물려 `connectTimeout` 을 따로 준다. 전역 `fetch` 도 결국 undici 지만
 * dispatcher 를 넘기는 경로가 버전에 따라 달라져, 우리가 설치한 undici 의 `fetch` 를 쓴다.
 */

export const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
export const DEFAULT_RESPONSE_TIMEOUT_MS = 10_000;

export interface AgentTimeouts {
  readonly connectTimeout: number;
  readonly headersTimeout: number;
  readonly bodyTimeout: number;
}

/**
 * 환경변수에서 타임아웃을 읽는다. 값이 없거나 숫자가 아니면 기본값이다.
 *
 * 0 이나 음수는 "타임아웃 없음" 으로 해석될 수 있어 받지 않는다 — 외부 호출에 상한이
 * 없으면 검수 작업이 통째로 매달린다.
 */
export function readAgentTimeouts(env: NodeJS.ProcessEnv = process.env): AgentTimeouts {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const response = read('HTTP_RESPONSE_TIMEOUT_MS', DEFAULT_RESPONSE_TIMEOUT_MS);
  return {
    connectTimeout: read('HTTP_CONNECT_TIMEOUT_MS', DEFAULT_CONNECT_TIMEOUT_MS),
    headersTimeout: response,
    bodyTimeout: response,
  };
}

let shared: Agent | undefined;

/** 연결을 재사용한다. 호출마다 새로 만들면 TLS 핸드셰이크가 매번 붙는다 */
export function sharedAgent(): Agent {
  shared ??= new Agent(readAgentTimeouts());
  return shared;
}

/** 테스트에서 환경을 바꾼 뒤 다시 만들게 한다 */
export function resetSharedAgent(): void {
  shared = undefined;
}

/**
 * 전역 `fetch` 와 같은 모양이되 dispatcher 가 물린 함수를 준다.
 *
 * 어댑터들은 이걸 기본값으로 받고, 테스트는 `fetchImpl` 로 갈아끼운다.
 */
export function createHttpFetch(): typeof globalThis.fetch {
  return ((input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: sharedAgent(),
    })) as unknown as typeof globalThis.fetch;
}

/**
 * 이 오류가 타임아웃인가.
 *
 * `AbortSignal.timeout()` 은 `TimeoutError` 를 던지지만, undici 의 연결·헤더·본문
 * 타임아웃은 `TypeError: fetch failed` 로 나오고 진짜 이유는 `cause.code` 에 있다.
 * 이름만 보면 연결 타임아웃이 네트워크 오류로 분류되어 호출 로그에 `TIMEOUT` 대신
 * `FETCH_ERROR` 로 남는다 — 느려서 끊긴 건지 못 붙은 건지 구분이 사라진다.
 */
const UNDICI_TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

export function isTimeoutError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  const code = (e as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === 'string' && UNDICI_TIMEOUT_CODES.has(code);
}
