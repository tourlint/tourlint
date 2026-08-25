"use client";

// 화면 2 · 상품 등록 · 편집 (UI-S2 · F01·F02). 1차 = 직접 입력.
// A 기본정보 + B 상품 성격·이동 + C 일정 입력 + 저장 → 검수 결과(화면 전이 2→3).
// 업로드·자연어(D)와 관광지 확정(E)은 후속 단계라 진입만 열어 둔다.

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Field, Section, Segmented, SelectInput, TextInput } from "./controls";
import { RegionSelect } from "./region-select";
import { ScheduleEditor } from "./schedule-editor";
import { UploadPanel, type ParsedItemDTO } from "./upload-panel";
import {
  NIGHTS_OPTIONS,
  TRANSPORT_OPTIONS,
  dayCount,
  type Nights,
  type Schedule,
  type Transport,
} from "./types";

type Method = "direct" | "upload" | "nl";

const METHODS: { value: Method; label: string; disabled?: boolean }[] = [
  { value: "direct", label: "직접 입력" },
  { value: "upload", label: "엑셀·CSV 업로드" },
  { value: "nl", label: "자연어 붙여넣기", disabled: true },
];

interface Region {
  regnCode: string;
  regnName: string;
  signguCode: string;
  signguName: string;
}

export default function ProductNewPage() {
  const router = useRouter();
  const [method, setMethod] = useState<Method>("direct");

  // A. 기본정보
  const [name, setName] = useState("");
  const [region, setRegion] = useState<Region>({ regnCode: "", regnName: "", signguCode: "", signguName: "" });
  const [startDate, setStartDate] = useState("");
  const [nights, setNights] = useState<Nights>(0);

  // B. 성격·이동
  const [target, setTarget] = useState("");
  const [concept, setConcept] = useState("");
  const [headcount, setHeadcount] = useState("");
  const [transport, setTransport] = useState<Transport>("car");

  // C. 일정 (일수 = 박수 + 1)
  const [schedule, setSchedule] = useState<Schedule>([[]]);

  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 업로드 파싱 결과를 폼에 채운다 (UI-S2-010). 박수와 일정만 채우고 나머지는 편집으로 둔다.
  function applyUpload(nights: number, items: ParsedItemDTO[]) {
    const n = Math.max(0, Math.min(2, nights)) as Nights;
    setNights(n);
    const days = dayCount(n);
    const sched: Schedule = Array.from({ length: days }, () => []);
    let seq = 0;
    for (const it of items) {
      const d = it.day - 1;
      if (d < 0 || d >= days) continue;
      seq += 1;
      sched[d].push({ id: `up-${seq}`, start: it.start, end: it.end ?? "", place: it.place, itemType: it.itemType });
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (errors.length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/v1/products", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload({ name, region, startDate, nights, target, concept, headcount, transport, schedule })),
      });
      if (!res.ok) throw new Error();
      const created = (await res.json()) as { productId?: number };
      // 저장 후 검수 결과로 (화면 전이 2→3). 관광지 확정은 2차라 자동 검수는 아직 안 돈다.
      router.push(created.productId != null ? `/products/${created.productId}` : "/");
    } catch {
      setSaveError("저장에 실패했습니다. 잠시 후 다시 시도해 주세요.");
      setSaving(false);
    }
  }

  return (
    <>
      <nav className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        <Link href="/" className="hover:underline">
          대시보드
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-700 dark:text-slate-300">신규 등록</span>
      </nav>

      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">상품 등록</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        여행 일정을 입력하면 관광정보로 검수할 수 있습니다. (F01)
      </p>

      {/* 등록 방식 선택 (UI-S2-001). 자연어 붙여넣기는 후속 단계. */}
      <div className="mt-6">
        <Segmented value={method} options={METHODS} onChange={setMethod} ariaLabel="등록 방식" />
        {method === "direct" && (
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
            엑셀·CSV 업로드로 일정을 한 번에 채울 수도 있습니다. 자연어 붙여넣기는 다음 단계에서 제공됩니다.
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
            <Field label="타깃 고객" hint="R10 타깃 적합성 판정에 쓰입니다.">
              <TextInput value={target} placeholder="예: 20~30대 커플" onChange={(e) => setTarget(e.target.value)} />
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
            <TextInput value={concept} placeholder="예: 해변 산책과 로컬 미식" onChange={(e) => setConcept(e.target.value)} />
          </Field>

          <Field label="이동수단" hint="R08 이동시간 판정에 쓰입니다.">
            <SelectInput value={transport} onChange={(e) => setTransport(e.target.value as Transport)}>
              {TRANSPORT_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </SelectInput>
          </Field>

          {/* 대중교통 선택 시 R08 확인 불가 안내 (UI-S2-005) */}
          {transport === "public" && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              대중교통을 선택하면 R08 이동시간 판정이 수행되지 않고 <strong>확인 불가</strong>로 처리됩니다.
            </p>
          )}
        </Section>

        {/* C. 일정 — 직접 입력이면 편집기, 업로드면 예시+파일 업로드 */}
        {method === "direct" ? (
          <ScheduleEditor nights={nights} schedule={schedule} onChange={setSchedule} />
        ) : (
          <UploadPanel onApplied={applyUpload} onEdit={() => setMethod("direct")} />
        )}

        {/* 저장 검증 결과 (UI-S2-012 박수↔일정 불일치 포함) */}
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

        <div className="flex items-center justify-end gap-3">
          <Link
            href="/"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            취소
          </Link>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "저장 중…" : "저장하고 검수"}
          </button>
        </div>
      </form>
    </>
  );
}

interface FormState {
  name: string;
  region: Region;
  startDate: string;
  nights: Nights;
  schedule: Schedule;
}

// UI-S2-012 — 박수와 일자별 일정 수가 불일치하면(빈 일차가 있으면) 저장을 막는다.
function validate(f: FormState): string[] {
  const errs: string[] = [];
  if (!f.name.trim()) errs.push("상품명을 입력하세요.");
  if (!f.region.regnCode) errs.push("여행 지역(시도)을 선택하세요.");
  if (!f.startDate) errs.push("출발일을 선택하세요.");
  for (let d = 0; d < dayCount(f.nights); d++) {
    if ((f.schedule[d]?.length ?? 0) === 0) errs.push(`${d + 1}일차 일정을 1개 이상 입력하세요.`);
  }
  return errs;
}

function buildPayload(
  f: FormState & {
    target: string;
    concept: string;
    headcount: string;
    transport: Transport;
  },
) {
  return {
    name: f.name.trim(),
    regnCd: f.region.regnCode,
    signguCd: f.region.signguCode || null,
    startDate: f.startDate,
    nights: f.nights,
    targetCustomer: f.target.trim() || null,
    concept: f.concept.trim() || null,
    headcount: f.headcount ? Number(f.headcount) : null,
    transport: f.transport,
    days: f.schedule.map((items, i) => ({
      day: i + 1,
      items: items.map((it) => ({
        start: it.start || null,
        end: it.end || null,
        place: it.place.trim(),
        itemType: it.itemType || null,
      })),
    })),
  };
}
