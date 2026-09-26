import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEVERITY_WEIGHT_DEFAULT, type Severity } from '@tourlint/shared';
import { AuditRunner, type ItineraryItemRow, type ProductRow } from './audit-runner';
import { calculateReadiness } from '../engine/score';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import { KtoClient } from '../external/kto/kto.client';
import { FixtureKtoTransport } from '../external/kto/transport';
import type { Finding } from '../engine/rules/types';
import { applyPatches } from './patch-apply';
import type { SelectedPatch } from './patch-types';

/**
 * **기대값 표(`docs/기대값표.md`)의 점수를 고정한다.**
 *
 * 그 표는 스스로를 「코드보다 먼저 존재하는 정답지」라고 정의하는데, 표를 고정하는 테스트가
 * 하나도 없었다. 규칙별 단위 테스트는 촘촘하지만 상품 하나를 통째로 돌려 등급 · 점수를
 * 대조하는 회귀가 없어, 엔진과 정답지가 **26점 대 29점으로 갈린 채 2주 넘게 있었다**
 * (이슈 #436 · #438). 사람이 운영 화면을 보고서야 알았다.
 *
 * 무엇을 보나 — 픽스처 상품을 `AuditRunner` 에 그대로 넣고 등급별 건수 · 점수 · 사유코드
 * 집합을 표와 대조한다. 규칙 하나를 고쳐 다른 규칙의 판정이 바뀌면 여기서 걸린다.
 *
 * **R08 · R09 는 대조에서 뺀다.** 픽스처에는 공사 응답만 있고 카카오모빌리티 · 기상청
 * 데이터가 없어, 둘은 외부 연동이 없다는 이유로 확인 불가를 낸다. 그건 규칙이 의도대로
 * 도는 것이지 판정이 아니다. 기대값 표도 두 규칙을 「미발동이어야 하는 규칙」으로 적고
 * 건수에 넣지 않았다. 두 규칙은 각자의 단위 테스트(`r08-travel.spec` · `r09-rain.spec`)가 본다.
 *
 * **기대값은 §8 「R10 몫 — 계산값」을 쓴다.** §2 · §3 의 「최종」 블록은 R01 ~ R08 만 있던
 * 때의 값이라 R10 주의 1건이 빠져 있다. 표 스스로 §8 에서 「지금 대조할 때는 두 규칙 몫을
 * 빼고 본다」며 보정값(TP-01 96 → 92 · TP-02 67 → 63)을 적어 뒀다. TP-03 은 §4 가 이미
 * R10 을 넣어 갱신돼 있어 29 다 — 명세 FR-AU-041 AC 이자 운영 실측값(2026-09-17 run 65)이다.
 *
 * TP-04 는 여기서 다루지 않는다. 조회 실패를 주입해 50% 경계를 보는 픽스처라 리플레이가
 * 아니라 실패 주입 장치가 필요하다.
 */

const FIXTURES = join(__dirname, '../../../../fixtures');
const KTO_DIR = join(FIXTURES, 'kto');

/** 픽스처의 항목. 시드(`demo-products.ts`)와 필드 이름이 다르다 — 여기는 `contentId` 다 */
interface FixtureItem {
  readonly dayNo: number;
  readonly seq: number;
  readonly startTime: string;
  readonly endTime: string | null;
  readonly placeLabel: string;
  readonly itemType: ItineraryItemRow['itemType'];
  readonly contentId: string | null;
  readonly contentTypeId: number | null;
  readonly lclsSystm1?: string | null;
  readonly lclsSystm2?: string | null;
  readonly lclsSystm3?: string | null;
}

interface Fixture {
  readonly fixtureId: string;
  readonly product: {
    readonly name: string;
    readonly ldongRegnCd: string;
    readonly ldongSignguCd: string;
    readonly startDate: string;
    readonly nights: number;
    readonly transport: ProductRow['transport'];
    readonly targetKey?: string | null;
    readonly conceptKey?: string | null;
  };
  readonly items: readonly FixtureItem[];
}

