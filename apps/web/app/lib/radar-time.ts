// 레이더 확인 시각 문구 (UI-S7-010). 언제 확인했고 다음은 언제인지 사람 말로.
// 날짜는 응답의 한국시간 문자열(YYYY-MM-DD...) 조각으로만 비교해 기기 시간대에 흔들리지 않는다.

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** 응답 타임스탬프의 시각을 "오전 5시" 로. */
function ampmHour(iso: string): string {
  const h = Number(iso.slice(11, 13));
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${ampm} ${h12}시`;
}

/** 마지막으로 확인한 때. 오늘 · 어제 · 그 밖의 날짜로 적는다. */
export function lastCheckedText(lastAt: string | null, todayIso: string): string {
  if (lastAt === null) return "아직 확인하기 전이에요";
  const day = lastAt.slice(0, 10);
  const when = day === todayIso ? "오늘" : day === addDaysIso(todayIso, -1) ? "어제" : `${Number(day.slice(5, 7))}월 ${Number(day.slice(8, 10))}일`;
  return `${when} ${ampmHour(lastAt)}에 확인했어요`;
}

/** 다음 확인 때. 배치가 꺼져 있으면(nextAt null) 그 사실을 알린다. 주말은 서버가 이미 건너뛴다. */
export function nextCheckText(nextAt: string | null, todayIso: string): string {
  if (nextAt === null) return "지금은 자동 확인이 꺼져 있어요";
  const day = nextAt.slice(0, 10);
  let label: string;
  if (day === todayIso) label = "오늘";
  else if (day === addDaysIso(todayIso, 1)) label = "내일";
  else {
    const [y, m, d] = day.split("-").map(Number);
    label = `${WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}요일`;
  }
  return `다음 확인은 ${label} 아침이에요`;
}

/**
 * 0 건의 뜻 (#644).
 *
 * 「0 건」은 **확인해 봤더니 없다**와 **아직 확인 전이다**가 다르다. 배치가 처리한 마지막
 * 날짜(covered)가 어제보다 오래됐으면 아직 안 본 날이 남아 있다는 뜻이다 — 그때 0 을
 * 「문제 없음」으로 읽으면 안 된다.
 */
export function zeroMeaning(covered: string | null, todayIso: string): string {
  if (covered === null) return "아직 확인 전이에요";
  return covered >= addDaysIso(todayIso, -1) ? "확인할 것이 없어요" : "아직 확인 전이에요";
}
