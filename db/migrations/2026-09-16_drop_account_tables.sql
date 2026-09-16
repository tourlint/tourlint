-- 계정별 기준표 3종 · 가중치 · R04 임계 삭제, R07 CHECK 조이기 — 릴리즈 2 (DR-CF-008 · FR-OP-021)
--
-- ⚠️ **이 파일은 코드 배포 뒤에 돌린다.** 더하기만 하던 릴리즈 1 과 반대다 —
--    지우는 표를 읽는 코드(`settings-tables` 라우트 4개)가 운영에 떠 있는 동안 지우면 그
--    라우트가 500 이다. 릴리즈 2 를 배포해 그 코드가 사라진 것을 확인한 뒤 돌린다.
--
-- ⚠️ **되돌릴 수 없다.** 표와 컬럼이 사라지면 그 이전 배포본(`user-setting.repository` 가
--    `weights` · `r04_threshold` 를 SELECT 하던 버전)으로 되돌릴 수 없다. 릴리즈 2 가
--    정상인 것을 보고 돌린다.
--
-- 여러 번 돌려도 된다. IF EXISTS 와 제약 재생성뿐이다.

-- 계정별 기준표 3종. 표준은 @tourlint/shared 시드에 있고 엔진 · 화면이 그것을 읽는다
DROP TABLE IF EXISTS target_profile;
DROP TABLE IF EXISTS dwell_default;
DROP TABLE IF EXISTS indoor_outdoor_map;

-- 가중치 · R04 임계는 모든 계정이 같은 표준이다 (FR-OP-021 · PM-NG-003)
ALTER TABLE user_setting DROP COLUMN IF EXISTS weights;
ALTER TABLE user_setting DROP COLUMN IF EXISTS r04_threshold;
ALTER TABLE user_setting DROP CONSTRAINT IF EXISTS ck_set_r04;

-- 구 설정 API 로 들어간 느슨한 값을 표준 안으로 되돌린 뒤에 조인다. 순서를 바꾸면 CHECK 가
-- 기존 행에서 걸려 마이그레이션 전체가 롤백된다 (DR-CF-008)
UPDATE user_setting SET r07_span_hours   = 6  WHERE r07_span_hours   > 6;
UPDATE user_setting SET r07_meal_minutes = 60 WHERE r07_meal_minutes < 60;

ALTER TABLE user_setting DROP CONSTRAINT IF EXISTS ck_set_span;
ALTER TABLE user_setting ADD  CONSTRAINT ck_set_span CHECK (r07_span_hours BETWEEN 1 AND 6);
ALTER TABLE user_setting DROP CONSTRAINT IF EXISTS ck_set_meal;
ALTER TABLE user_setting ADD  CONSTRAINT ck_set_meal CHECK (r07_meal_minutes BETWEEN 60 AND 240);
