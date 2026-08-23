import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import { createKtoClient } from '../external/kto';
import { AuditRunner, departureStamp, uniqueContentIds, type ItineraryItemRow, type ProductRow } from './audit-runner';
import { RULESET_VERSION } from './rule-registry';

/**
 * 파이프라인 관통 — **픽스처 리플레이로 공사 호출 0건**이다.
 *
 * D2 에서 리플레이를 넣은 이유가 여기 있다. 파이프라인을 고칠 때마다 실호출을 하면
 * 하루 예산 800건이 금방 마른다.
 */
const FIXTURE_ENV = {
  KTO_MODE: 'fixture',
  KTO_FIXTURE_DIR: join(__dirname, '../../../../fixtures/kto'),
};

const clock = (): Date => new Date('2026-10-01T09:00:00Z');

function runner(over: Partial<Parameters<typeof makeRunner>[0]> = {}): AuditRunner {
  return makeRunner({ ...over });
}

function makeRunner(opts: { concurrency?: number; onProgress?: (d: number, t: number) => void }): AuditRunner {
  return new AuditRunner({
    kto: createKtoClient(new InMemoryApiCallLogger(), FIXTURE_ENV),
    clock,
    concurrency: opts.concurrency,
    onProgress: opts.onProgress,
  });
}

const product: ProductRow = { id: 31, startDate: '2026-10-13', nights: 1, transport: 'CAR' };

const item = (over: Partial<ItineraryItemRow> & Pick<ItineraryItemRow, 'id' | 'dayNo' | 'seq'>): ItineraryItemRow => ({
  startTime: '10:00', endTime: '11:00', endTimeSource: 'INPUT',
  placeLabel: '테스트', itemType: 'SIGHT', ktoContentId: null, contentTypeId: null,
  lclsSystm1: null, lclsSystm2: null, lclsSystm3: null, mapX: null, mapY: null, matchStatus: 'CONFIRMED', ...over,
});

/** TP-03 의 축약판 — 실제 픽스처가 있는 콘텐츠만 골랐다 */
const TP03_LIKE: readonly ItineraryItemRow[] = [
  // 가람집옹심이(2868839, 음식점) — 매주 화요일 휴무 · 10/13 은 화요일 → 차단
  item({ id: 2, dayNo: 1, seq: 2, startTime: '12:00', endTime: '13:00', itemType: 'MEAL',
         placeLabel: '가람집옹심이', ktoContentId: '2868839', contentTypeId: 39, lclsSystm2: 'FD01' }),
  // 오죽헌(129784, 문화시설) — 가람집과 30분 중복 → 오류
  item({ id: 3, dayNo: 1, seq: 3, startTime: '12:30', endTime: '14:00',
         placeLabel: '오죽헌·시립박물관', ktoContentId: '129784', contentTypeId: 14, lclsSystm2: 'VE07' }),
  // 경포벚꽃축제(695592, 행사) — 2026-04-04~04-11 · 2일차 10/14 방문 → 차단
  item({ id: 5, dayNo: 2, seq: 1, startTime: '09:00', endTime: '10:00',
         placeLabel: '경포벚꽃축제', ktoContentId: '695592', contentTypeId: 15, lclsSystm2: 'EV01' }),
];

describe('uniqueContentIds — 같은 곳을 두 번 조회하지 않는다', () => {
  it('중복을 걷어낸다', () => {
    const targets = uniqueContentIds([
      item({ id: 1, dayNo: 1, seq: 1, ktoContentId: '125769', contentTypeId: 12 }),
      item({ id: 2, dayNo: 2, seq: 1, ktoContentId: '125769', contentTypeId: 12 }),
    ]);
    expect(targets).toHaveLength(1);
  });

  it('확정되지 않은 항목은 대상이 아니다', () => {
    expect(uniqueContentIds([
      item({ id: 1, dayNo: 1, seq: 1, ktoContentId: '125769', contentTypeId: 12, matchStatus: 'PENDING' }),
      item({ id: 2, dayNo: 1, seq: 2, ktoContentId: null, contentTypeId: null, matchStatus: 'EXCLUDED' }),
    ])).toHaveLength(0);
  });

  it('조회 순서를 고정한다 — 흔들리면 호출 로그와 진행률이 실행마다 달라진다', () => {
    const a = uniqueContentIds([
      item({ id: 1, dayNo: 1, seq: 1, ktoContentId: '999', contentTypeId: 12 }),
      item({ id: 2, dayNo: 1, seq: 2, ktoContentId: '1000', contentTypeId: 12 }),
    ]);
    const b = uniqueContentIds([
      item({ id: 2, dayNo: 1, seq: 1, ktoContentId: '1000', contentTypeId: 12 }),
      item({ id: 1, dayNo: 1, seq: 2, ktoContentId: '999', contentTypeId: 12 }),
    ]);
    expect(a).toEqual(b);
  });

  it('지원하지 않는 유형은 조회하지 않는다', () => {
    expect(uniqueContentIds([item({ id: 1, dayNo: 1, seq: 1, ktoContentId: '1', contentTypeId: 25 })])).toHaveLength(0);
  });
});

