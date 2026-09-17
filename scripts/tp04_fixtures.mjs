#!/usr/bin/env node
/**
 * TP-04 리허설용 픽스처 세트 두 벌을 만든다 (기대값표 §5 · 이슈 #505).
 *
 *   node scripts/tp04_fixtures.mjs <출력디렉터리>
 *
 * `fixtures/kto` 를 두 번 복사하고 실패시킬 콘텐츠의 **detail 스냅샷만** 지운다.
 * 없는 스냅샷은 `FixtureMissingError` 가 되고, 그것이 `KTO_FETCH_FAILED` 다
 * (`retryable = false`). 코드를 고치거나 목업을 넣지 않는다.
 *
 * **파일 이름만 보고 지우면 안 된다.** `11_detailIntro2_14_오죽헌박물관.json` 처럼
 * 이름에 contentid 가 없는 스냅샷이 있다 — `FixtureKtoTransport` 는 detail 계열의
 * contentid 를 파일 내용에서 읽는다. 그래서 여기서도 내용을 본다.
 *
 * 목록 조회 스냅샷(`areaBasedList2` 등)은 그 콘텐츠를 담고 있어도 남긴다. 검수가
 * 부르는 것은 detail 뿐이고, 목록까지 빼면 없앤 적 없는 실패를 만들게 된다.
 */
import { cpSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SOURCE = resolve(import.meta.dirname, '../fixtures/kto');
/** 기대값표 §5 의 실패 주입 목록 */
const CASES = {
  a: ['129784', '1756581', '2868869', '125769'],
  b: ['129784', '1756581', '2868869', '125769', '3022373'],
};
/** 검수가 부르는 상세 조회. 이 파일만 지운다 */
const DETAIL = /^(?:\d+_detail[A-Za-z0-9]*|(?:type)?(?:12|14|15|28|32|38|39)_\d+)/;

const outDir = process.argv[2];
if (outDir === undefined) {
  console.error('사용법: node scripts/tp04_fixtures.mjs <출력디렉터리>');
  process.exit(1);
}

for (const [name, ids] of Object.entries(CASES)) {
  const dir = join(resolve(outDir), `kto-${name}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(SOURCE, dir, { recursive: true });

  const removed = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json') || !DETAIL.test(file)) continue;
    const body = readFileSync(join(dir, file), 'utf8');
    const hit = ids.find((id) => new RegExp(`"contentid"\\s*:\\s*"?${id}"?`).test(body) || file.includes(id));
    if (hit === undefined) continue;
    unlinkSync(join(dir, file));
    removed.push(`${file} (${hit})`);
  }
  console.log(`TP-04${name} · ${dir}`);
  console.log(`  실패 ${ids.length}곳 · 스냅샷 ${removed.length}개 제거`);
  for (const r of removed) console.log(`    ${r}`);
}

console.log('\nKTO_FIXTURE_DIR 을 위 디렉터리로 두고 API 를 KTO_MODE=fixture 로 띄운다.');
