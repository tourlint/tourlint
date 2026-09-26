import {
  CLIMATE_NORMAL_PERIOD, CLIMATE_SOURCE_NOTE, findingMessage, SETTING_DEFAULTS, STANDARD_VERSION, type Severity, kstIso,
} from '@tourlint/shared';
import type { ContentView } from '../external/kto';
import type { StoredAuditRun, StoredFinding } from '../persistence/audit-result.repository';
import type { ComparisonMetric } from '../audit/comparison-metrics';

/**
 * 검수 리포트 7섹션 데이터 모델 (FR-PA-061 · UI-S6-001).
 *
 * 조립은 **순수 함수**다. DB 도 공사도 부르지 않고 받은 것만 엮는다 — 렌더러와 따로
 * 시험할 수 있어야 섹션 구성·건수 표기 같은 규정을 테스트로 잡는다.
 *
 * ## 여기서 지키는 규정
 *
 * - 관광지 이미지를 **임베드하지 않고 URL 로만** 싣는다 (FR-PA-063 · UI-S6-003)
 * - 무시된 항목 건수와 검수 제외 항목 건수를 **명시**한다 (FR-PA-064 · UI-S6-004)
 * - 비표출 콘텐츠의 명칭 · 주소 · 이미지는 **어디에도 넣지 않는다** (PM-NG-009)
 * - 데이터 출처에 조회 시각 · 지문 · 규칙셋 버전 · 출처 표기를 담는다 (FR-PA-062)
 */

/** 공사 원문 근거 한 콘텐츠 몫 (UI-S6-002). 못 읽었으면 `unavailableReason` 이 찬다 */
/**
 * 리포트가 싣는 관광지 근거. 조달은 화면과 같은 `fetchContentView` 가 한다 —
 * 두 벌로 두면 한쪽만 고쳐진다 (FR-AU-013 · 061 · 081).
 */
export type ContentEvidence = ContentView;

export interface ReportProduct {
  readonly name: string;
  readonly region: string;
  readonly startDate: string;
  readonly nights: number;
  readonly dayCount: number;
  readonly headCount: number | null;
  readonly transport: string;
  readonly releasedAt: string | null;
  /** 1절 「기획 출처」 한 줄 — 시작 방식 · 줄마다 들어온 경로 · 고른 방식 (FR-PL-020). `assembleReport` 가 채운다 */
  readonly planning?: string;
}

export interface ReportSummary {
  readonly score: number | null;
  readonly breakdown: string;
  readonly isPartial: boolean;
  readonly releasable: boolean;
  readonly releaseBlockedReason: string | null;
  readonly counts: Readonly<Record<Severity, number>>;
  /**
   * 적용 기준 머리글 (FR-PA-064 · FR-OP-023). "표준 2026.09 · 회사 기준 1건 (식사 90분) ·
   * 무시 1건 — 고객 요청 사항" 처럼, 이 검수에 적용한 표준 버전 · 회사 기준 · 무시 내역을 적는다.
   */
  readonly appliedBasis: string;
  /** 무시된 항목 건수 (FR-PA-064) */
  readonly dismissedCount: number;
  /** 검수 제외 항목 건수 (FR-PA-064 · FR-IN-026) */
  readonly excludedItemCount: number;
  readonly needsConfirmationCount: number;
  readonly targetCount: number;
  readonly failedCount: number;
}

export interface ReportItem {
  readonly seq: number;
  readonly start: string;
  readonly end: string | null;
  /** 표시명. 사용자 입력(`place_label`)이 기본이고 공식 명칭을 읽었으면 그것 */
  readonly place: string;
  readonly itemType: string;
  readonly matchStatus: string;
  /** 검수에서 빠진 항목. 일정표에서 지우지 않고 배지로 표시한다 (UI-S3-…·FR-IN-025) */
  readonly excluded: boolean;
}

export interface ReportDay {
  readonly dayNo: number;
  readonly items: readonly ReportItem[];
}

export interface ReportFinding {
  readonly ruleCode: string;
  /** 그 판정을 낸 규칙의 버전. 기능설명서가 「판정마다 규칙 버전을 병기」라고 적었다 (#848) */
  readonly ruleVersion: string;
  readonly severity: Severity;
  readonly message: string;
  readonly dismissed: boolean;
  /** 무시 사유 (FR-AU-068). 무시된 항목만 채워진다 */
  readonly dismissReason: string | null;
  readonly confirmed: boolean;
  /** 감점에서 빠지는 항목 (FR-AU-016) */
  readonly excludedFromScore: boolean;
  readonly targetPlace: string | null;
  readonly evidence: ContentEvidence | null;
}