describe('AuditRunner — 관통', () => {
  it('TP-03 축약판에서 세 규칙이 모두 발동한다', async () => {
    const result = await runner().run(product, TP03_LIKE);

    const codes = result.findings.map((f) => f.reasonCode).sort();
    expect(codes).toContain('REST_DAY_CONFLICT'); // R01 — 가람집 화요일 휴무
    expect(codes).toContain('TIME_OVERLAP');      // R03 — 30분 중복
    expect(codes).toContain('EVENT_ENDED');       // R02 — 끝난 축제

    expect(result.targetCount).toBe(3);
    expect(result.failedCount).toBe(0);
    expect(result.rulesetVersion).toBe(RULESET_VERSION);
  });

  it('일차별 방문일을 출발일에서 계산한다', async () => {
    const result = await runner().run(product, TP03_LIKE);
    const overlap = result.findings.find((f) => f.reasonCode === 'REST_DAY_CONFLICT');
    // 1일차 = 2026-10-13(화)
    expect(overlap?.evidence.date).toBe('2026-10-13');
    const ended = result.findings.find((f) => f.reasonCode === 'EVENT_ENDED');
    // 2일차 = 2026-10-14
    expect(ended?.evidence.visitDate).toBe('2026-10-14');
  });

  it('콘텐츠마다 지문을 하나씩 만든다 (DR-FP-007)', async () => {
    const result = await runner().run(product, TP03_LIKE);
    expect(result.fingerprints).toHaveLength(3);
    for (const fp of result.fingerprints) {
      expect(fp.fieldHash).toMatch(/^[0-9a-f]{64}$/);
      expect(fp.fieldNames.length).toBeGreaterThan(0);
    }
    expect(result.runFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('점수를 산식대로 낸다', async () => {
    const result = await runner().run(product, TP03_LIKE);
    const c = result.score.counts;
    expect(result.score.score).toBe(
      Math.max(0, 100 - c.BLOCKER * 25 - c.ERROR * 10 - c.WARNING * 4 - c.UNVERIFIED * 3),
    );
    expect(result.score.releaseBlocked).toBe(true);
  });

  it('진행률을 갱신한다 — 폴링 응답에 쓰인다', async () => {
    const seen: string[] = [];
    await runner({ onProgress: (d, t) => seen.push(`${d}/${t}`) }).run(product, TP03_LIKE);
    expect(seen[0]).toBe('0/3');
    expect(seen[seen.length - 1]).toBe('3/3');
  });

  it('공사 호출을 한 곳당 한 번만 한다 — 같은 관광지가 두 번 나와도', async () => {
    const logger = new InMemoryApiCallLogger();
    const r = new AuditRunner({ kto: createKtoClient(logger, FIXTURE_ENV), clock });
    await r.run(product, [
      item({ id: 1, dayNo: 1, seq: 1, ktoContentId: '2868839', contentTypeId: 39 }),
      item({ id: 2, dayNo: 2, seq: 1, ktoContentId: '2868839', contentTypeId: 39 }),
    ]);
    const intro = logger.entries.filter((e) => e.operation === 'detailIntro2');
    expect(intro).toHaveLength(1);
  });

  describe('부분 성공 격리 (EX-CM 원칙 ①)', () => {
    it('조회 실패한 곳은 확인 불가로 남고 나머지는 정상 판정된다', async () => {
      const withMissing = [
        ...TP03_LIKE,
        item({ id: 9, dayNo: 1, seq: 9, placeLabel: '없는 관광지', ktoContentId: '99999999', contentTypeId: 12 }),
      ];
      const result = await runner().run(product, withMissing);

      expect(result.failedCount).toBe(1);
      const isolated = result.findings.find((f) => f.evidence.isolated === true);
      // 조회가 안 된 것이라 휴무 판정과 무관하다. 사유는 실패한 이유 그대로 단다
      expect(isolated).toMatchObject({
        severity: 'UNVERIFIED', targetItemId: 9, needsConfirmation: true,
        // 리플레이에서 스냅샷이 없는 건 조회 실패다. 실호출에서 공사가 없다고 답하면
        // `CONTENT_NOT_FOUND` 가 온다 — 둘을 뭉뚱그리지 않는다
        ruleCode: 'R05', reasonCode: 'KTO_FETCH_FAILED',
      });
      // 실패한 곳을 결과에서 지우지 않는다 (EX-CM-003)
      expect(isolated?.message).toContain('없는 관광지');
      // 나머지는 그대로 판정된다
      expect(result.findings.some((f) => f.reasonCode === 'EVENT_ENDED')).toBe(true);
    });

    it('실패가 50% 를 넘으면 점수를 내지 않는다 (FR-AU-029)', async () => {
      const items = [
        item({ id: 1, dayNo: 1, seq: 1, ktoContentId: '2868839', contentTypeId: 39 }),
        item({ id: 2, dayNo: 1, seq: 2, ktoContentId: '90000001', contentTypeId: 12 }),
        item({ id: 3, dayNo: 1, seq: 3, ktoContentId: '90000002', contentTypeId: 12 }),
      ];
      const result = await runner().run(product, items);
      expect(result.failedCount).toBe(2);
      expect(result.score.isPartial).toBe(true);
      expect(result.score.score).toBeNull();
    });

    it('실패한 콘텐츠는 지문을 만들지 않는다', async () => {
      const result = await runner().run(product, [
        item({ id: 1, dayNo: 1, seq: 1, ktoContentId: '90000001', contentTypeId: 12 }),
      ]);
      expect(result.fingerprints).toHaveLength(0);
      expect(result.runFingerprint).toBeNull();
    });
  });

  it('대상이 없으면 빈 결과를 낸다 — 던지지 않는다', async () => {
    const result = await runner().run(product, [
      item({ id: 1, dayNo: 1, seq: 1, matchStatus: 'EXCLUDED', ktoContentId: null }),
    ]);
    expect(result.findings).toEqual([]);
    expect(result.score.score).toBe(100);
  });

  describe('R05 — 아무도 안 보던 항목 (FR-RU-050 ~ 052)', () => {
    it('매칭이 확정되지 않은 항목이 결과에 남는다', async () => {
      /*
       * 이 항목은 R01 · R02 · R06 이 모두 물러난다. R05 가 없으면 결과에 한 줄도 안 남고
       * 화면에서는 검수를 통과한 것처럼 보인다 — 픽스처에 PENDING 항목이 하나도 없어
       * 정답셋으로는 이 경로가 안 돈다. 여기서 돌린다
       */
      const result = await runner().run(product, [
        ...TP03_LIKE,
        item({ id: 9, dayNo: 1, seq: 9, placeLabel: '이름만 적힌 곳', matchStatus: 'PENDING', ktoContentId: null }),
      ]);

      const f = result.findings.find((x) => x.targetItemId === 9);
      expect(f).toMatchObject({
        ruleCode: 'R05', severity: 'UNVERIFIED', reasonCode: 'PLACE_UNRESOLVED', needsConfirmation: true,
      });
      expect(f?.message).toContain('이름만 적힌 곳');
    });

    it('수정안을 만들지 않는다 (FR-RU-052) — 무엇을 고칠지 우리가 모른다', async () => {
      const result = await runner().run(product, [
        item({ id: 9, dayNo: 1, seq: 9, matchStatus: 'PENDING', ktoContentId: null }),
      ]);
      const f = result.findings.find((x) => x.ruleCode === 'R05');
      expect(f).toBeDefined();
      expect(f?.patches ?? []).toHaveLength(0);
    });

    it('확인 불가도 감점이다 — 모른다고 만점을 주지 않는다 (FR-RU-051)', async () => {
      const result = await runner().run(product, [
        item({ id: 1, dayNo: 1, seq: 1, ktoContentId: '2868839', contentTypeId: 39 }),
        item({ id: 9, dayNo: 1, seq: 9, matchStatus: 'PENDING', ktoContentId: null }),
      ]);
      expect(result.score.counts.UNVERIFIED).toBeGreaterThan(0);
      expect(result.score.score).not.toBe(100);
    });
  });

  it('결정론성 — 같은 입력이면 같은 결과다 (NF-MT-001)', async () => {
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await runner().run(product, TP03_LIKE));
    for (const r of runs) {
      expect(r.findings).toEqual(runs[0]?.findings);
      expect(r.runFingerprint).toBe(runs[0]?.runFingerprint);
      expect(r.score).toEqual(runs[0]?.score);
    }
  });

  it('동시 실행 수를 바꿔도 결과가 같다', async () => {
    const one = await runner({ concurrency: 1 }).run(product, TP03_LIKE);
    const eight = await runner({ concurrency: 8 }).run(product, TP03_LIKE);
    expect(one.findings).toEqual(eight.findings);
    expect(one.runFingerprint).toBe(eight.runFingerprint);
  });
});

describe('출발시각 조립 (EI-KM-003)', () => {
  it('YYYYMMDDHHMM 12자리를 만든다', () => {
    expect(departureStamp('2026-10-22', '13:00')).toBe('202610221300');
  });

  it('초가 붙어 와도 12자리다 — 여기서 틀리면 다른 시간대 소요시간이 온다', () => {
    // DB 의 time 타입은 HH:MM:SS 로 온다. 위층이 자르는 데 기대면 안 된다
    expect(departureStamp('2026-10-22', '13:00:00')).toBe('202610221300');
  });

  it('자정 넘김도 자리수를 지킨다', () => {
    expect(departureStamp('2026-01-05', '09:05')).toBe('202601050905');
  });

  it('시각이 깨져 있으면 붙이지 않는다 — 지어낸 시각으로 부르지 않는다', () => {
    expect(departureStamp('2026-10-22', '13')).toBeNull();
  });
});
