"use client";

// 계정 기준표 편집 (UI-S8-005). 중분류별 기본 체류시간과 실내 · 야외 매핑을 표로
// 편집한다. JSON 직접 편집은 두지 않는다. 바뀐 행만 저장으로 보낸다.

import { useEffect, useState } from "react";
import { SelectInput, TextInput } from "../products/new/controls";
import {
  isApiError,
  settingsTablesApi,
  type DwellEntry,
  type IndoorOutdoor,
  type IoEntry,
} from "../../lib/api";

const SCROLL = "max-h-80 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800";
const IO_OPTIONS: { value: IndoorOutdoor; label: string }[] = [
  { value: "INDOOR", label: "실내" },
  { value: "OUTDOOR", label: "야외" },
  { value: "MIXED", label: "혼재" },
];
const IO_LABEL: Record<IndoorOutdoor, string> = { INDOOR: "실내", OUTDOOR: "야외", MIXED: "혼재" };

function SaveRow({
  changed,
  saving,
  saved,
  error,
  onSave,
}: {
  changed: number;
  saving: boolean;
  saved: boolean;
  error: string | null;
  onSave: () => void;
}) {
  return (
    <div className="mt-3 flex items-center justify-end gap-3">
      {error && <span className="mr-auto text-sm text-rose-600 dark:text-rose-400">{error}</span>}
      {saved && !error && (
        <span className="mr-auto text-sm text-emerald-600 dark:text-emerald-400">저장했습니다.</span>
      )}
      <span className="text-xs text-slate-400">{changed}개 변경됨</span>
      <button
        type="button"
        onClick={onSave}
        disabled={saving || changed === 0}
        className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {saving ? "저장 중…" : "저장"}
      </button>
    </div>
  );
}

export function DwellTable() {
  const [entries, setEntries] = useState<DwellEntry[] | null>(null);
  const [baseline, setBaseline] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await settingsTablesApi.dwell();
        if (alive) {
          setEntries(res.entries);
          setBaseline(Object.fromEntries(res.entries.map((e) => [e.lcls2, e.minutes])));
        }
      } catch (err) {
        if (alive) setError(isApiError(err) ? err.message : "체류시간 표를 불러오지 못했습니다.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function setMinutes(lcls2: string, v: number) {
    setSaved(false);
    setEntries((es) => (es === null ? es : es.map((e) => (e.lcls2 === lcls2 ? { ...e, minutes: v } : e))));
  }

  const changed = entries === null ? [] : entries.filter((e) => e.minutes !== baseline[e.lcls2]);

  async function save() {
    if (changed.length === 0) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await settingsTablesApi.saveDwell(changed.map((e) => ({ lcls2: e.lcls2, minutes: e.minutes })));
      setEntries(res.entries);
      setBaseline(Object.fromEntries(res.entries.map((e) => [e.lcls2, e.minutes])));
      setSaved(true);
    } catch (err) {
      setError(isApiError(err) ? err.message : "저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-slate-400">불러오는 중…</p>;
  if (entries === null) return <p className="text-sm text-rose-600 dark:text-rose-400">{error ?? "불러오지 못했습니다."}</p>;

  return (
    <>
      <p className="mb-2 text-xs text-slate-400">종료 시각이 없는 항목의 체류시간을 중분류별로 보완합니다 (분).</p>
      <div className={SCROLL}>
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th className="p-2 font-medium">중분류</th>
              <th className="p-2 font-medium">체류시간(분)</th>
              <th className="p-2 font-medium">기본값</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const dirty = e.minutes !== e.defaultMinutes;
              return (
                <tr key={e.lcls2} className="border-t border-slate-100 dark:border-slate-800/60">
                  <td className="p-2 text-slate-700 dark:text-slate-200">
                    {e.name} <span className="text-xs text-slate-400">{e.lcls2}</span>
                  </td>
                  <td className="p-2">
                    <TextInput
                      type="number"
                      value={e.minutes}
                      onChange={(ev) => setMinutes(e.lcls2, Number(ev.target.value))}
                      className="w-24"
                    />
                  </td>
                  <td className="p-2 text-xs text-slate-400">
                    {e.defaultMinutes}
                    {dirty && (
                      <button
                        type="button"
                        onClick={() => setMinutes(e.lcls2, e.defaultMinutes)}
                        className="ml-2 rounded border border-slate-300 px-1.5 py-0.5 font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                      >
                        복원
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <SaveRow changed={changed.length} saving={saving} saved={saved} error={error} onSave={save} />
    </>
  );
}

export function IndoorOutdoorTable() {
  const [entries, setEntries] = useState<IoEntry[] | null>(null);
  const [baseline, setBaseline] = useState<Record<string, IndoorOutdoor>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await settingsTablesApi.indoorOutdoor();
        if (alive) {
          setEntries(res.entries);
          setBaseline(Object.fromEntries(res.entries.map((e) => [e.lcls2, e.spaceType])));
        }
      } catch (err) {
        if (alive) setError(isApiError(err) ? err.message : "실내 · 야외 표를 불러오지 못했습니다.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function setSpace(lcls2: string, v: IndoorOutdoor) {
    setSaved(false);
    setEntries((es) => (es === null ? es : es.map((e) => (e.lcls2 === lcls2 ? { ...e, spaceType: v } : e))));
  }

  const changed = entries === null ? [] : entries.filter((e) => e.spaceType !== baseline[e.lcls2]);

  async function save() {
    if (changed.length === 0) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await settingsTablesApi.saveIndoorOutdoor(changed.map((e) => ({ lcls2: e.lcls2, spaceType: e.spaceType })));
      setEntries(res.entries);
      setBaseline(Object.fromEntries(res.entries.map((e) => [e.lcls2, e.spaceType])));
      setSaved(true);
    } catch (err) {
      setError(isApiError(err) ? err.message : "저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-slate-400">불러오는 중…</p>;
  if (entries === null) return <p className="text-sm text-rose-600 dark:text-rose-400">{error ?? "불러오지 못했습니다."}</p>;

  return (
    <>
      <p className="mb-2 text-xs text-slate-400">중분류가 실내인지 야외인지 지정합니다. R09 야외 비중 판정에 쓰입니다.</p>
      <div className={SCROLL}>
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th className="p-2 font-medium">중분류</th>
              <th className="p-2 font-medium">실내 · 야외</th>
              <th className="p-2 font-medium">기본값</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const dirty = e.spaceType !== e.defaultSpaceType;
              return (
                <tr key={e.lcls2} className="border-t border-slate-100 dark:border-slate-800/60">
                  <td className="p-2 text-slate-700 dark:text-slate-200">
                    {e.name} <span className="text-xs text-slate-400">{e.lcls2}</span>
                  </td>
                  <td className="p-2">
                    <SelectInput
                      value={e.spaceType}
                      onChange={(ev) => setSpace(e.lcls2, ev.target.value as IndoorOutdoor)}
                      className="w-28"
                    >
                      {IO_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </SelectInput>
                  </td>
                  <td className="p-2 text-xs text-slate-400">
                    {IO_LABEL[e.defaultSpaceType]}
                    {dirty && (
                      <button
                        type="button"
                        onClick={() => setSpace(e.lcls2, e.defaultSpaceType)}
                        className="ml-2 rounded border border-slate-300 px-1.5 py-0.5 font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                      >
                        복원
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <SaveRow changed={changed.length} saving={saving} saved={saved} error={error} onSave={save} />
    </>
  );
}
