#!/usr/bin/env node
// scripts/fill_gaps.mjs
// ① 로컬 픽스처에서 행사기간(eventstartdate/enddate) 추출 — 호출 0회
// ② 분류코드·좌표가 빈 7건만 detailCommon2로 보강 — 7콜
import fs from 'node:fs';
import path from 'node:path';

const KEY = process.env.KTO_KEY;
if (!KEY) { console.error('KTO_KEY 환경변수가 없습니다. export KTO_KEY=$(grep KTO_SERVICE_KEY .env | cut -d= -f2)'); process.exit(1); }

const DIR = 'fixtures/kto';
const OUT = 'probe4_out';
const BASE = 'https://apis.data.go.kr/B551011/KorService2';
const COMMON = { MobileOS: 'ETC', MobileApp: 'TourLint', _type: 'json' };

function items(file) {
  try {
    const b = JSON.parse(fs.readFileSync(file, 'utf8'))?.response?.body?.items;
    if (!b) return [];
    const it = b.item;
    return Array.isArray(it) ? it : [it];
  } catch { return []; }
}

// ── ① 행사기간: 상세 응답 자체에서 뽑는다 (목록이 아니라) ──
console.log('===== ① 행사기간 (호출 0회) =====');
let found = 0;
for (const f of fs.readdirSync(DIR).filter(f => /\.json$/.test(f))) {
  for (const x of items(path.join(DIR, f))) {
    if (x?.eventstartdate) {
      console.log(`  ${x.contentid}  ${x.eventstartdate} ~ ${x.eventenddate}   (${f})`);
      found++;
    }
  }
}
if (!found) console.log('  (없음)');

// ── ② 보강 대상 ──
const TARGETS = [
  ['129784',  '강릉 오죽헌·시립박물관'],
  ['3379937', '강릉 한복 문화 창작소'],
  ['3534495', '강릉바다 화이트비치'],
  ['3540781', '강릉관광호텔'],
  ['4074363', '강릉강변스테이'],
  ['132772',  '강릉 동부시장'],
  ['825295',  '강릉커피축제'],
];

fs.mkdirSync(OUT, { recursive: true });

async function call(op, params) {
  const u = new URL(`${BASE}/${op}`);
  u.searchParams.set('serviceKey', KEY);
  for (const [k, v] of Object.entries({ ...COMMON, ...params })) u.searchParams.set(k, String(v));
  const res = await fetch(u, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  if (text.trim().startsWith('<')) throw new Error(`XML 응답 (인증키/쿼터 확인): ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

console.log('\n===== ② 분류코드·좌표 보강 (detailCommon2 7콜) =====');
let calls = 0;
for (const [id, name] of TARGETS) {
  try {
    const j = await call('detailCommon2', { contentId: id });
    calls++;
    fs.writeFileSync(path.join(OUT, `common_${id}.json`), JSON.stringify(j, null, 2));
    const b = j?.response?.body?.items;
    const x = b ? (Array.isArray(b.item) ? b.item[0] : b.item) : null;
    if (!x) { console.log(`  ${id} ${name} → 응답 없음`); continue; }
    const lcls = [x.lclsSystm1, x.lclsSystm2, x.lclsSystm3].filter(Boolean).join('/') || '(없음)';
    const xy = x.mapx ? `${Number(x.mapx).toFixed(5)},${Number(x.mapy).toFixed(5)}` : '(없음)';
    console.log(`  ${id} ${name}`);
    console.log(`     type ${x.contenttypeid} · 분류 ${lcls} · 좌표 ${xy} · cpyrht ${x.cpyrhtDivCd ?? '-'}`);
    if (x.eventstartdate) console.log(`     행사 ${x.eventstartdate} ~ ${x.eventenddate}`);
  } catch (e) {
    console.log(`  ${id} ${name} → 실패: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 250));
}
console.log(`\n총 ${calls}콜 소모. 응답은 ${OUT}/ 에 저장했습니다.`);
