import { describe, expect, it } from 'vitest';
import { REPORT_CACHE_MAX, REPORT_TTL_MS, ReportStore } from './report-store';

function make(store: ReportStore, accountId: number): string {
  return store.put({
    accountId,
    auditRunId: 1,
    fileName: 'r.pdf',
    pdf: Buffer.from('%PDF-1.3'),
  });
}

describe('리포트 보관소', () => {
  it('보관한 것을 소유자가 꺼낸다', () => {
    const store = new ReportStore();
    const id = make(store, 7);
    expect(store.get(id, 7)?.auditRunId).toBe(1);
  });

  it('🔴 남의 계정으로는 못 꺼낸다 — reportId 만으로 열리면 그게 공개 링크다 (PM-DA-007)', () => {
    const store = new ReportStore();
    const id = make(store, 7);
    expect(store.get(id, 8)).toBeNull();
  });

  it('🔴 수명이 지나면 없어진다 — 오래 들고 있으면 그건 저장이다', () => {
    let now = 1_000;
    const store = new ReportStore(() => now);
    const id = make(store, 7);

    now += REPORT_TTL_MS - 1;
    expect(store.get(id, 7)).not.toBeNull();

    now += 1;
    expect(store.get(id, 7)).toBeNull();
  });

  it('상한을 넘으면 오래된 것부터 버린다', () => {
    let now = 0;
    const store = new ReportStore(() => now);
    const first = make(store, 7);
    for (let i = 0; i < REPORT_CACHE_MAX; i += 1) {
      now += 1;
      make(store, 7);
    }
    expect(store.get(first, 7)).toBeNull();
  });

  it('식별자가 추측되지 않는다 — 순번이 아니다 (PM-DA-003)', () => {
    const store = new ReportStore();
    const ids = [make(store, 7), make(store, 7)];
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
