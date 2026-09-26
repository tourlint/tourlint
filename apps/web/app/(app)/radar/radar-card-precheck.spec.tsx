import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationCard, verdictDiffLine } from "./page";
import { findForbidden } from "../../lib/screen-words";
import type { RadarNotification } from "../../lib/api";

const base: RadarNotification = {
  notificationId: 1, kind: "RISK", condition: 1, productId: 7, productName: "강릉 2일",
  startDate: "2026-10-28", ktoContentId: "126508", placeName: "강릉 오죽헌·시립박물관",
  schedule: { dayNo: 1, startTime: "12:00" }, changes: [], current: [], modifiedOn: null, eventPeriod: null, overlapDays: [],
  what: "운영시간 정보가 바뀌었습니다.", impact: "1일차 12:00 일정입니다.", action: "다시 검수해 판정을 갱신하세요.",
  hidden: false, fingerprint: { from: "abcdef0123", to: "0123abcdef" },
  dismissable: true, readAt: null, dismissedAt: null, createdAt: "2026-09-15T05:00:00+09:00",
};
const noop = async (): Promise<void> => undefined;
const html = (n: RadarNotification) => renderToStaticMarkup(<NotificationCard notification={n} onDismiss={noop} />);

describe("바뀐 정보 알림 뒤 재검수의 판정 차이 (FR-RU-061)", () => {
  it("🔴 새로 생김 · 사라짐 · 등급 변화를 한 줄로 — 규칙 번호 없이 화면 말로", () => {
    const card = html({
      ...base,
      verdictDiff: {
        added: [{ ruleCode: "R01", severity: "BLOCKER" }],
        removed: [{ ruleCode: "R02", severity: "BLOCKER" }],
        changed: [{ ruleCode: "R08", from: "WARNING", to: "ERROR" }],
      },
    });
    expect(card).toContain("다시 검수한 판정 · 새로 생김 쉬는 날 · 운영시간 차단 · 사라짐 행사 기간 차단 · 등급 변화 이동 시간 주의 → 오류");
    expect(findForbidden(card, false)).toEqual([]);
    expect(card).not.toMatch(/R0\d/);
  });

  it("달라진 것이 없으면 그렇게 말하고, 견줄 검수가 없으면 줄을 두지 않는다", () => {
    expect(verdictDiffLine({ added: [], removed: [], changed: [] })).toBe("다시 검수한 판정은 전과 같아요");
    expect(html({ ...base, verdictDiff: null })).not.toContain("data-verdict-diff");
  });
});

describe("새 소식의 넣을 자리 · 사전 확인 (UI-S7-008)", () => {
  const news: RadarNotification = {
    ...base, kind: "OPPORTUNITY", condition: 5, placeName: "상우마을", schedule: null,
    what: "일정의 빈 시간대에 넣을 만한 관광지가 새로 등록됐습니다.",
    impact: "2일차 12:00 ~ 14:30 빈 시간(150분)에 넣을 수 있어요. 머무는 시간은 약 60분으로 봤어요(알림 때 일정 기준).",
    action: "다른 일정과 겹치지 않고 앞뒤 이동(약 8분 · 9분)을 넣어도 빈 시간 안에 들어가요. 이동은 원래보다 약 5분 늘어요.",
    fingerprint: { from: null, to: null },
    opportunity: {
      slot: { dayNo: 2, from: "12:00", to: "14:30", minutes: 150, dwellMinutes: 60 }, slotMissing: null,
      precheck: { travel: "FITS", inMinutes: 8, outMinutes: 9, addedMinutes: 5, shortMinutes: null, currentTimeBased: false },
      travelSource: "카카오모빌리티",
    },
  };

  it("🔴 넣을 자리와 사전 확인을 보이고 이동시간에 출처를 붙인다", () => {
    const card = html(news);
    expect(card).toContain("2일차 12:00 ~ 14:30 빈 시간(150분)에 넣을 수 있어요");
    expect(card).toContain("앞뒤 이동(약 8분 · 9분)");
    expect(card).toContain("외부 참고 · 카카오모빌리티");
    expect(findForbidden(card, false)).toEqual([]);
  });

  it("이동을 재지 않았으면 출처 표시를 붙이지 않는다", () => {
    const card = html({ ...news, opportunity: { ...news.opportunity!, precheck: null, travelSource: null } });
    expect(card).not.toContain("외부 참고");
  });
});
