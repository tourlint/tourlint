import { describe, expect, it } from 'vitest';
import { SEVERITY_WEIGHT_DEFAULT } from '@tourlint/shared';
import { calculateReadiness } from '../engine/score';
import type { StoredAuditRun, StoredFinding } from '../persistence/audit-result.repository';
import {
  UNNAMED_PLACE, assembleReport, comparisonRows, describeItineraryChanges, externalSourcesOf, labelOnly,
  type AssembleInput, type ContentEvidence, type DiffableItem,
} from './report-model';

function finding(over: Partial<StoredFinding> = {}): StoredFinding {
  return {
    id: 1, ruleCode: 'R01', severity: 'ERROR', reasonCode: 'CLOSED_ON_VISIT',
    targetItemId: 11, targetItemId2: null, message: '방문일이 휴무일입니다.',
    evidence: {}, requiresExternal: false, externalSource: null,
    dismissed: false, dismissReason: null, confirmed: false, needsConfirmation: false,
    patches: [], ...over,
  } as StoredFinding;
}

function run(findings: readonly StoredFinding[], over: Partial<StoredAuditRun> = {}): StoredAuditRun {
  const weights = SEVERITY_WEIGHT_DEFAULT;
  const base = {
    id: 5, productId: 3, executedAt: new Date('2026-08-29T01:00:00.000Z'),
    rulesetVersion: 'r1', storedScore: 90, isPartial: false,
    targetCount: 2, failedCount: 0, weights, travelTotals: null, findings,
    ...over,
  };
  // `current` 는 덮어쓴 건수로 다시 계산한다 — 저장값이 아니라 조회 시점 값이다 (FR-AU-046)
  return {
    ...base,
    current: calculateReadiness({
      findings, weights, targetCount: base.targetCount, failedCount: base.failedCount,
    }),
  };
}

function item(over: Partial<AssembleInput['items'][number]> = {}): AssembleInput['items'][number] {
  return {
    itemId: 11, dayNo: 1, seq: 1, start: '10:00', end: '11:00',
    place: '내가 적은 이름', itemType: 'SIGHT', matchStatus: 'CONFIRMED',
    ktoContentId: '126508', walkId: null, ...over,
  };
}

function evidence(over: Partial<ContentEvidence> = {}): ContentEvidence {
  return {
    ktoContentId: '126508', officialName: '오죽헌', imageUrl: 'https://x/a.jpg',
    homepageUrl: null, contact: { tel: '033-640-4457' },
    fields: [{ name: 'restdate', value: '연중무휴' }],
    ktoModifiedTime: '20260801120000', hidden: false, unavailableReason: null,
    contentTypeId: 14, mapx: null, mapy: null, lclsSystm1: null, lclsSystm2: null, lclsSystm3: null, cpyrhtDivCd: null, ...over,
  };
}

function input(over: Partial<AssembleInput> = {}): AssembleInput {
  return {
    run: run([finding()]),
    product: {
      name: '강릉 2일', region: '강원특별자치도 강릉시', startDate: '2026-10-28',
      nights: 1, dayCount: 2, headCount: 20, transport: 'BUS', releasedAt: null,
    },
    items: [item()],
    patches: [],
    comparison: null,
    evidence: new Map([['126508', evidence()]]),
    walkNames: new Map(),
    dataFingerprint: 'ab12cd34',
    ktoModifiedAt: '20260801120000',
    generatedAt: new Date('2026-08-29T02:00:00.000Z'),
    ...over,
  };
}

