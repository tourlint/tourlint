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
 *
 * **스프레드는 따라 들어간다.** 스프레드로 들어간 객체 리터럴의 키도 결국 최상위에
 * 놓인다. 깊이만 보고 건너뛰었더니 R09 평년 경로의 `rainDays` · `normalMonth` 가
 * `...(cond ? { ... } : {})` 안에서 깊이 2 로 잡혀 빠졌다 (#502).
 *
 * 변수를 편 `...evidence` 는 여기서 볼 수 없다. 그 변수를 만든 자리가 같은 파일의
 * 다른 `evidence:` 리터럴이라 거기서 잡힌다.
 */
function topLevelKeys(body: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let buf = '';
  let expectingKey = true;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (depth === 0 && body.startsWith('...', i)) {
      const end = groupEnd(body, i + 3);
      for (const key of spreadKeys(body.slice(i + 3, end))) found.push(key);
      i = end - 1;
      buf = '';
      continue;
    }
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

/** 스프레드 대상 한 덩어리의 끝. 괄호로 열리면 짝까지, 아니면 다음 최상위 쉼표까지 */
function groupEnd(body: string, from: string | number): number {
  let i = Number(from);
  while (i < body.length && /\s/.test(body[i] as string)) i += 1;
  if (!'({['.includes(body[i] ?? '')) {
    while (i < body.length && body[i] !== ',') i += 1;
    return i;
  }
  let depth = 0;
  for (; i < body.length; i += 1) {
    const ch = body[i] as string;
    if ('({['.includes(ch)) depth += 1;
    else if (')}]'.includes(ch)) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return body.length;
}

/** 스프레드 덩어리 안의 객체 리터럴마다 그 최상위 키 */
function spreadKeys(group: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < group.length; i += 1) {
    if (group[i] !== '{') continue;
    const end = groupEnd(group, i);
    found.push(...topLevelKeys(group.slice(i + 1, end - 1)));
    i = end - 1;
  }
  return found;
}

describe('판정 입력값 이름표 전수 (#480)', () => {
  it('규칙 소스에서 키를 실제로 긁는다 — 긁지 못하면 아래 검사가 공짜로 통과한다', () => {
    const keys = evidenceKeys();
    expect(keys.size).toBeGreaterThan(40);
    // 규칙마다 최소 하나씩은 잡혔는지 표본으로 본다
    // rainDays 는 조건부 스프레드 안에 있다 — 스프레드를 못 따라가면 여기서 걸린다 (#502)
    for (const sample of ['verdict', 'dayOfWeek', 'overlapMinutes', 'rainProbability', 'targetKey', 'rainDays']) {
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
