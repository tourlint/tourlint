import type { UnparsedReason } from '@tourlint/shared';
import {
  extractParentheticals,
  normalizeLineBreaks,
  splitFragments,
  splitNotes,
  stripFormatting,
} from './preprocess';
import { parseDaySet, parseMonthDay, sortDays } from './primitives';
import type { ConditionalRule, DayOfWeek, HolidayRule, MonthDay, NthWeekday, PartialClosed } from './types';

/**
 * 휴무(닫힘) 축 사전 파서 (FR-AU-003 · 004 · DR-NM 5-3).
 *
 * 정규식이 처리한 조각에는 LLM 을 부르지 않는다. 여기서 잡는 만큼 호출도 비용도 줄고
 * 무엇보다 **결정론적**이 된다 (NF-MT-001).
 *
 * 조각 하나가 무엇을 주장하는지만 판별하고, 합치는 일은 `merge.ts` 가 한다.
 */

export type ClosedHit =
  | { readonly kind: 'ALWAYS_OPEN' }
  | { readonly kind: 'WEEKLY'; readonly days: readonly DayOfWeek[] }
  | { readonly kind: 'NTH'; readonly entries: readonly NthWeekday[] }
  | { readonly kind: 'FIXED'; readonly dates: readonly MonthDay[] }
  | { readonly kind: 'HOLIDAY'; readonly rules: readonly HolidayRule[] }
  | { readonly kind: 'CONDITIONAL'; readonly rule: ConditionalRule }
  | { readonly kind: 'PARTIAL'; readonly partial: PartialClosed }
  /** 해석 실패. 버리지 않고 사유와 함께 남긴다 (DR-NM-004) */
  | { readonly kind: 'UNPARSED'; readonly reason: UnparsedReason };

// ── 어휘 ──────────────────────────────────────────────────────────────

/**
 * 연중 휴무 없음.
 *
 * `연증무휴` 는 **실측 원문의 오타**다(1건). 흐릿한 매칭을 넣는 대신 관측된 오타만
 * 명시적으로 받는다 — 어떤 값을 왜 받아들이는지가 코드에 남아야 한다.
 */
const ALWAYS_OPEN_RE = /^(?:연중\s*무휴|연중무휴|연증무휴|상시\s*(?:개방|영업|운영)|무휴|없음|연중개방)$/;

/** 명절 축약. `명절` 한 단어가 설·추석 둘 다를 뜻한다 (실측 17건) */
const HOLIDAY_TOKENS: ReadonlyArray<readonly [RegExp, readonly HolidayRule[]]> = [
  [/^명절(?:\s*당일|\s*연휴)?$/, ['LUNAR_NEW_YEAR', 'CHUSEOK']],
  [/^설\s*[·ㆍ,]?\s*추석(?:\s*당일|\s*연휴)?$/, ['LUNAR_NEW_YEAR', 'CHUSEOK']],
  [/^설날\s*[·ㆍ,]?\s*추석(?:\s*당일|\s*연휴)?$/, ['LUNAR_NEW_YEAR', 'CHUSEOK']],
  [/^(?:설날?|구정)(?:\s*당일|\s*연휴)?$/, ['LUNAR_NEW_YEAR']],
  [/^(?:추석|한가위)(?:\s*당일|\s*연휴)?$/, ['CHUSEOK']],
  [/^(?:법정\s*)?공휴일(?:\s*및\s*대체\s*휴무일?)?$/, ['LEGAL_HOLIDAY']],
  [/^대체\s*휴무일?$/, ['LEGAL_HOLIDAY']],
];

/** 대상별로 다름 — 해석 대상이 하나가 아니라는 뜻이므로 확인 불가다 */
const TARGET_VARIES_RE = /(?:점포|매장|업소|노선|프로그램|시기|코스|상영\s*시간|업체)\s*별?\s*(?:로)?\s*상이|상이\s*함|별로\s*다름/;

/** 외부 참조 안내 */
const REFERENCE_RE = /홈페이지\s*참조|문의\s*요망|전화\s*문의|예약\s*시?\s*운영|예약제|별도\s*공지|공지\s*확인/;