function load(file: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, 'products', file), 'utf8')) as Fixture;
}

function rows(f: Fixture): { product: ProductRow; items: ItineraryItemRow[] } {
  return {
    product: {
      id: 1,
      startDate: f.product.startDate,
      nights: f.product.nights,
      transport: f.product.transport,
      ldongRegnCd: f.product.ldongRegnCd,
      ldongSignguCd: f.product.ldongSignguCd,
      targetKey: f.product.targetKey ?? null,
      conceptKey: f.product.conceptKey ?? null,
    },
    items: f.items.map((i, idx) => ({
      id: idx + 1,
      dayNo: i.dayNo,
      seq: i.seq,
      startTime: i.startTime,
      endTime: i.endTime,
      // 픽스처는 끝 시각이 있으면 사람이 적은 것이다. 없으면 기본 체류시간으로 채운다
      endTimeSource: i.endTime === null ? 'DWELL_DEFAULT' : 'INPUT',
      placeLabel: i.placeLabel,
      itemType: i.itemType,
      ktoContentId: i.contentId,
      contentTypeId: i.contentTypeId,
      lclsSystm1: i.lclsSystm1 ?? null,
      lclsSystm2: i.lclsSystm2 ?? null,
      lclsSystm3: i.lclsSystm3 ?? null,
      // 좌표는 픽스처에 없다. R08 을 대조에서 빼는 이유이기도 하다
      mapX: null,
      mapY: null,
      matchStatus: 'CONFIRMED',
    })),
  };
}

/**
 * 검수 시각을 고정한다. 여행일까지 남은 일수가 R09 분기를 정하므로(FR-RU-091) 오늘을
 * 쓰면 결과가 날짜에 따라 달라진다. 픽스처 출발일(2026-10) 기준 D+11 이상이 되도록 둔다.
 */
const EXECUTED_AT = new Date('2026-09-01T00:00:00+09:00');

/** 공사 데이터로 판정하는 규칙만 남긴다 — R08 · R09 는 픽스처에 입력이 없다 */
const EXTERNAL = new Set(['R08', 'R09']);

async function audit(file: string): Promise<{ findings: readonly Finding[]; score: number | null }> {
  const { product, items } = rows(load(file));
  return auditRows(product, items);
}

async function auditRows(
  product: ProductRow,
  items: readonly ItineraryItemRow[],
): Promise<{ findings: readonly Finding[]; score: number | null }> {
  const kto = new KtoClient({
    transport: new FixtureKtoTransport(KTO_DIR),
    logger: new InMemoryApiCallLogger(),
  });
  const result = await new AuditRunner({ kto, clock: () => EXECUTED_AT }).run(product, items);
  const findings = result.findings.filter((f) => !EXTERNAL.has(f.ruleCode));
  /*
   * **점수를 다시 낸다.** 러너가 준 점수에는 R08 · R09 의 확인 불가 감점이 섞여 있다.
   * 다시 낼 때도 엔진의 산출 함수(`calculateReadiness`)를 쓴다 — 여기서 산식을 베껴
   * 쓰면 산식이 바뀌어도 이 테스트가 모른다.
   */
  const score = calculateReadiness({
    findings: findings.map((f) => ({
      severity: f.severity,
      reasonCode: f.reasonCode,
      dismissed: false,
      needsConfirmation: f.needsConfirmation,
    })),
    targetCount: result.targetCount,
    failedCount: result.failedCount,
  }).score;
  return { findings, score };
}

interface Counts { BLOCKER: number; ERROR: number; WARNING: number; UNVERIFIED: number }

/** 등급별 건수. 기대값 표가 쓰는 말과 같은 순서로 둔다 */
function counts(findings: readonly Finding[]): Counts {
  const out: Counts = { BLOCKER: 0, ERROR: 0, WARNING: 0, UNVERIFIED: 0 };
  for (const f of findings) out[f.severity] += 1;
  return out;
}

