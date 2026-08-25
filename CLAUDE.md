# AI 도구 지침

코드 작업 전에 읽는다. 이슈·PR·커밋 규칙 전문은 [`.github/ISSUE_PR_PLAYBOOK.md`](.github/ISSUE_PR_PLAYBOOK.md),
이 저장소에 맞춰 적용한 것은 [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md).

## 절대 하지 않는 것

**커밋 트레일러를 넣지 않는다.**

```
Co-Authored-By: Claude <noreply@anthropic.com>
Generated with [Claude Code](https://claude.com/claude-code)
```

기본값으로 붙는 것들이라 지시하지 않으면 계속 붙는다. PR 본문에서 지워도 소용없다 —
트레일러는 커밋 메시지에 있다. `main` 은 Railway 가 배포 중이라 한 번 박히면 되돌리는
비용이 더 크다.

이모지도 쓰지 않는다. 커밋 · 이슈 · PR 어디에도.

## 코드에 들어가면 안 되는 것

- 인증키, DB 비밀번호 (NF-SC-007 · 008)
- 공사 원문을 DB 나 로그에 남기는 코드. 응답 본문 로깅은 개발 중에도 금지 (DB 명세서 6-4)
- 테스트 계정 자격 증명 하드코딩 — 시드로 만든다 (PM-TA-008)
- 이용자 GPS 요청 코드. 권한 요청 코드조차 있으면 안 된다 (PM-NG-013)
- 공사 API 를 전면 대체한 목업. 실엔진으로 교체한 라우트는 `src/mock` 에서 즉시 지운다
  (NF-CO-002 · FR-OP-009)

## 검수 엔진 4대 설계 원칙

1. 표시는 실시간, 저장은 판정 근거만
2. AI 는 정규화까지. 판정은 규칙엔진이 한다
3. 모르는 건 모른다고 한다. 정보가 없다는 이유로 정상 판정을 하지 않는다 (FR-RU-051)
4. 예측하지 않고 관측한다

규칙 평가는 순수 함수이며 메모리 전용이다 (NF-PF-014). `engine/rules` 는 `external` 과
`persistence` 를 import 할 수 없고 eslint 가 막는다. 같은 상품을 세 번 검수하면
`message` 까지 같아야 한다 (NF-MT-001).

## 글쓰기

**본문 길이는 변경 크기에 비례한다.** 모든 문서가 같은 길이인 게 기계가 쓴 것처럼 보이는
1순위 원인이다. 격언조로 문단을 닫지 않는다 — 사실만 적으면 교훈은 읽는 사람이 얻는다.

```
X  통과만 하는 테스트는 가드가 아니다.
O  고친 코드를 되돌려 넣어서 실제로 걸리는지 확인했다.
```

길이 기준과 나머지 규칙은 [`.github/ISSUE_PR_PLAYBOOK.md`](.github/ISSUE_PR_PLAYBOOK.md) §2 ~ §4.

## 검증

네 단계 전부 돌린다. `nest build` 는 타입을 안 보므로 typecheck 를 빼면 없는 함수를
부르는 코드도 통과한다.

```bash
pnpm build && pnpm lint && pnpm typecheck && pnpm test
```

DB 테스트는 `TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/tourlint_test`.
공사 실호출은 평소에 하지 않는다 — 일일 예산 800건을 시연 몫으로 남긴다.
평소 검증은 `KTO_MODE=fixture` 리플레이.

**새로 넣은 가드는 고치기 전으로 되돌려 실제로 실패하는지 본다.** 통과하는데 아무것도
안 지키는 검사가 실제로 여러 번 나왔다.
