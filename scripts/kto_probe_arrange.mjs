#!/usr/bin/env node
/**
 * `areaBasedList2` 의 `arrange` 실측 (T1 · FR-RU-110).
 *
 *   node scripts/kto_probe_arrange.mjs
 *
 * ## 무엇을 확정하려는가
 *
 * T1 은 「그 지역에 최근 30일 내 신규 등록」이다. 한 지역 `totalCount` 가 1,004 건이라
 * 정렬 없이 훑으면 상품당 열 콜이 넘는다. **생성일 내림차순 정렬이 되면 1~2콜**이면
 * 끝나므로, `arrange` 가 실제로 먹는지와 어느 값이 생성일 내림차순인지를 본다.
 *
 * EI 명세 3-3 의 `areaBasedList2` 항목에 `arrange` 가 없어 확인이 필요하다.
 *
 * ⚠️ **3콜 쓴다.** 일일 예산 800건 중이며 결과는 파일로 남기지 않는다 — 화면에 찍는 것도
 *    `contentid` · 날짜 · 유형뿐이다. 제목 · 주소 같은 원문은 담지 않는다 (DB 명세서 6-4).
 */
import { readFileSync } from 'node:fs';

/** `.env` 에서 키만 읽는다. 값은 절대 출력하지 않는다 */
function serviceKey() {
  const fromEnv = process.env.KTO_SERVICE_KEY;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').find((l) => l.startsWith('KTO_SERVICE_KEY='));
  if (line === undefined) throw new Error('.env 에 KTO_SERVICE_KEY 가 없다');
  return line.slice('KTO_SERVICE_KEY='.length).trim().replace(/^["']|["']$/g, '');
}

const BASE = 'https://apis.data.go.kr/B551011/KorService2';
const KEY = serviceKey();
let calls = 0;

async function areaBasedList(extra) {
  const params = new URLSearchParams({
    serviceKey: KEY, MobileOS: 'ETC', MobileApp: 'TourLint', _type: 'json',
    lDongRegnCd: '51', lDongSignguCd: '150', numOfRows: '10', pageNo: '1', ...extra,
  });
  calls++;
  const res = await fetch(`${BASE}/areaBasedList2?${String(params)}`);
  const body = await res.json();
  const header = body?.response?.header;
  if (header?.resultCode !== '0000') {
    throw new Error(`resultCode=${header?.resultCode} ${header?.resultMsg}`);
  }
  const items = body?.response?.body?.items?.item ?? [];
  return {
    total: body?.response?.body?.totalCount,
    rows: (Array.isArray(items) ? items : [items]).map((i) => ({
      id: String(i.contentid), type: String(i.contenttypeid),
      created: String(i.createdtime).slice(0, 8), modified: String(i.modifiedtime).slice(0, 8),
    })),
  };
}

/** 내림차순인지 오름차순인지 섞였는지 */
function direction(values) {
  const clean = values.filter((v) => /^\d{8}$/.test(v));
  if (clean.length < 2) return '판정 불가';
  const desc = clean.every((v, i) => i === 0 || clean[i - 1] >= v);
  const asc = clean.every((v, i) => i === 0 || clean[i - 1] <= v);
  return desc ? '내림차순' : asc ? '오름차순' : '정렬 안 됨';
}

const CASES = [
  ['기본 (arrange 없음)', {}],
  ['arrange=C (수정일)', { arrange: 'C' }],
  ['arrange=D (생성일)', { arrange: 'D' }],
];

console.log('\n강원 강릉(51/150) · 10건씩\n');
const seen = new Map();
for (const [label, extra] of CASES) {
  try {
    const { total, rows } = await areaBasedList(extra);
    seen.set(label, rows.map((r) => r.id).join(','));
    console.log(`[${label}] totalCount ${total}`);
    console.log(`  createdtime  ${direction(rows.map((r) => r.created))}  ${rows.map((r) => r.created).join(' ')}`);
    console.log(`  modifiedtime ${direction(rows.map((r) => r.modified))}  ${rows.map((r) => r.modified).join(' ')}`);
  } catch (e) {
    console.log(`[${label}] 실패 — ${e.message}`);
  }
}

console.log('\n[순서가 실제로 바뀌는가]');
const keys = [...seen.keys()];
for (let i = 1; i < keys.length; i++) {
  const same = seen.get(keys[0]) === seen.get(keys[i]);
  console.log(`  ${keys[0]} vs ${keys[i]}: ${same ? '같다 (arrange 가 안 먹는다)' : '다르다'}`);
}
console.log(`\n쓴 콜: ${calls}건`);