describe('리포트 모델 조립', () => {
  it('🔴 판정마다 그 규칙의 버전을 싣는다 — 기능설명서 「판정마다 규칙 버전 병기」 (#848)', () => {
    const m = assembleReport(input({ run: run([finding({ ruleVersion: '1.0.5' })]) }));
    expect(m.findings.map((f) => f.ruleVersion)).toEqual(['1.0.5']);
  });

  it('🔴 무시된 항목 건수와 검수 제외 항목 건수를 둘 다 담는다 (FR-PA-064 · UI-S6-004)', () => {
    const m = assembleReport(input({
      run: run([finding(), finding({ id: 2, severity: 'WARNING', dismissed: true })]),
      items: [item(), item({ itemId: 12, seq: 2, matchStatus: 'EXCLUDED', ktoContentId: null })],
    }));
    expect(m.summary.dismissedCount).toBe(1);
    expect(m.summary.excludedItemCount).toBe(1);
  });

  it('🔴 걷기 길(walk_id)은 코스 이름으로 적고, 못 찾으면 "걷기 길" 로 적는다 (D9)', () => {
    const m = assembleReport(input({
      items: [
        item({ itemId: 21, seq: 1, matchStatus: 'EXCLUDED', ktoContentId: null, place: '', walkId: 'C-1' }),
        item({ itemId: 22, seq: 2, matchStatus: 'EXCLUDED', ktoContentId: null, place: '', walkId: 'C-9' }),
      ],
      walkNames: new Map([['C-1', '경포호 산책길']]),
    }));
    const places = m.itinerary.flatMap((d) => d.items.map((i) => i.place));
    expect(places).toContain('경포호 산책길');
    // 못 찾은 코스는 저장 라벨(빈칸)이 아니라 "걷기 길" 로 채운다 — 원문 이름을 지어내지 않는다
    expect(places).toContain('걷기 길');
  });

  it('🔴 적용 기준 머리글에 표준 · 회사 기준 · 무시 사유를 담는다 (FR-PA-064 · FR-OP-023)', () => {
    const m = assembleReport(input({
      run: run(
        [
          finding(),
          finding({ id: 2, severity: 'WARNING', dismissed: true, dismissReason: '고객 요청 사항' }),
        ],
        { settingSnapshot: { standardVersion: '2026.09', r07SpanHours: 6, r07MealMinutes: 90 } },
      ),
    }));
    expect(m.summary.appliedBasis).toBe('표준 2026.09 · 회사 기준 1건 (식사 90분) · 무시 1건 — 고객 요청 사항');
  });

  it('회사 기준이 표준과 같고 무시가 없으면 머리글은 표준 버전만 담는다', () => {
    const m = assembleReport(input({
      run: run([finding()], { settingSnapshot: { standardVersion: '2026.09', r07SpanHours: 6, r07MealMinutes: 60 } }),
    }));
    expect(m.summary.appliedBasis).toBe('표준 2026.09');
  });

  it('🔴 출처 표기를 문자 그대로 담는다 (FR-PA-062)', () => {
    expect(assembleReport(input()).provenance.source).toBe('출처: ⓒ한국관광공사');
  });

  it('데이터 출처에 조회 시각 · 지문 · 규칙셋 버전이 있다 (FR-PA-062 · UI-S6-005)', () => {
    const p = assembleReport(input()).provenance;
    expect(p.fetchedAt).toBe('2026-08-29T10:00:00+09:00');
    expect(p.dataFingerprint).toBe('ab12cd34');
    expect(p.rulesetVersion).toBe('r1');
  });

  it('공식 명칭을 읽었으면 일정표에 그 이름을 쓴다', () => {
    expect(assembleReport(input()).itinerary[0]?.items[0]?.place).toBe('오죽헌');
  });

  it('🔴 비표출 콘텐츠의 명칭이 일정표에 새지 않는다 (PM-NG-009)', () => {
    const m = assembleReport(input({
      evidence: new Map([['126508', evidence({ hidden: true, officialName: null, imageUrl: null })]]),
    }));
    const shown = m.itinerary[0]?.items[0];
    expect(shown?.place).toBe('내가 적은 이름');
    expect(JSON.stringify(m)).not.toContain('오죽헌');
  });

  it('확인 필요는 ⑥ 으로, 감점 판정은 ④ 로 갈린다', () => {
    const m = assembleReport(input({
      run: run([
        finding(),
        finding({ id: 2, severity: 'UNVERIFIED', reasonCode: 'REST_DAY_UNCERTAIN' }),
        finding({ id: 3, severity: 'WARNING', needsConfirmation: true }),
      ]),
    }));
    expect(m.findings.map((f) => f.severity)).toEqual(['ERROR']);
    expect(m.unverified).toHaveLength(2);
  });

  it('검수 제외 항목을 일정표에서 지우지 않고 배지로 남긴다 (FR-IN-025)', () => {
    const m = assembleReport(input({
      items: [item({ matchStatus: 'EXCLUDED', ktoContentId: null })],
    }));
    expect(m.itinerary[0]?.items[0]?.excluded).toBe(true);
    expect(m.itinerary[0]?.items).toHaveLength(1);
  });

  it('부분 검수는 점수를 담지 않는다 (DR-IN-005)', () => {
    const m = assembleReport(input({
      run: run([finding()], { isPartial: true, targetCount: 4, failedCount: 3 }),
    }));
    expect(m.summary.score).toBeNull();
  });
});

