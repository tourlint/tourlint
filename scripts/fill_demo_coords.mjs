#!/usr/bin/env node
/**
 * 데모 시연 상품에 좌표를 박는다 (`apps/api/src/seed/demo-products.ts`).
 *
 *   node scripts/fill_demo_coords.mjs --check     받아서 비교만 한다 (파일 안 고침)
 *   node scripts/fill_demo_coords.mjs --write     파일을 고친다
 *
 * **공사를 부른다** — 고유 `contentId` 당 `detailCommon2` 1콜이다. 항목은 37개지만
 * 같은 관광지가 여러 상품에 겹쳐 고유 15개다.
 *
 * 왜 필요한가 — 시드가 `match_status = CONFIRMED` 를 박으면서 좌표는 안 넣었다.
 * 실사용 경로(F02 매칭)는 `detailCommon2` 의 `mapx` 를 저장하는데(place-match.service.ts),
 * 시드가 그 경로를 건너뛴다. 좌표가 없으면 R08 이 전 구간을 `COORD_MISSING` 으로 넘겨
 * (audit-runner.ts) 길찾기를 한 번도 부르지 않고, `travel_seconds` 가 0 으로 남는다.
 * 데모 상품 전부가 이동시간 확인 불가가 되고 성능 실측도 절반만 한 검수를 재게 된다.
 *
 * 좌표는 자주 바뀌지 않으므로 받은 값을 파일에 박아 둔다 — 시드가 공사를 부르게 하면
 * 키 없이는 시드를 못 돌린다.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const MODE = process.argv.includes('--write') ? 'write' : 'check';
const FILE = new URL('../apps/api/src/seed/demo-products.ts', import.meta.url);
const BASE = 'https://apis.data.go.kr/B551011/KorService2';

const KEY = readEnv('KTO_SERVICE_KEY');
if (KEY === null) die('KTO_SERVICE_KEY 가 없다 (.env 또는 환경변수)');

function readEnv(name) {
  if (process.env[name] !== undefined && process.env[name] !== '') return process.env[name];
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n').find((l) => l.startsWith(`${name}=`));
    const v = line === undefined ? '' : line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
    return v === '' ? null : v;
  } catch { return null; }
}
function die(msg) { console.error(`error: ${msg}`); process.exit(1); }

const src = readFileSync(FILE, 'utf8');
const ids = [...new Set([...src.matchAll(/ktoContentId: "(\d+)"/g)].map((m) => m[1]))];
console.log(`\n고유 contentId ${ids.length}개 · 항목 ${(src.match(/ktoContentId: "/g) ?? []).length}개`);
console.log(`detailCommon2 ${ids.length}콜을 부른다\n`);

/** 좌표 한 건. 실패는 null 로 돌려주고 뒤에서 통째로 막는다 */
async function coordsOf(contentId) {
  const qs = new URLSearchParams({
    MobileOS: 'ETC', MobileApp: 'TourLint', _type: 'json', contentId, serviceKey: KEY,
  });
  const res = await fetch(`${BASE}/detailCommon2?${qs.toString()}`);
  if (!res.ok) return { contentId, error: `HTTP ${res.status}` };
  const json = await res.json().catch(() => null);
  const item = json?.response?.body?.items?.item;
  const row = Array.isArray(item) ? item[0] : item;
  if (row === undefined || row === null) return { contentId, error: '빈 응답' };
  const mapx = Number(row.mapx);
  const mapy = Number(row.mapy);
  if (!Number.isFinite(mapx) || !Number.isFinite(mapy) || mapx === 0 || mapy === 0) {
    return { contentId, error: `좌표 없음 (mapx=${String(row.mapx)} mapy=${String(row.mapy)})` };
  }
  return { contentId, mapx, mapy, title: String(row.title ?? '') };
}

const found = new Map();
const failed = [];
for (const id of ids) {
  const r = await coordsOf(id);
  if (r.error !== undefined) {
    failed.push(r);
    console.log(`  ${id.padEnd(9)} 실패 — ${r.error}`);
  } else {
    found.set(id, r);
    console.log(`  ${id.padEnd(9)} ${String(r.mapx).padEnd(12)} ${String(r.mapy).padEnd(11)} ${r.title}`);
  }
}

if (failed.length > 0) {
  console.error(`\n${failed.length}건 실패. 좌표가 반쯤 빈 시드는 R08 이 구간마다 다르게 판정해`);
  console.error('원인을 읽기 더 어렵게 만든다. 파일을 고치지 않고 멈춘다.\n');
  process.exit(1);
}

if (MODE === 'check') {
  const already = (src.match(/mapx: /g) ?? []).length;
  console.log(`\n전부 받았다. 파일에 이미 박힌 좌표 ${already}건.`);
  console.log('고치려면 --write 를 붙여라.\n');
  process.exit(0);
}

// 항목 한 줄마다 lclsSystm3 뒤에 좌표를 끼운다. 이미 있으면 값을 갱신한다.
let patched = 0;
const out = src.replace(
  /(ktoContentId: "(\d+)"[^}]*?)(, mapx: [^,]+, mapy: [^,}]+)?( \})/g,
  (whole, head, id, _old, tail) => {
    const c = found.get(id);
    if (c === undefined) return whole;
    patched += 1;
    return `${head}, mapx: ${String(c.mapx)}, mapy: ${String(c.mapy)}${tail}`;
  },
);
if (patched === 0) die('한 줄도 못 고쳤다 — 파일 형식이 예상과 다르다');
writeFileSync(FILE, out, 'utf8');
console.log(`\n항목 ${patched}개에 좌표를 박았다. \`pnpm --filter api build\` 후 시드를 다시 돌려라.\n`);