export interface ReportPatch {
  readonly appliedAt: string;
  readonly reverted: boolean;
  readonly beforeScore: number | null;
  readonly afterScore: number | null;
  readonly changes: readonly string[];
}

export interface ReportProvenance {
  readonly fetchedAt: string;
  readonly generatedAt: string;
  readonly targetContentCount: number;
  /** 대표 지문 앞 8자리. 산출 못 했으면 `null` */
  readonly dataFingerprint: string | null;
  readonly rulesetVersion: string;
  /** 공사 데이터 최종 수정일 원문 `YYYYMMDDHHmmss`. 없으면 `null` (UI-CM-031) */
  readonly ktoModifiedAt: string | null;
  readonly delayNotice: string;
  /** `출처: ⓒ한국관광공사` (FR-PA-062). 문자 그대로 싣는다 */
  readonly source: string;
  /**
   * 판정에 쓴 외부 자료의 출처 (NF-CO-023 · EI-WX-004 · #849). 리포트에 실린 판정이 쓴 것만 적는다 —
   * 보인 값의 출처를 밝히는 자리다. 기상청 평년값은 기준 평년과 함께 적는다
   */
  readonly externalSources: readonly string[];
}

/**
 * 수정 전후 비교 (⑤ · FR-PA-043 · #806). 화면 5 와 같은 반영 · 같은 지표다 — 되돌리지 않은
 * 가장 최근 반영이고, 반영 뒤 재검수가 끝났을 때만 싣는다.
 */
export interface ReportComparison {
  readonly appliedAt: string;
  /** [지표, 반영 전, 반영 후, 변화] */
  readonly rows: readonly (readonly [string, string, string, string])[];
}

export interface ReportModel {
  readonly auditRunId: number;
  readonly product: ReportProduct;
  readonly summary: ReportSummary;
  readonly itinerary: readonly ReportDay[];
  readonly findings: readonly ReportFinding[];
  readonly comparison: ReportComparison | null;
  readonly patchHistory: readonly ReportPatch[];
  readonly unverified: readonly ReportFinding[];
  readonly provenance: ReportProvenance;
}

/** 스냅샷 항목 중 변경 서술에 쓰는 것만. `SnapshotItem` 이 이걸 만족한다 */
export interface DiffableItem {
  readonly id: number;
  readonly dayNo: number;
  readonly seq: number;
  readonly startTime: string;
  readonly endTime: string | null;
  /** 장소 담기 · 수정안으로 넣은 항목은 이름을 저장하지 않아 NULL 이거나 빈 문자열이다 (DR-PR-001) */
  readonly placeLabel: string | null;
  readonly ktoContentId: string | null;
  readonly walkId?: string | null;
}

/** 이름을 끝내 알 수 없는 항목. 되돌려서 지금 일정에 없는 곳은 공식 명칭을 다시 읽지 않는다 */
export const UNNAMED_PLACE = '이름을 저장하지 않은 곳';

/**
 * 변경 서술에 쓸 표시 이름. 3절 일정표와 같은 순서로 찾는다 — 공식 명칭, 걷기 길 이름, 입력 라벨.
 *
 * 스냅샷의 `placeLabel` 을 그대로 끼웠더니 이름을 저장하지 않는 항목이 PDF 에 `null` 로
 * 찍혔다 (#595).
 */
export type PlaceNamer = (item: DiffableItem) => string;

export const labelOnly: PlaceNamer = (item) =>
  item.placeLabel === null || item.placeLabel.trim() === '' ? UNNAMED_PLACE : item.placeLabel;

/**
 * 무엇이 달라졌는지 사람이 읽을 문장으로 (FR-PA-042 의 구분을 그대로).
 *
 * `selected_patches` 는 `{findingId, patchId}` 참조만 담고 있어 무엇을 했는지 알 수 없다.
 * 전후 스냅샷을 맞대는 것이 유일하게 정확한 방법이다.
 *
 * 대체(`REPLACE_CONTENT`)는 `place_label` 을 건드리지 않아 이름만 보면 안 바뀐 것처럼
 * 보인다 — `ktoContentId` 로 잡는다.
 */
