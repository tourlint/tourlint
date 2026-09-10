import { describe, expect, it } from 'vitest';
import { SEVERITY_WEIGHT_DEFAULT } from '@tourlint/shared';
import { calculateReadiness } from '../engine/score';
import type { StoredAuditRun, StoredFinding } from '../persistence/audit-result.repository';
import {
  assembleReport, describeItineraryChanges,
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
    ktoContentId: '126508', ...over,
  };
}

function evidence(over: Partial<ContentEvidence> = {}): ContentEvidence {
  return {
    ktoContentId: '126508', officialName: '오죽헌', imageUrl: 'https://x/a.jpg',
    homepageUrl: null, contact: { tel: '033-640-4457' },
    fields: [{ name: 'restdate', value: '연중무휴' }],
    ktoModifiedTime: '20260801120000', hidden: false, unavailableReason: null, ...over,
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
    evidence: new Map([['126508', evidence()]]),
    dataFingerprint: 'ab12cd34',
    ktoModifiedAt: '20260801120000',
    generatedAt: new Date('2026-08-29T02:00:00.000Z'),
    ...over,
  };
}

describe('리포트 모델 조립', () => {
  it('🔴 무시된 항목 건수와 검수 제외 항목 건수를 둘 다 담는다 (FR-PA-064 · UI-S6-004)', () => {
    const m = assembleReport(input({
      run: run([finding(), finding({ id: 2, severity: 'WARNING', dismissed: true })]),
      items: [item(), item({ itemId: 12, seq: 2, matchStatus: 'EXCLUDED', ktoContentId: null })],
    }));
    expect(m.summary.dismissedCount).toBe(1);
    expect(m.summary.excludedItemCount).toBe(1);
  });

  it('🔴 출처 표기를 문자 그대로 담는다 (FR-PA-062)', () => {
    expect(assembleReport(input()).provenance.source).toBe('출처: ⓒ한국관광공사');
  });

  it('데이터 출처에 조회 시각 · 지문 · 규칙셋 버전이 있다 (FR-PA-062 · UI-S6-005)', () => {
    const p = assembleReport(input()).provenance;
    expect(p.fetchedAt).toBe('2026-08-29T01:00:00.000Z');
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

describe('일정 변경 서술', () => {
  const base: DiffableItem = {
    id: 1, dayNo: 1, seq: 1, startTime: '10:00', endTime: '11:00',
    placeLabel: '오죽헌', ktoContentId: '126508',
  };

  it('추가 · 삭제 · 시각 변경 · 순서 변경을 구분한다 (FR-PA-042)', () => {
    expect(describeItineraryChanges([base], [{ ...base, startTime: '13:00' }])[0])
      .toContain('시각 변경');
    expect(describeItineraryChanges([base], [{ ...base, seq: 2 }])[0]).toContain('순서 변경');
    expect(describeItineraryChanges([], [base])[0]).toContain('추가');
    expect(describeItineraryChanges([base], [])[0]).toContain('삭제');
  });

  it('🔴 관광지 대체를 놓치지 않는다 — place_label 이 그대로라 이름만 보면 같아 보인다', () => {
    const changes = describeItineraryChanges([base], [{ ...base, ktoContentId: '999999' }]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain('관광지 대체');
  });
});
