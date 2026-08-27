-- audit_run 에 총 이동시간·거리 추가 (DB 명세서 v1.6 · FR-PA-040 · FR-RU-084)
--
-- `schema.sql` 은 통째로 적용하는 정본이라 이미 만들어진 DB 에는 쓸 수 없다.
-- 운영 DB 에는 이 파일을 한 번 적용한다. 여러 번 돌려도 안전하다.
--
--   DATABASE_URL=... psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f db/migrations/2026-08-27_audit_run_travel_totals.sql
--
-- 기존 행은 NULL 이 된다 — 그 실행들은 이동 산출값을 남기지 않았고, 지금 와서
-- 채우려면 그때의 교통 상황을 다시 부를 수가 없다. 0 으로 채우면 「이동이 없었다」로
-- 읽혀 전후 비교가 거짓말을 한다.

ALTER TABLE audit_run ADD COLUMN IF NOT EXISTS travel_seconds INT;
ALTER TABLE audit_run ADD COLUMN IF NOT EXISTS travel_meters  INT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ck_run_travel'
    ) THEN
        ALTER TABLE audit_run ADD CONSTRAINT ck_run_travel
            CHECK ((travel_seconds IS NULL) = (travel_meters IS NULL));
    END IF;
END $$;
