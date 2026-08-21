import type { UnparsedReason } from '@tourlint/shared';
import {
  extractParentheticals,
  normalizeLineBreaks,
  splitBlocks,
  splitFragments,
  splitNotes,
  stripFormatting,
} from './preprocess';
import { parseDaySet, parseMonthRange, parseTimeOfDay, sortDays } from './primitives';
import type { DayOfWeek, MonthDay, TimeOfDay, TimeSpan } from './types';

/**
 * 운영시간(열린 시간) 축 사전 파서 (FR-AU-014 · 015 · DR-NM 5-3).
 *
 * 이 축의 어려움은 **한 필드에 역할이 다른 시각이 여러 개** 들어온다는 것이다.
 *   `- 11:00~20:00- 준비시간 15:30~17:00- 점심 마지막 주문 15:00 / 저녁 마지막 주문 19:30`
 *
 * 라벨로 역할을 가른다. **라벨 없는 첫 범위를 운영시간으로 단정하지 않는다** (FR-AU-014) —
 * `- 전망대 09:00~17:00- 야외공간 09:00~18:00` 에서 첫 값을 고르면 절반이 틀린다.
 */

export type HoursRole = 'OPEN' | 'CUTOFF' | 'BREAK' | 'CHECK_IN' | 'CHECK_OUT';

/** 라벨 사전 (파싱규칙 §2). 긴 라벨을 먼저 본다 — `마지막 주문` 이 `주문` 보다 앞이어야 한다 */
const ROLE_LABELS: ReadonlyArray<readonly [RegExp, HoursRole]> = [
  [/입실|체크\s*인|입장\s*시작/, 'CHECK_IN'],
  [/퇴실|체크\s*아웃/, 'CHECK_OUT'],
  [/마지막\s*주문|라스트\s*오더|주문\s*마감|입장\s*마감|입장마감|매표\s*마감|매표시간|입장\s*시간|발권\s*마감/, 'CUTOFF'],
  [/준비\s*시간|브레이크\s*타임|휴게\s*시간|쉬는\s*시간|점심\s*시간|휴식\s*시간/, 'BREAK'],
  [/운영\s*시간|이용\s*시간|관람\s*시간|영업\s*시간|개방\s*시간|개관\s*시간/, 'OPEN'],
];

/** 하루 종일 열려 있다. 실측 원문에도 `00:00~24:00` 이 있어 `24:00` 을 하루 끝으로 쓴다 */
const ALL_DAY_RE = /^(?:상시\s*(?:개방|영업|운영|이용)|연중\s*무휴|24\s*시간|항시\s*개방)/;

const TARGET_VARIES_RE = /(?:점포|매장|업소|노선|프로그램|시기|코스|상영\s*시간|회차|업체|객실)\s*별?\s*(?:로)?\s*상이|상이\s*함|별로\s*다름|별\s*상이/;
const REFERENCE_RE = /홈페이지\s*참조|문의\s*요망|전화\s*문의|예약\s*시?\s*운영|예약제|별도\s*공지/;

/**
 * 시각 하나 또는 범위. 범위 부분은 선택이라 `마지막 주문 19:30` 같은 단독 시각도 같이 잡는다.
 *
 * `09:00~18:00` · `9:00-18:00` · `10:00 ~ 17:00` · `18:00~익일 11:00` · `17시`
 */
const TIME_TOKEN = /(\d{1,2}\s*(?::\s*\d{2}|시(?:\s*\d{1,2}\s*분)?))(?:\s*[~\-–—]\s*(?:익일\s*)?(\d{1,2}\s*(?::\s*\d{2}|시(?:\s*\d{1,2}\s*분)?)))?/g;

export interface TimeItem {
  readonly role: HoursRole;
  readonly from: TimeOfDay;
  /** 범위가 아니면 null */
  readonly to: TimeOfDay | null;
  /** `점심 마지막 주문` 의 `점심` 처럼 역할을 더 좁히는 말 */
  readonly label: string | null;
}

/** 한 블록이 어느 범위를 가리키는가 */
export type HoursScope =
  | { readonly kind: 'DEFAULT' }
  | { readonly kind: 'DAYS'; readonly days: readonly DayOfWeek[] }
  | { readonly kind: 'SEASON'; readonly from: MonthDay; readonly to: MonthDay; readonly label: string | null }
  /** `[종합/어린이/디지털 자료실]` 처럼 요일도 계절도 아닌 라벨. 시설 일부를 가리킨다 */
  | { readonly kind: 'UNKNOWN'; readonly label: string };

export interface HoursGroup {
  readonly scope: HoursScope;
  readonly items: readonly TimeItem[];
  readonly allDay: boolean;
}