describe('데이터 출처의 외부 자료 (NF-CO-023 · #849)', () => {
  it('🔴 평년 근거를 쓴 판정이 있으면 기상청 평년값 출처를 기준 평년과 함께 적는다', () => {
    const lines = externalSourcesOf([finding({
      ruleCode: 'R09', externalSource: '기상청',
      evidence: { rainSource: 'CLIMATE', normalPeriod: '1991~2020', normalSource: '기상청 기상자료개방포털 · 대표지점 제주' },
    })]);
    expect(lines).toEqual(['출처: 기상청 기상자료개방포털 · 대표지점 제주 (평년값 1991~2020)']);
  });

  it('값을 남기기 전의 평년 판정은 표에 넣는 상수로 채운다', () => {
    const lines = externalSourcesOf([finding({ ruleCode: 'R09', externalSource: '기상청', evidence: { rainSource: 'CLIMATE' } })]);
    expect(lines).toEqual(['출처: 기상청 기상자료개방포털 (평년값 1991~2020)']);
  });

  it('예보 · 길찾기를 쓴 판정은 그 출처를 적는다', () => {
    const lines = externalSourcesOf([
      finding({ ruleCode: 'R09', externalSource: '기상청', evidence: { rainSource: 'MID' } }),
      finding({ ruleCode: 'R09', externalSource: '기상청', evidence: { rainSource: 'SHORT' } }),
      finding({ ruleCode: 'R08', externalSource: '카카오모빌리티' }),
    ]);
    expect(lines).toEqual(['출처: 기상청 (단기예보 · 중기예보)', '외부 참고: 카카오모빌리티 (이동시간)']);
  });

  it('외부 자료를 쓴 판정이 없으면 비운다', () => {
    expect(externalSourcesOf([finding()])).toEqual([]);
  });

  it('리포트 모델의 데이터 출처에 실린다', () => {
    const m = assembleReport(input({
      run: run([finding({ ruleCode: 'R08', externalSource: '카카오모빌리티' })]),
    }));
    expect(m.provenance.externalSources).toEqual(['외부 참고: 카카오모빌리티 (이동시간)']);
  });
});