const ORDINALS: ReadonlyMap<string, number> = new Map([
  ['첫', 1], ['첫째', 1], ['첫번째', 1], ['1', 1],
  ['둘째', 2], ['두번째', 2], ['2', 2],
  ['셋째', 3], ['세번째', 3], ['3', 3],
  ['넷째', 4], ['네번째', 4], ['4', 4],
  ['다섯째', 5], ['다섯번째', 5], ['5', 5],
]);

const ORDINAL_TOKEN = /(첫째|첫번째|둘째|두번째|셋째|세번째|넷째|네번째|다섯째|다섯번째|[1-5])\s*(?:번째)?\s*(?:주|째)?/g;

// ── 조각 하나 해석 ─────────────────────────────────────────────────────

/**
 * 휴무 조각 하나를 판별한다.
 *
 * 순서가 곧 우선순위다 (FR-AU-004). 앞선 패턴이 잡으면 뒤는 보지 않는다 —
 * `연중무휴` 를 요일 패턴이 먼저 건드리면 안 되기 때문이다.
 */
export function parseClosedFragment(fragment: string): ClosedHit | null {
  const text = stripFormatting(fragment);
  if (text === '') return null;

  // 대상별 상이 · 참조형이 먼저다. 뒤 패턴이 일부만 물어 가면 "모른다" 가 "안다" 로 둔갑한다
  if (TARGET_VARIES_RE.test(text)) return { kind: 'UNPARSED', reason: 'TARGET_VARIES' };
  if (REFERENCE_RE.test(text)) return { kind: 'UNPARSED', reason: 'REFERENCE' };

  if (ALWAYS_OPEN_RE.test(text.replace(/\s+/g, ''))) return { kind: 'ALWAYS_OPEN' };

  for (const [re, rules] of HOLIDAY_TOKENS) {
    if (re.test(text)) return { kind: 'HOLIDAY', rules };
  }

  const nth = parseNthWeekday(text);
  if (nth !== null) return { kind: 'NTH', entries: nth };

  const weekly = parseWeeklyClosed(text);
  if (weekly !== null) return { kind: 'WEEKLY', days: weekly };

  const date = parseMonthDay(text);
  if (date !== null) return { kind: 'FIXED', dates: [date] };

  // 조건부 휴무는 "모른다" 가 아니라 "조건이 있다" 이다. 구조로 남기고 신뢰도를 추정으로 둔다.
  // 추정 경로는 차단 근거가 될 수 없으므로(FR-AU-008) 잘못 잡아도 과탐으로 번지지 않는다.
  if (BARE_CONDITION_RE.test(text)) {
    return { kind: 'CONDITIONAL', rule: { kind: 'OTHER', appliesTo: [], note: text } };
  }

  return { kind: 'UNPARSED', reason: 'CONDITIONAL' };
}

/**
 * 라벨 없이 조건만 오는 조각. 실측: `풍랑주의보 및 풍랑경보 발령 시`
 *
 * `~ 시` · `~ 경우` · `~ 때` 로 끝나면서 휴무 맥락이 읽히는 것만 받는다.
 * `예약시 운영` 같은 참조형은 앞에서 이미 걸러진다.
 */
const BARE_CONDITION_RE = /(?:발령|경보|주의보|특보|우천|기상|악천후|천재지변|사정)[^]*?(?:시|경우|때)$|(?:시|경우|때)\s*(?:휴관|휴무|미운영)$/;

/**
 * `매주 월요일` · `매주 월요일~화요일` · `주말` · `목요일`.
 *
 * `매주` 가 없어도 요일만 오면 매주 휴무로 읽는다 — 실측에 `목요일` · `주말` 단독이 있다.
 */
function parseWeeklyClosed(text: string): readonly DayOfWeek[] | null {
  const body = text.replace(/^매주\s*/, '').replace(/\s*(?:휴관|휴무|정기\s*휴무|휴점|휴원)$/, '').trim();
  const days = parseDaySet(body);
  return days === null || days.length === 0 ? null : sortDays(days);
}

/**
 * `매달 셋째 월요일` · `매월 둘째, 넷째 일요일` · `2,4주 일요일` · `매달 2번째 수요일`.
 *
 * 서수가 여럿이고 요일이 하나인 형태를 한 덩어리로 받는다. 조각으로 먼저 자르면
 * `매월 둘째 주` 와 `넷째 주 목요일` 로 갈려 앞쪽이 미아가 된다.
 */