export interface HoursParseResult {
  readonly groups: readonly HoursGroup[];
  readonly unparsedFragments: readonly { readonly fragment: string; readonly reason: UnparsedReason }[];
  readonly notes: readonly string[];
}

// ── 조각 하나 ─────────────────────────────────────────────────────────

/** 조각 앞머리에 붙은 요일·계절 수식을 떼어낸다 — `평일 10:00~19:00` · `하절기 09:30~18:00` */
function takeScopePrefix(text: string): { scope: HoursScope | null; rest: string } {
  const seasonal = /^(하절기|동절기|성수기|비수기)\s*/.exec(text);
  if (seasonal !== null) {
    const label = seasonal[1] as string;
    const rest = text.slice(seasonal[0].length);
    // 계절 라벨만 있고 기간이 없으면 기간을 지어내지 않는다. 라벨은 보존한다
    return { scope: { kind: 'SEASON', from: '', to: '', label }, rest: stripFormatting(rest) };
  }

  // `평일` · `월요일~토요일` · `금~수` — 시각 앞에 오는 요일 수식만 받는다
  const dayPrefix = /^((?:평일|주중|주말|[월화수목금토일](?:요일)?)(?:\s*[~\-/·]\s*(?:평일|주말|[월화수목금토일](?:요일)?))*)\s+(?=\d)/.exec(text);
  if (dayPrefix !== null) {
    const days = parseDaySet(dayPrefix[1] as string);
    if (days !== null && days.length > 0) {
      return { scope: { kind: 'DAYS', days: sortDays(days) }, rest: stripFormatting(text.slice(dayPrefix[0].length)) };
    }
  }

  return { scope: null, rest: text };
}

/**
 * 조각에서 시각 항목을 **전부** 읽는다.
 *
 * 한 조각에 라벨과 범위가 둘 이상 붙어 오는 것이 실데이터의 기본형이다.
 *   `매표시간 09:00~17:00 관람시간 09:00~18:00`   (실측: 오죽헌·시립박물관)
 * 첫 항목만 읽으면 관람시간을 통째로 잃고 매표 마감을 운영시간으로 오인한다.
 *
 * 각 시각의 역할은 **바로 앞 구간의 말**로 정한다. 앞말이 없으면 `OPEN` 으로 본다.
 */
export function readTimeItems(fragment: string): readonly TimeItem[] {
  const text = stripFormatting(fragment);
  if (text === '') return [];

  const items: TimeItem[] = [];
  TIME_TOKEN.lastIndex = 0;

  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = TIME_TOKEN.exec(text)) !== null) {
    const head = stripFormatting(text.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const from = parseTimeOfDay(match[1] as string);
    if (from === null) continue;
    const to = match[2] === undefined ? null : parseTimeOfDay(match[2]);

    const role = roleOf(head);
    // 라벨 없는 **단독** 시각은 개장인지 마감인지 알 수 없다. 단정하지 않고 버린다
    if (role === null && to === null) continue;

    items.push({ role: role ?? 'OPEN', from, to, label: head === '' ? null : head });
  }

  return items;
}

function roleOf(head: string): HoursRole | null {
  for (const [re, role] of ROLE_LABELS) {
    if (re.test(head)) return role;
  }
  return null;
}

// ── 원문 하나 전체 ─────────────────────────────────────────────────────

