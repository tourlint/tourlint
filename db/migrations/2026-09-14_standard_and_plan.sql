-- 검수 기준 탭 · 기획 · 검수 · 레이더 개편 — 릴리즈 1 (DB 명세서 v2.3 · 마이그레이션 목록)
--
-- **더하기만 한다.** 구 코드가 이 DB 에서 그대로 돌아야 한다.
--   - 표 3종(target_profile · dwell_default · indoor_outdoor_map)과 user_setting.weights ·
--     r04_threshold 는 남긴다. 릴리즈 2 에서 지운다.
--   - R07 CHECK(ck_set_span · ck_set_meal)는 조이지 않는다. 구 설정 API 가 1–24시간 ·
--     1–240분을 받는 동안 1–6 · 60–240 으로 조이면 그 저장이 실패한다. 릴리즈 2 에서 기존 행을
--     표준 안으로 되돌린 뒤 조인다 (DR-CF-008).
--
-- 여러 번 돌려도 된다. 제약은 지우고 다시 만든다.

-- 상품: 기획 중 단계 · 기획 출처 (FR-PL-001 · 020 · DR-IN-014)
ALTER TABLE product ADD COLUMN IF NOT EXISTS planned_at  TIMESTAMPTZ;
ALTER TABLE product ADD COLUMN IF NOT EXISTS plan_origin JSONB;
COMMENT ON COLUMN product.planned_at  IS '검수 시작을 누른 시각. NULL = 기획 중 - DR-IN-014';
COMMENT ON COLUMN product.plan_origin IS '기획 출처. 시작 방식 · 신호 종류 · 지역 코드 · 기간 · contentid 만. 원문 없음 - DR-PR-009';

-- 검수를 한 번이라도 돌린 상품은 이미 넘어간 것으로 본다. 안 하면 기존 상품이 전부 "기획 중"에 놓인다
UPDATE product p SET planned_at = p.created_at
 WHERE p.planned_at IS NULL
   AND EXISTS (SELECT 1 FROM audit_run r WHERE r.product_id = p.id);

-- 표준 키가 아닌 타깃 · 콘셉트는 비운다. 어차피 R10 이 확인 불가로 빠지던 값이다 (DR-IN-015)
UPDATE product SET target_key = NULL
 WHERE target_key IS NOT NULL
   AND target_key NOT IN ('YOUTH_20S','ADULT_3040','COUPLE','FAMILY_KIDS','SENIOR','GROUP','SOLO');
UPDATE product SET concept_key = NULL
 WHERE concept_key IS NOT NULL
   AND concept_key NOT IN ('EMOTIONAL','HEALING','GOURMET','ACTIVITY','HERITAGE','SCENERY','CRAFT','FESTIVAL','SHOPPING');

-- 일정 항목: 고른 방식 · 들어온 경로 · 걷기 길 식별자 (D1 · D8 · D9)
ALTER TABLE itinerary_item ADD COLUMN IF NOT EXISTS matched_by TEXT;
ALTER TABLE itinerary_item ADD COLUMN IF NOT EXISTS origin     TEXT;
ALTER TABLE itinerary_item ADD COLUMN IF NOT EXISTS walk_id    TEXT;
COMMENT ON COLUMN itinerary_item.walk_id IS '두루누비 걷기 길 식별자. 코스 이름은 저장하지 않음 - DR-MD-005';

ALTER TABLE itinerary_item DROP CONSTRAINT IF EXISTS ck_item_matched_by;
ALTER TABLE itinerary_item ADD  CONSTRAINT ck_item_matched_by
    CHECK (matched_by IS NULL OR matched_by IN ('AUTO','USER','AGENT'));
ALTER TABLE itinerary_item DROP CONSTRAINT IF EXISTS ck_item_origin;
ALTER TABLE itinerary_item ADD  CONSTRAINT ck_item_origin
    CHECK (origin IS NULL OR origin IN ('MANUAL','UPLOAD','TEXT','PICKER','SIGNAL','PATCH'));
ALTER TABLE itinerary_item DROP CONSTRAINT IF EXISTS ck_item_walk;
ALTER TABLE itinerary_item ADD  CONSTRAINT ck_item_walk
    CHECK (walk_id IS NULL OR match_status = 'EXCLUDED');

-- 장소명이 비어도 되는 것은 CONFIRMED 와 걷기 길뿐 (DR-IN-013). 기존 행은 전부 NOT NULL 이라 통과한다
ALTER TABLE itinerary_item ALTER COLUMN place_label DROP NOT NULL;
ALTER TABLE itinerary_item DROP CONSTRAINT IF EXISTS ck_item_label_required;
ALTER TABLE itinerary_item ADD  CONSTRAINT ck_item_label_required
    CHECK (match_status = 'CONFIRMED' OR place_label IS NOT NULL OR walk_id IS NOT NULL);

-- 검수 실행: 표준 버전 · 회사 기준 스냅샷 (DR-CF-009)
ALTER TABLE audit_run ADD COLUMN IF NOT EXISTS setting_snapshot JSONB;
COMMENT ON COLUMN audit_run.setting_snapshot IS '{standardVersion, r07SpanHours, r07MealMinutes}. 소급 변경 금지 - DR-CF-009';

-- 수요 신호: 키워드 일치 · T3 지난해 같은 달 방문자 수 (FR-RU-112 · FR-MO-059)
ALTER TABLE demand_signal ADD COLUMN IF NOT EXISTS by_keyword JSONB NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN demand_signal.by_keyword IS '키워드 → contentid 배열. 제목 미포함 - DR-PR-009';
COMMENT ON TABLE  demand_signal IS
    'T1 신규 콘텐츠 · T2 행사 밀도 · T3 지난해 같은 달 방문자 수. 배치 산출값이며 강도 점수를 담지 않는다 - FR-RU-121';
ALTER TABLE demand_signal DROP CONSTRAINT IF EXISTS ck_signal_type;
ALTER TABLE demand_signal ADD  CONSTRAINT ck_signal_type CHECK (signal_type IN ('T1','T2','T3'));

-- 외부 호출 로그: 공사 서비스는 활용신청 · 한도가 따로라 서비스마다 센다. 구 코드가 쓰는 'KTO' 는 그대로 유효하다
ALTER TABLE api_call_log DROP CONSTRAINT IF EXISTS ck_log_provider;
ALTER TABLE api_call_log ADD  CONSTRAINT ck_log_provider CHECK (provider IN
    ('KTO','KTO_WITH','KTO_PET','KTO_RELATED','KTO_DURUNUBI','KTO_VISITOR','KAKAO_MOBILITY','KMA','LLM'));

-- 계정 설정: 관심 지역 · 회사 기준 변경 이력 (FR-MO-059 · FR-OP-026)
ALTER TABLE user_setting ADD COLUMN IF NOT EXISTS watch_regions JSONB       NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE user_setting ADD COLUMN IF NOT EXISTS r07_history   JSONB       NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE user_setting ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT now();
