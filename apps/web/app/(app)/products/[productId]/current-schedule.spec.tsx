// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditApi, patchApi, productApi, planApi, itemApi, type RunSummary, type Finding, type ProductDetail, type ProductItem } from "../../../lib/api";
import { AuditResult, FindingsSection, FIRST_RUN_POLL_MS, FIRST_RUN_POLL_TRIES, isEditedSinceAudit, waitForFirstRun } from "./audit-result";
import { CurrentSchedule, hiddenItemIdsOf } from "./current-schedule";

const router = { replace: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const item: ProductItem = { itemId: 1, seq: 1, start: "10:00", end: "11:30", place: "경포대", itemType: "SIGHT", ktoContentId: null, matchStatus: "CONFIRMED", mapx: null, mapy: null };
const product = { days: [{ day: 1, items: [item, { ...item, itemId: 2, seq: 2, place: "오죽헌·시립박물관", start: "11:00", end: "12:30" }] }, { day: 2, items: [{ ...item, itemId: 3, end: null }] }] } as ProductDetail;
const finding = { findingId: 1, severity: "ERROR", ruleCode: "R03", message: "두 장소의 시간이 겹칩니다", target: { itemId: 1 }, targetSecondary: { itemId: 2 }, dismissedAt: null, dismissible: true, sourceBadge: "TOURLINT_VERDICT", patches: [{ patchId: "p1", type: "TIME_SHIFT", targetItemId: 2, payload: { newStartTime: "12:00", newEndTime: "13:30" } }, { patchId: "p2", type: "REORDER", targetItemId: 2, payload: { swapWithItemId: 3 } }] } as Finding;
let host: HTMLDivElement; let root: Root;
const select = vi.fn();
function Harness({ detail = product, findings = [finding] }: { detail?: ProductDetail; findings?: Finding[] }) {
  const [selected, setSelected] = useState<Record<number, string>>({});
  return <FindingsSection product={detail} findings={findings} itemLabel={id => `일정 ${id}`} contentOf={() => null} selected={selected}
    onSelectPatch={(id, patch) => { select(id, patch); setSelected(patch ? { [id]: patch } : {}); }} onChanged={async () => {}} busy={false} />;
}
const schedule = () => host.querySelector('aside[aria-label="현재 일정표"]')!;
async function click(text: string) { const b = [...host.querySelectorAll('button')].find(b => b.textContent === text); expect(b).toBeDefined(); await act(async () => b!.click()); }
async function render(detail = product, findings = [finding]) { await act(async () => root.render(<Harness detail={detail} findings={findings} />)); }
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host); select.mockClear(); sessionStorage.clear(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe('검수 중 현재 일정 참조 (#570)', () => {
  it('선택·미리보기 없이 모든 일차와 현재 시간을 표시한다', async () => {
    await render();
    expect(schedule().querySelectorAll('li')).toHaveLength(3);
    expect(schedule().textContent).toContain('1일차'); expect(schedule().textContent).toContain('2일차');
    expect(schedule().textContent).toContain('11:00 – 12:30'); expect(schedule().textContent).toContain('종료 미입력');
    expect(host.textContent).toContain('수정안 0개 선택됨'); expect(select).not.toHaveBeenCalled();
  });
  it('문제 카드에 초점을 옮기면 선택 없이 앞뒤 두 장소만 강조한다', async () => {
    await render(); await act(async () => host.querySelector<HTMLButtonElement>('.finding-card button')!.focus());
    const highlighted = schedule().querySelectorAll('[data-related="true"]');
    expect(highlighted).toHaveLength(2); expect(highlighted[1].textContent).toContain('오죽헌·시립박물관');
    expect(select).not.toHaveBeenCalled();
  });
  it('수정안을 선택해도 현재 시간은 유지하고 순서 교환의 상대 장소도 강조한다', async () => {
    await render();
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[0].click());
    expect(schedule().textContent).toContain('11:00 – 12:30'); expect(schedule().textContent).not.toContain('12:00 – 13:30');
    expect(select).toHaveBeenLastCalledWith(1, 'p1');
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click());
    expect(schedule().querySelectorAll('[data-related="true"]')).toHaveLength(3);
  });
  it('접은 일정을 다시 펼치고 필터 결과가 없어도 유지한다', async () => {
    await render(); await click('접기'); expect(schedule().querySelectorAll('li')).toHaveLength(0);
    await click('펼치기'); expect(schedule().querySelectorAll('li')).toHaveLength(3);
    await click('차단0'); expect(host.textContent).toContain('이 분류에 해당하는 항목이 없습니다'); expect(schedule().querySelectorAll('li')).toHaveLength(3);
  });
  it('갱신된 상품 일정을 표시하며 원본 배열 순서는 변경하지 않는다', async () => {
    const reversed = { ...product, days: [...product.days].reverse() }; await render(reversed);
    expect(reversed.days[0].day).toBe(2);
    expect(schedule().querySelector('section')?.getAttribute('aria-label')).toBe('1일차');
    await render({ ...product, days: [{ day: 1, items: [{ ...item, start: '09:00', place: '수정한 장소' }] }] });
    expect(schedule().textContent).toContain('09:00 – 11:30'); expect(schedule().textContent).toContain('수정한 장소'); expect(schedule().querySelectorAll('li')).toHaveLength(1);
  });
  it('상품 전체 판정은 특정 장소를 문제로 표시하지 않는다', async () => {
    await render(product, [{ ...finding, target: { itemId: null }, targetSecondary: null, patches: [] }]); await act(async () => host.querySelector<HTMLButtonElement>('.finding-card button')!.focus());
    expect(schedule().querySelectorAll('[data-related="true"]')).toHaveLength(0); expect(schedule().textContent).toContain('상품 전체를 함께');
  });
  it('문제가 없거나 저장된 일정이 없어도 상태를 명확히 표시한다', async () => {
    await render(product, []); expect(schedule().querySelectorAll('li')).toHaveLength(3); expect(host.textContent).toContain('발견된 문제가 없습니다');
    await render({ ...product, days: [] }, []); expect(schedule().textContent).toContain('저장된 일정이 없어요');
  });
});