export function parseHoursRaw(raw: string): HoursParseResult {
  const groups: HoursGroup[] = [];
  const unparsedFragments: { fragment: string; reason: UnparsedReason }[] = [];

  const { main, notes } = splitNotes(normalizeLineBreaks(raw));
  if (main === '') {
    for (const note of notes) {
      const reason = reasonOf(note);
      if (reason !== null) unparsedFragments.push({ fragment: note, reason });
    }
    return { groups, unparsedFragments, notes };
  }

  for (const block of splitBlocks(main)) {
    const blockScope: HoursScope = (block.label === null ? null : scopeFromLabel(block.label)) ?? { kind: 'DEFAULT' };

    /*
     * 같은 범위의 조각들은 **한 덩어리로 모은다** (DR-NM-015).
     *
     *   `- 11:00~20:00- 준비시간 15:30~17:00- 마지막 주문 19:30`
     *
     * 조각마다 따로 담으면 운영시간만 남고 준비시간 · 마지막 주문이 미아가 된다.
     * 이 셋은 한 운영시간 항목의 서로 다른 면이지 별개의 영업시간이 아니다.
     */
    const buckets = new Map<string, { scope: HoursScope; items: TimeItem[]; allDay: boolean }>();
    const take = (scope: HoursScope): { scope: HoursScope; items: TimeItem[]; allDay: boolean } => {
      const key = scopeKey(scope);
      const found = buckets.get(key);
      if (found !== undefined) return found;
      const created = { scope, items: [], allDay: false };
      buckets.set(key, created);
      return created;
    };

    // 두 칸 이상 띄어쓰기도 항목 경계다 — `일~금 11:00~17:00  토요일 11:00~18:00`
    for (const chunk of splitFragments(block.body).flatMap((f) => f.split(/\s{2,}/))) {
      const fragment = stripFormatting(chunk);
      if (fragment === '') continue;

      const reason = reasonOf(fragment);
      if (reason !== null) {
        unparsedFragments.push({ fragment, reason });
        continue;
      }

      const { head, parentheticals } = extractParentheticals(fragment);
      const items: TimeItem[] = [];
      let scope = blockScope;

      // 괄호는 라벨이거나(`(입장 마감 17:30)`) 계절 기간이다(`하절기(3월~10월)`)
      for (const inner of parentheticals) {
        const period = parseMonthRange(inner);
        if (period !== null) {
          scope = { kind: 'SEASON', from: period.from, to: period.to, label: seasonLabelNear(head) };
          continue;
        }
        const innerReason = reasonOf(inner);
        if (innerReason !== null) {
          unparsedFragments.push({ fragment: inner, reason: innerReason });
          continue;
        }
        for (const piece of splitFragments(inner)) items.push(...readTimeItems(piece));
      }

      const prefixed = takeScopePrefix(head);
      if (prefixed.scope !== null) scope = mergeScope(scope, prefixed.scope);

      const bucket = take(scope);
      if (ALL_DAY_RE.test(prefixed.rest)) {
        bucket.allDay = true;
      } else {
        const found = readTimeItems(prefixed.rest);
        items.push(...found);
        if (found.length === 0 && items.length === 0 && prefixed.rest !== '') {
          unparsedFragments.push({ fragment: prefixed.rest, reason: 'CONDITIONAL' });
          continue;
        }
      }
      bucket.items.push(...items);
    }

    for (const b of buckets.values()) {
      if (b.allDay || b.items.length > 0) groups.push({ scope: b.scope, items: b.items, allDay: b.allDay });
    }
  }

  for (const note of notes) {
    const reason = reasonOf(note);
    if (reason !== null) unparsedFragments.push({ fragment: note, reason });
  }

  return { groups, unparsedFragments, notes };
}

/** 계절 기간 괄호는 이미 떼였으므로 라벨은 앞말에서 찾는다 */
function seasonLabelNear(head: string): string | null {
  const m = /(하절기|동절기|성수기|비수기|주간\s*관람|야간\s*관람)/.exec(head);
  return m === null ? null : (m[1] as string);
}

/** 블록 라벨을 범위로 읽는다 — `[월요일]` · `[평일]` · `[하절기(5월~10월)]` */
function scopeFromLabel(label: string): HoursScope | null {
  const { head, parentheticals } = extractParentheticals(label);

  for (const inner of parentheticals) {
    const period = parseMonthRange(inner);
    if (period !== null) {
      return { kind: 'SEASON', from: period.from, to: period.to, label: head === '' ? null : head };
    }
  }

  const period = parseMonthRange(head);
  if (period !== null) return { kind: 'SEASON', from: period.from, to: period.to, label: null };

  const days = parseDaySet(head);
  if (days !== null && days.length > 0) return { kind: 'DAYS', days: sortDays(days) };

  if (/하절기|동절기|성수기|비수기/.test(head)) {
    return { kind: 'SEASON', from: '', to: '', label: head };
  }

  // 요일도 계절도 아니면 시설 라벨이다. 버리지 않고 남겨 병합 단계가 판단하게 한다
  return { kind: 'UNKNOWN', label: label };
}

/** 블록 라벨과 조각 앞머리 수식이 함께 오면 더 **구체적인** 쪽을 쓴다 */
function mergeScope(outer: HoursScope, inner: HoursScope): HoursScope {
  if (inner.kind === 'SEASON' && inner.from === '' && outer.kind === 'SEASON' && outer.from !== '') {
    return { ...outer, label: inner.label ?? outer.label };
  }
  return inner;
}

/** 같은 범위를 가리키는 조각을 한 바구니에 모으기 위한 키 */
function scopeKey(scope: HoursScope): string {
  switch (scope.kind) {
    case 'DAYS': return `DAYS:${scope.days.join(',')}`;
    case 'SEASON': return `SEASON:${scope.from}~${scope.to}:${scope.label ?? ''}`;
    case 'UNKNOWN': return `UNKNOWN:${scope.label}`;
    default: return 'DEFAULT';
  }
}

function reasonOf(text: string): UnparsedReason | null {
  if (TARGET_VARIES_RE.test(text)) return 'TARGET_VARIES';
  if (REFERENCE_RE.test(text)) return 'REFERENCE';
  return null;
}

export type { TimeSpan };
