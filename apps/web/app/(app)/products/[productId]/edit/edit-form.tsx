"use client";

// 화면 2 · 상품 편집 (UI-S2 · FR-CM-006 · FR-IN-014).
//
// 등록 폼의 ScheduleEditor 를 그대로 쓴다. 다른 것은 항목이 서버 id 를 들고 있다는 점뿐이고,
// 저장할 때 그 id 로 무엇을 지우고 무엇을 새로 넣을지 정한다 (app/lib/schedule-diff).
//
// 기획 중 상품의 「기획 이어하기」가 여기로 온다 (#665). 그래서 등록 화면과 같은 2단이다 —
// 왼쪽 폼 · 오른쪽 장소 담기 (UI-S2-036 「등록 전·저장 후 모두 같은 패널」). 고른 장소는
// 폼 상태에만 들어가고 저장할 때 확정 상태로 나간다.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isApiError, itemApi, matchApi, productApi, type PlanPlace, type PlanWalk, type ProductDetail, type ProductUpdate } from "../../../../lib/api";
import { isEmptyPlan, planSchedule, type EditedItem } from "../../../../lib/schedule-diff";
import { Field, Section, Segmented, SelectInput, TextInput } from "../../new/controls";
import { ScheduleEditor } from "../../new/schedule-editor";
import { RegisterPlacePicker } from "../../new/register-place-picker";
import { UploadPanel, type ParsedItemDTO } from "../../new/upload-panel";
import { NlPanel } from "../../new/nl-panel";
import { importedSchedule } from "../../new/imported-schedule";
import { pruneEmptyItems, scheduleErrors } from "../../new/schedule-check";
import { canAnchor } from "../../new/schedule-place-search";
import {
  INPUT_METHODS,
  TRANSPORT_OPTIONS,
  type InputMethod,
  type ItemType,
  type Nights,
  type Schedule,
  type ScheduleItem,
} from "../../new/types";
import { CONCEPT_KEY, CONCEPT_LABEL, TARGET_KEY, TARGET_LABEL } from "@tourlint/shared";

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
  // 오른쪽 장소 담기의 「근처 3km」 기준이 되는 줄. 등록 화면과 같다
  const [anchorId, setAnchorId] = useState<string | null>(null);
  // 일정을 채우는 방식 3종. 등록 화면과 같다 (UI-S2-001 · #670)
  const [method, setMethod] = useState<InputMethod>("direct");
  const [importNote, setImportNote] = useState<string | null>(null);

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

  /**
   * 엑셀 · 자연어로 읽은 일정을 폼에 채운다 (UI-S2-010 · #670).
   *
   * 등록 화면과 다른 점 하나 — **박수는 바꿀 수 없다.** 그래서 읽은 박수를 따르지 않고 이
   * 상품의 일수에 맞춰 넣고, 넘치는 일차의 항목은 버린 수를 알린다. 조용히 사라지면
   * 저장한 뒤에야 없어진 걸 안다.
   */
  const importSeq = useRef(0);
  function applyImport(items: ParsedItemDTO[], origin: "UPLOAD" | "TEXT") {
    if (loaded === null) return;
    importSeq.current += 1;
    // 엑셀이면 UPLOAD, 자연어면 TEXT 로 저장된다 (FR-PL-020)
    const { schedule: next, put, dropped } = importedSchedule(items, loaded.dayCount, importSeq.current, origin);
    setAnchorId(null);
    setSchedule(next);
    setImportNote(
      dropped === 0
        ? `${put}개 항목을 넣었어요. 저장하면 지금 일정이 이걸로 바뀝니다.`
        : `${put}개 항목을 넣었어요. ${dropped}개는 이 상품의 일수를 넘어 넣지 못했습니다 — 박수는 편집에서 바꿀 수 없어요.`,
    );
  }

  // 장소 담기에서 고른 곳을 폼 일정에 끼운다. 저장할 때 확정 상태로 나간다 (#665)
  const insertSeq = useRef(0);
  function handleInsert(p: PlanPlace, dayIdx: number, insertAt: number, itemType: ScheduleItem["itemType"]) {
    insertSeq.current += 1;
    const item: ScheduleItem = {
      id: `pk-${insertSeq.current}`,
      start: "",
      end: "",
      place: p.title,
      itemType,
      content: { contentId: p.contentId, contentTypeId: p.contentTypeId, mapx: p.mapx, mapy: p.mapy, lcls1: p.lcls1, lcls2: p.lcls2, lcls3: null },
      origin: "PICKER",
    };
    setSchedule((prev) =>
      prev.map((items, i) => {
        if (i !== dayIdx) return items;
        const next = [...items];
        next.splice(Math.max(0, Math.min(insertAt, next.length)), 0, item);
        return next;
      }),
    );
  }

  // 장소 담기에서 고른 걷기 길을 폼 일정에 끼운다 — 저장할 때 걷기 길 추가로 넣는다 (UI-S2-048)
  function handleInsertWalk(w: PlanWalk, dayIdx: number, insertAt: number) {
    insertSeq.current += 1;
    const item: ScheduleItem = {
      id: `wk-${insertSeq.current}`, start: "", end: "", place: w.name, itemType: "SIGHT", origin: "PICKER", walk: { walkId: w.walkId },
    };
    setSchedule((prev) => prev.map((items, i) => {
      if (i !== dayIdx) return items;
      const next = [...items];
      next.splice(Math.max(0, Math.min(insertAt, next.length)), 0, item);
      return next;
    }));
  }

  async function save() {
    if (loaded === null || basic === null) return;
    // 추가만 하고 만 줄은 보내지 않고, 채우다 만 줄은 짚어 준다 (#673)
    const filled = pruneEmptyItems(schedule);
    const rowErrors = scheduleErrors(filled);
    if (rowErrors.length > 0) {
      setErr(rowErrors.join(" "));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const update = changedBasic(loaded, basic);
      if (Object.keys(update).length > 0) await productApi.update(productId, update);

      const plan = planSchedule(toEdited(toSchedule(loaded)), toEdited(filled));
      if (!isEmptyPlan(plan)) {
        for (const itemId of plan.removed) await itemApi.remove(itemId);
        for (const p of plan.patched) await itemApi.patch(p.itemId, p.patch);

        /*
         * 추가한 항목의 id 를 받아 둔다. `PUT .../order` 는 그 상품의 **모든 항목**을
         * 요구해서(하나라도 빠지면 400) 새 항목이 빠지면 순서가 통째로 거절된다.
         */
        const newIds = new Map<number, number>();
        for (const [i, add] of plan.added.entries()) {
          // 장소 담기로 고른 곳은 확정으로 넣는다 — 손으로 친 줄과 호출이 다르다 (FR-PL-013).
          // 걷기 길은 식별자와 정한 시각만 보낸다 — 코스 이름은 보내지 않는다 (DR-MD-005 · UI-S2-048)
          const created = add.walkId !== undefined
            ? await itemApi.addWalk(productId, { dayNo: add.dayNo, walkId: add.walkId, startTime: add.startTime, endTime: add.endTime })
            : add.content
            ? await itemApi.addPicked(productId, {
                dayNo: add.dayNo,
                itemType: add.itemType,
                // 분류가 빈 곳도 있다. 서버는 빈 값을 없는 것으로 받는다 (validatePickedItem)
                content: { ...add.content, lcls1: add.content.lcls1 ?? "", lcls2: add.content.lcls2 ?? "" },
              })
            : await itemApi.add(productId, {
                dayNo: add.dayNo, startTime: add.startTime, endTime: add.endTime,
                placeLabel: add.placeLabel, itemType: add.itemType,
                // 편집 화면에서 친 줄은 직접 입력, 엑셀 · 메모로 채운 줄은 그 경로 (FR-PL-020)
                origin: add.origin ?? "MANUAL",
                // 「직접 정한 곳으로 두기」를 고른 새 줄 (UI-S2-021)
                ...(add.excluded ? { excluded: true } : {}),
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
      /*
       * 고르는 중이던 저장된 줄에 「직접 정한 곳으로 두기」를 골랐으면 직접 정한 곳으로 바꾼다 (UI-S2-021).
       * 순서 · 시각 비교(planSchedule)와 따로다 — 그것만 바꿨으면 비교는 빈 계획이다
       */
      for (const it of filled.flat()) {
        if (it.itemId !== undefined && it.excluded === true && it.saved?.matchStatus === "PENDING") {
          await matchApi.exclude(it.itemId);
        }
      }
      router.push(`/products/${productId}${loaded.plannedAt === null ? "/plan" : ""}`);
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
  const planning = loaded.plannedAt === null;

  // 「근처 3km」 기준. 관광지를 골라 좌표가 있는 줄만 기준이 된다 (등록 화면과 같다)
  const anchorRow = schedule.flat().find((it) => it.id === anchorId && canAnchor(it.content));
  const anchor = anchorRow?.content
    ? { contentId: anchorRow.content.contentId, mapx: anchorRow.content.mapx as number, mapy: anchorRow.content.mapy as number, label: anchorRow.place || "고른 장소" }
    : null;

  return (
    <>
      <nav className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        <Link href="/" className="hover:underline">홈</Link>
        <span className="mx-1">/</span>
        <Link href={`/products/${productId}${loaded.plannedAt === null ? "/plan" : ""}`} className="hover:underline">{loaded.name}</Link>
        <span className="mx-1">/</span>
        <span className="text-slate-700 dark:text-slate-200">편집</span>
      </nav>

      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">
        {planning ? "상품 기획" : "상품 편집"}
      </h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {planning
          ? "저장한 내용을 그대로 이어서 채웁니다. 저장하면 장소를 확정하고 검수를 시작할 수 있어요."
          : "일정을 고치면 지난 검수 결과는 낡습니다. 저장한 뒤 다시 검수해 주세요."}
      </p>

      {/* 왼쪽 폼 · 오른쪽 장소 담기 2단 (UI-S2-036 · UI-S2-047) */}
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1fr_24rem]">
        <div className="min-w-0 space-y-6">
        {/* 일정을 채우는 방식 3종. 등록 화면과 같다 (UI-S2-001 · #670) */}
        <div>
          <Segmented value={method} options={INPUT_METHODS} onChange={setMethod} ariaLabel="일정 채우는 방식" />
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
            {method === "direct"
              ? "일정은 비워 두고 저장해도 됩니다 — 오른쪽 장소 담기로 채울 수 있어요. 엑셀·CSV 업로드나 자연어 붙여넣기로 한 번에 채울 수도 있습니다."
              : "읽어 온 일정은 지금 일정을 대신합니다. 저장하기 전에 직접 편집으로 확인하세요."}
          </p>
          {importNote !== null && (
            <p role="status" className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              {importNote}
            </p>
          )}
        </div>

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
            <SelectInput value={basic.targetKey} onChange={(e) => setBasic({ ...basic, targetKey: e.target.value })}>
              <option value="">선택 안 함</option>
              {TARGET_KEY.map((k) => (
                <option key={k} value={k}>
                  {TARGET_LABEL[k]}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="상품 콘셉트">
            <SelectInput value={basic.conceptKey} onChange={(e) => setBasic({ ...basic, conceptKey: e.target.value })}>
              <option value="">선택 안 함</option>
              {CONCEPT_KEY.map((k) => (
                <option key={k} value={k}>
                  {CONCEPT_LABEL[k]}
                </option>
              ))}
            </SelectInput>
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

        {method === "direct" && (
          <ScheduleEditor
            nights={loaded.nights as Nights}
            schedule={schedule}
            onChange={setSchedule}
            regnCd={loaded.ldongRegnCd}
            signguCd={loaded.ldongSignguCd}
            regionLabel={loaded.region.signguName || loaded.region.regnName || "이 지역"}
            anchorId={anchorId}
            onAnchorChange={setAnchorId}
          />
        )}
        {method === "upload" && <UploadPanel onApplied={(_n, items) => applyImport(items, "UPLOAD")} onEdit={() => setMethod("direct")} />}
        {method === "nl" && <NlPanel onApplied={(_n, items) => applyImport(items, "TEXT")} onEdit={() => setMethod("direct")} />}

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
            <Link href={`/products/${productId}${loaded.plannedAt === null ? "/plan" : ""}`}
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

        {/* 오른쪽 장소 담기 — 등록 화면과 같은 패널. 고른 곳은 저장할 때 확정으로 나간다 */}
        <aside className="lg:sticky lg:top-4">
          <RegisterPlacePicker
            regnCd={loaded.ldongRegnCd}
            signguCd={loaded.ldongSignguCd}
            startDate={basic.startDate}
            nights={loaded.nights as Nights}
            regionLabel={loaded.region.signguName || loaded.region.regnName || "이 지역"}
            openType={null}
            target={basic.targetKey || null}
            anchor={anchor}
            schedule={schedule}
            onInsert={handleInsert}
            onStartDateChange={(date) => setBasic({ ...basic, startDate: date })}
            onInsertWalk={handleInsertWalk}
          />
        </aside>
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
      saved: { end: it.end ?? "", endTimeSource: it.endTimeSource, lcls2: it.lcls2, matchStatus: it.matchStatus },
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
        ...(it.content ? { content: it.content } : {}),
        ...(it.origin ? { origin: it.origin } : {}),
        ...(it.excluded && !it.content ? { excluded: true } : {}),
        ...(it.walk ? { walkId: it.walk.walkId } : {}),
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
