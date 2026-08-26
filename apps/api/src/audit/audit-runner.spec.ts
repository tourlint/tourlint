import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import { createKtoClient } from '../external/kto';
import {
  AuditRunner, departureStamp, uniqueContentIds,
  type ClimateNormalLookup, type ItineraryItemRow, type ProductRow,
} from './audit-runner';
import { FixtureKmaTransport, KmaClient } from '../external/kma';
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

function makeRunner(opts: {
  concurrency?: number;
  onProgress?: (d: number, t: number) => void;
  kma?: KmaClient;
  climate?: ClimateNormalLookup;
  clock?: () => Date;
}): AuditRunner {
  return new AuditRunner({
    kto: createKtoClient(new InMemoryApiCallLogger(), FIXTURE_ENV),
    clock: opts.clock ?? clock,
    concurrency: opts.concurrency,
    onProgress: opts.onProgress,
    kma: opts.kma,
    climate: opts.climate,
  });
}

const KMA_FIXTURES = join(__dirname, '../../../../fixtures/kma');
const kmaClient = (): KmaClient =>
  new KmaClient({ transport: new FixtureKmaTransport(KMA_FIXTURES), logger: new InMemoryApiCallLogger() });

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

describe('R09 — 강수 근거 수집 (FR-RU-091 · EI-WX-006)', () => {
  /** 강릉 좌표를 붙인 야외 항목. 격자 변환이 되어야 예보를 조회한다 */
  const outdoor = (id: number, dayNo: number): ItineraryItemRow =>
    item({ id, dayNo, seq: 1, placeLabel: '경포대', lclsSystm2: 'HS01', mapX: 128.8961, mapY: 37.7952 });

  it('기상청 클라이언트가 없으면 확인 불가로 남는다 — 정상이 아니다', async () => {
    const result = await runner().run(product, [outdoor(1, 1)]);

    const f = result.findings.find((x) => x.ruleCode === 'R09');
    expect(f?.severity).toBe('UNVERIFIED');
    expect(f?.reasonCode).toBe('FORECAST_UNAVAILABLE');
  });

  it('🔴 좌표가 하나도 없으면 좌표 없음으로 남는다', async () => {
    const result = await runner({ kma: kmaClient() }).run(product, [
      item({ id: 1, dayNo: 1, seq: 1, lclsSystm2: 'HS01' }),
    ]);

    const f = result.findings.find((x) => x.ruleCode === 'R09');
    expect(f?.reasonCode).toBe('COORD_MISSING');
  });

  it('평년 테이블이 없으면 D+11 이상은 확인 불가다 (이슈 #7)', async () => {
    // 검수 시각 2026-10-01, 출발 2026-10-13 → 전 일자가 D+11 이상이라 평년 경로다
    const result = await runner({ kma: kmaClient() }).run(product, [outdoor(1, 1)]);

    const f = result.findings.find((x) => x.ruleCode === 'R09');
    expect(f?.severity).toBe('UNVERIFIED');
    expect(f?.reasonCode).toBe('CLIMATE_DATA_MISSING');
  });

  it('평년 테이블이 있으면 그것으로 판정한다', async () => {
    const climate: ClimateNormalLookup = {
      find: async () => ({ rainDays: 9.2, rainRatio: 0.31, regionName: '강릉' }),
    };
    const withRegion: ProductRow = { ...product, ldongRegnCd: '51', ldongSignguCd: '150' };
    const result = await runner({ kma: kmaClient(), climate }).run(withRegion, [outdoor(1, 1)]);

    const f = result.findings.find((x) => x.ruleCode === 'R09');
    expect(f?.severity).toBe('WARNING');
    expect(f?.message).toContain('평년 기준 — 10월 강릉 강수일수 9.2일 (31%)');
  });

  /**
   * 픽스처 스냅샷을 뜬 날. 예보 날짜가 2026-08-26 ~ 08-30 이라 검수 시각을 그 근처로
   * 옮겨야 단기 · 중기 경로가 실제로 돈다. 기본 시계(2026-10-01)로는 전부 평년으로 빠진다.
   */
  const atSnapshot = (kstDate: string) => (): Date => new Date(`${kstDate}T09:00:00+09:00`);

  it('🔴 D+3 은 단기예보로 판정한다 — 중기에는 그 날 필드가 없다 (FR-RU-091)', async () => {
    // 2026-08-26 기준 D+3 = 08-29. 픽스처 단기예보의 그 날 15시 이후 강수확률이 60% 다
    const d3: ProductRow = { ...product, startDate: '2026-08-29', nights: 0 };
    const result = await runner({ kma: kmaClient(), clock: atSnapshot('2026-08-26') })
      .run(d3, [item({ id: 1, dayNo: 1, seq: 1, startTime: '15:00', endTime: '17:00',
                       placeLabel: '경포대', lclsSystm2: 'HS01', mapX: 128.8961, mapY: 37.7952 })]);

    const f = result.findings.find((x) => x.ruleCode === 'R09');
    expect(f?.severity).toBe('WARNING');
    expect(f?.evidence).toMatchObject({ rainSource: 'SHORT', rainProbability: 0.6 });
  });

  it('🔴 발표분이 담지 않은 날짜를 0% 로 읽지 않는다', async () => {
    /*
     * 픽스처는 08-26 발표분 고정이라 08-25 를 담고 있지 않다. 실호출이라면 어댑터의
     * 발표분 확인이 먼저 걸리지만, 발표분이 하루의 일부만 담는 경우는 실제로 있다 —
     * 그때 없는 날짜를 0% 로 읽으면 비 오는 날이 정상 판정된다.
     */
    const past: ProductRow = { ...product, startDate: '2026-08-25', nights: 0 };
    const result = await runner({ kma: kmaClient(), clock: atSnapshot('2026-08-25') })
      .run(past, [outdoor(1, 1)]);

    const f = result.findings.find((x) => x.ruleCode === 'R09');
    expect(f?.severity).toBe('UNVERIFIED');
    expect(f?.reasonCode).toBe('FORECAST_UNAVAILABLE');
  });

  it('🔴 평년 테이블에 그 지역 · 월이 없으면 확인 불가다', async () => {
    // 조회기를 붙였는데 값이 없는 경우다. 조회기 자체가 없는 경우와 다른 갈래를 탄다
    const empty: ClimateNormalLookup = { find: async () => null };
    const withRegion: ProductRow = { ...product, ldongRegnCd: '51', ldongSignguCd: '150' };
    const result = await runner({ kma: kmaClient(), climate: empty }).run(withRegion, [outdoor(1, 1)]);

    const f = result.findings.find((x) => x.ruleCode === 'R09');
    expect(f?.severity).toBe('UNVERIFIED');
    expect(f?.reasonCode).toBe('CLIMATE_DATA_MISSING');
  });

  it('일차마다 날짜가 다르므로 근거도 따로 잡힌다', async () => {
    const climate: ClimateNormalLookup = {
      find: async () => ({ rainDays: 9.2, rainRatio: 0.31, regionName: '강릉' }),
    };
    const withRegion: ProductRow = { ...product, ldongRegnCd: '51', ldongSignguCd: '150' };
    const result = await runner({ kma: kmaClient(), climate }).run(withRegion, [outdoor(1, 1), outdoor(2, 2)]);

    const dates = result.findings.filter((x) => x.ruleCode === 'R09').map((x) => x.evidence.date);
    expect(dates).toEqual(['2026-10-13', '2026-10-14']);
  });
});
