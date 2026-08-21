# db

`schema.sql` 이 정본이다. 마이그레이션 도구를 두지 않고 **한 파일을 통째로 적용**한다.
개발 기간이 5주고 스키마가 이미 확정돼 있어(DB 명세서 18테이블) 도구를 들이는 비용이 이득보다 크다.

## 로컬 테스트 DB

저장소 테스트는 **실제 Postgres** 를 쓴다. DB 명세서가 판정 불변식을 제약과 트리거에 맡기고
있어서다 — 차단은 무시할 수 없고(`ck_finding_blocker_not_dismissed`), 부분 검수에는 점수가
없고(`ck_run_partial`), 실행당 콘텐츠별 1행이다(`uq_fp_run_content`).

```bash
docker run -d --name tourlint-test-pg \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=tourlint_test \
  -p 55432:5432 postgres:16-alpine

docker cp db/schema.sql tourlint-test-pg:/tmp/schema.sql
docker exec tourlint-test-pg psql -U postgres -d tourlint_test -v ON_ERROR_STOP=1 -f /tmp/schema.sql
```

그다음 테스트를 돌릴 때 접속 문자열을 준다.

```bash
TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/tourlint_test pnpm test
```

**`TEST_DATABASE_URL` 이 없으면 DB 테스트는 건너뛴다.** 로컬에서 Postgres 없이도 나머지
테스트를 돌리기 위해서다. CI 는 `REQUIRE_DB_TESTS=1` 을 줘서 건너뛰기를 막는다 —
조용히 건너뛰면 통과한 것처럼 보인다.

정리할 때는 `docker rm -f tourlint-test-pg`.

## 운영 DB

Railway 의 Postgres 에 같은 파일을 한 번 적용한다. `schema.sql` 은 `DROP` 을 하지 않으므로
이미 적용된 DB 에 다시 돌리면 `already exists` 로 멈춘다. 스키마를 고칠 때는 변경분만 손으로
적용하고 `schema.sql` 을 함께 갱신한다.

⚠️ **접속 문자열을 커밋하지 않는다** (PM-SC-001 · 003). `.env` 로만 다룬다.
