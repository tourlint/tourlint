"use client";

// 화면 2 · 상품 등록 · 편집 (UI-S2 · F01·F02). 1차 = 직접 입력.
// A 기본정보 + B 상품 성격·이동 + C 일정 입력 + 저장 → 기획 화면(기획 중 · planned_at NULL).
// 저장은 검수를 돌리지 않는다 — 검수는 기획 화면의 「검수 시작」이 한다 (개편안 결정 1 · 문제 D).
// 등록 방식 3종(직접 입력 · 엑셀/CSV · 자연어)이 다 열려 있다 (UI-S2-001).
// 어느 쪽으로 들어와도 결과는 같은 폼 상태로 모이고 저장 전에 여기서 편집한다 (UI-S2-010).

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Field, Section, Segmented, SelectInput, TextInput } from "./controls";
import { RegionSelect } from "./region-select";
import { canAnchor } from "./schedule-place-search";
import { ScheduleEditor } from "./schedule-editor";
import { RegisterPlacePicker } from "./register-place-picker";
import { LeaveConfirm } from "./leave-confirm";
import { afterSaveHref, hasInput, type AfterSave } from "./save-intent";
import { NlPanel } from "./nl-panel";
import { UploadPanel, type ParsedItemDTO } from "./upload-panel";
import {
  INPUT_METHODS,
  NIGHTS_OPTIONS,
  TRANSPORT_OPTIONS,
  dayCount,
  type InputMethod,
  type Nights,
  type Schedule,
  type ScheduleItem,
  type Transport,
} from "./types";
import type { PlanPlace } from "../../../lib/api";
import {
  CONCEPT_KEY,
  CONCEPT_LABEL,
  LCLS_SYSTM2,
  TARGET_KEY,
  TARGET_LABEL,
  findProfile,
} from "@tourlint/shared";
import type { PlanOrigin } from "../../../lib/api";

interface Region {
  regnCode: string;
  regnName: string;
  signguCode: string;
  signguName: string;
}