export function parseNthWeekday(text: string): readonly NthWeekday[] | null {
  const dayMatch = /([월화수목금토일])\s*요일?\s*$/.exec(text);
  if (dayMatch === null) return null;

  const day = parseDaySet(dayMatch[1] as string)?.[0];
  if (day === undefined) return null;

  const head = text.slice(0, dayMatch.index);
  // 서수 없이 요일만 있으면 매주 휴무다 — 여기서 잡을 것이 아니다
  if (!/째|번째|주/.test(head)) return null;
  if (!/^\s*(?:매\s*[달월])?\s*[\d첫둘셋넷다섯째번주\s,·ㆍ/]*$/.test(head)) return null;

  ORDINAL_TOKEN.lastIndex = 0;
  const nths: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = ORDINAL_TOKEN.exec(head)) !== null) {
    const n = ORDINALS.get((m[1] ?? '').trim());
    if (n !== undefined && !nths.includes(n)) nths.push(n);
  }
  if (nths.length === 0) return null;

  return nths.sort((a, b) => a - b).map((nth) => ({ nth, day }));
}

// ── 괄호 · 조건절 ──────────────────────────────────────────────────────

/** `(단, 월요일이 공휴일인 경우 그 다음날 휴관)` 처럼 조건을 담은 괄호인가 */
const CONDITION_HINT = /단,|경우|공휴일|연휴|휴가철|정상\s*(?:개관|운영|영업)|익일|다음\s*날|별도\s*공지/;

/**
 * 괄호 내용을 조건 · 부분 휴관 중 하나로 읽는다.
 *
 * 같은 괄호가 두 가지 뜻으로 쓰인다.
 *   `(단, 월요일이 공휴일인 경우 그 다음날 휴관)`            → 조건부 휴무
 *   `(1월 1일/설날/추석 당일은 오죽헌만 개방, 실내 전시실 휴관)` → 시설 일부 휴관
 */
export function parseParenthetical(inner: string, contextDays: readonly DayOfWeek[]): ClosedHit {
  const partial = parsePartialClosed(inner);
  if (partial !== null) return { kind: 'PARTIAL', partial };

  if (CONDITION_HINT.test(inner)) {
    const kind = /공휴일|연휴/.test(inner) && /익일|다음\s*날|휴관|휴무|휴원/.test(inner)
      ? 'HOLIDAY_NEXT_DAY'
      : 'OTHER';
    return { kind: 'CONDITIONAL', rule: { kind, appliesTo: contextDays, note: inner } };
  }

  return { kind: 'UNPARSED', reason: 'CONDITIONAL' };
}

/**
 * `실내 전시실 휴관` 처럼 **휴관 대상이 시설 일부로 명시**된 경우를 가른다 (DR-NM-012).
 *
 * 시설 전체가 아니므로 `partialClosed` 에 담고 휴무 필드에는 넣지 않는다.
 * `partialClosed` 만으로는 R01 차단이 나지 않는다.
 */
function parsePartialClosed(inner: string): PartialClosed | null {
  /*
   * 휴관 대상은 **마지막 절**에 온다. 그 앞은 시점절이다.
   *   `1월 1일/설날/추석 당일은 오죽헌만 개방, 실내 전시실 휴관`
   *                                        └── 대상은 여기
   * 정규식 하나로 잡으면 왼쪽부터 매칭돼 `1월 1일은 실내 전시실` 처럼 시점까지 삼킨다.
   * 그래서 쉼표와 조사(`은`/`는`)로 먼저 갈라 마지막 절만 본다.
   */
  const clauses = inner.split(/[,·、]|(?<=[은는])\s+/);
  const last = stripFormatting(clauses[clauses.length - 1] ?? '');
  const scopeMatch = /^(.{1,30}?)\s*(?:만\s*)?(?:휴관|휴무|휴점|미운영)$/.exec(last);
  if (scopeMatch === null) return null;

  const scope = stripFormatting(scopeMatch[1] ?? '');
  // "월요일 휴관" 같은 요일 표현은 대상이 아니라 시점이다
  if (scope === '' || parseDaySet(scope) !== null) return null;
  // 시설을 가리키는 말이어야 한다 — 조건절(`~인 경우`)이 걸리면 대상이 아니다
  if (/경우|단,|시$/.test(scope)) return null;

  const on: (MonthDay | HolidayRule)[] = [];
  for (const piece of inner.split(/[/,·、]|은|는/)) {
    const t = stripFormatting(piece);
    if (t === '') continue;
    const date = parseMonthDay(t);
    if (date !== null && !on.includes(date)) {
      on.push(date);
      continue;
    }
    for (const [re, rules] of HOLIDAY_TOKENS) {
      if (re.test(t)) {
        for (const r of rules) if (!on.includes(r)) on.push(r);
        break;
      }
    }
  }

  return { scope, on };
}

