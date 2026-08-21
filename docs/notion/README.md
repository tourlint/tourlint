# 노션 문서 로컬 사본 (docs/notion)

노션 정본을 매번 MCP 로 직접 고치면 작업이 끊긴다. 여기서 몰아서 작업하고 마지막에 한 번에 정본과 맞춘다.

```
docs/notion/
├─ _pages.json        페이지 레지스트리 (키 · page_id · 파일명)
├─ .baseline/*.md     pull 시점 원본 — 사람이 손대지 않는다
└─ *.md               작업본 — 편집은 여기서만
```

`.baseline` 은 "노션이 지금 이렇게 생겼다"는 기록이고, 작업본과의 차이가 곧 push 할 변경분이다.

## 왜 안전한가

push 는 `notion-update-page` 의 `update_content` 로 나가고, `old_str` 이 정본과 한 글자라도
다르면 **호출이 실패할 뿐 정본이 망가지지 않는다.** 사본에 오차가 있어도 손대지 않은 영역은
무해하고, 손댄 영역은 실패로 즉시 드러난다. 통째 교체(`replace_content`)는 쓰지 않는다 —
통합 요구사항 명세서(`req`)처럼 자식 페이지를 품은 문서가 날아갈 수 있다.

## 절차

### 1. pull — 정본을 받아온다

Claude 가 `notion-fetch` 로 페이지를 읽고, 그 결과 파일을 넘긴다.

```bash
python3 scripts/notion_sync.py save <key> <fetch결과파일>
```

작업본에 push 하지 않은 수정이 남아 있으면 거부한다(덮어쓰면 그 수정이 사라지므로).

### 2. 편집 — 작업본만 고친다

`docs/notion/*.md` 를 평소처럼 편집한다. `.baseline/` 은 절대 건드리지 않는다.

개정할 때 이 프로젝트의 관례를 지킨다.
- 문서 상단 표의 **버전을 올린다**
- 맨 아래 **개정 이력 callout 에 항목을 추가**한다 (무엇을·왜·연쇄 개정 문서)
- 같은 수치를 인용하는 **다른 문서도 함께 고친다** — 안 고치면 문서 간 모순이 남는다

### 3. status / diff — 무엇이 달라졌는지 본다

```bash
python3 scripts/notion_sync.py status        # 전체 요약
python3 scripts/notion_sync.py diff fr       # 문서 하나를 unified diff 로
```

### 4. check — 그 사이 정본이 바뀌지 않았는지 확인한다

push 전에 반드시 한다. 누군가 노션을 직접 고쳤다면 여기서 걸린다.

```bash
python3 scripts/notion_sync.py check <key> <새로받은fetch결과파일>
```

`DRIFT` 가 나오면 push 하지 말고, 정본 변경분을 작업본에 먼저 반영한다.

### 5. plan → push

```bash
python3 scripts/notion_sync.py plan --out=/tmp/notion-plan.json
```

`content_updates` 쌍이 담긴 JSON 이 나온다. Claude 가 이걸 `notion-update-page` 로 실행한다.
`old_str` 은 문서 안에서 유일해질 때까지 문맥을 자동으로 넓혀 만든다.

`problems` 에 항목이 있으면 그 문서는 수동 처리한다 (유일한 `old_str` 을 못 만들었거나
변경 덩어리가 100개 상한을 넘은 경우).

### 6. accept — 기준선을 맞춘다

push 가 **성공한 뒤에만** 실행한다. 실패한 채로 accept 하면 기준선이 정본과 어긋나 다음 push 가 전부 깨진다.

```bash
python3 scripts/notion_sync.py accept <key>
```

## 수집 상태 (2026-08-21)

**13종 전부 수집 완료.** `status` 가 전 문서 `=` 이며 정본과 일치한다.

큰 문서는 MCP fetch 결과가 파일로 남아 그대로 추출했고, 작은 문서(파일로 남지 않는 것)는
**Claude Code 세션 트랜스크립트**(`~/.claude/projects/<project>/<session>.jsonl`)에서
원본 JSON 을 꺼내 넣었다. 어느 쪽도 사람이나 모델이 옮겨적지 않았으므로 바이트가 보존된다.

`api` 는 v1.4 스냅샷에 2026-08-21 개정 3건을 재적용해 복원한 것이었는데, 재연결 후
`check api` 로 **정본과 바이트 단위 일치**를 확인했다. 겸해서 노션이 저장 시 마크다운을
다시 정규화하지 않는다는 것도 확인됐다 — 왕복이 성립한다.

## 왕복 검증 기록 (2026-08-21)

DR-TD-001 · v1.6 개정문에 들어간 오타(`컴럼` → `컬럼`) 2건을 이 절차로 고쳤다.

```
편집 → status(+2 -2) → diff → plan(hunk 2개) → push(update_content) → accept → check → ok
```

`plan` 은 `old_str` 이 문서 안에서 유일해질 때까지 문맥을 자동으로 넓혀 정확히 그 두 곳만
집어냈다. 참고로 `12_용어정의.md` 에도 `컴럼` 이 있으나 그것은 **과거 오타를 정정했다는 기록**
이므로 건드리지 않았다 — 전역 치환을 하지 않고 문서별로 판단해야 하는 이유다.

## 알려진 제약

- `save` · `check` 는 Claude 가 MCP 로 받아온 fetch 결과 파일이 있어야 한다. 스크립트가
  직접 노션을 호출하지는 못한다 (인증이 MCP 쪽에 있다).
- MCP 연결이 **다른 워크스페이스로 바뀌면** 정본 접근이 끊긴다. 실제로 2026-08-21 작업 중
  "졸프" 워크스페이스로 전환돼 접근이 끊긴 적이 있다. **노션 작업 전에 `notion-fetch self` 로
  워크스페이스 이름이 "관광데이터 활용 공모전" 인지 먼저 확인할 것.**
- fetch 결과가 파일로 남지 않는 작은 문서는 세션 트랜스크립트(`*.jsonl`)에서 꺼낼 수 있다.
  `<content>` 와 `"title"` 을 함께 포함한 문자열을 찾아 JSON 으로 파싱하면 봉투가 그대로 나온다.
  **같은 문서가 여러 번 있으면 마지막 것이 최신**이다.
- 파일 내용은 노션 고유 마크다운(`<table>` · `<callout>` · `<td>`)이다. 일반 마크다운으로
  바꾸면 정본과 왕복이 안 된다. **형식을 손대지 말 것.**