export default function ProductNewPage() {
  const router = useRouter();
  const [method, setMethod] = useState<InputMethod>("direct");

  // A. 기본정보
  const [name, setName] = useState("");
  const [region, setRegion] = useState<Region>({ regnCode: "", regnName: "", signguCode: "", signguName: "" });
  const [startDate, setStartDate] = useState("");
  const [nights, setNights] = useState<Nights>(0);

  // B. 성격·이동
  const [target, setTarget] = useState("");
  const [concept, setConcept] = useState("");
  const [headcount, setHeadcount] = useState("");
  const [transport, setTransport] = useState<Transport>("CAR");

  // "자주 넣는 곳" 칩에서 고른 종류. 생성 후 기획 화면의 장소 담기를 이 종류로 연다 (UI-S2-030)
  const [openType, setOpenType] = useState<string | null>(null);

  // 오른쪽 장소 담기의 "근처 3km" 기준이 되는 일정 줄(고른 줄). 일정 편집기의 체크로 고른다.
  // 좌표가 있는(관광지를 고른) 줄만 기준이 될 수 있다 — id 로만 들고, 좌표는 렌더 때 찾는다.
  const [anchorId, setAnchorId] = useState<string | null>(null);

  // 레이더 "이 지역으로 새 상품 기획"에서 넘어오면 지역을 미리 채우고 기획 출처를 남긴다 (FR-PL-001)
  const [planOrigin, setPlanOrigin] = useState<PlanOrigin | null>(null);
  useEffect(() => {
    // 쿼리 읽기는 클라이언트에서만. setState 는 비동기 콜백 안에서 한다(effect 본문 동기 setState 금지)
    void (async () => {
      const q = new URLSearchParams(window.location.search);
      const inputMethod = q.get("method");
      if (inputMethod === "upload" || inputMethod === "nl") setMethod(inputMethod);
      if (q.get("origin") !== "SIGNAL") return;
      const regnCd = q.get("regnCd") ?? "";
      const signguCd = q.get("signguCd") ?? "";
      const month = q.get("month") ?? "";
      if (regnCd !== "") setRegion((r) => (r.regnCode === "" ? { ...r, regnCode: regnCd, signguCode: signguCd } : r));
      setPlanOrigin({
        startedBy: "SIGNAL",
        ...(regnCd !== "" && month !== ""
          ? { signal: { type: "NEWS", regnCd, signguCd: signguCd === "" ? null : signguCd, from: `${month}-01`, to: `${month}-01` } }
          : {}),
      });
    })();
  }, []);

  // C. 일정 (일수 = 박수 + 1)
  const [schedule, setSchedule] = useState<Schedule>([[]]);

  const [submitted, setSubmitted] = useState(false);
  // 어느 버튼으로 저장 중인지. 둘 다 잠그되 "저장 중…"은 누른 쪽에만 적는다 (#657)
  const [saving, setSaving] = useState<AfterSave | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  // 세션이 만료돼 저장이 튕겼다가 재로그인하고 돌아오면 작성분을 되살린다 (EX-SY-002).
  // 임시저장은 세션 만료 순간에만 쓰므로 평소 사용에는 초안이 없다. 한 번 복원하면 지운다.
  useEffect(() => {
    void (async () => {
      const d = readDraft();
      if (d === null) return;
      clearDraft();
      setMethod(d.method);
      setName(d.name);
      setRegion(d.region);
      setStartDate(d.startDate);
      setNights(d.nights);
      setTarget(d.target);
      setConcept(d.concept);
      setHeadcount(d.headcount);
      setTransport(d.transport);
      setSchedule(d.schedule);
    })();
  }, []);

  // 업로드 파싱 결과를 폼에 채운다 (UI-S2-010). 박수와 일정만 채우고 나머지는 편집으로 둔다.
  const importSeq = useRef(0);
  function applyUpload(nights: number, items: ParsedItemDTO[]) {
    importSeq.current += 1;
    setAnchorId(null);
    const n = Math.max(0, Math.min(2, nights)) as Nights;
    setNights(n);
    const days = dayCount(n);
    const sched: Schedule = Array.from({ length: days }, () => []);
    let seq = 0;
    for (const it of items) {
      const d = it.day - 1;
      if (d < 0 || d >= days) continue;
      seq += 1;
      sched[d].push({ id: `up-${importSeq.current}-${seq}`, start: it.start, end: it.end ?? "", place: it.place, itemType: it.itemType });
    }
    setSchedule(sched);
  }

  // 박수를 바꾸면 일수에 맞춰 일정 배열 크기를 조정한다 (기존 일차는 보존)
  function changeNights(n: Nights) {
    setNights(n);
    setSchedule((prev) => {
      const days = dayCount(n);
      const next = prev.slice(0, days);
      while (next.length < days) next.push([]);
      return next;
    });
  }

  const errors = useMemo(
    () => validate({ name, region, startDate, nights, schedule }),
    [name, region, startDate, nights, schedule],
  );

  // 고른 줄(체크한 일정)의 좌표. 관광지를 골라 좌표가 있는 줄만 근처 3km 기준이 된다.
  // 스케줄은 작아 매 렌더 훑어도 부담이 없다 — 오른쪽 picker 는 anchor.contentId 로만 다시 부른다.
  const anchorRow = schedule.flat().find(
    (it) => it.id === anchorId && canAnchor(it.content),
  );
  const anchor = anchorRow?.content
    ? { contentId: anchorRow.content.contentId, mapx: anchorRow.content.mapx as number, mapy: anchorRow.content.mapy as number, label: anchorRow.place || "고른 장소" }
    : null;

  // 장소 담기에서 고른 곳을 폼 일정에 끼운다. 저장 전이라 상품 없이 폼 상태만 바꾼다.
  // dayIdx = 0 기반 일차, insertAt = 그 날 항목 배열에 끼울 위치(0 = 맨 앞, 길이 = 맨 뒤).
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await save("plan");
  }

  /**
   * 저장한다. `plan` 이면 장소 고르기로 이어 가고, `list` 면 기획 목록으로 돌아간다 —
   * 상품은 기획중으로 남는다 (#657). 저장 조건은 둘 다 같다.
   */
  async function save(next: AfterSave) {
    setSubmitted(true);
    if (errors.length > 0) return;
    setSaving(next);
    setSaveError(null);
    try {
      const res = await fetch("/api/v1/products", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload({ name, region, startDate, nights, target, concept, headcount, transport, schedule, planOrigin })),
      });
      if (res.status === 401) {
        // 세션 만료 — 작성분을 담아 두고 재로그인으로 유도한다 (EX-SY-002). 돌아오면 복원된다.
        saveDraft({ method, name, region, startDate, nights, target, concept, headcount, transport, schedule });
        router.push("/login");
        return;
      }
      if (!res.ok) throw new Error();
      const created = (await res.json()) as { productId?: number };
      // 저장 후 기획 화면으로 — 거기서 이어서 장소를 고르고 검수로 넘어간다 (FR-PL-004)
      router.push(afterSaveHref(next, created.productId ?? null, openType));
    } catch {
      setSaveError("저장에 실패했습니다. 잠시 후 다시 시도해 주세요.");
      setSaving(null);
    }
  }

  /** 취소. 작성한 게 있으면 묻고, 빈 폼이면 그냥 나간다 (#657) */
  function leave() {
    if (hasInput({ name, regnCode: region.regnCode, startDate, nights, target, concept, headcount, transport, schedule })) {
      setLeaving(true);
      return;
    }
    router.push("/planning");
  }

  return (
    <>
      <nav className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        <Link href="/planning" className="hover:underline">
          기획
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-700 dark:text-slate-300">새 상품 기획</span>
      </nav>

      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">상품 기획</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        여행 일정을 입력하면 관광정보로 검수할 수 있습니다.
      </p>

      {/* 왼쪽 등록 폼 · 오른쪽 장소 담기 2단 (UI-S2-036). 좁은 화면에선 세로로 쌓인다.
          장소 담기는 저장 전에도 지역만 있으면 그 지역의 장소를 보여 준다 — 폼은 그대로 둔다. */}
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1fr_24rem]">
        <div className="min-w-0">
      {/* 등록 방식 선택 (UI-S2-001). 자연어 붙여넣기는 후속 단계. */}
      <div className="mt-0">
        <Segmented value={method} options={INPUT_METHODS} onChange={setMethod} ariaLabel="등록 방식" />
        {method === "direct" && (
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
            일정은 비워 두고 저장해도 됩니다 — 다음 기획 화면에서 장소 담기로 채울 수 있어요. 엑셀·CSV 업로드나 자연어 붙여넣기로 한 번에 채울 수도 있습니다.
          </p>
        )}
      </div>

      <form onSubmit={onSubmit} className="mt-6 space-y-6" noValidate>
        {/* A. 기본정보 */}
        <Section title="기본정보">
          <Field label="상품명" required>
            <TextInput value={name} placeholder="예: 강릉 바다 2박 3일" onChange={(e) => setName(e.target.value)} />
          </Field>

          <RegionSelect value={region} onChange={setRegion} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="출발일" required>
              <TextInput type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </Field>
            <Field label="박수" required>
              <Segmented value={nights} options={NIGHTS_OPTIONS} onChange={changeNights} ariaLabel="박수" />
            </Field>
          </div>
        </Section>

        {/* B. 상품 성격 · 이동 */}
        <Section title="상품 성격 · 이동">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="타깃 고객">
              <SelectInput value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">선택 안 함</option>
                {TARGET_KEY.map((k) => (
                  <option key={k} value={k}>
                    {TARGET_LABEL[k]}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label="예상 인원">
              <TextInput
                type="number"
                min={1}
                value={headcount}
                placeholder="예: 2"
                onChange={(e) => setHeadcount(e.target.value)}
              />
            </Field>
          </div>

          <Field label="상품 콘셉트">
            <SelectInput value={concept} onChange={(e) => setConcept(e.target.value)}>
              <option value="">선택 안 함</option>
              {CONCEPT_KEY.map((k) => (
                <option key={k} value={k}>
                  {CONCEPT_LABEL[k]}
                </option>
              ))}
            </SelectInput>
          </Field>

          <FavoriteTypes target={target} concept={concept} selected={openType} onPick={setOpenType} />

          <Field label="이동수단">
            <SelectInput value={transport} onChange={(e) => setTransport(e.target.value as Transport)}>
              {TRANSPORT_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </SelectInput>
          </Field>

          {/* 대중교통은 이동 시간을 확인하기 어렵다는 안내 (UI-S2-005). 규칙 번호 · 등급 말은 쓰지 않는다 */}
          {transport === "PUBLIC_TRANSIT" && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              대중교통을 선택하면 이동 시간을 확인하기 어려워, 이동 관련 항목은 검수에서 빠질 수 있습니다.
            </p>
          )}
        </Section>

        {/* C. 일정 — 직접 입력이면 편집기, 업로드·자연어면 각자의 입구. 결과는 셋 다 같은 폼 상태로 들어온다 */}
        {method === "direct" && (
          <ScheduleEditor
            nights={nights}
            schedule={schedule}
            onChange={setSchedule}
            regnCd={region.regnCode}
            signguCd={region.signguCode || null}
            regionLabel={region.signguName || region.regnName || "이 지역"}
            anchorId={anchorId}
            onAnchorChange={setAnchorId}
          />
        )}
        {method === "upload" && (
          <UploadPanel onApplied={applyUpload} onEdit={() => setMethod("direct")} />
        )}
        {method === "nl" && <NlPanel onApplied={applyUpload} onEdit={() => setMethod("direct")} />}

        {/* 저장 검증 결과 — 기본정보 3칸만 본다 (EX-IN-005 개정 · #519) */}
        {submitted && errors.length > 0 && (
          <div
            role="alert"
            className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300"
          >
            <p className="font-medium">입력을 확인해 주세요.</p>
            <ul className="mt-1 list-disc pl-5">
              {errors.map((msg) => (
                <li key={msg}>{msg}</li>
              ))}
            </ul>
          </div>
        )}
        {saveError && (
          <p role="alert" className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
            {saveError}
          </p>
        )}

        {/* 나가는 길 셋 — 버리기 · 남겨 두기 · 이어 가기 (#657) */}
        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={leave}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            취소
          </button>
          <button
            type="button"
            disabled={saving !== null}
            onClick={() => void save("list")}
            className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-indigo-900 dark:bg-indigo-950/50 dark:text-indigo-300 dark:hover:bg-indigo-900/60"
          >
            {saving === "list" ? "저장 중…" : "저장"}
          </button>
          <button
            type="submit"
            disabled={saving !== null}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving === "plan" ? "저장 중…" : "저장하고 장소 고르기"}
          </button>
        </div>
      </form>
        </div>

        {/* 오른쪽 장소 담기 — 지역이 없으면 기본 템플릿, 지역을 넣으면 그 지역 장소로 채운다 */}
        <aside className="lg:sticky lg:top-4">
          <RegisterPlacePicker
            regnCd={region.regnCode}
            signguCd={region.signguCode || null}
            startDate={startDate}
            nights={nights}
            regionLabel={region.signguName || region.regnName || "이 지역"}
            openType={openType}
            anchor={anchor}
            schedule={schedule}
            onInsert={handleInsert}
          />
        </aside>
      </div>

      {leaving && <LeaveConfirm onStay={() => setLeaving(false)} onLeave={() => router.push("/planning")} />}
    </>
  );
}

