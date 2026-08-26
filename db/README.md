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

### 기준 데이터 시드

스키마만 넣으면 `climate_normal` 이 비어 있고, R09 우천 리스크가 D+11 이상을 전부 확인
불가로 판정한다 (EI-WX-004 · 이슈 #7). 원본과 절차는 `fixtures/climate/README.md`.

```bash
DATABASE_URL=postgres://postgres:test@localhost:55432/tourlint_test \
  node scripts/seed_climate_normal.mjs "fixtures/climate/STCS_강수일수_MNH_강릉_1991-2020.csv"
```

**운영 DB 도 같은 명령으로 넣는다.** `DATABASE_URL` 만 Railway 것으로 바꾼다. 같은
`(시도, 월)` 을 다시 넣으면 덮어쓰므로 여러 번 돌려도 된다.

Railway 는 접속 URL 이 둘이다. **바깥에서 붙을 때는 공개 URL** 이어야 한다 —
`*.railway.internal` 은 Railway 컨테이너 안에서만 풀린다.

### 계정 기본 데이터

회원가입 트랜잭션이 `user_setting` 1행 · 기대 프로파일 63행 · 실내외 59행 · 체류시간 47행을
함께 만든다 (DR-CF-002). **그 코드가 붙기 전에 만들어진 계정에는 없다** — 데모 계정이 그렇다.

없으면 R10 이 타깃 · 콘셉트를 적은 상품을 전부 확인 불가로 판정하고, R09 와 체류시간
보완이 계정 설정 대신 상수로 돌아간다(설정 화면에서 고쳐도 안 바뀐다).

```bash
DATABASE_URL=... node scripts/seed_account_defaults.mjs --check     # 계정별 부족분
DATABASE_URL=... node scripts/seed_account_defaults.mjs             # 전 계정 채우기
DATABASE_URL=... node scripts/seed_account_defaults.mjs --account 3 # 하나만
```

이미 있는 행은 건드리지 않는다 — 설정 화면에서 고친 값을 시드가 덮으면 안 된다.

### 평년값 확인

넣고 나서 확인한다.

```bash
DATABASE_URL=... node scripts/seed_climate_normal.mjs --check
```

```
시도 2개 · 총 24행
  시도 42  1991-2020  평균비율 0.310  출처: 기상청 기상자료개방포털 · 대표지점 강릉
  시도 51  1991-2020  평균비율 0.310  출처: 기상청 기상자료개방포털 · 대표지점 강릉
빠진 시도 18개는 R09 가 확인 불가로 남긴다.
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
