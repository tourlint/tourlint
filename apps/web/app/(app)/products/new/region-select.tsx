"use client";

// 여행 지역 — 시도 → 시군구 2단 드롭다운 (UI-S2-004). 목록은 API 응답을 그대로 쓴다.
// 시도를 고르면 그 시도의 시군구를 `?regnCd=` 로 조회한다. 실호출(라이브) 모드에선 모든
// 지역이 채워지고, fixture 모드에 스냅샷이 없는 지역은 빈 목록(선택 불가)으로 온다.

import { useEffect, useState } from "react";
import { Field, SelectInput } from "./controls";
import type { CodeItem } from "./types";

export interface RegionValue {
  regnCode: string;
  regnName: string;
  signguCode: string;
  signguName: string;
}

async function loadCodes(url: string): Promise<CodeItem[]> {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return [];
    const json = (await res.json()) as { items?: CodeItem[] };
    return json.items ?? [];
  } catch {
    return [];
  }
}

export function RegionSelect({
  value,
  onChange,
}: {
  value: RegionValue;
  onChange: (v: RegionValue) => void;
}) {
  const [regns, setRegns] = useState<CodeItem[]>([]);
  // 어느 시도의 시군구를 로드했는지 함께 담는다. 시도가 바뀌면 파생값이 즉시 []로 떨어져
  // 이전 지역 목록이 남지 않는다(staleness 제거). setState 는 async 콜백에서만 한다.
  const [loaded, setLoaded] = useState<{ regnCode: string; items: CodeItem[] }>({ regnCode: "", items: [] });

  useEffect(() => {
    let alive = true;
    loadCodes("/api/v1/ldong-codes").then((items) => {
      if (alive) setRegns(items);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (value.regnCode === "") return;
    let alive = true;
    loadCodes(`/api/v1/ldong-codes?regnCd=${encodeURIComponent(value.regnCode)}`).then((items) => {
      if (alive) setLoaded({ regnCode: value.regnCode, items });
    });
    return () => {
      alive = false;
    };
  }, [value.regnCode]);

  const signgus = loaded.regnCode === value.regnCode ? loaded.items : [];
  const loadingSanggu = value.regnCode !== "" && loaded.regnCode !== value.regnCode;

  const signguPlaceholder =
    value.regnCode === ""
      ? "시도 먼저 선택"
      : loadingSanggu
        ? "불러오는 중…"
        : signgus.length === 0
          ? "해당 없음"
          : "선택";

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="시도" required>
        <SelectInput
          value={value.regnCode}
          onChange={(e) => {
            const opt = regns.find((r) => r.code === e.target.value);
            onChange({ regnCode: e.target.value, regnName: opt?.name ?? "", signguCode: "", signguName: "" });
          }}
        >
          <option value="">선택</option>
          {regns.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </SelectInput>
      </Field>

      <Field label="시군구">
        <SelectInput
          value={value.signguCode}
          disabled={value.regnCode === "" || signgus.length === 0}
          onChange={(e) => {
            const opt = signgus.find((s) => s.code === e.target.value);
            onChange({ ...value, signguCode: e.target.value, signguName: opt?.name ?? "" });
          }}
        >
          <option value="">{signguPlaceholder}</option>
          {signgus.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </SelectInput>
      </Field>
    </div>
  );
}
