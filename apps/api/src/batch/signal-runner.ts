import type { KtoClient } from '../external/kto';
import { isKtoError } from '../external/kto';
import {
  festivalQueryDate, reachedOlderThan, summarizeFestivals, summarizeNewContents,
  toSignalContent, type Signal, type SignalContent, type SignalWindow,
} from '../engine/signals';

/**
 * T1 · T2 수요 신호 러너 (F14 · FR-RU-110 ~ 122).
 *
 * 산출은 `engine/signals` 의 순수 함수가 하고, 여기서는 **공사를 불러 그 함수에 먹이는
 * 일만** 한다. 규칙 평가가 메모리 전용이어야 하는 것과 같은 분리다 (NF-PF-014).
 *
 * ## 한 번에 몇 페이지까지 읽는가
 *
 * `arrange=D` 가 생성일 내림차순이라 마지막 줄이 기준일보다 이르면 그만 읽는다
 * (EI-KT-021 실측). 강릉 첫 10건 중 최근 30일은 2건이었다 — 보통 한 페이지로 끝난다.
 * 그래도 상한을 둔다. 정렬을 못 믿는 응답이 오면 멈출 근거가 없어 계속 읽게 된다.
 *
 * ## 실패하면 신호를 만들지 않는다
 *
 * 조회에 실패하면 `null` 이다. 0 건으로 저장하면 「세어 보니 없었다」로 읽혀서
 * 「못 세어 봤다」와 구분이 사라진다 — 정보가 없다는 이유로 정상 판정을 하지 않는 것과
 * 같은 원칙이다 (FR-RU-051).
 */

/** 페이지 상한. 한 지역 한 구간에 이보다 더 부르지 않는다 */
export const MAX_PAGES = 5;
/** 한 페이지 건수 */
export const ROWS_PER_PAGE = 100;

export interface SignalRunnerOptions {
  readonly kto: () => KtoClient;
  /** 관심 키워드 (FR-RU-112). 비어 있으면 거르지 않는다 */
  readonly keywords?: readonly string[];
}

export class SignalRunner {
  private readonly kto: () => KtoClient;
  private readonly keywords: readonly string[];

  constructor(options: SignalRunnerOptions) {
    this.kto = options.kto;
    this.keywords = options.keywords ?? [];
  }

  /** T1 — 그 지역에 최근 등록된 콘텐츠 (FR-RU-110). 실패하면 `null` */
  async t1(window: SignalWindow): Promise<Signal | null> {
    if (window.ldongRegnCd === null) return null;
    const collected: SignalContent[] = [];
    try {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const res = await this.kto().areaBasedList({
          lDongRegnCd: window.ldongRegnCd,
          ...(window.ldongSignguCd === null ? {} : { lDongSignguCd: window.ldongSignguCd }),
          // 생성일 내림차순. 미지정이면 무정렬이라 조기 종료 판단이 서지 않는다 (EI-KT-021)
          arrange: 'D',
          numOfRows: ROWS_PER_PAGE,
          pageNo: page,
        });
        const rows = res.items.map((i) => toSignalContent(i, this.keywords));
        collected.push(...rows);
        if (rows.length === 0 || reachedOlderThan(rows, window.from)) break;
      }
    } catch (e) {
      if (!isKtoError(e)) throw e;
      return null;
    }
    return summarizeNewContents(collected, window, { keywordFiltered: this.keywords.length > 0 });
  }

  /** T2 — 여행기간 ±3일에 열리는 행사 (FR-RU-120). 실패하면 `null` */
  async t2(window: SignalWindow): Promise<Signal | null> {
    if (window.ldongRegnCd === null) return null;
    const collected: SignalContent[] = [];
    try {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const res = await this.kto().searchFestival({
          // 창의 시작일로 부른다. 그날 아직 안 끝난 행사가 함께 온다 (EI-KT-010)
          eventStartDate: festivalQueryDate(window),
          lDongRegnCd: window.ldongRegnCd,
          ...(window.ldongSignguCd === null ? {} : { lDongSignguCd: window.ldongSignguCd }),
          numOfRows: ROWS_PER_PAGE,
          pageNo: page,
        });
        const rows = res.items.map((i) => toSignalContent(i, this.keywords));
        collected.push(...rows);
        if (rows.length < ROWS_PER_PAGE) break;
      }
    } catch (e) {
      if (!isKtoError(e)) throw e;
      return null;
    }
    return summarizeFestivals(collected, window);
  }
}
