"use client";

// 여행 지역 — 시도 → 시군구 2단 드롭다운 (UI-S2-004). 목록은 API 응답을 그대로 쓴다.
// 시도를 고르면 그 시도의 시군구를 `?regnCd=` 로 조회한다. 실호출(라이브) 모드에선 모든
// 지역이 채워지고, fixture 모드에 스냅샷이 없는 지역은 빈 목록(선택 불가)으로 온다.
//
// 조회가 실패하면 조용히 [] 로 삼키지 않는다 — 드롭다운을 비활성화하고 재시도 수단을
// 준다 (EX-IN-010). 하드코딩 목록으로 대체하지 않는다.

import { useEffect, useState } from "react";
import { Field, SelectInput } from "./controls";
import { EXTERNAL_UNAVAILABLE } from "../../../lib/api";
import type { CodeItem } from "./types";

export interface RegionValue {
  regnCode: string;
  regnName: string;
  signguCode: string;
  signguName: string;
}

/** 실패는 던진다 — 빈 목록(정상)과 조회 실패(재시도 필요)를 구분해야 한다 (EX-IN-010) */
async function loadCodes(url: string): Promise<CodeItem[]> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("지역 코드를 불러오지 못했습니다.");
  const json = (await res.json()) as { items?: CodeItem[] };
  return json.items ?? [];
}

export function RegionSelect({
  value,
  onChange,
}: {
  value: RegionValue;
  onChange: (v: RegionValue) => void;
}) {
  const [regns, setRegns] = useState<CodeItem[]>([]);
  const [regnError, setRegnError] = useState(false);
  const [regnTick, setRegnTick] = useState(0);
  // 어느 시도의 시군구를 로드했는지 함께 담는다. 시도가 바뀌면 파생값이 즉시 []로 떨어져
  // 이전 지역 목록이 남지 않는다(staleness 제거). setState 는 async 콜백에서만 한다.
  const [loaded, setLoaded] = useState<{ regnCode: string; items: CodeItem[] }>({ regnCode: "", items: [] });
  const [signguError, setSignguError] = useState(false);
  const [signguTick, setSignguTick] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const items = await loadCodes("/api/v1/ldong-codes");
        if (alive) {
          setRegns(items);
          setRegnError(false);
        }
      } catch {
        if (alive) {
          setRegns([]);
          setRegnError(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [regnTick]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (value.regnCode === "") {
        if (alive) setSignguError(false);
        return;
      }
      try {
        const items = await loadCodes(`/api/v1/ldong-codes?regnCd=${encodeURIComponent(value.regnCode)}`);
        if (alive) {
          setLoaded({ regnCode: value.regnCode, items });
          setSignguError(false);
        }
      } catch {
        if (alive) setSignguError(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [value.regnCode, signguTick]);

  const signgus = loaded.regnCode === value.regnCode ? loaded.items : [];
  const loadingSanggu = value.regnCode !== "" && loaded.regnCode !== value.regnCode && !signguError;

  const signguPlaceholder =
    value.regnCode === ""
      ? "시도 먼저 선택"
      : signguError
        ? "불러오기 실패"
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
          disabled={regnError}
          onChange={(e) => {
            const opt = regns.find((r) => r.code === e.target.value);
            onChange({ regnCode: e.target.value, regnName: opt?.name ?? "", signguCode: "", signguName: "" });
          }}
        >
          <option value="">{regnError ? "불러오기 실패" : "선택"}</option>
          {regns.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </SelectInput>
        {regnError && <RetryNotice onRetry={() => setRegnTick((t) => t + 1)} />}
      </Field>

      <Field label="시군구">
        <SelectInput
          value={value.signguCode}
          disabled={value.regnCode === "" || signguError || signgus.length === 0}
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
        {signguError && <RetryNotice onRetry={() => setSignguTick((t) => t + 1)} />}
      </Field>
    </div>
  );
}

function RetryNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <p className="mt-1 flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400">
      {EXTERNAL_UNAVAILABLE}
      <button
        type="button"
        onClick={onRetry}
        className="rounded border border-rose-300 px-1.5 py-0.5 font-medium text-rose-700 transition hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/40"
      >
        재시도
      </button>
    </p>
  );
}