const run: RunSummary = {
  auditRunId: 1, productId: 42, executedAt: "2026-09-18T10:00:00", rulesetVersion: "1.2", isPartial: false,
  readinessScore: 42, scoreBreakdown: { formula: null, deduction: 58, weights: { BLOCKER: 25, ERROR: 10, WARNING: 4, UNVERIFIED: 3 } },
  counts: { blocker: 0, error: 4, warning: 0, unverified: 6, dismissed: 0 }, needsConfirmationCount: 8,
  targetCount: 10, failedCount: 0, releasable: true, releaseBlockedReason: null, settingSnapshot: null,
  evidence: { fetchedAt: "2026-09-18T10:00:00", targetContentCount: 10, dataFingerprint: null, dataFingerprintFull: null,
    rulesetVersion: "1.2", ktoModifiedAt: null, delayNotice: "안내", source: "출처" },
};

it('수정안 확정·재검수 후 현재 일정표를 서버의 최신 일정으로 갱신한다', async () => {
  const initial = { ...product, name: '검증 상품', region: { regnName: '강원', signguName: '강릉' }, composition: { manual: 3, picker: 0, excluded: 0 }, releasedAt: null };
  const updated = { ...initial, days: [{ day: 1, items: [{ ...item, place: '확정된 장소', start: '09:30' }] }] };
  const detail = vi.spyOn(productApi, 'detail').mockResolvedValueOnce(initial).mockResolvedValue(updated);
  vi.spyOn(auditApi, 'listRuns').mockResolvedValue({ totalCount: 1, runs: [run] });
  vi.spyOn(auditApi, 'getRun').mockResolvedValue(run);
  vi.spyOn(auditApi, 'getFindings').mockResolvedValue({ content: [finding] } as Awaited<ReturnType<typeof auditApi.getFindings>>);
  vi.spyOn(auditApi, 'getUnverified').mockResolvedValue({ totalCount: 0, items: [] });
  vi.spyOn(auditApi, 'getJob').mockResolvedValue({ auditRunId: 1 } as Awaited<ReturnType<typeof auditApi.getJob>>);
  vi.spyOn(patchApi, 'preview').mockResolvedValue({ before: [], after: [], conflict: { hasConflict: false, pairs: [] }, skipped: [], previewToken: 'test-preview' } as Awaited<ReturnType<typeof patchApi.preview>>);
  vi.spyOn(patchApi, 'apply').mockResolvedValue({ reauditJobId: 1, patchApplicationId: 1 } as Awaited<ReturnType<typeof patchApi.apply>>);
  vi.spyOn(patchApi, 'application').mockRejectedValue(new Error('배너 조회 생략'));
  Element.prototype.scrollIntoView = vi.fn();
  await act(async () => root.render(<AuditResult productId={42} />));
  expect(schedule().textContent).toContain('경포대');
  await act(async () => host.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
  await click('미리보기');
  expect(schedule().textContent).toContain('경포대'); expect(detail).toHaveBeenCalledTimes(1);
  await click('확정하고 재검수');
  expect(detail).toHaveBeenCalledTimes(2);
  expect(schedule().textContent).toContain('확정된 장소'); expect(schedule().textContent).toContain('09:30');
  expect(host.textContent).toContain('수정안 0개 선택됨');
});


it('검수에서 장소 추가 → 현재 일정 갱신 → 기존 수정안·출시 보류 → 재검수로 이어진다', async () => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  const initial = { ...product, productId: 42, dayCount: 2, ldongRegnCd: '51', name: '검증 상품', region: { regnName: '강원', signguName: '강릉' }, composition: { manual: 3, picker: 0, excluded: 0 }, releasedAt: null,
    days: [{ day: 1, items: [{ ...item, mapx: 128, mapy: 37 }] }] };
  const updated = { ...initial, days: [{ day: 1, items: [...initial.days[0].items, { ...item, itemId: 4, place: '추가한 식당', itemType: 'MEAL' }] }] };
  vi.spyOn(productApi, 'detail').mockResolvedValueOnce(initial).mockResolvedValue(updated);
  vi.spyOn(auditApi, 'listRuns').mockResolvedValue({ totalCount: 1, runs: [run] });
  vi.spyOn(auditApi, 'getRun').mockResolvedValue(run);
  vi.spyOn(auditApi, 'getFindings').mockResolvedValue({ content: [{ ...finding, ruleCode: 'R07' }] } as Awaited<ReturnType<typeof auditApi.getFindings>>);
  vi.spyOn(auditApi, 'getUnverified').mockResolvedValue({ totalCount: 0, items: [] });
  vi.spyOn(planApi, 'briefing').mockResolvedValue({ types: [], budget: 'OK', region: { regnCd: '51', signguCd: null, name: '강원' }, events: null, accessible: null, pet: null, walks: null } as Awaited<ReturnType<typeof planApi.briefing>>);
  vi.spyOn(planApi, 'places').mockResolvedValue({ items: [{ contentId: '100', title: '추가한 식당', firstImage: null, distanceM: null, togetherRank: null }], totalCount: 1, scope: { label: '근처' } } as Awaited<ReturnType<typeof planApi.places>>);
  const add = vi.spyOn(itemApi, 'addPicked').mockResolvedValue({} as Awaited<ReturnType<typeof itemApi.addPicked>>);
  vi.spyOn(auditApi, 'runAudit').mockResolvedValue({ jobId: 2 } as Awaited<ReturnType<typeof auditApi.runAudit>>);
  vi.spyOn(auditApi, 'getJob').mockResolvedValue({ auditRunId: 2 } as Awaited<ReturnType<typeof auditApi.getJob>>);
  await act(async () => root.render(<AuditResult productId={42} />));
  expect(host.textContent).not.toMatch(/일정에서 확인|규칙 설명 보기/);
  await act(async () => host.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
  await click('식당·카페 찾기');
  expect(host.querySelector('dialog')?.open).toBe(true);
  await click('일정에 넣기');
  expect(add).toHaveBeenCalledTimes(1);
  await click('닫기');
  expect(schedule().textContent).toContain('추가한 식당');
  expect(host.textContent).toContain('수정안 0개 선택됨');
  expect(host.textContent).toContain('아래 결과는 바뀌기 전 결과');
  expect(host.querySelector('fieldset')?.disabled).toBe(true);
  expect([...host.querySelectorAll('button')].find(b => b.textContent === '출시 승인')?.disabled).toBe(true);
  expect(host.textContent).not.toContain('리포트 생성');
  // 같은 검수 결과로 새로고침해도 보류 상태를 복원한다.
  await act(async () => root.render(<AuditResult key="reload" productId={42} />));
  expect(host.textContent).toContain('아래 결과는 바뀌기 전 결과');
  await click('지금 재검수');
  expect(auditApi.runAudit).toHaveBeenCalledWith(42, 'MANUAL');
  expect(host.textContent).not.toContain('아래 결과는 바뀌기 전 결과');
  expect(host.querySelector('fieldset')?.disabled).toBe(false);
});

it('🔴 수정안을 되돌린 뒤 새로 열면 반영 전 실행부터 연다 — 더 최근인 반영 후 실행이 아니라 (#551)', async () => {
  const detail = { ...product, name: '검증 상품', region: { regnName: '강원', signguName: '강릉' }, composition: { manual: 3, picker: 0, excluded: 0 }, releasedAt: null };
  vi.spyOn(productApi, 'detail').mockResolvedValue(detail);
  vi.spyOn(auditApi, 'listRuns').mockResolvedValue({
    totalCount: 2,
    runs: [
      { auditRunId: 9, executedAt: '2026-09-20T01:10:05Z', isPartial: false, readinessScore: 85, isCurrent: false },
      { auditRunId: 8, executedAt: '2026-09-20T01:00:00Z', isPartial: false, readinessScore: 61, isCurrent: true },
    ],
  });
  const getRun = vi.spyOn(auditApi, 'getRun').mockResolvedValue({ ...run, auditRunId: 8 });
  vi.spyOn(auditApi, 'getFindings').mockResolvedValue({ content: [finding] } as Awaited<ReturnType<typeof auditApi.getFindings>>);
  vi.spyOn(auditApi, 'getUnverified').mockResolvedValue({ totalCount: 0, items: [] });
  await act(async () => root.render(<AuditResult productId={42} />));
  expect(getRun).toHaveBeenCalledWith(8);
  expect(getRun).not.toHaveBeenCalledWith(9);
});

it('🔴 검수한 뒤에 일정을 고쳤으면 새로 연 화면도 출시 · 리포트를 잠근다 — 서버가 말해 준다 (#710)', async () => {
  // 브라우저 기억(sessionStorage)이 없는 상태다. 일정 편집을 저장하고 돌아온 경우가 이렇다
  const edited = { ...product, productId: 43, dayCount: 2, ldongRegnCd: '51', name: '고친 상품', region: { regnName: '강원', signguName: '강릉' }, composition: { manual: 3, picker: 0, excluded: 0 }, releasedAt: null,
    auditState: { kind: 'STALE', reason: 'EDIT' }, days: [{ day: 1, items: [{ ...item, mapx: 128, mapy: 37 }] }] };
  vi.spyOn(productApi, 'detail').mockResolvedValue(edited as Awaited<ReturnType<typeof productApi.detail>>);
  vi.spyOn(auditApi, 'listRuns').mockResolvedValue({ totalCount: 1, runs: [run] });
  vi.spyOn(auditApi, 'getRun').mockResolvedValue(run);
  vi.spyOn(auditApi, 'getFindings').mockResolvedValue({ content: [], totalElements: 0 });
  vi.spyOn(auditApi, 'getUnverified').mockResolvedValue({ totalCount: 0, items: [] });
  await act(async () => root.render(<AuditResult productId={43} />));
  expect(host.textContent).toContain('검수한 뒤에 일정이 바뀌었어요');
  expect([...host.querySelectorAll('button')].find(b => b.textContent === '출시 승인')?.disabled).toBe(true);
  expect(host.textContent).not.toContain('리포트 생성');
});

it('🔴 검수 시작 직후에는 「검수 실행」 을 보이지 않고 첫 결과를 기다린다 (#711)', async () => {
  const started = { ...product, productId: 44, dayCount: 2, ldongRegnCd: '51', name: '방금 넘긴 상품', region: { regnName: '강원', signguName: '강릉' }, composition: { manual: 3, picker: 0, excluded: 0 }, releasedAt: null,
    plannedAt: '2026-09-21T19:06:48+09:00', days: [{ day: 1, items: [{ ...item, mapx: 128, mapy: 37 }] }] };
  vi.spyOn(productApi, 'detail').mockResolvedValue(started as Awaited<ReturnType<typeof productApi.detail>>);
  // 처음 두 번은 아직 결과가 없다 — 검수 시작이 건 작업이 도는 중이다
  const runs = vi.spyOn(auditApi, 'listRuns')
    .mockResolvedValueOnce({ totalCount: 0, runs: [] })
    .mockResolvedValueOnce({ totalCount: 0, runs: [] })
    .mockResolvedValue({ totalCount: 1, runs: [run] });
  vi.spyOn(auditApi, 'getRun').mockResolvedValue(run);
  vi.spyOn(auditApi, 'getFindings').mockResolvedValue({ content: [], totalElements: 0 });
  vi.spyOn(auditApi, 'getUnverified').mockResolvedValue({ totalCount: 0, items: [] });
  vi.useFakeTimers();
  try {
    await act(async () => root.render(<AuditResult productId={44} />));
    expect(host.textContent).toContain('검수하고 있어요');
    expect([...host.querySelectorAll('button')].some(b => b.textContent === '검수 실행')).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_RUN_POLL_MS * 2 + 50); });
  } finally {
    vi.useRealTimers();
  }
  expect(runs.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(host.textContent).not.toContain('검수하고 있어요');
  expect(host.textContent).toContain('출시 준비도');
});