export function describeItineraryChanges(
  before: readonly DiffableItem[],
  after: readonly DiffableItem[],
  nameOf: PlaceNamer = labelOnly,
): readonly string[] {
  const was = new Map(before.map((i) => [i.id, i]));
  const now = new Map(after.map((i) => [i.id, i]));
  const out: string[] = [];
  /*
   * 순번은 앞 줄이 들어가거나 빠지면 밀린다. 그것까지 「순서 변경」 으로 적으면 손대지 않은 곳이
   * 줄줄이 바뀐 것처럼 읽힌다(#806). 같은 날에 남은 줄끼리의 차례가 바뀌었거나 일차를 옮긴 것만 적는다.
   */
  const stayed = new Set(after.filter((i) => was.get(i.id)?.dayNo === i.dayNo).map((i) => i.id));
  const rankBefore = rankWithinDay(before, stayed);
  const rankAfter = rankWithinDay(after, stayed);

  for (const item of after) {
    const prev = was.get(item.id);
    if (prev === undefined) {
      out.push(`추가 — ${item.dayNo}일차 ${item.startTime} ${nameOf(item)}`);
      continue;
    }
    if (prev.startTime !== item.startTime || prev.endTime !== item.endTime) {
      out.push(`시각 변경 — ${nameOf(item)} ${span(prev)} → ${span(item)}`);
    }
    if (prev.dayNo !== item.dayNo || rankBefore.get(item.id) !== rankAfter.get(item.id)) {
      out.push(`순서 변경 — ${nameOf(item)} ${prev.dayNo}일차 ${prev.seq}번 → ${item.dayNo}일차 ${item.seq}번`);
    }
    if (prev.ktoContentId !== item.ktoContentId) {
      out.push(`관광지 대체 — ${item.dayNo}일차 ${item.seq}번 자리의 연결 관광지를 교체`);
    }
  }
  for (const item of before) {
    if (!now.has(item.id)) out.push(`삭제 — ${item.dayNo}일차 ${item.startTime} ${nameOf(item)}`);
  }
  return out;
}

/** 그 날 안에서 몇 번째인가 — `keep` 에 든 줄끼리만 센다 */
function rankWithinDay(items: readonly DiffableItem[], keep: ReadonlySet<number>): ReadonlyMap<number, number> {
  const byDay = new Map<number, DiffableItem[]>();
  for (const i of items) {
    if (!keep.has(i.id)) continue;
    const list = byDay.get(i.dayNo) ?? [];
    list.push(i);
    byDay.set(i.dayNo, list);
  }
  const rank = new Map<number, number>();
  for (const list of byDay.values()) {
    [...list].sort((a, b) => a.seq - b.seq).forEach((i, n) => rank.set(i.id, n));
  }
  return rank;
}

function span(i: DiffableItem): string {
  return i.endTime === null ? i.startTime : `${i.startTime}~${i.endTime}`;
}

/**
 * 적용 기준 머리글을 만든다 (FR-PA-064 · FR-OP-023).
 *
 * 이 검수에 적용한 표준 버전과, 표준보다 엄격했던 회사 기준(R07 두 값), 무시 건수 · 사유를
 * 적는다. 회사 기준은 검수 당시 스냅샷(`setting_snapshot`)을 쓴다 — 나중에 회사 기준을 바꿔도
 * 이 리포트는 그대로다. 스냅샷이 없는 옛 검수는 표준 버전만 적는다.
 */
export function describeAppliedBasis(run: StoredAuditRun, dismissedCount: number): string {
  const snap = run.settingSnapshot ?? null;
  const version = snap?.standardVersion ?? STANDARD_VERSION;

  const overrides: string[] = [];
  if (snap) {
    if (snap.r07SpanHours !== SETTING_DEFAULTS.r07SpanHours) overrides.push(`연속 일정 ${snap.r07SpanHours}시간`);
    if (snap.r07MealMinutes !== SETTING_DEFAULTS.r07MealMinutes) overrides.push(`식사 ${snap.r07MealMinutes}분`);
  }

  const reasons = [
    ...new Set(
      run.findings
        .filter((f) => f.dismissed)
        .map((f) => f.dismissReason?.trim())
        .filter((r): r is string => r !== undefined && r !== ''),
    ),
  ];

  let basis = `표준 ${version}`;
  if (overrides.length > 0) basis += ` · 회사 기준 ${overrides.length}건 (${overrides.join(' · ')})`;
  if (dismissedCount > 0) {
    basis += ` · 무시 ${dismissedCount}건`;
    if (reasons.length > 0) basis += ` — ${reasons.join(' · ')}`;
  }
  return basis;
}

