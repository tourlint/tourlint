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

/** 그 날이 오늘 · 어제인지, 아니면 몇 월 며칠인지 */
function dayWord(iso: string, todayIso: string): string {
  const day = iso.slice(0, 10);
  if (day === todayIso) return "오늘";
  if (day === addDaysIso(todayIso, -1)) return "어제";
  return `${Number(day.slice(5, 7))}월 ${Number(day.slice(8, 10))}일`;
}

/** 마지막으로 확인한 때. 오늘 · 어제 · 그 밖의 날짜로 적는다. */
export function lastCheckedText(lastAt: string | null, todayIso: string): string {
  if (lastAt === null) return "아직 확인하기 전이에요";
  return `${dayWord(lastAt, todayIso)} ${ampmHour(lastAt)}에 확인했어요`;
}

/** 오늘 할 일이 무엇을 기준으로 정리됐는지 — 「오늘 오전 5시 확인 기준」 (UI-S7-018) */
export function checkedBasisText(basisAt: string, todayIso: string): string {
  return `${dayWord(basisAt, todayIso)} ${ampmHour(basisAt)} 확인 기준`;
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
 * 마지막 확인의 결과 (NF-OB-004 · TM-013). 저장된 상태 코드를 화면에 그대로 적지 않는다.
 *
 *   OK               그날 바뀐 것을 끝까지 읽었다
 *   EMPTY            어제(평일) 목록이 비어 있었다 — 관광정보가 아직 안 올라왔다고 보고 다음 확인 때 다시 본다
 *   FAILED           조회가 실패했다 — 실패한 날부터 다음 확인 때 다시 본다
 *   HIDDEN_OVERFLOW  바뀐 것이 너무 많아 일부만 읽었다
 */
const BATCH_STATUS_LABEL: Readonly<Record<string, string>> = {
  OK: "정상",
  EMPTY: "관광정보 반영 대기",
  FAILED: "확인 실패",
  HIDDEN_OVERFLOW: "일부만 확인",
};

export function batchStatusLabel(status: string | null | undefined): string {
  if (status == null || status === "") return "—";
  return BATCH_STATUS_LABEL[status] ?? "알 수 없음";
}

/**
 * 0 건의 뜻 (#644).
 *
 * 「0 건」은 **확인해 봤더니 없다**와 **아직 확인 전이다**가 다르다. 배치가 처리한 마지막
 * 날짜(covered)가 어제보다 오래됐으면 아직 안 본 날이 남아 있다는 뜻이다 — 그때 0 을
 * 「문제 없음」으로 읽으면 안 된다. 마지막 확인이 실패했거나 일부만 읽었으면 처리 기준일과
 * 상관없이 「없다」고 하지 않는다 (NF-OB-004).
 */
export function zeroMeaning(covered: string | null, todayIso: string, status: string | null = null): string {
  if (status === "FAILED") return "확인하지 못했어요";
  if (status === "HIDDEN_OVERFLOW") return "일부만 확인했어요";
  if (covered === null) return "아직 확인 전이에요";
  return covered >= addDaysIso(todayIso, -1) ? "확인할 것이 없어요" : "아직 확인 전이에요";
}

/**
 * 알림 목록이 비었을 때의 문장 (UI-S7-010). 0 의 뜻과 같은 기준으로 가른다 — 확인해 보니 없는 것만
 * 「없습니다」라고 쓴다. 요약을 못 읽었으면(meaning null) 확인 여부를 말하지 않는다.
 */
export function emptyListText(kind: "RISK" | "OPPORTUNITY", meaning: string | null): string {
  const subject = kind === "RISK" ? "바뀐 정보가" : "새 소식이";
  const object = kind === "RISK" ? "바뀐 정보를" : "새 소식을";
  switch (meaning) {
    case "확인할 것이 없어요":
      return `현재 여행에 확인할 ${subject} 없습니다.`;
    case "아직 확인 전이에요":
      return `아직 확인하지 않은 날이 남아 있어요. 다음 확인 때 ${subject} 있으면 여기에 보여 드려요.`;
    case "확인하지 못했어요":
      return `지난 확인이 실패해서 ${object} 다 보지 못했어요. 다음 확인 때 다시 봐요.`;
    case "일부만 확인했어요":
      return `바뀐 곳이 많아 일부만 확인했어요. 여기 없는 ${subject} 있을 수 있어요.`;
    default:
      return `지금 보여 드릴 ${subject} 없어요.`;
  }
}
