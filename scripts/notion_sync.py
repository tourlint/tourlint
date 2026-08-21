#!/usr/bin/env python3
"""
노션 정본 ↔ docs/notion 사본 동기화 도구.

왜 필요한가
-----------
문서 12종이 상호 참조로 얽혀 있어 한 곳을 고치면 다른 문서가 조용히 어긋난다.
그렇다고 결정할 때마다 MCP 로 노션 정본을 직접 고치면 작업이 끊긴다.
그래서 사본에서 몰아서 작업하고, 마지막에 정본과 한 번에 맞춘다.

안전 장치
---------
push 는 `update_content` 의 old_str/new_str 쌍으로 나간다.
old_str 이 정본과 한 글자라도 다르면 **호출이 실패할 뿐 정본이 망가지지 않는다.**
즉 사본에 오차가 있어도 손대지 않은 영역은 무해하고, 손댄 영역은 실패로 드러난다.

디렉터리
--------
  docs/notion/_pages.json     페이지 레지스트리
  docs/notion/<파일>.md       작업본 — 여기서만 편집한다
  docs/notion/.baseline/      pull 시점 원본 — 사람이 손대지 않는다

명령
----
  save <key> <rawFetchFile>   MCP fetch 결과(JSON 봉투)를 작업본+기준선에 기록
  status [key]                기준선 ↔ 작업본 차이 요약
  diff <key>                  차이를 unified diff 로 출력
  plan [key]                  push 용 content_updates JSON 생성
  check <key> <rawFetchFile>  정본이 기준선과 달라졌는지 (상류 변경 감지)
  accept <key>                push 성공 후 기준선 := 작업본
"""
from __future__ import annotations

import difflib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTION_DIR = ROOT / 'docs' / 'notion'
BASELINE_DIR = NOTION_DIR / '.baseline'
REGISTRY = NOTION_DIR / '_pages.json'

# update_content 한 번에 보낼 수 있는 최대 쌍 수
MAX_UPDATES = 100
# old_str 이 문서 안에서 유일해질 때까지 붙이는 문맥 줄 수 상한
MAX_CONTEXT = 40


def die(msg: str) -> None:
    print(f'error: {msg}', file=sys.stderr)
    raise SystemExit(1)


def load_registry() -> dict:
    if not REGISTRY.exists():
        die(f'레지스트리가 없다: {REGISTRY}')
    return json.loads(REGISTRY.read_text(encoding='utf-8'))


def page_entry(key: str) -> dict:
    reg = load_registry()
    if key not in reg['pages']:
        die(f'알 수 없는 키: {key}\n사용 가능: {", ".join(reg["pages"])}')
    return reg['pages'][key]


def paths(key: str) -> tuple[Path, Path]:
    e = page_entry(key)
    return NOTION_DIR / e['file'], BASELINE_DIR / e['file']


def extract_content(raw: str) -> str:
    """MCP fetch 결과 봉투에서 <content> 본문만 꺼낸다."""
    raw = raw.strip()
    if raw.startswith('{'):
        try:
            text = json.loads(raw)['text']
        except (json.JSONDecodeError, KeyError) as exc:
            die(f'fetch 결과를 해석할 수 없다: {exc}')
    else:
        text = raw

    start = text.find('<content>')
    end = text.rfind('</content>')
    if start == -1 or end == -1:
        die('<content> 블록을 찾지 못했다. fetch 결과가 맞는지 확인할 것')
    body = text[start + len('<content>'):end]
    return body.strip('\n') + '\n'


# ── save ──────────────────────────────────────────────────────────────
def cmd_save(key: str, raw_file: str) -> None:
    work, base = paths(key)
    content = extract_content(Path(raw_file).read_text(encoding='utf-8'))

    if work.exists() and base.exists():
        if work.read_text(encoding='utf-8') != base.read_text(encoding='utf-8'):
            die(
                f'{work.name} 에 아직 push 하지 않은 로컬 수정이 있다.\n'
                f'  덮어쓰면 그 수정이 사라진다. plan → push → accept 를 먼저 끝낼 것.'
            )

    work.parent.mkdir(parents=True, exist_ok=True)
    base.parent.mkdir(parents=True, exist_ok=True)
    work.write_text(content, encoding='utf-8')
    base.write_text(content, encoding='utf-8')
    lines = content.count('\n')
    print(f'saved  {key:12} {work.relative_to(ROOT)}  ({lines}줄 · {len(content):,}자)')


