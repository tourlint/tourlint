import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isHandledVerdictKey } from '@tourlint/shared';

const RULES_DIR = join(__dirname, 'rules');

/**
 * 규칙이 `evidence` 에 담는 최상위 키를 소스에서 긁는다.
 *
 * 운영 데이터로는 못 센다 — 아직 발동한 적 없는 규칙(R06 정보 바뀜 · R09 우천)의 키가
 * 빠진다. 실제로 그렇게 10종을 놓쳤다 (#480).
 */
function evidenceKeys(): Set<string> {
  const keys = new Set<string>();
  const files = readdirSync(RULES_DIR).filter((f) => /^r\d\d.*\.ts$/.test(f) && !f.includes('spec'));

  for (const file of files) {
    const src = readFileSync(join(RULES_DIR, file), 'utf8');
    let at = 0;
    for (;;) {
      at = src.indexOf('evidence:', at);
      if (at === -1) break;
      const open = src.indexOf('{', at);
      if (open === -1) break;

      let depth = 0;
      let close = open;
      for (; close < src.length; close += 1) {
        if (src[close] === '{') depth += 1;
        else if (src[close] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      for (const key of topLevelKeys(src.slice(open + 1, close))) keys.add(key);
      at = close;
    }
  }
  return keys;
}

/**
 * 중첩 객체 · 배열 · 호출 안은 건너뛰고 최상위 `이름:` 만.
 *
 * 한 항목의 `:` 은 하나뿐이다. 그 뒤는 값이므로 다음 쉼표까지 건너뛴다 — 안 그러면
 * 삼항연산자(`a === b ? null : c`)의 `:` 을 키로 읽어 `null` 이 키로 잡힌다.
 */
function topLevelKeys(body: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let buf = '';
  let expectingKey = true;
  for (const ch of body) {
    if (ch === '{' || ch === '[' || ch === '(') { depth += 1; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth -= 1; continue; }
    if (depth !== 0) continue;
    if (ch === ',') { buf = ''; expectingKey = true; continue; }
    if (ch === ':' && expectingKey) {
      const m = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(buf.trim());
      if (m?.[1] !== undefined) found.push(m[1]);
      buf = '';
      expectingKey = false;
      continue;
    }
    buf += ch;
  }
  return found;
}

describe('판정 입력값 이름표 전수 (#480)', () => {
  it('규칙 소스에서 키를 실제로 긁는다 — 긁지 못하면 아래 검사가 공짜로 통과한다', () => {
    const keys = evidenceKeys();
    expect(keys.size).toBeGreaterThan(40);
    // 규칙마다 최소 하나씩은 잡혔는지 표본으로 본다
    for (const sample of ['verdict', 'dayOfWeek', 'overlapMinutes', 'rainProbability', 'targetKey']) {
      expect([...keys]).toContain(sample);
    }
  });

  it('🔴 규칙이 담는 키를 전부 사람 말로 옮길 줄 안다', () => {
    /*
     * 이름표를 빠뜨리면 그 키가 화면에 영어로 찍힌다. 종전에는 아무것도 안 잡았고,
     * 운영 데이터에 없던 R06 · R09 의 키 10종이 그대로 새 나갔다.
     */
    const unhandled = [...evidenceKeys()].filter((k) => !isHandledVerdictKey(k));
    expect(unhandled).toEqual([]);
  });
});