// ── 원문 하나 전체 ─────────────────────────────────────────────────────

export interface ClosedParseResult {
  readonly hits: readonly ClosedHit[];
  /** 해석하지 못한 조각 원문 — `unparsed` 기록용 */
  readonly unparsedFragments: readonly { readonly fragment: string; readonly reason: UnparsedReason }[];
  /** 본문 뒤 `※` 안내. 조건이 붙어 있을 수 있어 호출자가 판단한다 */
  readonly notes: readonly string[];
}

/** 휴무 원문 하나를 조각 단위 판정 목록으로 바꾼다 */
export function parseClosedRaw(raw: string): ClosedParseResult {
  const hits: ClosedHit[] = [];
  const unparsedFragments: { fragment: string; reason: UnparsedReason }[] = [];

  const { main, notes } = splitNotes(normalizeLineBreaks(raw));
  const { head, parentheticals } = extractParentheticals(main);

  /*
   * **자르기 전에 전체를 먼저 본다.**
   *
   * `매월 둘째 주 ·넷째 주 목요일` 을 `·` 로 먼저 자르면 `매월 둘째 주` 가 요일 없는 미아가 된다.
   * 서수 · 요일 나열처럼 구분자를 넘나드는 패턴이 실재하기 때문이다.
   *
   * 전체가 **구조적으로** 해석될 때만 채택한다. `TARGET_VARIES` 같은 확인 불가 판정은
   * 조각 일부만 보고 내려진 것일 수 있으므로 채택하지 않고 정상적으로 잘라 본다.
   */
  const whole = parseClosedFragment(head);
  if (whole !== null && whole.kind !== 'UNPARSED') {
    const wholeHits: ClosedHit[] = [whole];
    const days = whole.kind === 'WEEKLY' ? sortDays(whole.days) : [];
    for (const inner of parentheticals) {
      const hit = parseParenthetical(inner, days);
      if (hit.kind === 'UNPARSED') unparsedFragments.push({ fragment: inner, reason: hit.reason });
      else wholeHits.push(hit);
    }
    for (const note of notes) {
      const hit = parseClosedFragment(note);
      if (hit?.kind === 'CONDITIONAL') wholeHits.push(hit);
      else if (hit?.kind === 'UNPARSED') unparsedFragments.push({ fragment: note, reason: hit.reason });
    }
    return { hits: wholeHits, unparsedFragments, notes };
  }

  const fragments = splitFragments(head);
  const contextDays: DayOfWeek[] = [];

  for (const fragment of fragments) {
    const hit = parseClosedFragment(fragment);
    if (hit === null) continue;
    if (hit.kind === 'UNPARSED') {
      unparsedFragments.push({ fragment, reason: hit.reason });
      continue;
    }
    if (hit.kind === 'WEEKLY') contextDays.push(...hit.days);
    hits.push(hit);
  }

  // 괄호는 앞선 요일 조각을 수식한다 — `매주 월요일 (단, 월요일이 공휴일인 …)`
  for (const inner of parentheticals) {
    const hit = parseParenthetical(inner, sortDays(contextDays));
    if (hit.kind === 'UNPARSED') unparsedFragments.push({ fragment: inner, reason: hit.reason });
    else hits.push(hit);
  }

  // `※` 주석은 **보조 정보**다. 조건 · 대상별 상이 신호만 받아들이고 확정 휴무 필드는 만들지 않는다.
  // 주석을 확정 근거로 쓰면 `※ 7 월~8 월은 무휴` 같은 예외 문구가 본문을 뒤집어 버린다.
  for (const note of notes) {
    const hit = parseClosedFragment(note);
    if (hit === null) continue;
    if (hit.kind === 'CONDITIONAL') hits.push(hit);
    else if (hit.kind === 'UNPARSED') unparsedFragments.push({ fragment: note, reason: hit.reason });
  }

  return { hits, unparsedFragments, notes };
}
