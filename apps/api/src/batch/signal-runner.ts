import type { KtoClient } from '../external/kto';
import { isKtoError } from '../external/kto';
import {
  festivalQueryDate, reachedOlderThan, summarizeFestivals, summarizeNewContents, summarizeVisitors,
  isNewInWindow, opensInWindow, toKtoDay, toSignalContent, toVisitorRow,
  type Signal, type SignalContent, type SignalWindow,
} from '../engine/signals';

/**
 * T1 · T2 · T3 수요 신호 러너 (F14 · FR-RU-110 ~ 122 · FR-MO-059).
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


/**
 * 화면에 보여 줄 신호 한 줄 (#644).
 *
 * **이름은 공사 원문이라 저장하지 않는다** (DR-PR-001). 세는 것과 달리 보여 줄 때는
 * 이름이 없으면 「그래서 무엇이 새로 생겼는지」를 말할 수 없어, 표시할 때만 조달한다.
 */
export interface SignalListItem {
  readonly contentId: string;
  readonly title: string;
  readonly contentTypeId: string;
  /** `YYYYMMDDHHmmss` — T1 의 근거 */
  readonly createdTime: string;
  readonly eventStart: string | null;
  readonly eventEnd: string | null;
}

/** 목록은 한 페이지만 본다 — 건수는 이미 세어 뒀고 여기서는 몇 줄 보여 주는 것이 전부다 */
export const LIST_ROWS = 100;

export interface SignalRunnerOptions {
  readonly kto: () => KtoClient;
}

export class SignalRunner {
  private readonly kto: () => KtoClient;

  constructor(options: SignalRunnerOptions) {
    this.kto = options.kto;
  }

  /**
   * T1 — 그 지역에 최근 등록된 콘텐츠 (FR-RU-110). 실패하면 `null`.
   *
   * `keywords` 는 그 창을 쓰는 계정들의 관심 키워드 합집합이다 (FR-RU-112). 제목 일치만
   * 판정해 `byKeyword` 에 곳 목록으로 남기고 건수는 거르지 않는다.
   */
  async t1(window: SignalWindow, keywords: readonly string[] = []): Promise<Signal | null> {
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
        const rows = res.items.map((i) => toSignalContent(i, keywords));
        collected.push(...rows);
        if (rows.length === 0 || reachedOlderThan(rows, window.from)) break;
      }
    } catch (e) {
      if (!isKtoError(e)) throw e;
      return null;
    }
    return summarizeNewContents(collected, window, keywords);
  }

  /** T2 — 여행기간 ±3일(관심 지역은 그 달)에 열리는 행사 (FR-RU-120). 실패하면 `null` */
  async t2(window: SignalWindow, keywords: readonly string[] = []): Promise<Signal | null> {
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
        const rows = res.items.map((i) => toSignalContent(i, keywords));
        collected.push(...rows);
        if (rows.length < ROWS_PER_PAGE) break;
      }
    } catch (e) {
      if (!isKtoError(e)) throw e;
      return null;
    }
    return summarizeFestivals(collected, window, keywords);
  }


  /**
   * T1 목록 — 그 창에 새로 등록된 곳 (#644). 세는 조건은 `isNewInWindow` 로 같다.
   *
   * 한 페이지(100건)만 본다. 등록일 내림차순이라 새 것이 앞에 오고, 창을 벗어난 줄은
   * 조건이 걸러 낸다. 조회에 실패하면 `null` — 목록을 못 보여 주는 것이지 건수가 틀린 게 아니다.
   */
  async listT1(window: SignalWindow, limit: number): Promise<readonly SignalListItem[] | null> {
    if (window.ldongRegnCd === null) return null;
    try {
      const res = await this.kto().areaBasedList({
        lDongRegnCd: window.ldongRegnCd,
        ...(window.ldongSignguCd === null ? {} : { lDongSignguCd: window.ldongSignguCd }),
        arrange: 'D',
        numOfRows: LIST_ROWS,
        pageNo: 1,
      });
      return pickItems(res.items, window, isNewInWindow, limit);
    } catch (e) {
      if (!isKtoError(e)) throw e;
      return null;
    }
  }

  /** T2 목록 — 그 창에 열리는 행사 (#644). 세는 조건은 `opensInWindow` 로 같다 */
  async listT2(window: SignalWindow, limit: number): Promise<readonly SignalListItem[] | null> {
    if (window.ldongRegnCd === null) return null;
    try {
      const res = await this.kto().searchFestival({
        eventStartDate: festivalQueryDate(window),
        lDongRegnCd: window.ldongRegnCd,
        ...(window.ldongSignguCd === null ? {} : { lDongSignguCd: window.ldongSignguCd }),
        numOfRows: LIST_ROWS,
        pageNo: 1,
      });
      return pickItems(res.items, window, opensInWindow, limit);
    } catch (e) {
      if (!isKtoError(e)) throw e;
      return null;
    }
  }

  /**
   * T3 — 지난해 같은 달 방문자 수 (FR-MO-059 · EI-KT-026).
   *
   * 방문자수 API 는 지역 조건이 없어 **기간 하나에 1콜**이고 전국 시군구가 온다. 창들은 모두
   * 같은 기간이어야 하며, 받은 목록을 창마다 거른다. 결과는 `windows` 와 같은 순서이고
   * 그 지역 줄이 없으면 그 자리가 `null` 이다. 조회에 실패하면 전체가 `null` 이다.
   */
  async t3(windows: readonly SignalWindow[]): Promise<readonly (Signal | null)[] | null> {
    const first = windows[0];
    if (first === undefined) return [];
    if (windows.some((w) => w.from !== first.from || w.to !== first.to)) {
      throw new Error('T3 창은 같은 기간끼리만 한 번에 부른다');
    }
    let rows;
    try {
      const res = await this.kto().locgoRegnVisitrDDList({ startYmd: toKtoDay(first.from), endYmd: toKtoDay(first.to) });
      rows = res.items.map(toVisitorRow);
    } catch (e) {
      if (!isKtoError(e)) throw e;
      return null;
    }
    return windows.map((w) => summarizeVisitors(rows, w));
  }
}

/** 응답 줄에서 표시할 것만 골라 낸다. 세는 조건과 같은 함수를 받아 쓴다 (#644) */
function pickItems(
  items: readonly Record<string, unknown>[],
  window: SignalWindow,
  matches: (c: SignalContent, w: SignalWindow) => boolean,
  limit: number,
): readonly SignalListItem[] {
  const out: SignalListItem[] = [];
  for (const raw of items) {
    const content = toSignalContent(raw);
    if (!matches(content, window)) continue;
    out.push({
      contentId: content.contentId,
      title: String(raw.title ?? ''),
      contentTypeId: content.contentTypeId,
      createdTime: content.createdTime,
      eventStart: content.eventStart,
      eventEnd: content.eventEnd,
    });
    if (out.length >= limit) break;
  }
  return out;
}
