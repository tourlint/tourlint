#!/usr/bin/env python3
"""노션 정본 ↔ docs/notion 사본 글자 단위 대조.

왜 필요한가
-----------
`notion_sync.py` 의 push 는 `old_str` 이 정본과 다를 때만 거부한다. **`new_str`
오타는 막는 장치가 없다.** 보내기가 성공해도 한글 음절이 한 칸 틀어져 들어갈 수
있고, 틀린 글자도 대부분 실제 음절이라 눈으로 훑어서는 못 찾는다 — 2026-09-14 에
네 건, 09-16 에 열아홉 건이 그렇게 들어갔다.

어떻게 하나
-----------
`notion-fetch` 결과 원문이 세션 전사(`~/.claude/projects/<프로젝트>/*.jsonl`)에
그대로 남는다. 거기서 `<content>` 를 꺼내 사본과 difflib 로 붙인다. 사람이 읽고
판단하는 단계가 없어야 오타가 샐 구멍이 없다.

    python3 scripts/notion_verify.py            # 전사에 fetch 가 있는 문서 전부
    python3 scripts/notion_verify.py ex nf      # 지정한 문서만

문서마다 **가장 최근 fetch** 를 쓴다. 고친 뒤에는 다시 fetch 한 다음 돌린다.

표기 차이
---------
노션이 돌려주는 본문은 사본과 표기가 몇 군데 다르다. 내용이 아니라 노션의 표기
방식이므로 비교 전에 되돌린다 — `~` 이스케이프, 맨 도메인의 자동 링크, 댓글 달린 구간을
감싸는 `<span discussion-urls=...>`. 콜아웃 안의
표를 HTML `<table>` 로 돌려주는 것은 되돌리지 않고 그대로 차이로 보인다(되돌리면
진짜 차이까지 가려진다).
"""
from __future__ import annotations

import datetime as dt
import difflib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTION_DIR = ROOT / 'docs' / 'notion'
REGISTRY = NOTION_DIR / '_pages.json'
TRANSCRIPTS = Path.home() / '.claude' / 'projects' / f'-{str(ROOT).lstrip("/").replace("/", "-")}'

# 노션 표기 → 사본 표기
UNESCAPE = [('\\~', '~')]
AUTOLINK = re.compile(r'\[([\w.-]+\.\w+)\]\(https?://\1\)')
COMMENT = re.compile(r'<span discussion-urls="[^"]*">(.*?)</span>', re.S)
ENVELOPE = re.compile(r'^\{"metadata".*?"url":"https://app\.notion\.com/p/([0-9a-f]+)')


def registry() -> dict:
    return json.loads(REGISTRY.read_text(encoding='utf-8'))['pages']


def _strings(x):
    if isinstance(x, dict):
        for v in x.values():
            yield from _strings(v)
    elif isinstance(x, list):
        for v in x:
            yield from _strings(v)
    elif isinstance(x, str):
        yield x


def _body(envelope: str) -> str | None:
    """fetch 봉투(JSON 문자열)에서 <content> 본문을 꺼낸다."""
    try:
        text = json.loads(envelope)['text']
    except (json.JSONDecodeError, KeyError, TypeError):
        return None
    start, end = text.find('<content>'), text.rfind('</content>')
    if start == -1 or end == -1:
        return None
    return text[start + len('<content>'):end].strip('\n') + '\n'


def _candidates(path: Path):
    """파일 하나에서 fetch 봉투 후보 문자열을 뽑는다."""
    text = path.read_text(encoding='utf-8', errors='replace')
    if path.suffix == '.txt':          # 큰 fetch 는 파일 하나가 봉투 그 자체다
        yield text.strip()
        return
    for line in text.splitlines():
        if '<content>' not in line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        yield from (s for s in _strings(obj) if '<content>' in s)


def fetched(by_id: dict[str, str]) -> dict[str, tuple[str, Path]]:
    """page_id → (가장 최근 fetch 본문, 그 파일). 오래된 파일부터 읽어 덮어쓴다.

    **전사와 `tool-results/` 를 둘 다 읽는다.** 큰 fetch 결과는 전사에 들어가지 않고
    `tool-results/` 파일로 떨어진다. 전사만 읽으면 몇 달 전 응답을 최신으로 착각해
    「다른 조각」을 무더기로 뱉거나, 더 나쁘게는 고쳐 놓은 정본을 옛 본문과 맞춰 본다.
    """
    out: dict[str, tuple[str, Path]] = {}
    files = sorted([*TRANSCRIPTS.glob('*.jsonl'), *TRANSCRIPTS.glob('*/tool-results/*.txt')],
                   key=lambda p: p.stat().st_mtime)
    for f in files:
        for s in _candidates(f):
            # 봉투 맨 앞의 url 로 고른다 — 뒤쪽 ancestor-path 에 부모 주소가 있어
            # 단순 검색은 전부 허브 페이지로 잡힌다
            m = ENVELOPE.match(s)
            body = _body(s) if m else None
            if m and body and m.group(1) in by_id:
                out[by_id[m.group(1)]] = (body, f)
    return out


def normalize(s: str) -> str:
    for a, b in UNESCAPE:
        s = s.replace(a, b)
    s = COMMENT.sub(r'\1', s)
    return AUTOLINK.sub(r'\1', s)


def main(keys: list[str]) -> int:
    reg = registry()
    by_id = {e['page_id']: k for k, e in reg.items()}
    found = fetched(by_id)
    if not keys:
        keys = [k for k in reg if k in found]
        if not keys:
            print('전사에 fetch 결과가 없다. 먼저 notion-fetch 로 정본을 받을 것')
            return 1

    bad = 0
    for key in keys:
        if key not in found:
            print(f'{key:8} 전사에 fetch 결과가 없다')
            bad += 1
            continue
        body, src = found[key]
        when = dt.datetime.fromtimestamp(src.stat().st_mtime).strftime('%m-%d %H:%M')
        canon = normalize(body)
        work = normalize((NOTION_DIR / reg[key]['file']).read_text(encoding='utf-8'))
        ops = [o for o in difflib.SequenceMatcher(None, canon, work, autojunk=False)
               .get_opcodes() if o[0] != 'equal']
        if not ops:
            print(f'{key:8} 일치 ({len(canon):,}자 · fetch {when})')
            continue
        print(f'{key:8} 다른 조각 {len(ops)}개 (fetch {when} — 오래됐으면 다시 받을 것)')
        for _tag, i1, i2, j1, j2 in ops:
            a, b = canon[i1:i2], work[j1:j2]
            before = canon[max(0, i1 - 30):i1].replace('\n', '⏎')
            print(f'   …{before}｜ 정본 {a[:120]!r} → 사본 {b[:120]!r}')
        bad += 1
    return bad


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