# ── status / diff ─────────────────────────────────────────────────────
def _pair(key: str) -> tuple[list[str], list[str]]:
    work, base = paths(key)
    if not base.exists():
        die(f'기준선이 없다: {base.relative_to(ROOT)} — 먼저 save 할 것')
    if not work.exists():
        die(f'작업본이 없다: {work.relative_to(ROOT)}')
    return (
        base.read_text(encoding='utf-8').splitlines(keepends=True),
        work.read_text(encoding='utf-8').splitlines(keepends=True),
    )


def cmd_status(key: str | None) -> None:
    reg = load_registry()
    keys = [key] if key else list(reg['pages'])
    dirty = 0
    for k in keys:
        e = reg['pages'][k]
        work, base = NOTION_DIR / e['file'], BASELINE_DIR / e['file']
        if not base.exists():
            print(f'  ?  {k:12} 기준선 없음 — save 필요')
            continue
        b, w = base.read_text(encoding='utf-8'), work.read_text(encoding='utf-8')
        if b == w:
            print(f'  =  {k:12} {e["title"]}')
        else:
            add = sum(1 for ln in difflib.ndiff(b.splitlines(), w.splitlines()) if ln.startswith('+ '))
            rm = sum(1 for ln in difflib.ndiff(b.splitlines(), w.splitlines()) if ln.startswith('- '))
            print(f'  M  {k:12} {e["title"]}   +{add} -{rm}')
            dirty += 1
    print(f'\n변경된 문서 {dirty}건' + ('' if dirty else ' — 정본과 같다'))


def cmd_diff(key: str) -> None:
    b, w = _pair(key)
    e = page_entry(key)
    out = difflib.unified_diff(b, w, fromfile=f'notion/{e["file"]}', tofile=f'local/{e["file"]}', n=3)
    sys.stdout.writelines(out)


# ── plan ──────────────────────────────────────────────────────────────
def _hunks(base: list[str], work: list[str]) -> list[tuple[int, int, int, int]]:
    """인접한 변경 구간을 하나로 묶어 (b1,b2,w1,w2) 목록으로 돌려준다."""
    sm = difflib.SequenceMatcher(None, base, work, autojunk=False)
    ops = [op for op in sm.get_opcodes() if op[0] != 'equal']
    if not ops:
        return []
    merged: list[list[int]] = []
    for _, b1, b2, w1, w2 in ops:
        if merged and b1 - merged[-1][1] <= 2:  # 사이에 같은 줄이 2줄 이하면 한 덩어리로
            merged[-1][1], merged[-1][3] = b2, w2
        else:
            merged.append([b1, b2, w1, w2])
    return [tuple(m) for m in merged]  # type: ignore[misc]