/** 표의 산식을 그대로 다시 센다 — 엔진이 준 점수와 맞는지 본다 (FR-AU-041) */
function deduct(c: Counts): number {
  const w = SEVERITY_WEIGHT_DEFAULT as Readonly<Record<Severity, number>>;
  return Math.max(0, 100
    - c.BLOCKER * w.BLOCKER - c.ERROR * w.ERROR
    - c.WARNING * w.WARNING - c.UNVERIFIED * w.UNVERIFIED);
}

describe('픽스처 리플레이 — 기대값 표와 대조 (이슈 #438)', () => {
  it('🔴 TP-01 표준 — 차단 0 · 오류 0 · 주의 2(R04 · R10) → 92점', async () => {
    /*
     * 이 픽스처의 목적은 「차단 0건인 정상 경로」다. 규칙이 과탐하면 여기서 먼저 걸린다.
     * **R04 집계 제외(FR-RU-040)가 빠졌는지는 점수가 아니라 `CONTENT_IMBALANCE` 건수로
     * 본다** — R10 이 붙으면서 92 가 정상값이 되어 점수로는 못 가린다고 기대값 표 §8 이
     * 고쳐 적었다. 식사 · 숙박 · 휴식 · 이동 · 자유시간을 집계에 넣으면 39가 3곳이 되어
     * 2건이 된다. 1건이어야 한다.
     */
    const r = await audit('TP-01_standard.json');
    const c = counts(r.findings);
    expect(c, JSON.stringify(r.findings.map((f) => `${f.severity} ${f.ruleCode} ${f.reasonCode}`)))
      .toEqual({ BLOCKER: 0, ERROR: 0, WARNING: 2, UNVERIFIED: 0 });
    expect(r.findings.filter((f) => f.reasonCode === 'CONTENT_IMBALANCE')).toHaveLength(1);
    expect(r.score).toBe(92);
    expect(deduct(c)).toBe(r.score);
  });

  it('🔴 TP-02 경계 — 차단 1 · 오류 0 · 주의 3(R01 · R07 · R10) → 63점', async () => {
    /*
     * 1분 차이로 갈리는 지점만 모은 픽스처다. **차단이 2건이 되면 운영시간 시작 경계를
     * 초과(`>=`)로 처리한 것이다** — 녹색도시 09:00 이 함께 잡힌다(기대값 표 §3).
     */
    const r = await audit('TP-02_boundary.json');
    const c = counts(r.findings);
    expect(c, JSON.stringify(r.findings.map((f) => `${f.severity} ${f.ruleCode} ${f.reasonCode}`)))
      .toEqual({ BLOCKER: 1, ERROR: 0, WARNING: 3, UNVERIFIED: 0 });
    expect(r.score).toBe(63);
    expect(deduct(c)).toBe(r.score);
  });

  it('🔴 TP-03 위반 — 차단 2 · 오류 1 · 주의 2 · 확인 불가 1 → 29점 (FR-AU-041 AC)', async () => {
    /*
     * 명세 FR-AU-041 인수조건의 「29점 시연 상품」을 실제 강릉 데이터로 재현한 것이다.
     * 시연에서 보여 주는 숫자이기도 하다.
     */
    const r = await audit('TP-03_violation.json');
    const c = counts(r.findings);
    expect(c, JSON.stringify(r.findings.map((f) => `${f.severity} ${f.ruleCode} ${f.reasonCode}`)))
      .toEqual({ BLOCKER: 2, ERROR: 1, WARNING: 2, UNVERIFIED: 1 });
    expect(r.score).toBe(29);
    expect(deduct(c)).toBe(r.score);
  });

  it('🔴 TP-03 의 사유코드가 기대값 표와 같다 — 등급만 맞고 이유가 달라지면 안 된다', async () => {
    const r = await audit('TP-03_violation.json');
    const got = r.findings.map((f) => `${f.ruleCode}:${f.reasonCode}`).sort();
    expect(got).toEqual([
      'R01:REST_DAY_CONFLICT',      // 가람집옹심이 — 매주 화요일 · 1일차가 화요일
      // 갈골한과체험전시관 — 휴무 · 운영 모두 `예약시 운영`. 기대값 표 §4 는 처음부터 PARSE_REFERENCE 였는데
      // 코드가 REST_DAY_UNCERTAIN 을 냈고 이 목록이 코드를 따라 적혀 있었다 (EX-PS-002 · #855)
      'R01:PARSE_REFERENCE',
      'R02:EVENT_ENDED',            // 경포벚꽃축제 — 행사 2026-04-04~04-11, 방문은 10월
      'R03:TIME_OVERLAP',           // 가람집 12:00~13:00 과 오죽헌 12:30~14:00 이 30분 겹침
      'R07:MEAL_TIME_SHORT',        // 감천골 30분 < 최소 60분
      'R10:TARGET_MISMATCH',        // 20대 · 감성인데 체험 0곳 · 19:00 이후 0곳
    ].sort());
  });

  it('축제는 R01 판정을 받지 않는다 (FR-RU-015)', async () => {
    // 휴무일 필드가 없는 유형이다. 이것이 26점과 29점을 갈랐다 (이슈 #436)
    const r = await audit('TP-03_violation.json');
    const festival = r.findings.filter((f) => f.ruleCode === 'R01'
      && String(f.evidence.ktoContentId ?? '') === '695592');
    expect(festival).toHaveLength(0);
  });
});