describe('일정 변경 서술', () => {
  const base: DiffableItem = {
    id: 1, dayNo: 1, seq: 1, startTime: '10:00', endTime: '11:00',
    placeLabel: '오죽헌', ktoContentId: '126508',
  };

  it('추가 · 삭제 · 시각 변경 · 순서 변경을 구분한다 (FR-PA-042)', () => {
    expect(describeItineraryChanges([base], [{ ...base, startTime: '13:00' }])[0])
      .toContain('시각 변경');
    const next: DiffableItem = { ...base, id: 2, seq: 2, placeLabel: '경포대', ktoContentId: '125790' };
    // 두 줄의 차례를 맞바꾼다
    expect(describeItineraryChanges([base, next], [{ ...base, seq: 2 }, { ...next, seq: 1 }]).join('\n'))
      .toContain('순서 변경');
    expect(describeItineraryChanges([], [base])[0]).toContain('추가');
    expect(describeItineraryChanges([base], [])[0]).toContain('삭제');
  });

  it('🔴 이름을 저장하지 않는 항목을 null 로 찍지 않는다 (#595)', () => {
    /*
     * 장소 담기 · 수정안으로 넣은 항목은 이름을 저장하지 않는다 (DR-PR-001). 스냅샷 라벨을 그대로
     * 끼웠더니 운영 PDF 에 「순서 변경 — null 1일차 5번 → 1일차 3번」 · 「추가 — 3일차 16:00 」 이 찍혔다.
     */
    const picked: DiffableItem = { ...base, id: 2, placeLabel: null, ktoContentId: '2925502' };
    const inserted: DiffableItem = { ...base, id: 3, placeLabel: '', ktoContentId: '3537133' };

    const plain = describeItineraryChanges([picked], [{ ...picked, dayNo: 2, seq: 3 }, inserted]);
    expect(plain.join('\n')).not.toContain('null');
    expect(plain[0]).toBe(`순서 변경 — ${UNNAMED_PLACE} 1일차 1번 → 2일차 3번`);
    expect(plain[1]).toBe(`추가 — 1일차 10:00 ${UNNAMED_PLACE}`);

    // 표시 이름을 찾을 수 있으면 3절 일정표와 같은 이름을 쓴다
    const named = describeItineraryChanges([picked], [{ ...picked, dayNo: 2, seq: 3 }],
      (item) => (item.ktoContentId === '2925502' ? '리고엠' : labelOnly(item)));
    expect(named[0]).toBe('순서 변경 — 리고엠 1일차 1번 → 2일차 3번');
  });

  it('🔴 앞 줄이 빠지거나 옮겨져 순번만 밀린 줄은 순서 변경이 아니다 (#806)', () => {
    const a: DiffableItem = { ...base, id: 1, seq: 1, placeLabel: '녹색도시체험센터' };
    const b: DiffableItem = { ...base, id: 2, seq: 2, startTime: '12:00', endTime: '13:00', placeLabel: '가람집옹심이' };
    const c: DiffableItem = { ...base, id: 3, seq: 3, startTime: '16:45', endTime: '17:45', placeLabel: '오죽헌' };

    // 가운데 줄을 2일차로 옮기면 오죽헌은 3번 → 2번이 되지만 손댄 곳이 아니다
    const moved = describeItineraryChanges([a, b, c], [a, { ...b, dayNo: 2, seq: 1 }, { ...c, seq: 2 }]);
    expect(moved).toEqual(['순서 변경 — 가람집옹심이 1일차 2번 → 2일차 1번']);

    // 가운데 줄을 지워도 같다
    expect(describeItineraryChanges([a, b, c], [a, { ...c, seq: 2 }])).toEqual(['삭제 — 1일차 12:00 가람집옹심이']);
  });

  it('🔴 관광지 대체를 놓치지 않는다 — place_label 이 그대로라 이름만 보면 같아 보인다', () => {
    const changes = describeItineraryChanges([base], [{ ...base, ktoContentId: '999999' }]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain('관광지 대체');
  });
});

describe('수정 전후 비교 (FR-PA-043 · #806)', () => {
  it('🔴 화면 5 와 같은 단위로 적고, 총 감점에는 계산식을 붙인다', () => {
    expect(comparisonRows([
      { key: 'blocker', label: '차단', before: 2, after: 0 },
      { key: 'deduction', label: '총 감점', before: 71, after: 30, formulaBefore: '100 − 71', formulaAfter: '100 − 30' },
      { key: 'readinessScore', label: '출시 준비도', before: 29, after: 70 },
      { key: 'travelMinutes', label: '총 이동시간', before: 189, after: 213 },
      { key: 'travelMeters', label: '총 이동거리', before: 122_307, after: 122_307 },
      { key: 'targetFit', label: '수요 적합성', beforeText: '음식점 없음', afterText: '결손 유형 없음' },
    ])).toEqual([
      ['차단', '2', '0', '−2'],
      ['총 감점', '71 (100 − 71)', '30 (100 − 30)', '−41'],
      ['출시 준비도', '29', '70', '+41'],
      ['총 이동시간', '3시간 9분', '3시간 33분', '+24분'],
      ['총 이동거리', '122.3km', '122.3km', '변화 없음'],
      ['수요 적합성', '음식점 없음', '결손 유형 없음', '—'],
    ]);
  });

  it('값이 없으면 지어내지 않는다 — 부분 검수는 점수 · 감점이 없다', () => {
    expect(comparisonRows([{ key: 'readinessScore', label: '출시 준비도', before: 80, after: null }]))
      .toEqual([['출시 준비도', '80', '—', '—']]);
  });

  it('조립한 모델에 그대로 실린다', () => {
    const comparison = { appliedAt: '2026-09-25T20:00:00+09:00', rows: [['차단', '1', '0', '−1']] as const };
    expect(assembleReport(input({ comparison })).comparison).toEqual(comparison);
    expect(assembleReport(input()).comparison).toBeNull();
  });
});