// ── 세션 만료 대비 임시저장 (EX-SY-002) ──────────────────────────────────────
// sessionStorage 는 같은 탭에서 로그인 화면을 거쳐 돌아와도 유지된다. 세션 만료 순간에만
// 쓰고, 복원하면 지운다.

const DRAFT_KEY = "tourlint:product-new-draft";

interface Draft {
  method: InputMethod;
  name: string;
  region: Region;
  startDate: string;
  nights: Nights;
  target: string;
  concept: string;
  headcount: string;
  transport: Transport;
  schedule: Schedule;
}

function saveDraft(d: Draft): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    // 저장이 안 되면(사생활 모드 등) 임시저장만 건너뛴다 — 저장 흐름 자체는 막지 않는다
  }
}

function readDraft(): Draft | null {
  try {
    const s = sessionStorage.getItem(DRAFT_KEY);
    return s === null ? null : (JSON.parse(s) as Draft);
  } catch {
    return null;
  }
}

function clearDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // 지우기 실패는 무시한다 — 다음 복원에서 clearDraft 가 다시 시도한다
  }
}

interface FormState {
  name: string;
  region: Region;
  startDate: string;
  nights: Nights;
  schedule: Schedule;
}

// 기본정보만 있으면 기획 중으로 저장한다 (EX-IN-005 개정 · #519). 일정은 비워 두고 저장해
// 다음 기획 화면에서 장소 담기로 채울 수 있다. 박수↔일정 완성도는 검수 시작에서 본다.
function validate(f: FormState): string[] {
  const errs: string[] = [];
  if (!f.name.trim()) errs.push("상품명을 입력하세요.");
  if (!f.region.regnCode) errs.push("여행 지역(시도)을 선택하세요.");
  if (!f.startDate) errs.push("출발일을 선택하세요.");
  return errs;
}

