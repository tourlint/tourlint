"use client";

// 화면 2 · 상품 편집 (UI-S2 · FR-CM-006 · FR-IN-014).
//
// 등록 폼의 ScheduleEditor 를 그대로 쓴다. 다른 것은 항목이 서버 id 를 들고 있다는 점뿐이고,
// 저장할 때 그 id 로 무엇을 지우고 무엇을 새로 넣을지 정한다 (app/lib/schedule-diff).

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isApiError, itemApi, productApi, type ProductDetail, type ProductUpdate } from "../../../../lib/api";
import { isEmptyPlan, planSchedule, type EditedItem } from "../../../../lib/schedule-diff";
import { Field, Section, SelectInput, TextInput } from "../../new/controls";
import { ScheduleEditor } from "../../new/schedule-editor";
import {
  TRANSPORT_OPTIONS,
  type ItemType,
  type Nights,
  type Schedule,
  type ScheduleItem,
} from "../../new/types";

interface Basic {
  name: string;
  startDate: string;
  targetKey: string;
  conceptKey: string;
  headCount: string;
  transport: string;
}

export function EditForm({ productId }: { productId: number }) {
  const router = useRouter();
  const [loaded, setLoaded] = useState<ProductDetail | null>(null);
  const [basic, setBasic] = useState<Basic | null>(null);
  const [schedule, setSchedule] = useState<Schedule>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // setState 는 전부 await 뒤에서 한다 (effect 안 동기 setState 금지 — 화면 3 과 같은 모양)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await productApi.detail(productId);
        if (cancelled) return;
        setLoaded(d);
        setBasic({
          name: d.name,
          startDate: d.startDate,
          targetKey: d.targetKey ?? "",
          conceptKey: d.conceptKey ?? "",
          headCount: d.headCount === null ? "" : String(d.headCount),
          transport: d.transport,
        });
        setSchedule(toSchedule(d));
      } catch (e) {
        if (!cancelled) setErr(isApiError(e) ? e.message : "상품을 불러오지 못했습니다.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [productId]);

  async function save() {
    if (loaded === null || basic === null) return;
    setBusy(true);
    setErr(null);
    try {
      const update = changedBasic(loaded, basic);
      if (Object.keys(update).length > 0) await productApi.update(productId, update);

      const plan = planSchedule(toEdited(toSchedule(loaded)), toEdited(schedule));
      if (!isEmptyPlan(plan)) {
        for (const itemId of plan.removed) await itemApi.remove(itemId);
        for (const p of plan.patched) await itemApi.patch(p.itemId, p.patch);

        /*
         * 추가한 항목의 id 를 받아 둔다. `PUT .../order` 는 그 상품의 **모든 항목**을
         * 요구해서(하나라도 빠지면 400) 새 항목이 빠지면 순서가 통째로 거절된다.
         */
        const newIds = new Map<number, number>();
        for (const [i, add] of plan.added.entries()) {
          const created = await itemApi.add(productId, {
            dayNo: add.dayNo, startTime: add.startTime, endTime: add.endTime,
            placeLabel: add.placeLabel, itemType: add.itemType,
          });
          newIds.set(i, created.itemId);
        }

        if (plan.needsOrder) {
          let added = 0;
          const order = plan.order.map((it) => ({
            itemId: it.itemId ?? (newIds.get(added++) as number),
            dayNo: it.dayNo,
            seq: it.seq,
          }));
          await itemApi.reorder(productId, order);
        }
      }
      router.push(`/products/${productId}`);
    } catch (e) {
      setErr(isApiError(e) ? e.message : "저장하지 못했습니다.");
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      await productApi.remove(productId);
      router.push("/");
    } catch (e) {
      setErr(isApiError(e) ? e.message : "삭제하지 못했습니다.");
      setBusy(false);
    }
  }

  if (loaded === null || basic === null) {
    return (
      <div className="text-sm text-slate-500 dark:text-slate-400">
        {err ?? "불러오는 중…"}
      </div>
    );
  }

  const region = [loaded.region.regnName, loaded.region.signguName].filter(Boolean).join(" ");

  return (
    <>
      <nav className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        <Link href="/" className="hover:underline">대시보드</Link>
        <span className="mx-1">/</span>
        <Link href={`/products/${productId}`} className="hover:underline">{loaded.name}</Link>
        <span className="mx-1">/</span>
        <span className="text-slate-700 dark:text-slate-200">편집</span>
      </nav>

      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">상품 편집</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        일정을 고치면 지난 검수 결과는 낡습니다. 저장한 뒤 다시 검수해 주세요.
      </p>

      <div className="mt-6 space-y-6">
        <Section title="기본정보">
          <Field label="상품명" required>
            <TextInput value={basic.name} onChange={(e) => setBasic({ ...basic, name: e.target.value })} />
          </Field>
          <Field label="출발일" required>
            <TextInput type="date" value={basic.startDate} onChange={(e) => setBasic({ ...basic, startDate: e.target.value })} />
          </Field>
          <Field label="여행 지역">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {region} · 바꿀 수 없습니다 — 확정한 관광지가 이 지역에서 나온 것입니다
            </p>
          </Field>
          <Field label="박수">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {loaded.nights === 0 ? "당일" : `${loaded.nights}박 ${loaded.nights + 1}일`} · 바꿀 수 없습니다 —
              줄이면 사라진 일차의 항목이 갈 곳이 없습니다
            </p>
          </Field>
        </Section>

        <Section title="상품 성격 · 이동">
          <Field label="타깃 고객">
            <TextInput value={basic.targetKey} onChange={(e) => setBasic({ ...basic, targetKey: e.target.value })} />
          </Field>
          <Field label="상품 콘셉트">
            <TextInput value={basic.conceptKey} onChange={(e) => setBasic({ ...basic, conceptKey: e.target.value })} />
          </Field>
          <Field label="예상 인원">
            <TextInput type="number" value={basic.headCount} onChange={(e) => setBasic({ ...basic, headCount: e.target.value })} />
          </Field>
          <Field label="이동수단">
            <SelectInput value={basic.transport} onChange={(e) => setBasic({ ...basic, transport: e.target.value })}>
              {TRANSPORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </SelectInput>
          </Field>
        </Section>

        <ScheduleEditor nights={loaded.nights as Nights} schedule={schedule} onChange={setSchedule} />

        {err !== null && <p className="text-sm text-rose-600 dark:text-rose-400">{err}</p>}

        <div className="flex items-center justify-between gap-3">
          {confirmDelete ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-rose-600 dark:text-rose-400">상품과 검수 이력이 함께 지워집니다. 되돌릴 수 없습니다.</span>
              <button type="button" onClick={remove} disabled={busy}
                className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60">
                삭제
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} disabled={busy}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 dark:border-slate-700 dark:text-slate-300">
                취소
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} disabled={busy}
              className="rounded-md border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-600 disabled:opacity-60 dark:border-rose-900 dark:text-rose-400">
              상품 삭제
            </button>
          )}

          <div className="flex gap-2">
            <Link href={`/products/${productId}`}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 dark:border-slate-700 dark:text-slate-300">
              취소
            </Link>
            <button type="button" onClick={save} disabled={busy}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
              {busy ? "저장 중…" : "저장"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/** 서버 일정 → 편집 모델. 항목 id 를 들고 가야 저장할 때 무엇이 바뀌었는지 안다 */
function toSchedule(d: ProductDetail): Schedule {
  const days: Schedule = Array.from({ length: d.dayCount }, () => []);
  for (const day of d.days) {
    const idx = day.day - 1;
    if (idx < 0 || idx >= days.length) continue;
    days[idx] = day.items.map((it) => ({
      id: `srv-${it.itemId}`,
      itemId: it.itemId,
      start: it.start,
      end: it.end ?? "",
      place: it.place,
      itemType: it.itemType as ItemType,
    }));
  }
  return days;
}

function toEdited(schedule: Schedule): EditedItem[] {
  const out: EditedItem[] = [];
  schedule.forEach((items, dayIdx) => {
    items.forEach((it: ScheduleItem, i) => {
      out.push({
        itemId: it.itemId,
        dayNo: dayIdx + 1,
        seq: i + 1,
        startTime: it.start,
        endTime: it.end,
        placeLabel: it.place,
        itemType: it.itemType,
      });
    });
  });
  return out;
}

/** 안 바뀐 값은 보내지 않는다 — 서버가 같은 값을 다시 쓰게 할 이유가 없다 */
function changedBasic(before: ProductDetail, now: Basic): ProductUpdate {
  const update: ProductUpdate = {};
  if (now.name !== before.name) update.name = now.name;
  if (now.startDate !== before.startDate) update.startDate = now.startDate;
  if (now.targetKey !== (before.targetKey ?? "")) update.targetKey = now.targetKey || null;
  if (now.conceptKey !== (before.conceptKey ?? "")) update.conceptKey = now.conceptKey || null;
  const head = before.headCount === null ? "" : String(before.headCount);
  if (now.headCount !== head) update.headCount = now.headCount === "" ? null : Number(now.headCount);
  if (now.transport !== before.transport) update.transport = now.transport;
  return update;
}
