/**
 * 부팅 때 한 번, 이 컨테이너가 바깥으로 어떻게 나가는지 한 줄로 남긴다 (#758).
 *
 * 2026-09-21 · 22 에 새 컨테이너가 공사 게이트웨이에 못 닿는 일이 배포 14번 중 3번 있었다.
 * 흐름 로그로는 SYN 만 나가고 돌아오는 패킷이 없다는 것까지 보이는데, 그것이 「이 발신 IP 를
 * 공사 쪽이 버리는 것」 인지 「이 호스트에서 한국으로 가는 경로가 불량한 것」 인지는 가릴 수
 * 없다 — 흐름 로그는 컨테이너 안쪽 IP(10.x)만 보여 준다.
 *
 * 그래서 네 곳에 아주 작은 요청을 보낸다: 발신 IP 를 되돌려 주는 곳 · 공사 게이트웨이 · 카카오
 * (한국 · 다른 망) · 해외 대조. **닿았는지만 본다** — 4xx 도 닿은 것이다. 키를 붙이지 않으니
 * 예산과 무관하고, 실패해도 부팅 · 예열에 영향이 없다. 이 요청들은 흐름 로그에도 남으므로 앱
 * 로그가 안 남는 FAILED 컨테이너에서도 「공사만 안 닿는지 · 한국 전부 안 닿는지」 를 가를 수 있다.
 */

export interface EgressProbeTarget {
  readonly label: string;
  readonly url: string;
}

/** 순서대로 로그에 찍힌다. 공사 → 한국 다른 망 → 해외 순이라 어디서부터 끊기는지 읽힌다 */
export const EGRESS_PROBES: readonly EgressProbeTarget[] = [
  { label: '공사', url: 'https://apis.data.go.kr/' },
  { label: '카카오', url: 'https://apis-navi.kakaomobility.com/' },
  { label: '해외', url: 'https://www.google.com/generate_204' },
];

/** 발신 IP 를 본문으로 되돌려 주는 곳. 못 받으면 IP 없이 나머지만 적는다 */
export const EGRESS_IP_URL = 'https://api.ipify.org/?format=text';

export const EGRESS_TIMEOUT_MS = 5_000;

export interface EgressProbeResult {
  readonly label: string;
  readonly reached: boolean;
  readonly ms: number;
  /** 닿았으면 HTTP 상태, 못 닿았으면 오류 이름 */
  readonly detail: string;
}

export interface EgressReport {
  readonly ip: string | null;
  readonly probes: readonly EgressProbeResult[];
}

type FetchLike = (url: string, init: { signal: AbortSignal; redirect: 'manual' }) => Promise<{ status: number; text(): Promise<string> }>;

/** 네 요청을 나란히 보내고 결과를 모은다. 절대 던지지 않는다 */
export async function describeEgress(
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = EGRESS_TIMEOUT_MS,
): Promise<EgressReport> {
  const [ip, ...probes] = await Promise.all([
    egressIp(fetchImpl, timeoutMs),
    ...EGRESS_PROBES.map((t) => probe(t, fetchImpl, timeoutMs)),
  ]);
  return { ip, probes };
}

async function egressIp(fetchImpl: FetchLike, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  try {
    const res = await fetchImpl(EGRESS_IP_URL, { signal: controller.signal, redirect: 'manual' });
    if (res.status !== 200) return null;
    const text = (await res.text()).trim();
    // IP 모양이 아니면 남기지 않는다 — 응답이 HTML 오류 페이지일 수 있다
    return /^[0-9a-f.:]{7,45}$/i.test(text) ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probe(target: EgressProbeTarget, fetchImpl: FetchLike, timeoutMs: number): Promise<EgressProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(target.url, { signal: controller.signal, redirect: 'manual' });
    return { label: target.label, reached: true, ms: Date.now() - started, detail: String(res.status) };
  } catch (e) {
    const name = e instanceof Error ? (e.name === 'AbortError' ? '시간 초과' : (e.cause instanceof Error ? e.cause.name : e.name)) : String(e);
    return { label: target.label, reached: false, ms: Date.now() - started, detail: name };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 결과를 한 줄로. 맨 앞의 진단 낱말이 흐름을 가른다 —
 * 공사만 막힘 → 공사 쪽 필터 가능성 · 한국 전부 막힘 → 경로 문제 · 전부 막힘 → 컨테이너 발신 자체 문제.
 */
export function formatEgressReport(r: EgressReport): string {
  const by = new Map(r.probes.map((p) => [p.label, p.reached]));
  const kto = by.get('공사') === true;
  const kakao = by.get('카카오') === true;
  const abroad = by.get('해외') === true;
  const verdict = kto ? '전부 닿음'
    : kakao ? '공사만 막힘'
      : abroad ? '한국행 전부 막힘'
        : '바깥 전부 막힘';
  const parts = r.probes.map((p) => `${p.label} ${p.reached ? '닿음' : '못 닿음'}(${String(p.ms)}ms · ${p.detail})`);
  return `발신 경로 진단: ${verdict} · 발신 IP ${r.ip ?? '모름'} · ${parts.join(' · ')}`;
}
