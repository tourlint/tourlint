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