function buildPayload(
  f: FormState & {
    target: string;
    concept: string;
    headcount: string;
    transport: Transport;
    planOrigin?: PlanOrigin | null;
  },
) {
  // 필드명·enum 은 API 정본(설계 5-1)을 따른다. 이동수단은 공용 TRANSPORT 값을 그대로 보낸다.
  return {
    name: f.name.trim(),
    ldongRegnCd: f.region.regnCode,
    ldongSignguCd: f.region.signguCode || null,
    startDate: f.startDate,
    nights: f.nights,
    targetKey: f.target.trim() || null,
    conceptKey: f.concept.trim() || null,
    headCount: f.headcount ? Number(f.headcount) : null,
    transport: f.transport,
    planOrigin: f.planOrigin ?? null,
    days: f.schedule.map((items, i) => ({
      day: i + 1,
      items: items.map((it) => ({
        start: it.start,
        end: it.end || null,
        place: it.place.trim(),
        itemType: it.itemType,
        // 입력하는 순간 고른 관광지가 있으면 저장 시 CONFIRMED 로 (UI-S2-020 · create content 계약)
        ...(it.content ? { content: it.content } : {}),
      })),
    })),
  };
}

// 타깃 · 콘셉트를 고르면 그 조합에 자주 넣는 종류를 칩으로 보여 준다 (FR-PL-003). R10 표준
// 프로파일(@tourlint/shared)을 그대로 읽는다 — 기대 · 없음 같은 판정은 붙이지 않는다. 종류
// 칩을 누르면 생성 후 기획 화면의 장소 담기가 그 종류로 열린다 (UI-S2-030). "저녁 일정"은
// 종류(lcls2)가 아니라 밤을 낀다는 표시라 누를 수 없다.
function FavoriteTypes({
  target,
  concept,
  selected,
  onPick,
}: {
  target: string;
  concept: string;
  selected: string | null;
  onPick: (lcls2: string | null) => void;
}) {
  const profile = target !== "" && concept !== "" ? findProfile(target, concept) : null;
  if (profile === null) return null;
  const tLabel = TARGET_LABEL[target as keyof typeof TARGET_LABEL] ?? target;
  const cLabel = CONCEPT_LABEL[concept as keyof typeof CONCEPT_LABEL] ?? concept;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40">
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {tLabel} · {cLabel} 여행에 자주 넣는 곳
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {profile.expectedLcls2.map((code) => {
          const on = selected === code;
          return (
            <button
              key={code}
              type="button"
              aria-pressed={on}
              // 같은 칩을 다시 누르면 선택을 끈다 — 종류 없이 기획 화면으로 간다
              onClick={() => onPick(on ? null : code)}
              className={`rounded-md border px-2 py-0.5 text-xs transition ${
                on
                  ? "border-indigo-500 bg-indigo-600 text-white"
                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              }`}
            >
              {LCLS_SYSTM2[code]?.name ?? code}
            </button>
          );
        })}
        {profile.expectsNight && (
          <span className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            저녁 일정
          </span>
        )}
      </div>
    </div>
  );
}
