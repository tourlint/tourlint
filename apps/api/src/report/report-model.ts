import type { Severity } from '@tourlint/shared';
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
export interface ContentEvidence {
  readonly ktoContentId: string;
  /** 공식 명칭. 못 읽었거나 비표출이면 `null` — 지어내지 않는다 */
  readonly officialName: string | null;
  /** 원본 이미지 URL. 임베드하지 않는다 (FR-PA-063) */
  readonly imageUrl: string | null;
  readonly homepageUrl: string | null;
  /** 판정 필드 원문. `FINGERPRINT_FIELDS` 순서 그대로 */
  readonly fields: readonly { readonly name: string; readonly value: string }[];
  /** 원본 `YYYYMMDDHHmmss`. 변환하지 않는다 (DR-PR-008) */
  readonly ktoModifiedTime: string | null;
  /** 비표출(`show_flag = 0`). 참이면 명칭 · 주소 · 이미지를 싣지 않는다 (PM-NG-009) */
  readonly hidden: boolean;
  /** 조회 실패 사유코드. 성공이면 `null` */
  readonly unavailableReason: string | null;
}

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
  }[];
  readonly patches: readonly ReportPatch[];
  readonly evidence: ReadonlyMap<string, ContentEvidence>;
  readonly dataFingerprint: string | null;
  readonly generatedAt: Date;
}

/**
 * 7섹션을 엮는다.
 *
 * 일정표의 표시명은 **공식 명칭을 읽었으면 그것**을 쓴다. 못 읽었으면 사용자가 입력한
 * `place_label` 그대로다 — 비표출 콘텐츠도 여기로 떨어져 원문 명칭이 새지 않는다.
 */
export function assembleReport(input: AssembleInput): ReportModel {
  const { run, evidence } = input;
  const c = run.current;

  const nameOf = (contentId: string | null, fallback: string): string => {
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
      place: nameOf(it.ktoContentId, it.place),
      itemType: it.itemType,
      matchStatus: it.matchStatus,
      excluded,
    });
    days.set(it.dayNo, bucket);
  }

  const placeOf = new Map(input.items.map((i) => [i.itemId, nameOf(i.ktoContentId, i.place)]));
  const contentOf = new Map(input.items.map((i) => [i.itemId, i.ktoContentId]));

  const toFinding = (f: StoredFinding): ReportFinding => {
    const contentId = f.targetItemId === null ? null : contentOf.get(f.targetItemId) ?? null;
    return {
      ruleCode: f.ruleCode,
      severity: f.severity,
      message: f.message,
      dismissed: f.dismissed,
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
      delayNotice:
        '공사 데이터는 당일 변경분이 익일 반영되므로 출발 임박 시 운영기관 최종 확인을 권장합니다',
      source: '출처: ⓒ한국관광공사',
    },
  };
}
