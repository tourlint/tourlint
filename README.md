# TourLint

관광상품 출시 검수 · 수요 적합성 · 데이터 신선도 관리 플랫폼
2026 관광데이터 활용 공모전 (웹·앱 구현 부문, 지정과제 7번)

## 배포

| | |
|---|---|
| API | https://api-production-1e7c2.up.railway.app |
| 상태 확인 | https://api-production-1e7c2.up.railway.app/health |

`/health` 가 배포 상태를 그대로 보여준다. `ready: true` 면 DB · 스키마 · 인증키가 다 맞은 것이다.

```json
{ "ready": true, "db": "up", "mode": "live",
  "checks": { "database": "up", "schema": "ok", "tableCount": 18, "ktoServiceKey": "ok" } }
```

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

## 작업 규칙

브랜치 흐름, 커밋 형식, PR·이슈 양식은 `.github/CONTRIBUTING.md`.
주차별 목표는 GitHub 마일스톤에서 본다.
