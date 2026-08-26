# TourLint

관광상품 출시 검수 · 수요 적합성 · 데이터 신선도 관리 플랫폼
2026 관광데이터 활용 공모전 (웹·앱 구현 부문, 지정과제 7번)

## 배포

| | |
|---|---|
| API | https://api-production-1e7c2.up.railway.app |
| **API 문서** | https://api-production-1e7c2.up.railway.app/docs |
| 상태 확인 | https://api-production-1e7c2.up.railway.app/health |

`/docs` 에서 라우트 목록을 브라우저로 본다. **`실엔진` 태그가 붙은 것만 실제로 판정 · 저장이
돈다.** `mock` 태그는 API 명세의 응답 예시를 그대로 돌려주는 임시 라우트이며 실엔진으로
교체되는 즉시 제거된다 (NF-CO-002 · FR-OP-009). 전체 계약은
[`docs/notion/21_API백엔드설계.md`](docs/notion/21_API백엔드설계.md).

루트(`/`)는 서비스명과 위 주소들을 돌려준다. 예전에는 404 였는데, API 서버에 루트 라우트가
없는 건 정상이지만 브라우저로 열어 본 사람 눈에는 오류 화면이라 안내를 넣었다.

`/health` 가 배포 상태를 그대로 보여준다. `ready: true` 면 DB · 스키마 · 인증키가 다 맞은 것이다.

```json
{"status":"ok","ready":false,"db":"up","mode":"live",
 "checks":{"database":"up","schema":"ok","tableCount":19,"expectedTableCount":19,
           "ktoServiceKey":"ok","kakaoRestApiKey":"ok","kmaServiceKey":"missing","llmApiKey":"ok"}}
```

2026.08.26 실제 응답이다. `kmaServiceKey` 가 `missing` 이라 `ready` 가 `false` 인
상태이고, Railway 에 환경변수를 넣으면 `true` 로 돌아온다 (이슈 #101).

`mode` 가 `fixture` 면 공사 호출을 픽스처로 대체하고 있다는 뜻이다. 운영에서는 `live` 여야 한다.

## 구조

```
apps/api      NestJS. 검수 엔진과 API
apps/web      Next.js
packages/shared  두 쪽이 같이 쓰는 상수와 타입
db            schema.sql 이 정본. db/README.md 참고
docs          기대값표(회귀 기준선) · 파싱규칙 · notion/ 은 정본 사본
fixtures      실호출 스냅샷과 회귀 정답셋
```

## 개발

```bash
pnpm install
pnpm verify        # build, lint, typecheck, test
```

공사 API 는 평소에 부르지 않는다. 일일 예산 800건을 시연 몫으로 남겨야 해서 픽스처 리플레이로 개발한다.

```bash
KTO_MODE=fixture pnpm --filter @tourlint/api test
```

저장소 테스트는 실제 Postgres 를 쓴다. 없으면 건너뛴다. 띄우는 방법은 `db/README.md`.

실호출은 게이트에서만 한 번 돈다.

```bash
LIVE_KTO=1 TEST_DATABASE_URL=... pnpm --filter @tourlint/api exec vitest run test/live-kto.smoke.spec.ts
```

## 저장소 읽는 법

**라벨은 두 축이다.** 유형(`feat` `fix` `chore` `docs` `refactor` `test`) 하나와
영역 하나를 붙인다. 영역 라벨은 노션 명세 문서에서 그대로 가져왔다.

| 라벨 | 문서 |
|---|---|
| `FR 기능` | 13_기능요구사항 (FR-*) |
| `DR 데이터` | 16_데이터요구사항 (DR-*) |
| `NF 비기능` | 17_비기능요구사항 (NF-*) |
| `EI 연동` | 18_외부연동요구사항 (EI-*) |
| `EX 예외` | 19_예외처리요구사항 (EX-*) |
| `DB` | 20_DB명세서 |
| `API` | 21_API백엔드설계 |

라벨과 문서가 1:1이라 라벨로 거르면 그 문서에 관한 작업만 남는다. 특수 라벨은
`spec-mismatch` 하나이고 근거는 `SC-CM-001`(코드보다 문서가 먼저다)이다.

**제목** — 이슈는 `[FEAT]` · `[FIX]` · `[CHORE]` 로 시작하고 명세 ID 를 괄호에 넣는다.
PR 은 Conventional Commits (`feat(engine): R05 데이터 검증 불가 (FR-RU-051)`).

**계획의 정본은 GitHub 이슈와 마일스톤이다.** 주차별 목표는 마일스톤(`W1`~`W5`),
할 일은 이슈에 있다. `docs/` 는 명세 사본이지 계획서가 아니다.

**머지** — 작업 브랜치 → `dev` → `main`. `main` 은 Railway 가 자동 배포한다.
CI 통과가 머지 조건이다.

**어느 문서를 언제 보나**

| 문서 | 무엇이 있나 |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | 코드 작업 전에 읽는다. 절대 하지 않는 것과 검증 절차 |
| [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) | 이 저장소 고유 — 브랜치, 라벨 값, 검증 명령, 배포 |
| [`.github/ISSUE_PR_PLAYBOOK.md`](.github/ISSUE_PR_PLAYBOOK.md) | 일반 규칙과 그 근거. 프로젝트 무관이라 다른 저장소에 그대로 복사한다 |

규칙이 왜 그런지는 규칙집, 이 저장소에서 어떻게 적용하는지는 CONTRIBUTING 이다.
한 내용을 두 곳에 적지 않는다.
