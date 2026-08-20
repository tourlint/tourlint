#!/usr/bin/env node
// scripts/dump_fixture_meta.mjs
// 로컬 픽스처만 읽는다 — KTO 호출 0회.
// 픽스처 22건의 판정 관련 원문을 한 표로 뽑아 기대값 표 작성의 입력으로 쓴다.
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'fixtures/kto';

// contentTypeId별 판정 필드 (필드 대조표 확정본 기준)
const FIELD_MAP = {
  12: { rest: 'restdate',          open: 'usetime',           tel: 'infocenter' },
  14: { rest: 'restdateculture',   open: 'usetimeculture',    tel: 'infocenterculture' },
  15: { rest: null,                open: 'playtime',          tel: 'sponsor1tel' },
  28: { rest: 'restdateleports',   open: 'usetimeleports',    tel: 'infocenterleports' },
  32: { rest: null,                open: null,                tel: 'infocenterlodging' },
  38: { rest: 'restdateshopping',  open: 'opentime',          tel: 'infocentershopping' },
  39: { rest: 'restdatefood',      open: 'opentimefood',      tel: 'infocenterfood' },
};

const TYPE_NAME = { 12:'관광지', 14:'문화시설', 15:'축제', 25:'코스', 28:'레포츠', 32:'숙박', 38:'쇼핑', 39:'음식점' };

function items(file) {
  try {
    const b = JSON.parse(fs.readFileSync(file, 'utf8'))?.response?.body?.items;
    if (!b) return [];
    const it = b.item;
    return Array.isArray(it) ? it : [it];
  } catch { return []; }
}

// 1) 유형별 상세(운영정보) 파일 수집: 12_125790.json 형태
const files = fs.readdirSync(DIR).filter(f => /^\d{2}_\d+\.json$/.test(f) || /^type\d+_\d+\.json$/.test(f));

// 2) 목록 응답에서 lclsSystm·좌표·제목 보강
const listIndex = new Map();
for (const f of fs.readdirSync(DIR)) {
  if (!/\.json$/.test(f)) continue;
  for (const x of items(path.join(DIR, f))) {
    if (!x?.contentid) continue;
    if (x.title || x.mapx || x.lclsSystm1) {
      const prev = listIndex.get(String(x.contentid)) ?? {};
      listIndex.set(String(x.contentid), {
        title: x.title ?? prev.title,
        mapx: x.mapx ?? prev.mapx,
        mapy: x.mapy ?? prev.mapy,
        lcls1: x.lclsSystm1 ?? prev.lcls1,
        lcls2: x.lclsSystm2 ?? prev.lcls2,
        lcls3: x.lclsSystm3 ?? prev.lcls3,
        cpyrht: x.cpyrhtDivCd ?? prev.cpyrht,
        eventstart: x.eventstartdate ?? prev.eventstart,
        eventend: x.eventenddate ?? prev.eventend,
      });
    }
  }
}

const rows = [];
for (const f of files.sort()) {
  for (const x of items(path.join(DIR, f))) {
    const t = Number(x.contenttypeid);
    const m = FIELD_MAP[t] ?? {};
    const meta = listIndex.get(String(x.contentid)) ?? {};
    rows.push({
      id: String(x.contentid),
      type: `${t} ${TYPE_NAME[t] ?? '?'}`,
      title: meta.title ?? '(목록에 없음)',
      lcls: [meta.lcls1, meta.lcls2, meta.lcls3].filter(Boolean).join('/') || '(없음)',
      휴무: m.rest ? (x[m.rest] || '(빈값)') : '—',
      운영: m.open ? (x[m.open] || '(빈값)') : (t === 32 ? `입실 ${x.checkintime || '?'} / 퇴실 ${x.checkouttime || '?'}` : '—'),
      문의: m.tel ? (x[m.tel] || '(빈값)') : '—',
      행사: meta.eventstart ? `${meta.eventstart}~${meta.eventend}` : '—',
      좌표: meta.mapx ? `${Number(meta.mapx).toFixed(5)},${Number(meta.mapy).toFixed(5)}` : '(없음)',
    });
  }
}

rows.sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title));

console.log(`\n===== 픽스처 판정 원문 덤프 (${rows.length}건 · KTO 호출 0회) =====\n`);
for (const r of rows) {
  console.log(`■ ${r.id} · ${r.type} · ${r.title}`);
  console.log(`   분류 ${r.lcls}   좌표 ${r.좌표}`);
  console.log(`   휴무 : ${r.휴무}`);
  console.log(`   운영 : ${r.운영}`);
  console.log(`   문의 : ${r.문의}`);
  if (r.행사 !== '—') console.log(`   행사 : ${r.행사}`);
  console.log('');
}

// 중분류 요약 — 체류시간·실내외 매핑표에서 채워야 할 행
const lclsSet = new Map();
for (const r of rows) {
  if (r.lcls === '(없음)') continue;
  const mid = r.lcls.split('/')[1];
  if (!mid) continue;
  if (!lclsSet.has(mid)) lclsSet.set(mid, []);
  lclsSet.get(mid).push(`${r.type.split(' ')[1]} ${r.title}`);
}
console.log('===== 채워야 할 중분류(lclsSystm2) 목록 =====');
if (lclsSet.size === 0) {
  console.log('(목록 응답에 분류코드가 없습니다 — detailCommon2 보강이 필요합니다)');
} else {
  for (const [mid, names] of [...lclsSet].sort()) {
    console.log(`  ${mid}  ← ${names.join(' · ')}`);
  }
  console.log(`\n총 ${lclsSet.size}개 중분류만 채우면 됩니다 (전체 59행 중).`);
}
