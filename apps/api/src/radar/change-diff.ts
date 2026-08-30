/**
 * 판독 결과 변화를 문장으로 (FR-MO-006).
 *
 * 명세가 든 예시가 그대로 목표다 — 「휴무일 월 → 월·화」 · 「운영시간 18시까지 → 17시까지」.
 * 지문 해시가 달라졌다는 사실만으로는 사용자가 무엇이 바뀌었는지 알 수 없다.
 *
 * ## 축을 다 비교하지 않는다
 *
 * `NormalizedOperatingInfo` 에는 축이 열둘 넘게 있는데 여기서는 **사용자가 읽고 행동할 수
 * 있는 축만** 본다 — 휴무 요일 · 운영시간 · 입퇴실. 나머지가 바뀌어도 「무언가 바뀌었다」로만
 * 적는다. 다 늘어놓으면 읽지 않는다.
 *
 * ## 모르는 것은 모른다고 한다
 *
 * 어느 한쪽이 없으면(`null`) 비교하지 않고 빈 배열을 돌려준다. 검수 실행이 한 번뿐인
 * 콘텐츠에는 비교할 이전 값이 없다 — 없는 것을 「변화 없음」으로 읽으면 안 된다
 * (FR-RU-051 과 같은 원칙).
 *
 * 순수 함수다. 입력은 저장된 JSONB 두 덩이뿐이고 아무것도 조회하지 않는다.
 */

const DAY_LABEL: Readonly<Record<string, string>> = {
  MON: '월', TUE: '화', WED: '수', THU: '목', FRI: '금', SAT: '토', SUN: '일',
};
const DAY_ORDER = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

interface Hours {
  readonly open?: unknown;
  readonly close?: unknown;
  readonly admissionCutoff?: unknown;
}

interface Normalized {
  readonly alwaysOpen?: unknown;
  readonly weeklyClosed?: unknown;
  readonly openHours?: unknown;
  readonly checkIn?: unknown;
  readonly checkOut?: unknown;
}

/** 한 줄. 화면이 「무엇: 전 → 후」로 그린다 */
export interface ChangeLine {
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

export function diffNormalized(before: unknown, after: unknown): readonly ChangeLine[] {
  if (!isObject(before) || !isObject(after)) return [];
  const a = before as Normalized;
  const b = after as Normalized;
  const out: ChangeLine[] = [];

  const closedA = closedLabel(a);
  const closedB = closedLabel(b);
  if (closedA !== closedB) out.push({ label: '휴무일', before: closedA, after: closedB });

  const hoursA = hoursLabel(a.openHours);
  const hoursB = hoursLabel(b.openHours);
  if (hoursA !== hoursB) out.push({ label: '운영시간', before: hoursA, after: hoursB });

  const cutA = timeLabel((a.openHours as Hours | null | undefined)?.admissionCutoff);
  const cutB = timeLabel((b.openHours as Hours | null | undefined)?.admissionCutoff);
  if (cutA !== cutB) out.push({ label: '입장마감', before: cutA, after: cutB });

  const inA = timeLabel(a.checkIn);
  const inB = timeLabel(b.checkIn);
  if (inA !== inB) out.push({ label: '입실', before: inA, after: inB });

  const outA = timeLabel(a.checkOut);
  const outB = timeLabel(b.checkOut);
  if (outA !== outB) out.push({ label: '퇴실', before: outA, after: outB });

  return out;
}

/** 휴무 표기. 「연중무휴」 · 「월·화」 · 「확인 불가」 */
function closedLabel(n: Normalized): string {
  if (n.alwaysOpen === true) return '연중무휴';
  const days = Array.isArray(n.weeklyClosed) ? n.weeklyClosed : [];
  if (days.length === 0) return '없음';
  return days
    .filter((d): d is string => typeof d === 'string')
    .slice()
    .sort((x, y) => DAY_ORDER.indexOf(x) - DAY_ORDER.indexOf(y))
    .map((d) => DAY_LABEL[d] ?? d)
    .join('·');
}

/** 운영시간 표기. 「09:00~18:00」 · 「확인 불가」 */
function hoursLabel(value: unknown): string {
  if (!isObject(value)) return '확인 불가';
  const h = value as Hours;
  const open = timeLabel(h.open);
  const close = timeLabel(h.close);
  if (open === '확인 불가' && close === '확인 불가') return '확인 불가';
  return `${open}~${close}`;
}

/** `TimeOfDay` 는 `HH:MM` 문자열이다. 아니면 모르는 값이다 */
function timeLabel(value: unknown): string {
  return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value : '확인 불가';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
