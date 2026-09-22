import { describe, expect, it } from 'vitest';
import {
  EGRESS_IP_URL, EGRESS_PROBES, describeEgress, formatEgressReport, type EgressReport,
} from './egress-diagnostics';

/** url → 상태 · 본문. 없는 url 은 던진다(못 닿음) */
function fakeFetch(table: Record<string, { status: number; body?: string } | Error>, delayMs = 0) {
  const calls: string[] = [];
  const impl = async (url: string, init: { signal: AbortSignal }) => {
    calls.push(url);
    const entry = table[url];
    if (entry === undefined) throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') });
    if (entry instanceof Error) throw entry;
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        init.signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
    }
    return { status: entry.status, text: async () => entry.body ?? '' };
  };
  return { impl, calls };
}

const ok = (status: number, body?: string) => ({ status, body });

describe('발신 경로 진단 (#758)', () => {
  it('네 곳을 한 번씩 부르고, 닿았는지와 발신 IP 를 모은다 — 4xx 도 닿은 것이다', async () => {
    const f = fakeFetch({
      [EGRESS_IP_URL]: ok(200, '203.0.113.7\n'),
      'https://apis.data.go.kr/': ok(404),
      'https://apis-navi.kakaomobility.com/': ok(401),
      'https://www.google.com/generate_204': ok(204),
    });
    const r = await describeEgress(f.impl, 1000);
    expect(f.calls.sort()).toEqual([EGRESS_IP_URL, ...EGRESS_PROBES.map((p) => p.url)].sort());
    expect(r.ip).toBe('203.0.113.7');
    expect(r.probes.map((p) => [p.label, p.reached, p.detail])).toEqual([['공사', true, '404'], ['카카오', true, '401'], ['해외', true, '204']]);
    expect(formatEgressReport(r)).toMatch(/^발신 경로 진단: 전부 닿음 · 발신 IP 203\.0\.113\.7 · 공사 닿음\(\d+ms · 404\)/);
  });

  it('🔴 공사만 못 닿으면 「공사만 막힘」, 한국 둘 다 못 닿으면 「한국행 전부 막힘」, 셋 다면 「바깥 전부 막힘」', async () => {
    const only = await describeEgress(fakeFetch({
      [EGRESS_IP_URL]: ok(200, '198.51.100.9'),
      'https://apis-navi.kakaomobility.com/': ok(401),
      'https://www.google.com/generate_204': ok(204),
    }).impl, 1000);
    expect(formatEgressReport(only)).toContain('공사만 막힘');
    expect(only.probes.find((p) => p.label === '공사')).toMatchObject({ reached: false, detail: 'Error' });

    const korea = await describeEgress(fakeFetch({ 'https://www.google.com/generate_204': ok(204) }).impl, 1000);
    expect(formatEgressReport(korea)).toContain('한국행 전부 막힘 · 발신 IP 모름');

    const all = await describeEgress(fakeFetch({}).impl, 1000);
    expect(formatEgressReport(all)).toContain('바깥 전부 막힘');
  });

  it('🔴 응답이 없으면 시간 초과로 끝난다 — 부팅을 붙잡지 않는다', async () => {
    const f = fakeFetch({
      [EGRESS_IP_URL]: ok(200, '198.51.100.9'),
      'https://apis.data.go.kr/': ok(200),
      'https://apis-navi.kakaomobility.com/': ok(401),
      'https://www.google.com/generate_204': ok(204),
    }, 10_000);
    const started = Date.now();
    const r = await describeEgress(f.impl, 50);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.probes.every((p) => !p.reached && p.detail === '시간 초과')).toBe(true);
    expect(r.ip).toBeNull();
  });

  it('IP 응답이 IP 모양이 아니면 남기지 않는다 — HTML 오류 페이지를 IP 로 적지 않는다', async () => {
    const r = await describeEgress(fakeFetch({ [EGRESS_IP_URL]: ok(200, '<html>blocked</html>') }).impl, 1000);
    expect(r.ip).toBeNull();
    const r2 = await describeEgress(fakeFetch({ [EGRESS_IP_URL]: ok(503, '1.2.3.4') }).impl, 1000);
    expect(r2.ip).toBeNull();
  });

  it('진단 요청에는 키가 붙지 않는다 — 예산과 무관해야 한다', () => {
    for (const url of [EGRESS_IP_URL, ...EGRESS_PROBES.map((p) => p.url)]) {
      expect(url).not.toMatch(/serviceKey|Authorization|KakaoAK/i);
    }
    const sample: EgressReport = { ip: null, probes: [] };
    expect(formatEgressReport(sample)).toBe('발신 경로 진단: 바깥 전부 막힘 · 발신 IP 모름 · ');
  });
});
