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

| 키 | 문서 | 상태 |
|---|---|---|
| `plan` | 서비스 기획서 | ✅ |
| `fr` | 기능 요구사항 | ✅ |
| `db` | DB 명세서 | ✅ |
| `api` | API · 백엔드 설계 | ⚠️ **재검증 필요** |
| `req` `scope` `terms` `ui` `pm` `dr` `nf` `ei` `ex` | 나머지 9종 | ⬜ 미수집 |

**`api` 주의** — 로컬 사본은 v1.4 스냅샷에 2026-08-21 개정 3건을 재적용해 복원한 것이다.
노션이 저장하면서 마크다운을 다르게 정규화했을 수 있으므로, 재연결 후 **`check api` 를 먼저 돌리고**
`DRIFT` 가 없을 때만 신뢰한다.

**미수집 9종** — MCP fetch 결과는 크기가 클 때만 파일로 남는다. 이 9종은 작아서 파일로
떨어지지 않아 사본을 만들 수 없었다. 억지로 옮겨적으면 사양서에 미세한 오차가 섞이고,
그 오차를 읽고 결정을 내리는 쪽이 더 위험하다. **각 문서를 실제로 고치기 직전에 `save` 로
채운다**(pull-on-demand). 어차피 기준선은 최신이어야 의미가 있어서, 미리 받아둬도 나중에
다시 받아야 한다.

## 알려진 제약

- `save` · `check` 는 Claude 가 MCP 로 받아온 fetch 결과 파일이 있어야 한다. 스크립트가
  직접 노션을 호출하지는 못한다 (인증이 MCP 쪽에 있다).
- MCP 연결이 **다른 워크스페이스로 바뀌면** 정본 접근이 끊긴다. 실제로 2026-08-21 작업 중
  "졸프" 워크스페이스로 전환돼 접근이 끊긴 적이 있다. `notion-fetch self` 로 현재 연결된
  워크스페이스를 확인할 수 있다.
- 파일 내용은 노션 고유 마크다운(`<table>` · `<callout>` · `<td>`)이다. 일반 마크다운으로
  바꾸면 정본과 왕복이 안 된다. **형식을 손대지 말 것.**
