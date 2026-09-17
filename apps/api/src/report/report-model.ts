import { SETTING_DEFAULTS, STANDARD_VERSION, type Severity } from '@tourlint/shared';
import type { ContentView } from '../external/kto';
import type { StoredAuditRun, StoredFinding } from '../persistence/audit-result.repository';

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
}

export interface ReportModel {
  readonly auditRunId: number;
  readonly product: ReportProduct;
  readonly summary: ReportSummary;
  readonly itinerary: readonly ReportDay[];
  readonly findings: readonly ReportFinding[];
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
  readonly placeLabel: string;
  readonly ktoContentId: string | null;
}

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
): readonly string[] {
  const was = new Map(before.map((i) => [i.id, i]));
  const now = new Map(after.map((i) => [i.id, i]));
  const out: string[] = [];

  for (const item of after) {
    const prev = was.get(item.id);
    if (prev === undefined) {
      out.push(`추가 — ${item.dayNo}일차 ${item.startTime} ${item.placeLabel}`);
      continue;
    }
    if (prev.startTime !== item.startTime || prev.endTime !== item.endTime) {
      out.push(`시각 변경 — ${item.placeLabel} ${span(prev)} → ${span(item)}`);
    }
    if (prev.dayNo !== item.dayNo || prev.seq !== item.seq) {
      out.push(`순서 변경 — ${item.placeLabel} ${prev.dayNo}일차 ${prev.seq}번 → ${item.dayNo}일차 ${item.seq}번`);
    }
    if (prev.ktoContentId !== item.ktoContentId) {
      out.push(`관광지 대체 — ${item.dayNo}일차 ${item.seq}번 자리의 연결 관광지를 교체`);
    }
  }
  for (const item of before) {
    if (!now.has(item.id)) out.push(`삭제 — ${item.dayNo}일차 ${item.startTime} ${item.placeLabel}`);
  }
  return out;
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
  }[];
  readonly patches: readonly ReportPatch[];
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
      severity: f.severity,
      message: f.message,
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
    product: input.product,
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
    patchHistory: input.patches,
    unverified: run.findings.filter(needsAttention).map(toFinding),
    provenance: {
      fetchedAt: run.executedAt.toISOString(),
      generatedAt: input.generatedAt.toISOString(),
      targetContentCount: run.targetCount,
      dataFingerprint: input.dataFingerprint,
      rulesetVersion: run.rulesetVersion,
      ktoModifiedAt: input.ktoModifiedAt,
      delayNotice:
        '공사 데이터는 당일 변경분이 익일 반영되므로 출발 임박 시 운영기관 최종 확인을 권장합니다',
      source: '출처: ⓒ한국관광공사',
    },
  };
}
