/**
 * 외부 호출 로그 — `api_call_log` 에 그대로 대응한다 (DB 명세서 3-16 · EI-CM-006 · FR-OP-001).
 *
 * **이 로그는 공모전 API 활용 증빙 자료다.** 개발 기간 전체를 보존하며 임의 정리하지 않는다
 * (DR-LC-004).
 *
 * 설계상 안전 장치 — 항목에 **자유 서술 필드를 두지 않았다.** 넣을 수 있는 값이
 * 오퍼레이션명·상태·코드·시각·소요시간뿐이라 인증키나 응답 원문이 들어갈 자리가 없다
 * (PM-SC-005 · NF-OB-006 · DB 명세서 6-4 누출 경로 ①).
 */

export const CALL_PROVIDER = ['KTO', 'KAKAO_MOBILITY', 'KMA', 'LLM'] as const;
export type CallProvider = (typeof CALL_PROVIDER)[number];

export const CALL_STATUS = ['OK', 'FAIL', 'TIMEOUT'] as const;
export type CallStatus = (typeof CALL_STATUS)[number];

export interface ApiCallLogEntry {
  readonly provider: CallProvider;
  readonly operation: string;
  readonly calledAt: Date;
  readonly status: CallStatus;
  readonly httpStatus: number | null;
  /** 공사 `resultCode` 등 제공자 결과 코드 */
  readonly resultCode: string | null;
  readonly latencyMs: number;
  /** 배치 호출은 null (DB 명세서 — FK SET NULL) */
  readonly auditRunId: number | null;
}

export interface ApiCallLogger {
  record(entry: ApiCallLogEntry): void | Promise<void>;
}

/**
 * 하루치 호출량을 세는 쪽. 예산 관리자가 이것만 알면 된다.
 *
 * 소진량은 **계정별이 아니라 서비스 전체(단일 인증키) 기준**이다 (FR-OP-002 · PM-DA-006).
 */
export interface DailyCallCounter {
  countToday(provider: CallProvider, now: Date): number | Promise<number>;
}

/**
 * DB 가 붙기 전까지 쓰는 메모리 구현이자, 테스트의 관측 지점.
 *
 * 프로세스가 죽으면 사라지므로 **증빙 보존 요건을 만족하지 않는다.**
 * 실제 보존은 `api_call_log` 테이블 구현으로 넘어간다.
 */
export class InMemoryApiCallLogger implements ApiCallLogger, DailyCallCounter {
  private readonly rows: ApiCallLogEntry[] = [];

  record(entry: ApiCallLogEntry): void {
    this.rows.push(entry);
  }

  get entries(): readonly ApiCallLogEntry[] {
    return this.rows;
  }

  countToday(provider: CallProvider, now: Date): number {
    const today = localDateKey(now);
    return this.rows.filter((r) => r.provider === provider && localDateKey(r.calledAt) === today).length;
  }

  /** 위젯의 "오퍼레이션별 상위 5개" (FR-OP-005) */
  topOperations(provider: CallProvider, now: Date, limit = 5): { operation: string; count: number }[] {
    const today = localDateKey(now);
    const tally = new Map<string, number>();
    for (const r of this.rows) {
      if (r.provider !== provider || localDateKey(r.calledAt) !== today) continue;
      tally.set(r.operation, (tally.get(r.operation) ?? 0) + 1);
    }
    return [...tally.entries()]
      .map(([operation, count]) => ({ operation, count }))
      .sort((a, b) => b.count - a.count || a.operation.localeCompare(b.operation))
      .slice(0, limit);
  }

  reset(): void {
    this.rows.length = 0;
  }
}

/**
 * 예산의 하루 경계 — **한국 시간 기준 날짜**다.
 *
 * 공사 한도가 KST 자정에 초기화되므로 UTC 로 세면 오후 9시 이후 호출이 다음 날로 넘어가
 * 소진량이 실제보다 적게 보인다.
 */
export function localDateKey(d: Date, offsetMinutes = 9 * 60): string {
  const shifted = new Date(d.getTime() + offsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}
