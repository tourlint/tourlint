import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseKtoResponse } from './envelope';
import { KtoFetchError, KtoTimeoutError } from './kto.errors';
import { FixtureKtoTransport, HttpKtoTransport } from './transport';

const FIXTURES = join(__dirname, '../../../../../fixtures/kto');

describe('FixtureKtoTransport — 픽스처 리플레이 (KTO_MODE=fixture)', () => {
  const transport = new FixtureKtoTransport(FIXTURES);

  it('목록 조회는 오퍼레이션당 스냅샷 1개를 돌려준다', async () => {
    const { body, httpStatus } = await transport.request('searchKeyword2', { keyword: '강릉' });
    expect(httpStatus).toBeNull(); // HTTP 를 타지 않았다
    expect(parseKtoResponse('searchKeyword2', body).items.length).toBeGreaterThan(0);
  });

  it('상세 조회는 contentId 로 정확히 그 콘텐츠를 돌려준다', async () => {
    const { body } = await transport.request('detailIntro2', { contentId: '125769' });
    const item = parseKtoResponse('detailIntro2', body).items[0];
    expect(item?.contentid).toBe('125769');
  });

  it('파일명이 아니라 본문의 contentid 로 색인한다', async () => {
    // type15_695592.json — 파일명 접두사가 다른 규칙이지만 같은 방식으로 찾는다
    const { body } = await transport.request('detailIntro2', { contentId: '695592' });
    expect(parseKtoResponse('detailIntro2', body).items[0]?.contentid).toBe('695592');
  });

  it('contentid 소문자 파라미터도 받는다', async () => {
    const { body } = await transport.request('detailIntro2', { contentid: '125769' });
    expect(parseKtoResponse('detailIntro2', body).items[0]?.contentid).toBe('125769');
  });

  it('7개 유형 전부 리플레이된다', async () => {
    const ids = transport.availableContentIds('detailIntro2');
    const types = new Set<unknown>();
    for (const id of ids) {
      const { body } = await transport.request('detailIntro2', { contentId: id });
      types.add(String(parseKtoResponse('detailIntro2', body).items[0]?.contenttypeid));
    }
    expect([...types].sort()).toEqual(['12', '14', '15', '28', '32', '38', '39']);
  });

  it('없는 콘텐츠는 다른 응답으로 대체하지 않고 던진다', async () => {
    // 슬쩍 다른 관광지를 돌려주면 검수 결과가 그럴듯하게 틀린다
    await expect(transport.request('detailIntro2', { contentId: '99999999' })).rejects.toBeInstanceOf(KtoFetchError);
  });

  it('없는 콘텐츠 오류는 보유 목록을 알려준다', async () => {
    const e = await transport.request('detailIntro2', { contentId: '99999999' }).catch((x: unknown) => x);
    expect((e as Error).message).toContain('보유 목록');
    expect((e as Error).message).toContain('125769');
  });

  it('스냅샷이 없는 오퍼레이션은 어떤 것도 대신 돌려주지 않는다', async () => {
    const empty = new FixtureKtoTransport(mkdtempSync(join(tmpdir(), 'kto-fixture-')));
    await expect(empty.request('searchKeyword2', { keyword: '강릉' })).rejects.toThrow(/픽스처가 없다/);
  });

  it('같은 요청은 언제나 같은 본문을 돌려준다', async () => {
    const a = await transport.request('detailIntro2', { contentId: '129784' });
    const b = await transport.request('detailIntro2', { contentId: '129784' });
    expect(a.body).toBe(b.body);
  });
});

describe('HttpKtoTransport', () => {
  const opts = { serviceKey: 'TEST-KEY-DO-NOT-LOG', fetchImpl: async () => new Response('{}') };

  it('인증키가 비어 있으면 생성 단계에서 막는다', () => {
    // 키 없이 호출하면 전부 인증 오류로 돌아와 원인이 흐려진다
    expect(() => new HttpKtoTransport({ serviceKey: '' })).toThrow(/인증키/);
  });

  it('공사 필수 공통 파라미터를 붙인다', async () => {
    let seen = '';
    const t = new HttpKtoTransport({
      ...opts,
      fetchImpl: async (url) => {
        seen = String(url);
        return new Response('{}');
      },
    });
    await t.request('searchKeyword2', { keyword: '강릉' });
    const parsed = new URL(seen);
    expect(parsed.pathname).toMatch(/\/searchKeyword2$/);
    expect(parsed.searchParams.get('_type')).toBe('json');
    expect(parsed.searchParams.get('MobileOS')).toBe('ETC');
    expect(parsed.searchParams.get('MobileApp')).toBe('TourLint');
    expect(parsed.searchParams.get('keyword')).toBe('강릉');
  });

  it('타임아웃은 KtoTimeoutError 로 확정한다', async () => {
    const t = new HttpKtoTransport({
      serviceKey: 'k',
      timeoutMs: 5,
      fetchImpl: async () => {
        const e = new Error('timed out');
        e.name = 'TimeoutError';
        throw e;
      },
    });
    await expect(t.request('detailCommon2', {})).rejects.toBeInstanceOf(KtoTimeoutError);
  });

  it('HTTP 오류에 응답 본문을 담지 않는다 — 원문 누출 경로다', async () => {
    const t = new HttpKtoTransport({
      serviceKey: 'k',
      fetchImpl: async () => new Response('강릉 오죽헌 운영시간 09:00~18:00', { status: 503 }),
    });
    const e = await t.request('detailIntro2', {}).catch((x: unknown) => x);
    expect((e as KtoFetchError).httpStatus).toBe(503);
    expect((e as Error).message).not.toContain('오죽헌');
  });

  describe('인증키가 오류·예외 어디에도 새지 않는다 (EI-CM-002 · NF-SC-009)', () => {
    const KEY = 'SUPER-SECRET-SERVICE-KEY';

    it('네트워크 오류 메시지에 없다', async () => {
      const t = new HttpKtoTransport({ serviceKey: KEY, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
      const e = await t.request('searchKeyword2', {}).catch((x: unknown) => x);
      expect(JSON.stringify({ m: (e as Error).message, s: (e as Error).stack })).not.toContain(KEY);
    });

    it('HTTP 오류 메시지에 없다', async () => {
      const t = new HttpKtoTransport({ serviceKey: KEY, fetchImpl: async () => new Response('e', { status: 500 }) });
      const e = await t.request('searchKeyword2', {}).catch((x: unknown) => x);
      expect((e as Error).message).not.toContain(KEY);
    });

    it('타임아웃 메시지에 없다', async () => {
      const t = new HttpKtoTransport({
        serviceKey: KEY,
        timeoutMs: 1,
        fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; },
      });
      const e = await t.request('searchKeyword2', {}).catch((x: unknown) => x);
      expect((e as Error).message).not.toContain(KEY);
    });
  });
});
