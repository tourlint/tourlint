/**
 * 전처리 — 원문을 해석 가능한 조각으로 자른다 (FR-AU-016 · 파싱규칙 §1 · §2).
 *
 * ⚠️ **이 전처리는 해석 입력에만 적용한다.** 검수 지문은 언제나 가공하지 않은 원문으로
 * 만든다 (DR-FP-004). 여기서 공백 하나를 지우면 그 변경을 영영 감지하지 못한다.
 *
 * 실측 원문에는 **개행이 없다.** 라벨 블록과 항목이 그대로 이어 붙는다.
 *   `[월요일]- 07:40~16:00- 마지막 주문 15:45[수요일~일요일]- 07:40~19:30`
 */

/** 서식용 접두 기호 (FR-AU-016) — 전각 공백 포함 */
const LEADING_SYMBOLS = /^[\s\u3000·•\-–—]+/;

/** `<br>` 은 실측 데이터다 — 강릉 동부시장 · 감자적본부 등 3건 */
const BR_TAG = /<br\s*\/?>/gi;

/** 부가 안내 표지. 이 뒤는 본문이 아니라 주석이다 */
const NOTE_MARKER = '※';

/**
 * 라벨 블록 하나. `[...]` 로 구분된 구간이다.
 *
 * 라벨 없는 선두 구간도 블록 하나로 만든다 — 호출자가 두 경우를 구분하지 않게.
 */
export interface Block {
  /** `[월요일]` → `월요일`. 라벨이 없으면 null */
  readonly label: string | null;
  readonly body: string;
}

/** `<br>` 을 개행으로 바꾼다. 조각 경계로 쓰기 위해서다 */
export function normalizeLineBreaks(raw: string): string {
  return raw.replace(BR_TAG, '\n');
}

/** 조각 하나의 앞뒤 서식 기호와 공백을 턴다 */
export function stripFormatting(fragment: string): string {
  return fragment.replace(LEADING_SYMBOLS, '').replace(/[\s\u3000]+$/, '').trim();
}

/**
 * 본문과 부가 안내(`※`)를 가른다.
 *
 * 안내는 버리지 않는다 — 조건이 붙어 있을 수 있어서 호출자가 판단해야 한다.
 * (`※ 점포별 상이함` 은 운영시간을 무효로 만들지만 `※ 자세한 사항은 전화문의` 는 그렇지 않다)
 */
export function splitNotes(text: string): { readonly main: string; readonly notes: readonly string[] } {
  const parts = text.split(NOTE_MARKER);
  const main = stripFormatting(parts[0] ?? '');
  const notes = parts.slice(1).map(stripFormatting).filter((n) => n !== '');
  return { main, notes };
}

/**
 * `[...]` 라벨 블록으로 자른다.
 *
 *   `[월요일]- 07:40~16:00[수요일~일요일]- 07:40~19:30`
 *     → [{label:'월요일', body:'07:40~16:00'}, {label:'수요일~일요일', body:'07:40~19:30'}]
 */
export function splitBlocks(text: string): readonly Block[] {
  const blocks: Block[] = [];
  const re = /\[([^\]]*)\]/g;

  let cursor = 0;
  let pendingLabel: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const body = stripFormatting(text.slice(cursor, match.index));
    if (body !== '' || pendingLabel !== null) {
      blocks.push({ label: pendingLabel, body });
    }
    pendingLabel = stripFormatting(match[1] ?? '');
    cursor = match.index + match[0].length;
  }

  const tail = stripFormatting(text.slice(cursor));
  if (tail !== '' || pendingLabel !== null) {
    blocks.push({ label: pendingLabel, body: tail });
  }

  return blocks.filter((b) => b.label !== null || b.body !== '');
}

/**
 * 블록 본문을 조각으로 자른다.
 *
 * 경계 — 개행(`<br>` 유래) · `/` · `,` · `·` · **`- `**
 *
 * `- ` 은 실측에서 **항목 구분자**로 쓰인다(45건). ` - ` 처럼 앞뒤로 공백을 둔 형태는
 * 287건 어디에도 없으므로 `10:00-20:00` 의 시각 범위 하이픈과 안전하게 구분된다.
 *
 * **괄호 안은 자르지 않는다.** `(쉬는시간 15:00~17:00 / 마지막 주문 19:30)` 은 한 덩어리다.
 */
export function splitFragments(body: string): readonly string[] {
  const out: string[] = [];
  let buffer = '';
  let depth = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;

    if (ch === '(' || ch === '（') depth++;
    else if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1);

    if (depth === 0) {
      if (ch === '\n' || ch === '/' || ch === ',' || ch === '·') {
        out.push(buffer);
        buffer = '';
        continue;
      }
      // `- ` 은 항목 구분자다. 단, 조각 맨 앞의 `- ` 는 접두 기호이므로 새 조각을 만들지 않는다
      if (ch === '-' && body[i + 1] === ' ' && buffer.trim() !== '') {
        out.push(buffer);
        buffer = '';
        i++;
        continue;
      }
    }
    buffer += ch;
  }
  out.push(buffer);

  return out.map(stripFormatting).filter((f) => f !== '');
}

/**
 * 괄호 내용을 뽑아내고 나머지를 돌려준다.
 *
 * 괄호의 뜻은 축마다 다르다 — 휴무에서는 조건·예외(`(단, 월요일이 공휴일인 경우 …)`),
 * 운영시간에서는 라벨(`(입장 마감 17:30)`)이다. 그래서 뽑기만 하고 해석은 호출자에게 맡긴다.
 */
export function extractParentheticals(text: string): {
  readonly head: string;
  readonly parentheticals: readonly string[];
} {
  const parentheticals: string[] = [];
  let head = '';
  let buffer = '';
  let depth = 0;

  for (const ch of text) {
    if (ch === '(' || ch === '（') {
      if (depth === 0) buffer = '';
      else buffer += ch;
      depth++;
      continue;
    }
    if ((ch === ')' || ch === '）') && depth > 0) {
      depth--;
      if (depth === 0) {
        const inner = stripFormatting(buffer);
        if (inner !== '') parentheticals.push(inner);
        buffer = '';
      } else {
        buffer += ch;
      }
      continue;
    }
    if (depth > 0) buffer += ch;
    else head += ch;
  }

  // 닫히지 않은 괄호 — 열린 뒤 내용이 있으면 살린다
  if (depth > 0) {
    const inner = stripFormatting(buffer);
    if (inner !== '') parentheticals.push(inner);
  }

  return { head: stripFormatting(head.replace(/\s{2,}/g, ' ')), parentheticals };
}

/** `unparsed.fragment` 는 200자로 절단한다 (DR-NM-014 · DR-PR-003) */
export const MAX_FRAGMENT_LENGTH = 200;

export function truncateFragment(fragment: string): string {
  return fragment.length <= MAX_FRAGMENT_LENGTH ? fragment : fragment.slice(0, MAX_FRAGMENT_LENGTH);
}