it('첫 결과가 끝내 안 생기면 기다리기를 그만두고 null 을 준다', async () => {
  let calls = 0;
  const got = await waitForFirstRun(1, () => false, async () => { calls += 1; return { runs: [] }; }, async () => undefined);
  expect(got).toBeNull();
  expect(calls).toBe(FIRST_RUN_POLL_TRIES);
  expect(isEditedSinceAudit(null)).toBe(false);
});

// 표출이 중단된 곳 (FR-RU-066 · UI-S3-025 · #810)
const hiddenFinding = {
  ...finding, findingId: 9, ruleCode: "R06", severity: "BLOCKER", reasonCode: "CONTENT_HIDDEN",
  message: "공사에서 이 관광지의 표출이 중단됐습니다", target: { itemId: 2 }, targetSecondary: null, patches: [],
  hiddenContent: { contentid: "129784", detectedAt: "2026-09-25T20:00:00+09:00" },
} as Finding;

it('🔴 표출이 중단된 곳은 지우지 않고 흐리게 둔 뒤 「표출 중단」 배지를 붙인다', async () => {
  const ids = hiddenItemIdsOf([finding, hiddenFinding]);
  expect([...ids]).toEqual([2]);
  await act(async () => root.render(<CurrentSchedule product={product} finding={null} expanded onToggle={() => {}} hiddenItemIds={ids} />));
  const rows = [...host.querySelectorAll('li')];
  expect(rows).toHaveLength(3);
  const hidden = rows.filter((li) => li.getAttribute('data-hidden') === 'true');
  expect(hidden).toHaveLength(1);
  expect(hidden[0]?.textContent).toContain('오죽헌·시립박물관');
  expect(hidden[0]?.textContent).toContain('표출 중단');
  expect(rows.filter((li) => li.textContent?.includes('표출 중단'))).toHaveLength(1);
});

it('🔴 결과 화면이 표출 중단 판정을 현재 일정표에 넘긴다', async () => {
  vi.spyOn(productApi, 'detail').mockResolvedValue({ ...product, name: '검증 상품', region: { regnName: '강원', signguName: '강릉' }, composition: { manual: 3, picker: 0, excluded: 0 }, releasedAt: null });
  vi.spyOn(auditApi, 'listRuns').mockResolvedValue({ totalCount: 1, runs: [run] });
  vi.spyOn(auditApi, 'getRun').mockResolvedValue(run);
  vi.spyOn(auditApi, 'getFindings').mockResolvedValue({ content: [finding, hiddenFinding] } as Awaited<ReturnType<typeof auditApi.getFindings>>);
  vi.spyOn(auditApi, 'getUnverified').mockResolvedValue({ totalCount: 0, items: [] });
  Element.prototype.scrollIntoView = vi.fn();
  await act(async () => root.render(<AuditResult productId={42} />));
  const hidden = [...schedule().querySelectorAll('li[data-hidden="true"]')];
  expect(hidden.map((li) => li.textContent)).toEqual([expect.stringContaining('오죽헌·시립박물관')]);
});
