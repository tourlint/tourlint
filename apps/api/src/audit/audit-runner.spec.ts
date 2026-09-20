import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STANDARD_VERSION, type TargetProfileSeed } from '@tourlint/shared';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import { DEFAULT_AUDIT_SETTINGS } from '../engine/rules/types';
import { createKtoClient, FixtureKtoTransport, KtoClient } from '../external/kto';
import {
  AuditRunner, DEFAULT_AUDIT_CONCURRENCY, concurrencyFromEnv, departureStamp,
  uniqueContentIds, withConcurrency,
  type ClimateNormalLookup, type ItineraryItemRow, type ProductRow,
  type TargetProfileLookup,
} from './audit-runner';
import { FixtureKmaTransport, KmaClient } from '../external/kma';
import { FixtureKakaoTransport, KakaoMobilityClient } from '../external/kakao';
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
  profileOf?: TargetProfileLookup;
  maxReplacementCalls?: number;
  settings?: typeof DEFAULT_AUDIT_SETTINGS;
}): AuditRunner {
  return new AuditRunner({
    kto: createKtoClient(new InMemoryApiCallLogger(), FIXTURE_ENV),
    clock: opts.clock ?? clock,
    concurrency: opts.concurrency,
    onProgress: opts.onProgress,
    kma: opts.kma,
    climate: opts.climate,
    profileOf: opts.profileOf,
    maxReplacementCalls: opts.maxReplacementCalls,
    settings: opts.settings,
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

  it('🔴 적용한 기준을 실행 결과에 남긴다 — 표준 버전과 회사 기준 두 값 (DR-CF-009)', async () => {
    const standard = await runner().run(product, TP03_LIKE);
    expect(standard.settingSnapshot).toEqual({ standardVersion: STANDARD_VERSION, r07SpanHours: 6, r07MealMinutes: 60 });

    const company = await runner({ settings: { ...DEFAULT_AUDIT_SETTINGS, r07MealMinutes: 90 } }).run(product, TP03_LIKE);
    expect(company.settingSnapshot).toEqual({ standardVersion: STANDARD_VERSION, r07SpanHours: 6, r07MealMinutes: 90 });
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

  describe('검수 제외 (FR-IN-025 · 026)', () => {
    const excluded = TP03_LIKE.map((i) => ({ ...i, matchStatus: 'EXCLUDED' as const, ktoContentId: null }));

    it('🔴 전 규칙의 판정 대상에서 빠진다 — 감점도 없다', async () => {
      const result = await runner().run(product, excluded);
      expect(result.findings).toEqual([]);
      expect(result.score.score).toBe(100);
    });

    it('🔴 이동 구간도 만들지 않는다 — 좌표가 없어 말할 근거가 없다', async () => {
      // R08 이 제외 항목 사이에 확인 불가를 내고 3점을 깎았다 (이슈 #348)
      const result = await runner().run(product, excluded);
      expect(result.findings.filter((f) => f.ruleCode === 'R08')).toEqual([]);
    });

    it('섞여 있으면 남은 것만 판정한다', async () => {
      const mixed = TP03_LIKE.map((i, idx) =>
        idx === 0 ? { ...i, matchStatus: 'EXCLUDED' as const } : i);
      const result = await runner().run(product, mixed);
      const excludedId = TP03_LIKE[0]?.id;
      expect(result.findings.some((f) => f.targetItemId === excludedId)).toBe(false);
      expect(result.findings.length).toBeGreaterThan(0);
    });
  });

  it('공사 호출을 한 곳당 한 번만 한다 — 같은 관광지가 두 번 나와도', async () => {
    // 리플레이는 호출 로그를 남기지 않으므로(FR-OP-007) transport 에서 센다
    const transport = new FixtureKtoTransport(FIXTURE_ENV.KTO_FIXTURE_DIR);
    const kto = new KtoClient({ transport, logger: new InMemoryApiCallLogger() });
    const r = new AuditRunner({ kto, clock });
    await r.run(product, [
      item({ id: 1, dayNo: 1, seq: 1, ktoContentId: '2868839', contentTypeId: 39 }),
      item({ id: 2, dayNo: 2, seq: 1, ktoContentId: '2868839', contentTypeId: 39 }),
    ]);
    expect(transport.replayCounts.get('detailIntro2')).toBe(1);
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

  /** 검수 시각(10-01) 기준 D+2. 단기예보 구간이라 기상청과 격자가 실제로 필요하다 */
  const soon: ProductRow = { ...product, startDate: '2026-10-03' };

  it('기상청 클라이언트가 없으면 확인 불가로 남는다 — 정상이 아니다', async () => {
    // 조용히 넘기면 「우천 위험 없음」 으로 읽힌다
    const result = await runner().run(soon, [outdoor(1, 1)]);

    const f = result.findings.find((x) => x.ruleCode === 'R09');
    expect(f?.severity).toBe('UNVERIFIED');
    expect(f?.reasonCode).toBe('FORECAST_UNAVAILABLE');
  });

  it('🔴 좌표가 하나도 없으면 좌표 없음으로 남는다', async () => {
    // 단기예보는 격자가 있어야 부른다. 평년 경로는 격자를 안 쓰므로 근거리로 본다
    const result = await runner({ kma: kmaClient() }).run(soon, [
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

  it('🔴 기상청이 없어도 평년값으로는 판정한다', async () => {
    /*
     * 필요한 것이 날짜마다 다르다 — 평년 경로(D+11 이상)는 기상청도 격자도 안 쓰고 표만 본다.
     * 그런데 기상청 클라이언트가 없으면 **여행일 전부**를 확인 불가로 돌리고 있었다.
     * 필요 없는 것이 없다는 이유로 판정을 포기하면 안 된다.
     */
    const climate: ClimateNormalLookup = {
      find: async () => ({ rainDays: 9.2, rainRatio: 0.31, regionName: '강릉' }),
    };
    const withRegion: ProductRow = { ...product, ldongRegnCd: '51', ldongSignguCd: '150' };
    // kma 를 안 넘긴다
    const result = await runner({ climate }).run(withRegion, [outdoor(1, 1)]);

    const f = result.findings.find((x) => x.ruleCode === 'R09');
    expect(f?.severity).toBe('WARNING');
    expect(f?.reasonCode).not.toBe('FORECAST_UNAVAILABLE');
  });

  it('🔴 좌표가 없어도 평년값으로는 판정한다', async () => {
    // 격자는 단기예보만 쓴다. 좌표가 없다고 두 달 뒤 일정까지 못 볼 이유가 없다
    const climate: ClimateNormalLookup = {
      find: async () => ({ rainDays: 9.2, rainRatio: 0.31, regionName: '강릉' }),
    };
    const withRegion: ProductRow = { ...product, ldongRegnCd: '51', ldongSignguCd: '150' };
    const noCoords = { ...outdoor(1, 1), mapX: null, mapY: null };
    const result = await runner({ kma: kmaClient(), climate }).run(withRegion, [noCoords]);

    const f = result.findings.find((x) => x.ruleCode === 'R09');
    expect(f?.severity).toBe('WARNING');
    expect(f?.reasonCode).not.toBe('COORD_MISSING');
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
    /*
     * 문장까지 본다. 빈 예보를 넘겨도 규칙이 "덮는 칸이 없다" 로 걸러 주기 때문에
     * 등급과 사유코드만 보면 러너가 손을 놔도 초록이 나온다. 사용자에게 할 말은 다르다 —
     * 조회 실패는 다시 시도할 일이고, 시간대 미커버는 일정을 옮길 일이다
     */
    expect(f?.message).toContain('강수 정보를 조회하지 못했습니다');
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

describe('R10 — 기대 프로파일 조회 (FR-RU-100)', () => {
  const sight = (id: number, lcls2: string): ItineraryItemRow =>
    item({ id, dayNo: 1, seq: id, placeLabel: '오죽헌·시립박물관', ktoContentId: '129784',
           contentTypeId: 14, lclsSystm2: lcls2 });

  const found = (expectedLcls2: string[], expectsNight = false): TargetProfileLookup =>
    (targetKey, conceptKey): TargetProfileSeed =>
      ({ targetKey, conceptKey, expectedLcls2, expectsNight } as TargetProfileSeed);

  it('🔴 타깃 · 콘셉트를 안 적은 상품은 R10 이 물러난다', async () => {
    // 선택 입력이다. 조회 자체를 하지 않는다
    let called = 0;
    const spy: TargetProfileLookup = () => { called++; return null; };
    const result = await runner({ profileOf: spy }).run(product, [sight(1, 'VE07')]);

    expect(called).toBe(0);
    expect(result.findings.filter((f) => f.ruleCode === 'R10')).toEqual([]);
  });

  it('🔴 조회기를 주지 않으면 표준 63행으로 판정한다 — 계정 표를 읽지 않는다', async () => {
    // 커플 · 감성 표준 = 카페/ 찻집(FD05) · 랜드마크(VE01) · 바다 · 강 풍경(NA02) · 저녁 일정
    const withTarget: ProductRow = { ...product, targetKey: 'COUPLE', conceptKey: 'EMOTIONAL', accountId: 7 };
    const result = await runner().run(withTarget, [sight(1, 'VE07')]);

    const f = result.findings.find((x) => x.ruleCode === 'R10');
    expect(f?.severity).toBe('WARNING');
    expect(f?.evidence).toMatchObject({
      expectedLcls2: ['FD05', 'VE01', 'NA02'], missingLcls2: ['FD05', 'VE01', 'NA02'], expectsNight: true,
    });
  });

  it('🔴 결손 유형을 빈 시간대에 넣는 수정안이 붙는다 (FR-RU-103)', async () => {
    /*
     * 「무엇을」 넣을지가 제안의 전부다. 자리만 비워 주면 사용자가 할 일이 안 준다.
     * 자리 계산은 0콜이고 콘텐츠만 위치기반 조회로 찾는다.
     */
    const withTarget: ProductRow = { ...product, targetKey: 'YOUTH_20S', conceptKey: 'EMOTIONAL', accountId: 7 };
    // 오전 · 오후 사이를 넉넉히 비워 둔다
    const morning = item({ id: 1, dayNo: 1, seq: 1, startTime: '09:00', endTime: '10:00',
                           placeLabel: '오죽헌', ktoContentId: '129784', contentTypeId: 14,
                           lclsSystm2: 'VE07', mapX: 128.898632, mapY: 37.753996 });
    const evening = item({ id: 2, dayNo: 1, seq: 2, startTime: '17:00', endTime: '18:00',
                           placeLabel: '경포대', ktoContentId: '125790', contentTypeId: 12,
                           lclsSystm2: 'VE07', mapX: 128.8961, mapY: 37.7955 });

    // 분류로 좁힌 위치기반 스냅샷이 있는 중분류를 결손으로 둔다 (`29_locationBasedList2_FD_FD05`)
    const lcls2 = 'FD05';
    const result = await runner({ profileOf: found(['VE07', lcls2]) })
      .run(withTarget, [morning, evening]);

    const r10 = result.findings.find((f) => f.ruleCode === 'R10');
    expect(r10?.evidence).toMatchObject({ missingLcls2: [lcls2] });
    const inserts = (r10?.patches ?? []).filter((p) => p.type === 'INSERT_ITEM');
    expect(inserts.length, '넣기 수정안이 안 붙었다').toBeGreaterThan(0);

    const payload = inserts[0]?.payload as { content?: { lclsSystm2: string | null }; startTime: string };
    // 결손 중분류로 채운다. 아무거나 넣는 제안이 아니다
    expect(payload.content?.lclsSystm2).toBe(lcls2);
    expect(payload.startTime).toBe('10:30');
  });

  it('🔴 제보된 일정 — 사이 공백이 좁고 야간이 빈 2박 3일에도 수정안이 붙는다 (#579)', async () => {
    /*
     * 「강릉 바다 2박 3일」 검수 #96 의 모양 그대로다. 항목 사이 공백이 30 ~ 60분뿐이고
     * 19:00 이후가 비어 있다. 「공예체험, 19:00 이후 일정이 없습니다」 에 수정안이 하나도 안 붙었다.
     *
     *   낮 자리  3일차 마지막 일정 뒤 — 결손 중분류(EX02)로 좁혀 찾는다
     *   야간 자리 1일차 19:00 — 숙소 근처에서 찾고, **그 시각에 여는 것이 확인된 곳만** 넣는다
     */
    const withTarget: ProductRow = {
      ...product, startDate: '2026-11-06', nights: 2, targetKey: 'YOUTH_20S', conceptKey: 'EMOTIONAL', accountId: 7,
    };
    const at = { mapX: 128.898632, mapY: 37.753996 };
    const place = (id: number, dayNo: number, seq: number, startTime: string, endTime: string | null,
                   over: Partial<ItineraryItemRow> = {}): ItineraryItemRow =>
      item({ id, dayNo, seq, startTime, endTime, placeLabel: `장소${String(id)}`, ktoContentId: '125790',
             contentTypeId: 12, lclsSystm2: 'NA02', ...at, ...over });
    const meal = { itemType: 'MEAL' as const, ktoContentId: '2868869', contentTypeId: 39 as const, lclsSystm2: 'FD01' };
    const hotel = { itemType: 'LODGING' as const, ktoContentId: '4074363', contentTypeId: 32 as const, lclsSystm2: 'AC01' };

    const itinerary = [
      place(1, 1, 1, '10:00', '11:30'), place(2, 1, 2, '12:30', '13:30', meal),
      place(3, 1, 3, '14:00', '16:00', { ktoContentId: '129784', contentTypeId: 14, lclsSystm2: 'VE07' }),
      place(4, 1, 4, '17:00', null, hotel),
      place(5, 2, 1, '10:00', '11:30'), place(6, 2, 2, '12:00', '13:00', meal),
      // 랜드마크는 있고 카페가 없다 — 공예체험 · 카페가 같이 결손이다 (#584 의 모양)
      place(7, 2, 3, '13:30', '14:30', { ktoContentId: '3022373', lclsSystm2: 'VE01' }),
      place(8, 2, 4, '15:00', '17:00'), place(9, 2, 5, '18:00', null, hotel),
      place(10, 3, 1, '10:00', '11:30'), place(11, 3, 2, '12:00', '13:30', meal),
      place(12, 3, 3, '14:00', '15:30', { ktoContentId: '3022373' }),
    ];
    const result = await runner().run(withTarget, itinerary);

    const r10 = result.findings.find((f) => f.ruleCode === 'R10');
    expect(r10?.evidence).toMatchObject({ missingLcls2: ['EX02', 'FD05'], expectsNight: true, hasNight: false });

    const inserts = (r10?.patches ?? []).map((p) => p.payload as {
      dayNo: number; startTime: string; endTime: string; content?: { ktoContentId: string; lclsSystm2: string | null };
    });
    /*
     * 야간이 먼저다 (#589) — 1일차 19:00. 결손인 공예체험부터 찾지만 그곳(2925502)은 이용시간이
     * 「체험에 따라 상이함」 이라 밤에 여는지 알 수 없어 떨어진다. 다음 결손인 카페로 넘어가
     * 가장 가까운 3532680 은 18:00 에 닫아 떨어지고 11:00~20:00 인 2891773 이 들어간다.
     * 카페 체류는 60분이라 20:00 에 끝난다. 이 하나로 「카페 없음」 과 「19:00 이후 없음」 이 풀린다.
     */
    expect(inserts[0]).toMatchObject({
      dayNo: 1, startTime: '19:00', endTime: '20:00', content: { ktoContentId: '2891773', lclsSystm2: 'FD05' },
    });
    // 낮 — 야간이 못 채운 공예체험만 맡는다. 3일차 15:30 뒤
    expect(inserts[1]).toMatchObject({ dayNo: 3, startTime: '16:00', content: { lclsSystm2: 'EX02' } });
    expect(inserts).toHaveLength(2);

    /*
     * 위치기반 조회가 2콜만 남은 검수 (#592). 운영에서 다른 finding 이 1콜을 먼저 썼다. 낮 자리
     * 몫 1콜을 빼면 야간은 1콜이다 — 그 한 콜을 공예체험에 쓰면 야간 수정안이 안 나온다.
     */
    const tight = await runner({ maxReplacementCalls: 2 }).run(withTarget, itinerary);
    const tightInserts = (tight.findings.find((f) => f.ruleCode === 'R10')?.patches ?? [])
      .map((p) => (p.payload as { startTime: string; content?: { lclsSystm2: string | null } }));
    expect(tightInserts.map((p) => [p.startTime, p.content?.lclsSystm2])).toEqual([['19:00', 'FD05'], ['16:00', 'EX02']]);
  });

  it('🔴 표준 목록에 없는 타깃 · 콘셉트(옛 자유 입력)면 확인 불가다', async () => {
    const withTarget: ProductRow = { ...product, targetKey: '20대 커플', conceptKey: '감성', accountId: 7 };
    const result = await runner().run(withTarget, [sight(1, 'VE07')]);

    const f = result.findings.find((x) => x.ruleCode === 'R10');
    expect(f?.severity).toBe('UNVERIFIED');
    expect(f?.evidence).toMatchObject({ targetKey: '20대 커플', conceptKey: '감성' });
  });

  it('🔴 조회가 깨져도 검수를 세우지 않는다 — 그 규칙만 확인 불가다', async () => {
    const withTarget: ProductRow = { ...product, targetKey: 'YOUTH_20S', conceptKey: 'EMOTIONAL', accountId: 7 };
    const broken: TargetProfileLookup = () => { throw new Error('표를 못 읽음'); };
    const result = await runner({ profileOf: broken }).run(withTarget, [sight(1, 'VE07')]);

    expect(result.findings.find((x) => x.ruleCode === 'R10')?.severity).toBe('UNVERIFIED');
    // 나머지 규칙은 그대로 돈다
    expect(result.score.score).toBeGreaterThan(0);
  });
});

describe('동시 실행 제한 (NF-PF-010)', () => {
  it('AUDIT_CONCURRENCY 로 조정된다 — 명세가 환경변수 조정을 요구한다', () => {
    expect(concurrencyFromEnv({ AUDIT_CONCURRENCY: '4' })).toBe(4);
    expect(concurrencyFromEnv({})).toBe(DEFAULT_AUDIT_CONCURRENCY);
  });

  it('🔴 러너가 실제로 환경변수를 읽는다', () => {
    // 함수만 맞고 배선이 안 돼 있으면, 값을 넣어도 조용히 기본값으로 돈다
    const saved = process.env.AUDIT_CONCURRENCY;
    process.env.AUDIT_CONCURRENCY = '3';
    try {
      expect(makeRunner({}).concurrency).toBe(3);
      // 넘겨준 값이 있으면 그게 이긴다
      expect(makeRunner({ concurrency: 5 }).concurrency).toBe(5);
    } finally {
      if (saved === undefined) delete process.env.AUDIT_CONCURRENCY;
      else process.env.AUDIT_CONCURRENCY = saved;
    }
  });

  it('🔴 0 이나 말이 안 되는 값은 기본값으로 간다', () => {
    // 0 을 그대로 받으면 조회가 한 건도 안 나가고 검수가 멈춘 것처럼 보인다
    for (const bad of ['0', '-2', '', 'eight', '3.5']) {
      expect(concurrencyFromEnv({ AUDIT_CONCURRENCY: bad }), bad).toBe(DEFAULT_AUDIT_CONCURRENCY);
    }
  });

  it('🔴 느린 하나가 나머지를 붙잡지 않는다 — 묶음이 아니라 미끄러지는 창이다', async () => {
    /*
     * `size` 개씩 잘라 `Promise.all` 로 기다리면 묶음의 가장 느린 호출이 끝날 때까지
     * 나머지 일꾼이 논다. 여기서는 느린 것 하나가 도는 동안 뒤의 것들이 먼저 끝나야 한다.
     */
    const started: number[] = [];
    const finished: number[] = [];
    let release = (): void => {};
    const blocked = new Promise<void>((r) => { release = r; });

    const work = withConcurrency([0, 1, 2, 3, 4], 2, async (i) => {
      started.push(i);
      if (i === 0) await blocked;
      finished.push(i);
    });

    // 0 이 막혀 있는 동안 1 이 끝나고 2 · 3 · 4 까지 들어간다
    await new Promise((r) => setImmediate(r));
    expect(finished).toContain(4);
    expect(finished).not.toContain(0);

    release();
    await work;
    expect(finished.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('동시 실행 수를 넘겨 돌리지 않는다', async () => {
    let running = 0;
    let peak = 0;
    await withConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setImmediate(r));
      running--;
    });
    expect(peak).toBe(3);
  });
});

describe('구간 캐시 (NF-PF-012 · EI-KM-006)', () => {
  /** 같은 좌표 · 같은 출발 시각으로 두 구간이 동시에 들어오는 상황 */
  const twoSamePlaces: readonly ItineraryItemRow[] = [
    item({ id: 1, dayNo: 1, seq: 1, startTime: '10:00', endTime: '11:00',
           placeLabel: 'A', mapX: 128.8, mapY: 37.7 }),
    item({ id: 2, dayNo: 1, seq: 2, startTime: '11:00', endTime: '12:00',
           placeLabel: 'B', mapX: 128.9, mapY: 37.8 }),
    // 같은 좌표 쌍이 같은 출발 시각으로 한 번 더 — 구간 2개가 같은 캐시 키를 문다
    item({ id: 3, dayNo: 1, seq: 3, startTime: '12:00', endTime: '11:00',
           placeLabel: 'A2', mapX: 128.8, mapY: 37.7 }),
    item({ id: 4, dayNo: 1, seq: 4, startTime: '13:00', endTime: '14:00',
           placeLabel: 'B2', mapX: 128.9, mapY: 37.8 }),
  ];

  /** 응답을 붙잡아 두는 카카오 스텁. 병렬로 들어온 것을 셀 수 있게 한다 */
  function slowKakao() {
    const calls: string[] = [];
    let release = (): void => {};
    const held = new Promise<void>((r) => { release = r; });
    const client = {
      route: async (o: { x: number; y: number }, d: { x: number; y: number }, at: string | null) => {
        calls.push(`${o.x},${o.y}>${d.x},${d.y}@${at ?? ''}`);
        await held;
        return { durationSeconds: 600, distanceMeters: 12000, futureBased: true };
      },
    };
    return { client, calls, release };
  }

  it('🔴 같은 구간이 동시에 들어와도 한 번만 부른다', async () => {
    /*
     * 결과만 캐시하면 둘 다 캐시를 못 보고 각자 호출한다 — 결과가 들어오기 전에 둘 다
     * 출발하기 때문이다. 병렬로 도는 이상 그게 정상 경로다 (NF-PF-010 과 함께 본다).
     */
    const { client, calls, release } = slowKakao();
    const runner = new AuditRunner({
      kto: createKtoClient(new InMemoryApiCallLogger(), FIXTURE_ENV),
      clock,
      kakao: client as never,
    });

    const running = runner.run(product, twoSamePlaces);
    await new Promise((r) => setImmediate(r));
    release();
    await running;

    const same = calls.filter((c) => c === calls[0]);
    expect(same).toHaveLength(1);
  });
});

describe('R08 대체 후보는 앞 항목 주변에서 찾는다 (FR-RU-083 ③)', () => {
  const GYEONGPO = { x: 128.898632, y: 37.753996 };
  const FAR = { x: 129.2, y: 37.2 };

  it('🔴 위치기반 조회 중심이 뒤 항목이 아니라 앞 항목이다', async () => {
    /*
     * 너무 먼 것이 문제인데 그 자리에서 찾으면 여전히 먼 것들만 나온다. 러너가 중심을
     * 안 넘기면 `proposeReplacements` 가 대체 대상 자리에서 찾는다 — 함수만 맞고 배선이
     * 빠지면 화면은 그대로다.
     */
    const centers: { x: number; y: number }[] = [];
    const real = createKtoClient(new InMemoryApiCallLogger(), FIXTURE_ENV);
    const kto = {
      ...real,
      detailCommon: real.detailCommon.bind(real),
      detailIntro: real.detailIntro.bind(real),
      locationBasedList: async (p: { mapX: number; mapY: number; radius: number }) => {
        centers.push({ x: p.mapX, y: p.mapY });
        return real.locationBasedList(p as never);
      },
    } as unknown as ReturnType<typeof createKtoClient>;

    // 이동에 아주 오래 걸린다고 답하는 지도 스텁 — R08 오류를 만든다
    const kakao = {
      route: async () => ({ durationSeconds: 7200, distanceMeters: 90_000, futureBased: true }),
    };

    const from = item({ id: 1, dayNo: 1, seq: 1, startTime: '10:00', endTime: '11:00',
                        placeLabel: '경포대', ktoContentId: '125790', contentTypeId: 12,
                        mapX: GYEONGPO.x, mapY: GYEONGPO.y });
    const to = item({ id: 2, dayNo: 1, seq: 2, startTime: '11:00', endTime: '12:00',
                      placeLabel: '먼 곳', ktoContentId: '129784', contentTypeId: 14,
                      mapX: FAR.x, mapY: FAR.y });

    const runner = new AuditRunner({ kto, clock, kakao: kakao as never });
    const result = await runner.run(product, [from, to]);

    const r08 = result.findings.filter((f) => f.ruleCode === 'R08' && f.reasonCode === 'TRAVEL_TIME_SHORT');
    const first = r08[0];
    expect(first, 'R08 이 안 났다').toBeDefined();
    expect((first?.patches ?? []).map((p) => p.type)).toContain('TIME_SHIFT');

    expect(centers.length, '위치기반 조회를 안 했다').toBeGreaterThan(0);
    expect(centers[0]?.x).toBeCloseTo(GYEONGPO.x, 4);
    expect(centers[0]?.y).toBeCloseTo(GYEONGPO.y, 4);
  });
});

describe('외부 조회 상한은 차단부터 쓴다 (#602 · NF-PF-014)', () => {
  const withTarget: ProductRow = { ...product, targetKey: 'YOUTH_20S', conceptKey: 'EMOTIONAL', accountId: 7 };
  const profileOf: TargetProfileLookup = (targetKey, conceptKey) =>
    ({ targetKey, conceptKey, expectedLcls2: ['FD01', 'FD05'], expectsNight: false } as TargetProfileSeed);

  /** 좌표는 픽스처 `detailCommon2` 의 실제 값이다 — 없으면 대체 후보를 못 찾는다 */
  // 10/13 은 화요일 — 가람집옹심이가 매주 화요일 휴무다. 2일차로 옮길 수 있어 0콜 수정안이 있다
  const restDay = item({ id: 1, dayNo: 1, seq: 1, startTime: '12:00', endTime: '13:00', itemType: 'MEAL',
                         placeLabel: '가람집옹심이', ktoContentId: '2868839', contentTypeId: 39, lclsSystm2: 'FD01',
                         mapX: 128.9393320379, mapY: 37.7611934162 });
  // 농산물도매시장은 18:00 에 닫는다 — 17:30~18:30 방문은 운영시간 차단이다
  const afterClose = item({ id: 2, dayNo: 1, seq: 2, startTime: '17:30', endTime: '18:30',
                            placeLabel: '농산물도매시장', ktoContentId: '1756581', contentTypeId: 38,
                            mapX: 128.9182652483, mapY: 37.7367152805 });
  const sightDay2 = item({ id: 3, dayNo: 2, seq: 1, startTime: '10:00', endTime: '11:00', placeLabel: '오죽헌',
                           ktoContentId: '129784', contentTypeId: 14, lclsSystm2: 'VE07',
                           mapX: 128.8797, mapY: 37.7791 });
  // 갈골한과체험전시관은 휴무일 정보가 없어 확인 불가다 — 0콜로 낼 것이 없어 굶는 쪽이다
  const uncertain = item({ id: 4, dayNo: 2, seq: 2, startTime: '13:00', endTime: '14:00',
                           placeLabel: '갈골한과체험전시관', ktoContentId: '3539725', contentTypeId: 14,
                           lclsSystm2: 'VE05', mapX: 128.8433165066, mapY: 37.8245592109 });

  it('🔴 한 콜뿐이면 차단이 쓴다 — 주의가 먼저 가져가면 차단에 대체가 안 붙는다', async () => {
    /*
     * 원래 순서는 규칙 번호 순이고 상한은 굶는 finding 부터 썼다. 그래서 **차단인 휴무일은
     * 0콜 수정안(날짜 이동)이 있다는 이유로 뒤로 밀려** 대체를 못 받았다 — 사용자는 다른 것을
     * 고치고 재검수해야 대체를 봤다 (#602). 차단이 먼저다.
     */
    const result = await runner({ profileOf, maxReplacementCalls: 1 }).run(withTarget, [restDay, sightDay2]);

    const r01 = result.findings.find((f) => f.reasonCode === 'REST_DAY_CONFLICT');
    expect(r01?.severity, 'R01 차단이 안 났다').toBe('BLOCKER');
    expect((r01?.patches ?? []).map((p) => p.type), '차단에 대체가 안 붙었다')
      .toEqual(expect.arrayContaining(['TIME_SHIFT', 'REPLACE_CONTENT']));
    // 한 콜을 차단이 썼으니 주의(R10)는 이번 검수에 못 받는다
    expect(result.findings.find((f) => f.ruleCode === 'R10')?.patches ?? []).toHaveLength(0);
  });

  it('🔴 기본 상한이면 차단 둘 · 확인 불가 · R10 이 모두 수정안을 받는다', async () => {
    /*
     * 상한을 앞에서부터 쓰던 때 **차단 두 건이 3콜을 소진해 R10 이 수정안 하나 없이** 떴다.
     * 등급 순으로 바꾼 뒤에도 그 일이 다시 나면 안 된다.
     *
     * **기본 상한이 4콜인 이유가 여기 있다** (#602). 3콜이면 마지막 순서인 확인 불가가 굶는다 —
     * 차단이 대체를 얻는 대신 확인 불가가 갖고 있던 대체를 잃으면 고친 것이 아니다.
     */
    const result = await runner({ profileOf }).run(withTarget, [restDay, afterClose, uncertain, sightDay2]);

    const blockers = result.findings.filter((f) => f.ruleCode === 'R01' && f.severity === 'BLOCKER');
    expect(blockers.length, '차단 두 건이 안 났다').toBe(2);
    for (const f of blockers) {
      expect((f.patches ?? []).map((p) => p.type), `${f.reasonCode} 에 대체가 없다`).toContain('REPLACE_CONTENT');
    }
    const unsure = result.findings.find((f) => f.reasonCode === 'REST_DAY_UNCERTAIN');
    expect((unsure?.patches ?? []).map((p) => p.type), '확인 불가가 굶었다').toContain('REPLACE_CONTENT');
    expect((result.findings.find((f) => f.ruleCode === 'R10')?.patches ?? []).length,
      'R10 이 수정안 없이 남았다').toBeGreaterThan(0);
  });
});


describe('이동 조회 → 겹침 수정안 관통 (#554)', () => {
  it('조회된 이동 분이 R08과 R03 수정안 모두에 전달된다', async () => {
    const r = new AuditRunner({
      kto: createKtoClient(new InMemoryApiCallLogger(), FIXTURE_ENV), clock,
      kakao: new KakaoMobilityClient({
        transport: new FixtureKakaoTransport(join(__dirname, '../../../../fixtures/kakao')),
        logger: new InMemoryApiCallLogger(),
      }),
    });
    const result = await r.run({ ...product, startDate: '2026-11-12', nights: 0 }, [
      item({ id: 501, dayNo: 1, seq: 1, startTime: '10:00', endTime: '11:30',
        placeLabel: '경포대', ktoContentId: '125790', contentTypeId: 12, mapX: 128.89648, mapY: 37.79551 }),
      item({ id: 502, dayNo: 1, seq: 2, startTime: '11:00', endTime: '12:30',
        placeLabel: '오죽헌', ktoContentId: '129784', contentTypeId: 14, mapX: 128.87966, mapY: 37.77913 }),
    ]);
    const travel = result.findings.find(f => f.ruleCode === 'R08');
    expect(travel?.evidence).toMatchObject({neededMinutes: 6, shortfallMinutes: 36});
    const overlap = result.findings.find(f => f.ruleCode === 'R03');
    expect(overlap?.patches?.map(p => p.payload)).toEqual([
      {newStartTime: '12:00', newEndTime: '13:30'}, {newEndTime: '10:54'},
    ]);
  });
});
