#!/usr/bin/env node
/**
 * TourLint D0 — KTO OpenAPI 9종 실호출 프로브
 * 실행:  KTO_KEY='디코딩키(원문)' node kto_probe.mjs
 * 산출:  probe_out/NN_오퍼레이션.json + 콘솔 요약표
 *
 * ⚠️ 반드시 "디코딩키(Decoding, 원문)"를 넣을 것.
 *    인코딩키를 넣으면 URLSearchParams가 이중 인코딩해서
 *    SERVICE_KEY_IS_NOT_REGISTERED_ERROR가 난다. (가장 흔한 실수)
 * 예상 소모: 12콜 (일 1,000콜 중)
 */
import { mkdirSync, writeFileSync } from "node:fs";

const KEY = process.env.KTO_KEY;
if (!KEY) { console.error("KTO_KEY 환경변수에 디코딩키를 넣어 실행하세요."); process.exit(1); }

const BASE = "https://apis.data.go.kr/B551011/KorService2";
const COMMON = { MobileOS: "ETC", MobileApp: "TourLint", _type: "json" };

// 어제 날짜 (KST) — areaBasedSyncList2 용
const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
kstNow.setUTCDate(kstNow.getUTCDate() - 1);
const yesterday = kstNow.toISOString().slice(0, 10).replaceAll("-", "");

// ── 9종 오퍼레이션 (외부연동 v1.1 3-3 계약 그대로) + 골든 케이스 검증 3콜 ──
const CALLS = [
  ["01_ldongCode2_sido",      "ldongCode2",         {}],                                                          // 시도 목록 (실측 16건)
  ["02_ldongCode2_gangwon",   "ldongCode2",         { lDongRegnCd: "51" }],                                       // 강원 시군구 (강릉=150)
  ["03_lclsSystmCode2_lv1",   "lclsSystmCode2",     {}],                                                          // 대분류 10개
  ["04_searchKeyword2",       "searchKeyword2",     { keyword: "중앙시장", arrange: "A", numOfRows: "10" }],        // 동명 장소 후보
  ["05_areaBasedList2",       "areaBasedList2",     { lDongRegnCd: "51", lDongSignguCd: "150", numOfRows: "20" }],
  ["06_locationBasedList2",   "locationBasedList2", { mapX: "128.898632", mapY: "37.753996", radius: "5000", arrange: "S", numOfRows: "10" }],
  ["07_searchFestival2",      "searchFestival2",    { eventStartDate: "20261001", lDongRegnCd: "51", lDongSignguCd: "150" }], // 강릉커피축제(10.21-25) 확인
  ["08_areaBasedSyncList2",   "areaBasedSyncList2", { modifiedtime: yesterday, numOfRows: "1000" }],               // showflag 미지정 = 표출+비표출
  ["09_detailCommon2",        "detailCommon2",      { contentId: "126508" }],
  ["10_detailIntro2_12",      "detailIntro2",       { contentId: "126508", contentTypeId: "12" }],
  // 골든 케이스 원문 재확인 (데이터 요구사항 5-7)
  ["11_detailIntro2_14_오죽헌박물관", "detailIntro2", { contentId: "129784", contentTypeId: "14" }],
  ["12_detailIntro2_39_소나무집",    "detailIntro2", { contentId: "134338", contentTypeId: "39" }],
];

mkdirSync("probe_out", { recursive: true });
const summary = [];

for (const [name, op, params] of CALLS) {
  const qs = new URLSearchParams({ ...COMMON, ...params, serviceKey: KEY });
  const url = `${BASE}/${op}?${qs}`;
  let note = "", resultCode = "-", count = "-";
  try {
    const res = await fetch(url);
    const body = await res.text();
    if (body.trimStart().startsWith("<")) {
      // EI-KT-002: XML 오류 응답 = 인증 실패·쿼터 초과. JSON 파싱 오류로 오인 금지
      note = "⚠️ XML 오류 응답 (키/쿼터 확인)";
      writeFileSync(`probe_out/${name}.xml.txt`, body);
    } else {
      const json = JSON.parse(body);
      writeFileSync(`probe_out/${name}.json`, JSON.stringify(json, null, 2));
      const h = json?.response?.header, b = json?.response?.body;
      resultCode = h?.resultCode ?? "?";
      const items = b?.items; // EI-KT-004: 0건이면 배열이 아니라 빈 문자열 ""
      if (items === "" || items == null) { count = 0; note = "items=\"\" (0건 정상 처리 확인)"; }
      else {
        const item = items.item;
        count = Array.isArray(item) ? item.length : 1; // EI-KT-005: 1건이면 객체
        if (!Array.isArray(item)) note = "1건=객체 형태 (배열 아님) 확인";
      }
      if (b?.totalCount != null) count = `${count} (total ${b.totalCount})`;
    }
  } catch (e) { note = `요청 실패: ${e.message}`; }
  summary.push({ 파일: name, resultCode, 건수: String(count), 비고: note });
  await new Promise(r => setTimeout(r, 300)); // 예의상 간격
}

console.table(summary);
console.log(`\n총 ${CALLS.length}콜 소모. resultCode가 전부 0000이고 XML 경고가 없으면 성공.`);
console.log("probe_out/ 폴더를 레포의 fixtures/kto/ 로 커밋하세요 (키는 절대 커밋 금지).");