const STARTED_BY_LABEL: Readonly<Record<string, string>> = {
  MANUAL: '직접 입력으로 시작',
  UPLOAD: '엑셀로 시작',
  TEXT: '메모 붙여넣기로 시작',
  CLONE: '복제로 시작',
  SIGNAL: '레이더 소식으로 시작',
};

const ORIGIN_LABEL: readonly (readonly [string, string])[] = [
  ['MANUAL', '직접 입력'], ['UPLOAD', '엑셀'], ['TEXT', '메모'], ['PICKER', '장소 담기'],
  ['SIGNAL', '레이더 소식'], ['PATCH', '수정안'],
];

const MATCHED_BY_LABEL: readonly (readonly [string, string])[] = [
  ['AUTO', '자동'], ['USER', '직접 고름'], ['AGENT', 'AI가 찾음'],
];

export interface PlanningItem {
  readonly matchStatus: string;
  readonly origin?: string | null;
  readonly matchedBy?: string | null;
}

/**
 * 1절 「기획 출처」 한 줄 (FR-PL-020). 어떻게 시작했는지, 줄마다 어디로 들어왔는지, 고른 곳을
 * 어떻게 골랐는지를 센다. 장소 이름 · 행사명 같은 원문은 넣지 않는다 — 기획 출처에는 애초에
 * 없다(DR-PR-009).
 *
 * 시작 방식이 없는 상품은 결과 화면처럼 「직접 기획」 이다. 경로를 남기기 전에 넣은 줄은
 * 「기록 없음」 으로 센다 — 직접 입력으로 치면 모르는 것을 아는 것처럼 적게 된다.
 */
export function describePlanning(planOrigin: unknown, items: readonly PlanningItem[]): string {
  const origin = typeof planOrigin === 'object' && planOrigin !== null ? planOrigin as Record<string, unknown> : null;
  const startedBy = typeof origin?.startedBy === 'string' ? origin.startedBy : null;
  let started = startedBy === null ? '직접 기획' : (STARTED_BY_LABEL[startedBy] ?? '기획으로 시작');
  const signal = typeof origin?.signal === 'object' && origin.signal !== null ? origin.signal as Record<string, unknown> : null;
  if (signal !== null && typeof signal.from === 'string' && typeof signal.to === 'string') {
    started += signal.from === signal.to ? `(기간 ${signal.from})` : `(기간 ${signal.from} ~ ${signal.to})`;
  }
  if (items.length === 0) return `${started} · 일정 없음`;

  const count = (pick: (i: PlanningItem) => boolean): number => items.filter(pick).length;
  const origins = ORIGIN_LABEL
    .map(([code, label]) => [label, count((i) => i.origin === code)] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${n}`);
  const unknown = count((i) => i.origin == null || !ORIGIN_LABEL.some(([code]) => code === i.origin));
  if (unknown > 0) origins.push(`기록 없음 ${unknown}`);

  const picked = MATCHED_BY_LABEL
    .map(([code, label]) => [label, count((i) => i.matchStatus === 'CONFIRMED' && i.matchedBy === code)] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${n}`);

  const line = `${started} · 일정 ${items.length}개 (${origins.join(' · ')})`;
  return picked.length === 0 ? line : `${line} · 고른 방식 (${picked.join(' · ')})`;
}

/** 확인 필요 목록에 들어가는 조건. `toUnverifiedResponse` 와 같아야 화면과 리포트가 안 갈린다 */
export function needsAttention(f: StoredFinding): boolean {
  return f.severity === 'UNVERIFIED' || f.needsConfirmation;
}

export interface AssembleInput {
  readonly run: StoredAuditRun;
  readonly product: ReportProduct;
  readonly items: readonly {
    readonly dayNo: number;
    readonly seq: number;
    readonly start: string;
    readonly end: string | null;
    readonly place: string;
    readonly itemType: string;
    readonly matchStatus: string;
    readonly ktoContentId: string | null;
    readonly itemId: number;
    readonly walkId: string | null;
    /** 들어온 경로 · 고른 방식 (FR-PL-020). 1절 기획 출처 요약에만 쓴다 */
    readonly origin?: string | null;
    readonly matchedBy?: string | null;
  }[];
  /** 상품의 기획 출처 (`product.plan_origin`). 없으면 「직접 기획」 */
  readonly planOrigin?: unknown;
  readonly patches: readonly ReportPatch[];
  readonly comparison: ReportComparison | null;
  readonly evidence: ReadonlyMap<string, ContentEvidence>;
  /** 걷기 길 코스 이름 (walk_id → 이름 · D9). 못 찾은 코스는 여기 없어 "걷기 길" 로 떨어진다 */
  readonly walkNames: ReadonlyMap<string, string>;
  readonly dataFingerprint: string | null;
  /** 공사 데이터 최종 수정일 원문. 지문 행에서 모은다 */
  readonly ktoModifiedAt: string | null;
  readonly generatedAt: Date;
}

