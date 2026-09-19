// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditApi, patchApi, productApi, type RunSummary, type Finding, type ProductDetail, type ProductItem } from "../../../lib/api";
import { AuditResult, FindingsSection } from "./audit-result";

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
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host); select.mockClear(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe('검수 중 현재 일정 참조 (#570)', () => {
  it('선택·미리보기 없이 모든 일차와 현재 시간을 표시한다', async () => {
    await render();
    expect(schedule().querySelectorAll('li')).toHaveLength(3);
    expect(schedule().textContent).toContain('1일차'); expect(schedule().textContent).toContain('2일차');
    expect(schedule().textContent).toContain('11:00 – 12:30'); expect(schedule().textContent).toContain('종료 미입력');
    expect(host.textContent).toContain('수정안 0개 선택됨'); expect(select).not.toHaveBeenCalled();
  });
  it('일정에서 확인은 수정안을 선택하지 않고 앞뒤 두 장소만 강조한다', async () => {
    await render(); await click('일정에서 확인');
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
  it('접은 일정은 확인 버튼으로 다시 열리고 필터 결과가 없어도 남는다', async () => {
    await render(); await click('접기'); expect(schedule().querySelectorAll('li')).toHaveLength(0);
    await click('일정에서 확인'); expect(schedule().querySelectorAll('li')).toHaveLength(3);
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
    await render(product, [{ ...finding, target: { itemId: null }, targetSecondary: null, patches: [] }]); await click('일정에서 확인');
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
