import type { IsoDate } from '../calendar/dates';
import type { SignalContent, SignalWindow, VisitorRow } from './types';

/**
 * 목록 응답 한 줄 → 신호 입력 (T1 · T2).
 *
 * ⚠️ **공사 원문을 담지 않는다.** `title` · `addr1` · `firstimage` 는 여기서 버린다
 *    (FR-MO-002 · DB 명세서 6-4). 키워드 판정만 여기서 끝내고 문자열은 안 넘긴다.
 */
export function toSignalContent(
  item: Record<string, unknown>,
  keywords: readonly string[] = [],
): SignalContent {
  const title = String(item.title ?? '');
  return {
    contentId: String(item.contentid ?? ''),
    contentTypeId: String(item.contenttypeid ?? ''),
    ldongRegnCd: code(item.lDongRegnCd),
    ldongSignguCd: code(item.lDongSignguCd),
    createdTime: String(item.createdtime ?? ''),
    eventStart: toIsoDay(item.eventstartdate),
    eventEnd: toIsoDay(item.eventenddate),
    // 판정만 하고 제목은 버린다. 화면은 자기 데이터로 이름을 채운다
    matchedKeywords: [...new Set(keywords)].filter((k) => k !== '' && title.includes(k)),
  };
}

/** 방문자수 응답 한 줄 → T3 입력. 지역 이름 · 요일 이름은 버린다 (EI-KT-026) */
export function toVisitorRow(item: Record<string, unknown>): VisitorRow {
  const raw = String(item.touNum ?? '').trim();
  const num = raw === '' ? Number.NaN : Number(raw);
  return {
    signguCode: String(item.signguCode ?? '').trim(),
    baseYmd: toIsoDay(item.baseYmd),
    touDivCd: String(item.touDivCd ?? '').trim(),
    touNum: Number.isFinite(num) ? num : null,
  };
}

/**
 * 관심 지역 → 방문자수 지역 코드 (EI-KT-026).
 *
 * `lDongRegnCd` + `lDongSignguCd` 5자리다. 세종은 시군구 단계가 없어 시도 코드 `36110` 이 곧
 * 그 코드다. 시군구 없이 두 자리 시도만 있으면 방문자수가 시군구 단위라 맞출 코드가 없다.
 */
export function visitorRegionCode(region: {
  readonly ldongRegnCd: string | null;
  readonly ldongSignguCd: string | null;
}): string | null {
  const regn = region.ldongRegnCd ?? '';
  if (region.ldongSignguCd === null) return /^\d{5}$/.test(regn) ? regn : null;
  const code = `${regn}${region.ldongSignguCd}`;
  return /^\d{5}$/.test(code) ? code : null;
}

/**
 * T1 목록이 여기까지면 그만 읽어도 되는가 (EI-KT-021).
 *
 * `arrange=D` 는 생성일 내림차순이라, 한 페이지의 **마지막 줄**이 기준일보다 이르면 뒤는
 * 볼 필요가 없다. 강릉 첫 10건 중 최근 30일은 2건이었다 — 보통 한 페이지로 끝난다.
 *
 * **정렬을 못 믿을 때는 멈추지 않는다.** 마지막 줄의 `createdtime` 이 14자리가 아니면
 * 판단할 근거가 없으므로 계속 읽는다.
 */
export function reachedOlderThan(page: readonly SignalContent[], from: IsoDate): boolean {
  const last = page[page.length - 1];
  if (last === undefined) return true;
  if (!/^\d{14}$/.test(last.createdTime)) return false;
  return last.createdTime < `${from.replace(/-/g, '')}000000`;
}

/** `YYYY-MM-DD` → `YYYYMMDD`. 공사가 받는 형식이다 */
export function toKtoDay(iso: IsoDate): string {
  return iso.replace(/-/g, '');
}

/** T2 조회 시작일. 창의 시작일로 부르면 그날 아직 안 끝난 행사가 온다 (EI-KT-010) */
export function festivalQueryDate(window: SignalWindow): string {
  return toKtoDay(window.from);
}

function toIsoDay(value: unknown): IsoDate | null {
  const raw = String(value ?? '').trim();
  if (!/^\d{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/** 빈 문자열은 없는 것이다. `''` 끼리 같다고 봐서 엉뚱한 지역이 묶이면 안 된다 */
function code(value: unknown): string | null {
  const s = value === undefined || value === null ? '' : String(value).trim();
  return s === '' ? null : s;
}