/**
 * 7섹션을 엮는다.
 *
 * 일정표의 표시명은 **공식 명칭을 읽었으면 그것**을 쓴다. 못 읽었으면 사용자가 입력한
 * `place_label` 그대로다 — 비표출 콘텐츠도 여기로 떨어져 원문 명칭이 새지 않는다.
 */
export function assembleReport(input: AssembleInput): ReportModel {
  const { run, evidence, walkNames } = input;
  const c = run.current;
  const appliedBasis = describeAppliedBasis(run, c.dismissedCount);

  // 표시명: 공식 명칭을 읽었으면 그것, 걷기 길이면 코스 이름(못 찾으면 "걷기 길"), 아니면 입력 라벨
  const nameOf = (contentId: string | null, fallback: string, walkId: string | null): string => {
    if (walkId !== null) return walkNames.get(walkId) ?? '걷기 길';
    if (contentId === null) return fallback;
    return evidence.get(contentId)?.officialName ?? fallback;
  };

  const days = new Map<number, ReportItem[]>();
  let excludedItemCount = 0;
  for (const it of [...input.items].sort((a, b) => a.dayNo - b.dayNo || a.seq - b.seq)) {
    const excluded = it.matchStatus === 'EXCLUDED';
    if (excluded) excludedItemCount += 1;
    const bucket = days.get(it.dayNo) ?? [];
    bucket.push({
      seq: it.seq,
      start: it.start,
      end: it.end,
      place: nameOf(it.ktoContentId, it.place, it.walkId),
      itemType: it.itemType,
      matchStatus: it.matchStatus,
      excluded,
    });
    days.set(it.dayNo, bucket);
  }

  const placeOf = new Map(input.items.map((i) => [i.itemId, nameOf(i.ktoContentId, i.place, i.walkId)]));
  const contentOf = new Map(input.items.map((i) => [i.itemId, i.ktoContentId]));

  const toFinding = (f: StoredFinding): ReportFinding => {
    const contentId = f.targetItemId === null ? null : contentOf.get(f.targetItemId) ?? null;
    return {
      ruleCode: f.ruleCode,
      ruleVersion: f.ruleVersion,
      severity: f.severity,
      // 이름 없이 저장된 문장은 여기서 채운다 — 리포트는 공사 명칭을 이미 읽어 뒀다 (#606)
      message: findingMessage(f.ruleCode, f.message, f.evidence, placeOf,
        f.targetItemId === null ? null : placeOf.get(f.targetItemId) ?? null),
      dismissed: f.dismissed,
      dismissReason: f.dismissed ? f.dismissReason : null,
      confirmed: f.confirmed,
      excludedFromScore: f.reasonCode === 'PRE_DEPARTURE_CHECK',
      targetPlace: f.targetItemId === null ? null : placeOf.get(f.targetItemId) ?? null,
      evidence: contentId === null ? null : evidence.get(contentId) ?? null,
    };
  };

  return {
    auditRunId: run.id,
    product: { ...input.product, planning: describePlanning(input.planOrigin ?? null, input.items) },
    summary: {
      score: c.score,
      breakdown: c.breakdown,
      isPartial: run.isPartial,
      releasable: !c.releaseBlocked,
      releaseBlockedReason: c.releaseBlocked ? `차단 ${c.counts.BLOCKER}건` : null,
      counts: c.counts,
      appliedBasis,
      dismissedCount: c.dismissedCount,
      excludedItemCount,
      needsConfirmationCount: c.needsConfirmationCount,
      targetCount: run.targetCount,
      failedCount: run.failedCount,
    },
    itinerary: [...days.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([dayNo, items]) => ({ dayNo, items })),
    // ④ 는 감점이 걸린 판정, ⑥ 은 사용자가 직접 확인할 것 — 화면이 나누는 방식 그대로다
    findings: run.findings.filter((f) => !needsAttention(f)).map(toFinding),
    comparison: input.comparison,
    patchHistory: input.patches,
    unverified: run.findings.filter(needsAttention).map(toFinding),
    provenance: {
      fetchedAt: kstIso(run.executedAt),
      generatedAt: kstIso(input.generatedAt),
      targetContentCount: run.targetCount,
      dataFingerprint: input.dataFingerprint,
      rulesetVersion: run.rulesetVersion,
      ktoModifiedAt: input.ktoModifiedAt,
      delayNotice:
        '공사 데이터는 당일 변경분이 익일 반영되므로 출발 임박 시 운영기관 최종 확인을 권장합니다',
      source: '출처: ⓒ한국관광공사',
      externalSources: externalSourcesOf(run.findings),
    },
  };
}