def cmd_plan(key: str | None, out_path: str | None) -> None:
    reg = load_registry()
    keys = [key] if key else list(reg['pages'])
    plans = []
    problems = []

    for k in keys:
        e = reg['pages'][k]
        base_p, work_p = BASELINE_DIR / e['file'], NOTION_DIR / e['file']
        if not base_p.exists() or base_p.read_text(encoding='utf-8') == work_p.read_text(encoding='utf-8'):
            continue
        base_text = base_p.read_text(encoding='utf-8')
        base = base_text.splitlines(keepends=True)
        work = work_p.read_text(encoding='utf-8').splitlines(keepends=True)

        updates = []
        for b1, b2, w1, w2 in _hunks(base, work):
            ctx = 1
            while True:
                lo, hi = max(0, b1 - ctx), min(len(base), b2 + ctx)
                wlo, whi = max(0, w1 - ctx), min(len(work), w2 + ctx)
                old = ''.join(base[lo:hi]).rstrip('\n')
                new = ''.join(work[wlo:whi]).rstrip('\n')
                if old and base_text.count(old) == 1:
                    break
                ctx += 1
                if ctx > MAX_CONTEXT:
                    problems.append(
                        f'{k}: {b1 + 1}~{b2}행 구간의 old_str 을 유일하게 만들지 못했다. '
                        f'해당 문서는 replace_content 로 통째 교체하거나 수동 처리할 것'
                    )
                    old = new = None
                    break
            if old is None:
                continue
            if old == new:
                continue
            updates.append({'old_str': old, 'new_str': new})

        if len(updates) > MAX_UPDATES:
            problems.append(f'{k}: 변경 덩어리가 {len(updates)}개로 상한({MAX_UPDATES})을 넘는다. 나눠서 push 할 것')
        if updates:
            plans.append({
                'key': k,
                'title': e['title'],
                'page_id': e['page_id'],
                'command': 'update_content',
                'content_updates': updates,
            })

    payload = {'generated_from': 'docs/notion/.baseline', 'plans': plans, 'problems': problems}
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if out_path:
        Path(out_path).write_text(text, encoding='utf-8')
        print(f'plan → {out_path}')
    else:
        print(text)

    for p in problems:
        print(f'  !! {p}', file=sys.stderr)
    if not plans:
        print('변경 없음 — push 할 것이 없다', file=sys.stderr)
    else:
        total = sum(len(p['content_updates']) for p in plans)
        print(f'\n문서 {len(plans)}건 · 변경 덩어리 {total}개', file=sys.stderr)


# ── check ─────────────────────────────────────────────────────────────
def cmd_check(key: str, raw_file: str) -> None:
    """정본을 다시 받아 기준선과 비교한다. 다르면 누군가 노션을 직접 고친 것이다."""
    _, base = paths(key)
    fresh = extract_content(Path(raw_file).read_text(encoding='utf-8'))
    current = base.read_text(encoding='utf-8')
    if fresh == current:
        print(f'ok     {key} — 정본이 기준선과 같다. push 해도 안전하다')
        return
    print(f'DRIFT  {key} — 정본이 기준선과 다르다. 누군가 노션을 직접 고쳤다.', file=sys.stderr)
    d = difflib.unified_diff(
        current.splitlines(keepends=True), fresh.splitlines(keepends=True),
        fromfile='baseline', tofile='notion(정본)', n=2,
    )
    sys.stdout.writelines(d)
    raise SystemExit(2)


# ── accept ────────────────────────────────────────────────────────────
def cmd_accept(key: str | None) -> None:
    reg = load_registry()
    keys = [key] if key else list(reg['pages'])
    n = 0
    for k in keys:
        e = reg['pages'][k]
        work, base = NOTION_DIR / e['file'], BASELINE_DIR / e['file']
        if work.exists() and (not base.exists() or base.read_text(encoding='utf-8') != work.read_text(encoding='utf-8')):
            base.parent.mkdir(parents=True, exist_ok=True)
            base.write_text(work.read_text(encoding='utf-8'), encoding='utf-8')
            print(f'accept {k}')
            n += 1
    print(f'기준선 {n}건 갱신' if n else '갱신할 것 없음')


USAGE = re.sub(r'^\s+', '', __doc__ or '', flags=re.M)


def main() -> None:
    if len(sys.argv) < 2:
        print(USAGE)
        raise SystemExit(1)
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == 'save' and len(args) == 2:
        cmd_save(*args)
    elif cmd == 'status':
        cmd_status(args[0] if args else None)
    elif cmd == 'diff' and len(args) == 1:
        cmd_diff(args[0])
    elif cmd == 'plan':
        key = next((a for a in args if not a.startswith('-')), None)
        out = next((a.split('=', 1)[1] for a in args if a.startswith('--out=')), None)
        cmd_plan(key, out)
    elif cmd == 'check' and len(args) == 2:
        cmd_check(*args)
    elif cmd == 'accept':
        cmd_accept(args[0] if args else None)
    else:
        print(USAGE)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