/**
 * 시연 상품에 수정안을 반영한 결과 (DR-TD-006 · FR-PA-040 · #883).
 *
 * 명세는 29 → 93 을 적었지만 그것을 검증하는 테스트가 없었고, 지금 규칙으로는 89 다 — 휴무 식당이
 * 2일차로 가며 1일차 식사가 비고(R07 식사 · 휴식 주의), R10 결손 주의에는 수정안이 없다. 93 은 R10 이
 * 생기기 전 숫자다. 실측을 고정하고 명세를 이 값으로 고쳤다.
 */
describe('시연 상품 수정안 반영 (DR-TD-006 · #883)', () => {
  it('🔴 TP-03 에 휴무 식당 날짜 변경 · 끝난 행사 삭제를 반영하면 29 → 89점이다', async () => {
    const { product, items } = rows(load('TP-03_violation.json'));
    const before = await auditRows(product, items);
    expect(before.score).toBe(29);

    const pick = (rule: string, type: string): SelectedPatch => {
      const finding = before.findings.find((f) => f.ruleCode === rule && (f.patches ?? []).some((p) => p.type === type));
      const patch = finding?.patches?.find((p) => p.type === type);
      if (finding === undefined || patch === undefined) throw new Error(`${rule} ${type} 수정안이 없다`);
      return { ...patch, findingId: before.findings.indexOf(finding) + 1 } as SelectedPatch;
    };
    const applied = applyPatches(items, [pick('R01', 'TIME_SHIFT'), pick('R02', 'REMOVE_ITEM')]);
    expect(applied.skipped).toEqual([]);

    const after = await auditRows(product, applied.items);
    expect(counts(after.findings)).toEqual({ BLOCKER: 0, ERROR: 0, WARNING: 2, UNVERIFIED: 1 });
    expect(after.findings.map((f) => `${f.ruleCode}:${f.reasonCode}`).sort()).toEqual([
      'R01:PARSE_REFERENCE',     // 갈골한과체험전시관 — 그대로
      'R07:MEAL_REST_MISSING',   // 가람집이 2일차로 가며 1일차 식사가 빈다
      'R10:TARGET_MISMATCH',     // 수정안이 없는 결손
    ]);
    expect(after.score).toBe(89);
    expect(deduct(counts(after.findings))).toBe(after.score);
  });
});
