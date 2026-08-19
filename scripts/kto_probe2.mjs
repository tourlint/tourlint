#!/usr/bin/env node
/**
 * TourLint STEP 5 보조 — 미검증 contentTypeId 4종 + spendtime/구코드 값 확인
 * 실행: KTO_KEY='...' node scripts/kto_probe2.mjs
 * 소모: 최대 8콜 (목록 4 + 상세 4)
 */
import { mkdirSync, writeFileSync } from "node:fs";
const KEY = process.env.KTO_KEY;
if (!KEY) { console.error("KTO_KEY 필요"); process.exit(1); }
const BASE = "https://apis.data.go.kr/B551011/KorService2";
const COMMON = { MobileOS: "ETC", MobileApp: "TourLint", _type: "json" };
const get = async (op, params) => {
  const qs = new URLSearchParams({ ...COMMON, ...params, serviceKey: KEY });
  const body = await (await fetch(`${BASE}/${op}?${qs}`)).text();
  if (body.trimStart().startsWith("<")) throw new Error("XML 오류 응답");
  return JSON.parse(body);
};
const list = (j) => { const b = j?.response?.body?.items; if (!b) return []; const i = b.item; return Array.isArray(i) ? i : [i]; };

// 문서상 분기표 (외부연동 §3-3)
const EXPECT = {
  15: { rest: null,                 open: "playtime",          tel: "sponsor1tel" },
  28: { rest: "restdateleports",    open: "usetimeleports",    tel: "infocenterleports" },
  32: { rest: null,                 open: "checkintime|checkouttime", tel: "infocenterlodging" },
  38: { rest: "restdateshopping",   open: "opentime",          tel: "infocentershopping" },
};

mkdirSync("probe2_out", { recursive: true });
for (const t of [15, 28, 32, 38]) {
  try {
    const L = list(await get("areaBasedList2", { lDongRegnCd: "51", lDongSignguCd: "150", contentTypeId: String(t), numOfRows: "5" }));
    if (!L.length) { console.log(`\n■ contentTypeId ${t} — 강릉에 0건. 다른 지역으로 재시도 필요`); continue; }
    const c = L[0];
    const d = await get("detailIntro2", { contentId: c.contentid, contentTypeId: String(t) });
    const item = list(d)[0] ?? {};
    writeFileSync(`probe2_out/type${t}_${c.contentid}.json`, JSON.stringify(d, null, 2));
    console.log(`\n■ contentTypeId ${t} — ${c.title} (${c.contentid})`);
    console.log("  전체 필드:", Object.keys(item).sort().join(", "));
    const e = EXPECT[t];
    for (const key of [e.rest, ...e.open.split("|"), e.tel].filter(Boolean)) {
      const has = key in item;
      const v = String(item[key] ?? "").slice(0, 70);
      console.log(`  ${has ? "✅" : "❌"} ${key} = ${JSON.stringify(v)}`);
    }
    if ("spendtime" in item) console.log(`  ➕ spendtime = ${JSON.stringify(item.spendtime)}`);
  } catch (err) { console.log(`\n■ contentTypeId ${t} — 실패: ${err.message}`); }
  await new Promise(r => setTimeout(r, 300));
}

// spendtime 값 확인 (문화시설 오죽헌박물관) + 구 코드체계 값 확인 (공통정보)
console.log("\n\n===== 추가 확인 =====");
const intro14 = list(await get("detailIntro2", { contentId: "129784", contentTypeId: "14" }))[0] ?? {};
console.log("■ B. 문화시설 spendtime 값 →", JSON.stringify(intro14.spendtime ?? "(필드 없음)"));
const common = list(await get("detailCommon2", { contentId: "129784" }))[0] ?? {};
console.log("■ C. 상세 조회의 구 코드체계 값 →",
  JSON.stringify({ areacode: common.areacode, sigungucode: common.sigungucode, cat1: common.cat1, cat2: common.cat2, cat3: common.cat3 }));
console.log("\n총 10콜 소모.");