/**
 * 판정이 쓴 외부 자료 → 데이터 출처 줄 (NF-CO-023 · #849).
 *
 * 평년 근거의 기준 평년 · 출처는 판정이 남긴 값을 쓴다. 이 값을 남기기 전(규칙셋 1.2.8 까지)의
 * 판정은 공유 상수로 채운다 — 표에 넣는 값과 같은 상수다(`seed_climate_normal.mjs`).
 */
export function externalSourcesOf(findings: readonly StoredFinding[]): string[] {
  const lines: string[] = [];
  const add = (line: string): void => { if (!lines.includes(line)) lines.push(line); };
  const forecasts = new Set<string>();

  for (const f of findings) {
    if (f.ruleCode === 'R09') {
      const source = f.evidence.rainSource;
      if (source === 'SHORT') forecasts.add('단기예보');
      if (source === 'MID') forecasts.add('중기예보');
      if (source === 'CLIMATE') {
        const period = typeof f.evidence.normalPeriod === 'string' && f.evidence.normalPeriod !== ''
          ? f.evidence.normalPeriod : CLIMATE_NORMAL_PERIOD.replace('-', '~');
        const from = typeof f.evidence.normalSource === 'string' && f.evidence.normalSource !== ''
          ? f.evidence.normalSource : CLIMATE_SOURCE_NOTE.replace(/^출처\s*:\s*/, '');
        add(`출처: ${from} (평년값 ${period})`);
      }
    }
  }
  if (forecasts.size > 0) add(`출처: 기상청 (${['단기예보', '중기예보'].filter((x) => forecasts.has(x)).join(' · ')})`);
  if (findings.some((f) => f.externalSource === '카카오모빌리티')) add('외부 참고: 카카오모빌리티 (이동시간)');
  return lines;
}

/**
 * 비교 지표를 표 한 줄씩으로 (FR-PA-043 · #806). 값은 화면 5 와 같게 적는다 — 이동시간은
 * 「3시간 9분」, 거리는 「122.3km」, 총 감점은 계산식을 붙여 검산할 수 있게 한다(FR-PA-041).
 * 값이 없으면 지어내지 않고 「—」다.
 */
export function comparisonRows(metrics: readonly ComparisonMetric[]): ReportComparison['rows'] {
  return metrics.map((m) => {
    if (m.beforeText !== undefined || m.afterText !== undefined) {
      return [m.label, m.beforeText ?? '—', m.afterText ?? '—', '—'] as const;
    }
    const cell = (v: number | null | undefined, formula: string | undefined): string =>
      v == null ? '—' : formula === undefined ? metricValue(m.key, v) : `${metricValue(m.key, v)} (${formula})`;
    return [m.label, cell(m.before, m.formulaBefore), cell(m.after, m.formulaAfter), metricChange(m)] as const;
  });
}

function metricChange(m: ComparisonMetric): string {
  if (m.before == null || m.after == null) return '—';
  const diff = m.after - m.before;
  if (diff === 0) return '변화 없음';
  return `${diff > 0 ? '+' : '−'}${metricValue(m.key, Math.abs(diff))}`;
}

/** 화면 5 의 `formatMetric` 과 같은 단위 (#726). 건수 · 점수는 표의 이름이 단위를 말한다 */
function metricValue(key: string, v: number): string {
  if (key === 'travelMinutes') {
    const hours = Math.floor(v / 60);
    const minutes = v % 60;
    if (hours === 0) return `${minutes}분`;
    return minutes === 0 ? `${hours}시간` : `${hours}시간 ${minutes}분`;
  }
  if (key === 'travelMeters') return v < 1000 ? `${v}m` : `${(Math.round(v / 100) / 10).toFixed(1)}km`;
  return String(v);
}
