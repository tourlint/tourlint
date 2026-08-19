#!/usr/bin/env node
/**
 * TourLint STEP 5 — 픽스처용 contentid 선별
 * 실행: KTO_KEY='...' node scripts/pick_fixtures.mjs
 * 소모: 약 26콜 (목록 6 + 상세 20)
 * 산출: fixtures/products/contentids.md  +  probe3_out/*.json
 *
 * 강릉(51/150)에서 유형별 후보를 모아 운영정보를 자동 분류하고,
 * TP-01(표준) / TP-03(위반 유도) / R05(결측) 용도를 제안한다.
 * 축제 2건(강릉커피축제 825295 · 경포벚꽃축제 695592)은 앞선 probe에서 확보되어 목록에 병합한다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
const KEY = process.env.KTO_KEY;
if (!KEY) { console.error("KTO_KEY 필요"); process.exit(1); }
const BASE = "https://apis.data.go.kr/B551011/KorService2";
const COMMON = { MobileOS: "ETC", MobileApp: "TourLint", _type: "json" };
const REGN = "51", SIGNGU = "150";           // 강원 / 강릉

const get = async (op, params) => {
  const qs = new URLSearchParams({ ...COMMON, ...params, serviceKey: KEY });
  const body = await (await fetch(`${BASE}/${op}?${qs}`)).text();
  if (body.trimStart().startsWith("<")) throw new Error("XML 오류 응답 (키/쿼터)");
  return JSON.parse(body);
};
const list = (j) => { const b = j?.response?.body?.items; if (!b) return []; const i = b.item; return Array.isArray(i) ? i : [i]; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// contentTypeId → [휴무일 필드, 운영시간 필드, 문의처 필드]  (외부연동 §3-3 분기표)
const F = {
  12: ["restdate", "usetime", "infocenter"],
  14: ["restdateculture", "usetimeculture", "infocenterculture"],
  28: ["restdateleports", "usetimeleports", "infocenterleports"],
  32: [null, "checkintime|checkouttime", "infocenterlodging"],
  38: ["restdateshopping", "opentime", "infocentershopping"],
  39: ["restdatefood", "opentimefood", "infocenterfood"],
};
const NAME = { 12: "관광지", 14: "문화시설", 15: "축제", 28: "레포츠", 32: "숙박", 38: "쇼핑", 39: "음식점" };
const TARGET = { 12: 6, 14: 3, 28: 1, 32: 3, 38: 2, 39: 5 };   // 합 20건

function classify(typeId, item) {
  if (typeId === 32) {
    const ci = (item.checkintime ?? "").trim(), co = (item.checkouttime ?? "").trim();
    if (!ci && !co) return ["결측", "체크인/아웃 모두 빈 값 → R05"];
    return ["정상", `체크인 ${ci || "-"} / 체크아웃 ${co || "-"}`];
  }
  const [rf, of_] = F[typeId];
  const rest = (rf ? item[rf] ?? "" : "").trim();
  const open = (item[of_] ?? "").trim();
  const t = `${rest} ${open}`;
  if (!rest && !open) return ["결측", "휴무·운영시간 모두 빈 값 → R05 · UNPARSED 검증"];
  if (/참조|문의\s*요망|상이|홈페이지/.test(t)) return ["참조형", "TARGET_VARIES / REFERENCE → 확인 필요 목록"];
  if (/매주\s*[월화수목금토일]/.test(rest)) return ["요일휴무", "R01 휴무일 충돌 유도 가능 ★"];
  if (/입실|퇴실|체크인|체크아웃/.test(open)) return ["체크인형", "숙박형 — 파서 §E 케이스 ★"];
  if (!rest || !open) return ["결측(일부)", "한쪽만 비어 있음 → 부분 확인 불가"];
  if (/연중무휴|상시/.test(rest)) return ["상시개방", "TP-01 표준 구성용"];
  return ["정상", "TP-01 표준 구성용"];
}

const R = 6371e3, rad = (d) => d * Math.PI / 180;
const distKm = (a, b) => {
  const p1 = rad(+a.mapy), p2 = rad(+b.mapy), dp = rad(+b.mapy - +a.mapy), dl = rad(+b.mapx - +a.mapx);
  const h = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return (R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h)) / 1000);
};

mkdirSync("probe3_out", { recursive: true });
const rows = [];
let calls = 0;

for (const t of Object.keys(TARGET).map(Number)) {
  let cands = [];
  try {
    cands = list(await get("areaBasedList2", { lDongRegnCd: REGN, lDongSignguCd: SIGNGU, contentTypeId: String(t), numOfRows: "15" }));
    calls++;
  } catch (e) { console.log(`■ ${NAME[t]}(${t}) 목록 실패: ${e.message}`); continue; }
  await sleep(250);

  const picked = cands.filter(c => c.mapx && c.mapy).slice(0, TARGET[t]);
  for (const c of picked) {
    try {
      const d = await get("detailIntro2", { contentId: c.contentid, contentTypeId: String(t) });
      calls++;
      const item = list(d)[0] ?? {};
      writeFileSync(`probe3_out/${t}_${c.contentid}.json`, JSON.stringify(d, null, 2));
      const [cls, note] = classify(t, item);
      const [rf, of_, tf] = F[t];
      rows.push({
        contentid: c.contentid, type: t, typeName: NAME[t], title: c.title,
        cls, note,
        rest: rf ? String(item[rf] ?? "").replace(/\s+/g, " ").slice(0, 60) : "-",
        open: t === 32
          ? `${item.checkintime ?? ""}/${item.checkouttime ?? ""}`
          : String(item[of_] ?? "").replace(/\s+/g, " ").slice(0, 60),
        tel: String(item[tf] ?? "").slice(0, 40),
        mapx: c.mapx, mapy: c.mapy, lcls2: c.lclsSystm2 ?? "",
      });
    } catch (e) { console.log(`  ${c.title} 상세 실패: ${e.message}`); }
    await sleep(250);
  }
}

// 축제 2건은 앞선 probe에서 확보 — 호출 없이 병합
rows.push(
  { contentid: "825295", type: 15, typeName: "축제", title: "강릉커피축제", cls: "행사기간", note: "20261021~25 · 출발 10/28이면 R02 EVENT_ENDED ★", rest: "-", open: "-", tel: "", mapx: "", mapy: "", lcls2: "" },
  { contentid: "695592", type: 15, typeName: "축제", title: "강릉 경포벚꽃축제", cls: "행사기간", note: "봄 축제 · 가을 출발이면 R02 위반 유도 ★", rest: "-", open: "-", tel: "", mapx: "", mapy: "", lcls2: "" },
);

// 최장 거리 쌍 (R08 이동시간 부족 유도용)
const geo = rows.filter(r => r.mapx && r.mapy);
const pairs = [];
for (let i = 0; i < geo.length; i++) for (let j = i + 1; j < geo.length; j++)
  pairs.push({ a: geo[i], b: geo[j], km: distKm(geo[i], geo[j]) });
pairs.sort((x, y) => y.km - x.km);

console.table(rows.map(r => ({ id: r.contentid, 유형: r.typeName, 이름: r.title.slice(0, 18), 분류: r.cls, 운영: r.open.slice(0, 28) })));
console.log(`\n총 ${calls}콜 소모.`);
console.log("\n── R08 위반 유도용 최장 거리 쌍 3개 ──");
pairs.slice(0, 3).forEach(p => console.log(`  ${p.km.toFixed(1)}km  ${p.a.title} ↔ ${p.b.title}`));

// contentids.md 작성
const byCls = (c) => rows.filter(r => r.cls === c);
const md = `# 픽스처용 contentid 목록 (강릉)

수집일: 2026-08-20 · 근거: probe3_out/*.json · 소모 ${calls}콜
지역: 강원 51 / 강릉 150 · 좌표는 R08 이동시간 계산 입력

## 전체 목록

| contentid | 유형 | 이름 | 분류 | 휴무일 원문 | 운영시간 원문 | 문의처 | mapx | mapy |
|---|---|---|---|---|---|---|---|---|
${rows.map(r => `| ${r.contentid} | ${r.type} ${r.typeName} | ${r.title} | ${r.cls} | ${r.rest || "-"} | ${r.open || "-"} | ${r.tel || "-"} | ${r.mapx} | ${r.mapy} |`).join("\n")}

## 용도 배정

### TP-01 표준 (2박 3일 · 12곳 · 전부 정상 판정 기대)
관광 콘텐츠는 \`정상\` · \`상시개방\` 분류에서 고르고, 숙박 2곳 + 식사 구성을 포함한다.
${[...byCls("정상"), ...byCls("상시개방")].map(r => `- ${r.contentid} ${r.title} (${r.typeName})`).join("\n") || "- (없음)"}

### TP-02 경계 (TP-01과 동일 구성, 출발일만 파라미터)
R09 분기 확인용 — 출발일 D+2 / D+3 / D+10 / D+11 네 값으로 돌린다.

### TP-03 위반 유도 (R01~R10을 하나씩 의도적 위반)
${byCls("요일휴무").map(r => `- **R01** ${r.contentid} ${r.title} — ${r.rest}`).join("\n") || "- R01: 요일 휴무 후보 없음 → 수동 탐색 필요"}
- **R02** 825295 강릉커피축제 (20261021~25) / 695592 경포벚꽃축제 — 출발일을 기간 밖으로
- **R03** 시간 중복은 픽스처 일정 자체로 구성 (API 무관)
${pairs.slice(0, 1).map(p => `- **R08** ${p.a.contentid} ${p.a.title} ↔ ${p.b.contentid} ${p.b.title} (${p.km.toFixed(1)}km) — 이동시간 부족 유도`).join("\n")}
${byCls("체크인형").map(r => `- **파서 §E** ${r.contentid} ${r.title} — ${r.open}`).join("\n")}

### TP-04 실패 / R05 확인 불가
${[...byCls("결측"), ...byCls("결측(일부)"), ...byCls("참조형")].map(r => `- ${r.contentid} ${r.title} — ${r.cls}: ${r.note}`).join("\n") || "- (없음) → 존재하지 않는 contentid를 임의 생성해 6곳 구성"}

> TP-04는 12곳 중 6곳을 **존재하지 않는 contentid**(예: \`99999901\`~\`99999906\`)로 채워 조회 실패 50% 초과 → 부분 검수 상태를 재현한다.

## 다음 (기대값 표)
각 픽스처에 대해 **구현 전에** 사람이 정답을 확정한다 — TP-01 등급 분포·점수, TP-03의 규칙×사유코드 매핑, TP-04 UNVERIFIED 6건.
`;
writeFileSync("fixtures/products/contentids.md", md);
console.log("\n✅ fixtures/products/contentids.md 작성 완료");
