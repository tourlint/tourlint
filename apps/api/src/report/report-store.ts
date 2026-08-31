import { randomUUID } from 'node:crypto';

/**
 * 생성된 PDF 를 **프로세스 메모리에만** 짧게 들고 있는다 (DB 명세서 6-4).
 *
 * PDF 에는 관광지명과 `restdate` 원문이 들어간다. 서버에 보관하면 그 파일이 곧 원문
 * 저장소이므로 디스크에도 DB 에도 쓰지 않는다 — `report` 테이블 자체가 없다(엔터티 20종).
 *
 * ## 왜 만들자마자 흘려보내지 않는가
 *
 * API 설계 4-7 이 생성(`POST`)과 내려받기(`GET .../download`)를 나눠 놨고, PM-DA-007 의
 * 인수조건이 "리포트 다운로드 URL 을 로그아웃 상태에서 열면"이라 열어 볼 URL 이 있어야
 * 그 조건을 적힌 대로 시험할 수 있다. 두 단계를 유지하되 사이를 메모리로 잇는다.
 *
 * 내려받을 때 다시 만들면 공사 재조회가 매번 나간다. 새로고침 다섯 번이면 80콜이다.
 *
 * ⚠️ 인스턴스가 여러 개로 늘면 만든 곳과 받는 곳이 갈려 깨진다. 지금 Railway 는 1개다.
 */

/** 보관 수명. 짧게 둔다 — 오래 들고 있으면 그건 저장이다 */
export const REPORT_TTL_MS = 5 * 60_000;
/** 동시 보관 상한. 넘으면 오래된 것부터 버린다 */
export const REPORT_CACHE_MAX = 20;

export interface ReportEntry {
  readonly reportId: string;
  readonly accountId: number;
  readonly auditRunId: number;
  readonly fileName: string;
  readonly pdf: Buffer;
  /** 보관 시각 (epoch ms) */
  readonly at: number;
}

export type NewReport = Omit<ReportEntry, 'reportId' | 'at'>;

export class ReportStore {
  private readonly entries = new Map<string, ReportEntry>();
  private readonly clock: () => number;

  constructor(clock: () => number = (): number => Date.now()) {
    this.clock = clock;
  }

  /** 보관하고 `reportId` 를 돌려준다. 식별자는 추측할 수 없어야 한다 (PM-DA-003) */
  put(report: NewReport): string {
    const now = this.clock();
    this.evict(now);
    const reportId = randomUUID();
    this.entries.set(reportId, { ...report, reportId, at: now });
    return reportId;
  }

  /**
   * 꺼낸다. **소유자가 아니면 없는 것으로 친다.**
   *
   * `reportId` 만으로는 부족하다 — 그걸로 충분하면 그게 곧 공개 링크다 (PM-DA-007).
   * 남의 것인지 만료된 것인지 구분해 알려주지 않는다 (EX-SY-003).
   */
  get(reportId: string, accountId: number): ReportEntry | null {
    const now = this.clock();
    this.evict(now);
    const hit = this.entries.get(reportId);
    if (hit === undefined || hit.accountId !== accountId) return null;
    return hit;
  }

  /** 수명이 지난 것과 상한을 넘긴 것을 버린다 */
  private evict(now: number): void {
    for (const [id, e] of this.entries) {
      if (now - e.at >= REPORT_TTL_MS) this.entries.delete(id);
    }
    // 삽입 순서가 곧 오래된 순이다 (Map 의 성질)
    while (this.entries.size > REPORT_CACHE_MAX) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}
