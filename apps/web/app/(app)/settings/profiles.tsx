"use client";

// R10 기대 콘텐츠 프로파일 편집 (UI-S8-005 · FR-RU-100). (타깃 · 콘셉트) → 기대 중분류
// 목록의 가변 행이다. 행을 더하고 지우며, 기대 중분류는 칩으로 고른다. 저장은 전체
// 교체다 — 지운 프로파일까지 반영된다.

import { useEffect, useMemo, useRef, useState } from "react";
import { SelectInput, TextInput } from "../products/new/controls";
import { isApiError, settingsTablesApi, type LclsItem, type ProfileEntry } from "../../lib/api";

interface Row extends ProfileEntry {
  _id: number;
}

export function ProfileEditor() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [catalog, setCatalog] = useState<LclsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(1);

  const nameOf = useMemo(() => new Map(catalog.map((c) => [c.code, c.name])), [catalog]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [p, l] = await Promise.all([settingsTablesApi.profiles(), settingsTablesApi.lcls()]);
        if (alive) {
          setRows(p.entries.map((e) => ({ ...e, _id: nextId.current++ })));
          setCatalog(l.entries);
        }
      } catch (err) {
        if (alive) setError(isApiError(err) ? err.message : "프로파일을 불러오지 못했습니다.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function edit(id: number, patch: Partial<ProfileEntry>) {
    setSaved(false);
    setRows((rs) => (rs === null ? rs : rs.map((r) => (r._id === id ? { ...r, ...patch } : r))));
  }
  function addRow() {
    setSaved(false);
    setRows((rs) => [
      ...(rs ?? []),
      { _id: nextId.current++, targetKey: "", conceptKey: "", expectedLcls2: [], expectsNight: false },
    ]);
  }
  function removeRow(id: number) {
    setSaved(false);
    setRows((rs) => (rs === null ? rs : rs.filter((r) => r._id !== id)));
  }
  function addLcls(id: number, code: string) {
    if (code === "") return;
    setRows((rs) =>
      rs === null
        ? rs
        : rs.map((r) => (r._id === id && !r.expectedLcls2.includes(code) ? { ...r, expectedLcls2: [...r.expectedLcls2, code] } : r)),
    );
    setSaved(false);
  }
  function removeLcls(id: number, code: string) {
    setSaved(false);
    setRows((rs) =>
      rs === null ? rs : rs.map((r) => (r._id === id ? { ...r, expectedLcls2: r.expectedLcls2.filter((c) => c !== code) } : r)),
    );
  }

  async function save() {
    if (rows === null) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await settingsTablesApi.saveProfiles(
        rows.map(({ targetKey, conceptKey, expectedLcls2, expectsNight }) => ({
          targetKey,
          conceptKey,
          expectedLcls2,
          expectsNight,
        })),
      );
      setRows(res.entries.map((e) => ({ ...e, _id: nextId.current++ })));
      setSaved(true);
    } catch (err) {
      setError(isApiError(err) ? err.message : "저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-slate-400">불러오는 중…</p>;
  if (rows === null) return <p className="text-sm text-rose-600 dark:text-rose-400">{error ?? "불러오지 못했습니다."}</p>;

  return (
    <>
      <p className="mb-2 text-xs text-slate-400">
        타깃 · 콘셉트별로 일정에 있어야 할 중분류를 지정합니다. R10 타깃 적합성 판정에 쓰입니다.
      </p>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 py-6 text-center text-sm text-slate-400 dark:border-slate-700">
          등록된 프로파일이 없습니다. 아래에서 추가하세요.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r._id} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-slate-500 dark:text-slate-400">
                  타깃
                  <TextInput
                    value={r.targetKey}
                    placeholder="예: 20대"
                    onChange={(e) => edit(r._id, { targetKey: e.target.value })}
                  />
                </label>
                <label className="text-xs text-slate-500 dark:text-slate-400">
                  콘셉트
                  <TextInput
                    value={r.conceptKey}
                    placeholder="예: 감성"
                    onChange={(e) => edit(r._id, { conceptKey: e.target.value })}
                  />
                </label>
              </div>

              <div className="mt-3">
                <p className="text-xs text-slate-500 dark:text-slate-400">기대 중분류</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {r.expectedLcls2.map((code) => (
                    <span
                      key={code}
                      className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-xs text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
                    >
                      {nameOf.get(code) ?? code}
                      <button
                        type="button"
                        onClick={() => removeLcls(r._id, code)}
                        className="text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-200"
                        aria-label={`${nameOf.get(code) ?? code} 제거`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <SelectInput
                    value=""
                    onChange={(e) => addLcls(r._id, e.target.value)}
                    className="w-40"
                  >
                    <option value="">+ 중분류 추가</option>
                    {catalog
                      .filter((c) => !r.expectedLcls2.includes(c.code))
                      .map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.name} ({c.code})
                        </option>
                      ))}
                  </SelectInput>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={r.expectsNight}
                    onChange={(e) => edit(r._id, { expectsNight: e.target.checked })}
                  />
                  숙박 포함 기대
                </label>
                <button
                  type="button"
                  onClick={() => removeRow(r._id)}
                  className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-50 dark:border-slate-700 dark:text-rose-400 dark:hover:bg-rose-950/40"
                >
                  프로파일 삭제
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={addRow}
        className="mt-3 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        + 프로파일 추가
      </button>

      <div className="mt-3 flex items-center justify-end gap-3">
        {error && <span className="mr-auto text-sm text-rose-600 dark:text-rose-400">{error}</span>}
        {saved && !error && <span className="mr-auto text-sm text-emerald-600 dark:text-emerald-400">저장했습니다.</span>}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "저장 중…" : "저장"}
        </button>
      </div>
    </>
  );
}
