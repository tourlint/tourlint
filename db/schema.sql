-- =====================================================================
-- TourLint DB Schema  (DB 명세서 v1.4 · 2026.08.20 생성)
-- PostgreSQL 16
-- 원칙: 공사 원문을 담는 테이블·컬럼은 존재하지 않는다 (DR-PR-001)
-- 범위: 당일 ~ 2박 3일 (nights 0~2) · 최대 구간 12곳
--
-- 적용:  docker compose up -d
--        docker exec -i tourlint-db psql -U tourlint -d tourlint < db/schema.sql
-- =====================================================================

-- =====================================================================
-- TourLint DB Schema v1.0
-- PostgreSQL / 2026.08.15
-- 원칙: 공사 원문을 담는 테이블·컬럼은 존재하지 않는다 (DR-PR-001)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. account : 계정
-- ---------------------------------------------------------------------
CREATE TABLE account (
    id              BIGSERIAL PRIMARY KEY,
    email           TEXT        NOT NULL UNIQUE,
    password_hash   TEXT        NOT NULL,
    is_demo         BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE  account IS '계정. 수집 개인정보는 이메일 1종으로 한정 (PM-AC-009)';
COMMENT ON COLUMN account.is_demo IS '심사용 테스트 계정 여부 (PM-TA)';

-- ---------------------------------------------------------------------
-- 1-2. session : 로그인 세션
-- ---------------------------------------------------------------------
-- 쿠키에는 이 id(추측 불가 난수)만 담고 서버가 계정을 되찾는다. 무상태 서명 쿠키가
-- 아니라 DB 행으로 두는 이유는, 로그아웃·만료를 서버측에서 확실히 무효화해야 하기
-- 때문이다 — 쿠키만 지우면 탈취된 쿠키가 만료까지 살아 있다 (PM-AC-005).
-- 저장 방식(인메모리 vs DB)은 API 설계 13장 미결 항목이었고, 여기서 DB 로 확정한다.
CREATE TABLE session (
    id           TEXT        PRIMARY KEY,
    account_id   BIGINT      NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_session_account ON session(account_id);
COMMENT ON TABLE session IS '로그인 세션. 쿠키에는 불투명 id 만 담고, 로그아웃·만료 시 행을 지워 서버측에서 무효화한다 (PM-AC-002 · PM-AC-005)';

-- ---------------------------------------------------------------------
-- 2. product : 관광상품
-- ---------------------------------------------------------------------
CREATE TABLE product (
    id               BIGSERIAL PRIMARY KEY,
    account_id       BIGINT      NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    name             TEXT        NOT NULL,
    ldong_regn_cd    TEXT        NOT NULL,
    ldong_signgu_cd  TEXT,
    start_date       DATE        NOT NULL,
    nights           SMALLINT    NOT NULL DEFAULT 0,
    target_key       TEXT,
    concept_key      TEXT,
    head_count       INT,
    transport        TEXT        NOT NULL,
    released_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_product_nights    CHECK (nights BETWEEN 0 AND 2),
    CONSTRAINT ck_product_transport CHECK (transport IN ('CHARTER_BUS','CAR','PUBLIC_TRANSIT')),
    CONSTRAINT ck_product_headcount CHECK (head_count IS NULL OR head_count > 0)
);
COMMENT ON COLUMN product.ldong_regn_cd IS '법정동 시도 코드. 길이 가정 금지 (세종 36110) - DR-IN-010';
COMMENT ON COLUMN product.released_at   IS '출시 승인 시각. 차단 1건 이상이면 설정 불가 - DR-IN-007';

-- ---------------------------------------------------------------------
-- 3. itinerary_item : 일정 항목
-- ---------------------------------------------------------------------
CREATE TABLE itinerary_item (
    id               BIGSERIAL PRIMARY KEY,
    product_id       BIGINT      NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    day_no           SMALLINT    NOT NULL,
    seq              SMALLINT    NOT NULL,
    start_time       TIME        NOT NULL,
    end_time         TIME,
    end_time_source  TEXT        NOT NULL,
    place_label      TEXT        NOT NULL,
    item_type        TEXT        NOT NULL,
    kto_content_id   TEXT,
    content_type_id  SMALLINT,
    lcls_systm1      TEXT,
    lcls_systm2      TEXT,
    lcls_systm3      TEXT,
    mapx             NUMERIC(12,8),
    mapy             NUMERIC(12,8),
    match_status     TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_item_product_day_seq UNIQUE (product_id, day_no, seq),
    CONSTRAINT ck_item_day_no    CHECK (day_no >= 1),
    CONSTRAINT ck_item_end_src   CHECK (end_time_source IN ('INPUT','DWELL_DEFAULT','DWELL_FALLBACK')),
    CONSTRAINT ck_item_type      CHECK (item_type IN ('SIGHT','MEAL','LODGING','REST','MOVE','FREE')),
    CONSTRAINT ck_item_match     CHECK (match_status IN ('CONFIRMED','EXCLUDED','PENDING')),
    -- DR-IN-004 : CONFIRMED면 contentid 필수, EXCLUDED면 NULL
    CONSTRAINT ck_item_match_content CHECK (
        (match_status = 'CONFIRMED' AND kto_content_id IS NOT NULL)
     OR (match_status = 'EXCLUDED'  AND kto_content_id IS NULL)
     OR (match_status = 'PENDING')
    )
);
COMMENT ON COLUMN itinerary_item.place_label    IS '사용자가 입력한 장소명. 공사 원문이 아님 - DR-PR-001';
COMMENT ON COLUMN itinerary_item.kto_content_id IS '확정된 contentid. FK를 걸지 않음 - DR-IN-001';

-- ---------------------------------------------------------------------
-- 5. audit_run : 검수 실행 (불변) - audit_job보다 먼저 생성
-- ---------------------------------------------------------------------
CREATE TABLE audit_run (
    id               BIGSERIAL PRIMARY KEY,
    product_id       BIGINT      NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    executed_at      TIMESTAMPTZ NOT NULL,
    ruleset_version  TEXT        NOT NULL,
    readiness_score  SMALLINT,
    is_partial       BOOLEAN     NOT NULL DEFAULT FALSE,
    target_count     SMALLINT    NOT NULL,
    failed_count     SMALLINT    NOT NULL DEFAULT 0,
    blocker_cnt      SMALLINT    NOT NULL DEFAULT 0,
    error_cnt        SMALLINT    NOT NULL DEFAULT 0,
    warn_cnt         SMALLINT    NOT NULL DEFAULT 0,
    unverified_cnt   SMALLINT    NOT NULL DEFAULT 0,
    weight_snapshot  JSONB       NOT NULL,
    -- 상품 단위 총 이동시간·거리 (FR-RU-084 · F10 전후 비교의 입력).
    -- 외부 호출로만 얻는 값이라 나중에 다시 계산할 수 없어 실행 시점에 남긴다.
    -- NULL = 산출하지 않음 / 0 = 산출했으나 합이 0 (대중교통·조회 실패)
    travel_seconds   INT,
    travel_meters    INT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_run_travel  CHECK ((travel_seconds IS NULL) = (travel_meters IS NULL)),
    CONSTRAINT ck_run_score   CHECK (readiness_score IS NULL
                                     OR readiness_score BETWEEN 0 AND 100),
    -- DR-IN-005 : 부분 검수에는 점수를 부여하지 않는다
    CONSTRAINT ck_run_partial CHECK (is_partial = FALSE OR readiness_score IS NULL),
    CONSTRAINT ck_run_counts  CHECK (target_count >= 0 AND failed_count >= 0
                                     AND failed_count <= target_count)
);
COMMENT ON TABLE  audit_run IS '검수 실행. 불변 기록이며 수정 API를 제공하지 않는다 (PM-NG-004)';
COMMENT ON COLUMN audit_run.weight_snapshot IS '산출 시점 가중치. 설정 변경의 소급 적용 차단 - DR-CF-006';

-- ---------------------------------------------------------------------
-- 4. audit_job : 검수 작업 큐
-- ---------------------------------------------------------------------
CREATE TABLE audit_job (
    id               BIGSERIAL PRIMARY KEY,
    product_id       BIGINT      NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    status           TEXT        NOT NULL,
    trigger_type     TEXT        NOT NULL,
    progress_done    INT         NOT NULL DEFAULT 0,
    progress_total   INT         NOT NULL DEFAULT 0,
    audit_run_id     BIGINT      REFERENCES audit_run(id),
    error_code       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at      TIMESTAMPTZ,

    CONSTRAINT ck_job_status   CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED')),
    CONSTRAINT ck_job_trigger  CHECK (trigger_type IN ('INITIAL','MANUAL','PATCH','BATCH')),
    CONSTRAINT ck_job_progress CHECK (progress_done >= 0 AND progress_done <= progress_total)
);

-- ---------------------------------------------------------------------
-- 6. finding : 발견된 문제
-- ---------------------------------------------------------------------
CREATE TABLE finding (
    id                BIGSERIAL PRIMARY KEY,
    audit_run_id      BIGINT      NOT NULL REFERENCES audit_run(id) ON DELETE CASCADE,
    rule_code         TEXT        NOT NULL,
    rule_version      TEXT        NOT NULL,
    severity          TEXT        NOT NULL,
    reason_code       TEXT        NOT NULL,
    target_item_id    BIGINT      REFERENCES itinerary_item(id) ON DELETE SET NULL,
    target_item_id2   BIGINT      REFERENCES itinerary_item(id) ON DELETE SET NULL,
    message           TEXT        NOT NULL,
    evidence          JSONB       NOT NULL,
    requires_external BOOLEAN     NOT NULL DEFAULT FALSE,
    external_source   TEXT,
    patches           JSONB       NOT NULL DEFAULT '[]'::jsonb,
    dismissed_at      TIMESTAMPTZ,
    dismiss_reason    TEXT,
    confirmed_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_finding_rule     CHECK (rule_code IN
        ('R01','R02','R03','R04','R05','R06','R07','R08','R09','R10')),
    CONSTRAINT ck_finding_severity CHECK (severity IN
        ('BLOCKER','ERROR','WARNING','UNVERIFIED')),
    -- DR-IN-006 : 차단 등급은 무시할 수 없다 (PM-NG-001). DB 레벨 강제.
    CONSTRAINT ck_finding_blocker_not_dismissed
        CHECK (severity <> 'BLOCKER' OR dismissed_at IS NULL),
    -- FR-PA-002 : 수정안은 최대 3개
    CONSTRAINT ck_finding_patch_max CHECK (jsonb_array_length(patches) <= 3),
    CONSTRAINT ck_finding_external  CHECK (requires_external = FALSE
                                           OR external_source IS NOT NULL)
);
COMMENT ON COLUMN finding.reason_code IS
    '규칙 판정 사유코드 또는 예외 사유코드. 두 네임스페이스 공존 - EX-CM-002. 화면 미노출';
COMMENT ON COLUMN finding.evidence    IS '판정 입력값. 공사 원문 미포함 - DR-PR-001';
COMMENT ON COLUMN finding.confirmed_at IS
    '확인 필요 목록 체크 시각. 확인 결과 값 자체는 저장하지 않는다 - PM-NG-006';

-- ---------------------------------------------------------------------
-- 7. content_fingerprint : 검수 지문
-- ---------------------------------------------------------------------
CREATE TABLE content_fingerprint (
    id                BIGSERIAL PRIMARY KEY,
    audit_run_id      BIGINT      NOT NULL REFERENCES audit_run(id) ON DELETE CASCADE,
    kto_content_id    TEXT        NOT NULL,
    content_type_id   SMALLINT    NOT NULL,
    fetched_at        TIMESTAMPTZ NOT NULL,
    kto_modified_time TEXT        NOT NULL,
    show_flag         SMALLINT    NOT NULL,
    field_names       TEXT[]      NOT NULL,
    field_hash        TEXT        NOT NULL,
    normalized_json   JSONB,
    parse_confidence  TEXT        NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- DR-FP-007 : 검수 실행당 콘텐츠별 1행
    CONSTRAINT uq_fp_run_content UNIQUE (audit_run_id, kto_content_id),
    CONSTRAINT ck_fp_showflag   CHECK (show_flag IN (0,1)),
    CONSTRAINT ck_fp_hash       CHECK (field_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_fp_fields     CHECK (array_length(field_names, 1) >= 1),
    CONSTRAINT ck_fp_confidence CHECK (parse_confidence IN
        ('CONFIRMED','ESTIMATED','UNPARSED'))
    -- DR-IN-009 의 'NULL + UNPARSED'는 스키마 검증 실패 · 전면 파싱 실패에만 해당 (앱 레벨 검증).
    -- 부분 해석(confidence.overall = UNPARSED · 객체 존재)을 허용해야 하므로 CHECK로 강제하지 않는다.
    -- (구 ck_fp_unparsed_null 삭제 — 데이터 요구사항 5-7 사례 3 · DR-NM-033–035 정합)
);
COMMENT ON COLUMN content_fingerprint.kto_modified_time IS
    '원본 YYYYMMDDHHmmss 문자열. 비교 목적이므로 timestamptz로 변환하지 않는다 - DR-PR-008';
COMMENT ON COLUMN content_fingerprint.field_hash IS
    'sha256(판정 필드 원문을 U+001F로 이어붙인 문자열). 전처리 금지 - DR-FP-004';

-- ---------------------------------------------------------------------
-- 8. patch_application : 패치 적용 이력
-- ---------------------------------------------------------------------
CREATE TABLE patch_application (
    id                  BIGSERIAL PRIMARY KEY,
    product_id          BIGINT      NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    applied_at          TIMESTAMPTZ NOT NULL,
    applied_by          BIGINT      NOT NULL REFERENCES account(id),
    selected_patches    JSONB       NOT NULL,
    before_snapshot     JSONB       NOT NULL,
    after_snapshot      JSONB       NOT NULL,
    before_audit_run_id BIGINT      REFERENCES audit_run(id),
    after_audit_run_id  BIGINT      REFERENCES audit_run(id),
    reverted_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_patch_selected CHECK (jsonb_array_length(selected_patches) >= 1)
);

-- ---------------------------------------------------------------------
-- 9. notification : 위험 · 기회 알림
-- ---------------------------------------------------------------------
CREATE TABLE notification (
    id               BIGSERIAL PRIMARY KEY,
    product_id       BIGINT      NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    kind             TEXT        NOT NULL,
    match_condition  SMALLINT    NOT NULL,
    kto_content_id   TEXT,
    change_hash_from TEXT,
    change_hash_to   TEXT,
    change_key       TEXT        NOT NULL,
    body             JSONB       NOT NULL,
    dismissed_at     TIMESTAMPTZ,
    read_at          TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_notif_kind      CHECK (kind IN ('RISK','OPPORTUNITY')),
    CONSTRAINT ck_notif_condition CHECK (match_condition BETWEEN 1 AND 6),
    -- FR-MO-036 : 동일 콘텐츠 · 동일 변경은 재노출하지 않는다
    --   지문 두 컬럼을 키로 쓰지 않는다. 조건 2·3 알림은 그 콘텐츠가 어느 일정에도 없어
    --   지문 이력이 없고, NULL 이 섞이면 평범한 UNIQUE 가 행마다 다른 것으로 보아 제약이
    --   통째로 논다. NULLS NOT DISTINCT 로 바꾸면 반대로 (상품, 콘텐츠) 만으로 막혀 진짜
    --   새 변경까지 차단된다. 조건별로 「같은 변경」의 정의가 달라 앱이 키를 만든다.
    CONSTRAINT uq_notif_change UNIQUE (product_id, kto_content_id, change_key)
);
COMMENT ON COLUMN notification.change_key IS
    '재노출 판정 키 - FP:{직전지문|-}:{현재지문} (조건 1) · MT:{modifiedtime} (조건 2·3)';
COMMENT ON COLUMN notification.change_hash_from IS
    '변경 전 지문. 근거 표시용이며 재노출 판정에는 쓰지 않는다 - DB 명세서 v1.7';

-- ---------------------------------------------------------------------
-- 10. user_setting : 계정 설정
-- ---------------------------------------------------------------------
CREATE TABLE user_setting (
    id               BIGSERIAL PRIMARY KEY,
    account_id       BIGINT      NOT NULL UNIQUE REFERENCES account(id) ON DELETE CASCADE,
    weights          JSONB       NOT NULL
        DEFAULT '{"BLOCKER":25,"ERROR":10,"WARNING":4,"UNVERIFIED":3}'::jsonb,
    r07_span_hours   SMALLINT    NOT NULL DEFAULT 6,
    r07_meal_minutes SMALLINT    NOT NULL DEFAULT 60,
    r04_threshold    SMALLINT    NOT NULL DEFAULT 3,
    watch_keywords   TEXT[]      NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_set_span   CHECK (r07_span_hours   BETWEEN 1 AND 24),
    CONSTRAINT ck_set_meal   CHECK (r07_meal_minutes BETWEEN 1 AND 240),
    CONSTRAINT ck_set_r04    CHECK (r04_threshold    BETWEEN 2 AND 10)
);

-- ---------------------------------------------------------------------
-- 11~13. 계정 단위 기준 테이블
-- ---------------------------------------------------------------------
CREATE TABLE target_profile (
    id             BIGSERIAL PRIMARY KEY,
    account_id     BIGINT      NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    target_key     TEXT        NOT NULL,
    concept_key    TEXT        NOT NULL,
    expected_lcls2 TEXT[]      NOT NULL,
    expects_night  BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_profile UNIQUE (account_id, target_key, concept_key),
    CONSTRAINT ck_profile_lcls CHECK (array_length(expected_lcls2, 1) >= 1)
);

CREATE TABLE dwell_default (
    id          BIGSERIAL PRIMARY KEY,
    account_id  BIGINT      NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    lcls_systm2 TEXT        NOT NULL,
    minutes     SMALLINT    NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_dwell   UNIQUE (account_id, lcls_systm2),
    CONSTRAINT ck_dwell_m CHECK (minutes BETWEEN 1 AND 1440)
);

CREATE TABLE indoor_outdoor_map (
    id          BIGSERIAL PRIMARY KEY,
    account_id  BIGINT      NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    lcls_systm2 TEXT        NOT NULL,
    space_type  TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_io    UNIQUE (account_id, lcls_systm2),
    CONSTRAINT ck_io_st CHECK (space_type IN ('INDOOR','OUTDOOR','MIXED'))
);

-- ---------------------------------------------------------------------
-- 14~18. 전역 기준 · 운영 테이블
-- ---------------------------------------------------------------------
CREATE TABLE lcls_systm_code (
    id           BIGSERIAL PRIMARY KEY,
    level        SMALLINT    NOT NULL,
    code         TEXT        NOT NULL UNIQUE,
    name         TEXT        NOT NULL,
    parent_code  TEXT,
    collected_at TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_lcls_level CHECK (level BETWEEN 1 AND 3)
);
COMMENT ON TABLE lcls_systm_code IS
    '분류체계 기준표. 관광지 원문이 아니므로 무저장 원칙 대상 아님 - DR-CF-001';

CREATE TABLE climate_normal (
    id            BIGSERIAL PRIMARY KEY,
    ldong_regn_cd TEXT         NOT NULL,
    month         SMALLINT     NOT NULL,
    rain_days     NUMERIC(4,1) NOT NULL,
    rain_ratio    NUMERIC(4,3) NOT NULL,
    normal_period TEXT         NOT NULL,
    source_note   TEXT         NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_climate    UNIQUE (ldong_regn_cd, month),
    CONSTRAINT ck_climate_m  CHECK (month BETWEEN 1 AND 12),
    CONSTRAINT ck_climate_r  CHECK (rain_ratio BETWEEN 0 AND 1)
);

CREATE TABLE api_call_log (
    id           BIGSERIAL PRIMARY KEY,
    provider     TEXT        NOT NULL,
    operation    TEXT        NOT NULL,
    called_at    TIMESTAMPTZ NOT NULL,
    quota_date   DATE        NOT NULL,
    status       TEXT        NOT NULL,
    http_status  SMALLINT,
    result_code  TEXT,
    latency_ms   INT         NOT NULL,
    audit_run_id BIGINT      REFERENCES audit_run(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_log_provider CHECK (provider IN ('KTO','KAKAO_MOBILITY','KMA','LLM')),
    CONSTRAINT ck_log_status   CHECK (status   IN ('OK','FAIL','TIMEOUT')),
    CONSTRAINT ck_log_latency  CHECK (latency_ms >= 0)
);
COMMENT ON COLUMN api_call_log.quota_date IS
    'KST 기준 일자. UTC로 채우면 예산 집계가 9시간 어긋남 - DR-CF-004';

CREATE TABLE batch_state (
    id              BIGSERIAL PRIMARY KEY,
    key             TEXT        NOT NULL UNIQUE,
    last_covered    DATE,
    last_run_at     TIMESTAMPTZ,
    last_status     TEXT,
    last_item_count INT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_batch_status CHECK (last_status IS NULL OR last_status IN
        ('OK','EMPTY','FAILED','HIDDEN_OVERFLOW'))
);
COMMENT ON COLUMN batch_state.last_covered IS
    '배치 성공 시에만 갱신. 평일 조회 0건이면 갱신 금지 - DR-CF-005';

-- ---------------------------------------------------------------------
-- 18. system_setting : 전역 운영 설정 (전역 1행)
--     배치 시각 · 활성화 · 일일 호출 예산은 계정별 값이 아니라 서비스 전체 값
-- ---------------------------------------------------------------------
CREATE TABLE system_setting (
    id             BIGSERIAL   PRIMARY KEY,
    key            TEXT        NOT NULL UNIQUE DEFAULT 'global',
    batch_time     TIME        NOT NULL DEFAULT '05:00',
    batch_enabled  BOOLEAN     NOT NULL DEFAULT FALSE,
    daily_quota    INT         NOT NULL DEFAULT 800,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- DR-IN-008 : 개발계정 1000 / 운영계정 100000 상한 (계정 유형별 상한은 앱 검증)
    CONSTRAINT ck_sys_quota CHECK (daily_quota BETWEEN 1 AND 100000)
);
COMMENT ON TABLE  system_setting IS
    '전역 운영 설정. 배치 시각·활성화·일일 호출 예산은 전 계정 공통 - PM-DA-006 · DR-CF-007';

-- ---------------------------------------------------------------------
-- 19. demand_signal : 수요 신호 T1 · T2 (배치 산출)
-- ---------------------------------------------------------------------
CREATE TABLE demand_signal (
    id              BIGSERIAL PRIMARY KEY,
    signal_type     TEXT        NOT NULL,
    -- `regn` 또는 `regn:signgu`. 시군구가 NULL 인 행이 섞이면 평범한 UNIQUE 가
    -- 행마다 다른 것으로 보아 제약이 통째로 논다 (notification.change_key 와 같은 함정).
    region_key      TEXT        NOT NULL,
    ldong_regn_cd   TEXT        NOT NULL,
    ldong_signgu_cd TEXT,
    window_from     DATE        NOT NULL,
    window_to       DATE        NOT NULL,
    total_count     INT         NOT NULL,
    by_type         JSONB       NOT NULL,
    computed_at     TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_signal_type   CHECK (signal_type IN ('T1','T2')),
    CONSTRAINT ck_signal_count  CHECK (total_count >= 0),
    CONSTRAINT ck_signal_window CHECK (window_from <= window_to),
    CONSTRAINT uq_signal UNIQUE (signal_type, region_key, window_from, window_to)
);

COMMENT ON TABLE  demand_signal IS
    'T1 신규 콘텐츠 · T2 행사 밀도. 배치 산출값이며 강도 점수를 담지 않는다 - FR-RU-121';
COMMENT ON COLUMN demand_signal.by_type IS
    'contentTypeId → 건수. 공사 원문 미포함 - DR-PR-001';
COMMENT ON COLUMN demand_signal.region_key IS
    'regn 또는 regn:signgu. NULL 이 UNIQUE 를 무력화하는 것을 피한다';

-- ---------------------------------------------------------------------
-- 20. llm_parse_cache : LLM 해석 결과 캐시
-- ---------------------------------------------------------------------
CREATE TABLE llm_parse_cache (
    fragment_hash TEXT        PRIMARY KEY,
    purpose       TEXT        NOT NULL,
    model         TEXT        NOT NULL,
    result_json   JSONB       NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_lpc_purpose CHECK (purpose IN ('STRUCTURE','NORMALIZE')),
    CONSTRAINT ck_lpc_hash    CHECK (fragment_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE  llm_parse_cache IS
    'LLM 해석 결과 캐시. 같은 조각을 두 번 부르지 않고 같은 답을 보장한다 - EI-LM-005 · NF-MT-001';
COMMENT ON COLUMN llm_parse_cache.fragment_hash IS
    'sha256(purpose + model + fragment). 원문 대신 이것만 저장한다 - DR-PR-001';
COMMENT ON COLUMN llm_parse_cache.model IS
    '모델을 바꾸면 답도 달라진다. 키에 섞여 있고 조회 결과에도 남긴다';

-- DR-IN-011 최소 목록
CREATE INDEX idx_product_account    ON product(account_id);
CREATE INDEX idx_item_content       ON itinerary_item(kto_content_id)
                                       WHERE kto_content_id IS NOT NULL;
CREATE INDEX idx_run_product_time   ON audit_run(product_id, executed_at DESC);
CREATE INDEX idx_finding_run_sev    ON finding(audit_run_id, severity);
CREATE INDEX idx_fp_content_time    ON content_fingerprint(kto_content_id, fetched_at DESC);
CREATE INDEX idx_call_quota         ON api_call_log(quota_date, provider);

-- 보완 인덱스
CREATE UNIQUE INDEX uq_job_active   ON audit_job(product_id)
                                       WHERE status IN ('QUEUED','RUNNING');
CREATE INDEX idx_notif_product_read ON notification(product_id, read_at);
CREATE INDEX idx_product_region_start ON product(ldong_signgu_cd, start_date);
CREATE INDEX idx_patch_product_time ON patch_application(product_id, applied_at DESC);
CREATE INDEX idx_signal_lookup      ON demand_signal(signal_type, region_key, window_from);

-- ---------------------------------------------------------------------
-- DR-IN-003 : day_no <= product.nights + 1
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_check_item_day_no() RETURNS trigger AS $fn$
DECLARE
    max_day SMALLINT;
BEGIN
    SELECT nights + 1 INTO max_day FROM product WHERE id = NEW.product_id;
    IF NEW.day_no > max_day THEN
        RAISE EXCEPTION 'DAY_COUNT_MISMATCH: day_no % exceeds product day count %',
            NEW.day_no, max_day;
    END IF;
    RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER check_item_day_no
    BEFORE INSERT OR UPDATE OF day_no, product_id ON itinerary_item
    FOR EACH ROW EXECUTE FUNCTION trg_check_item_day_no();

-- ---------------------------------------------------------------------
-- DR-IN-007 : 출시 승인은 최신 audit_run.blocker_cnt = 0 일 때만
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_check_release() RETURNS trigger AS $fn$
DECLARE
    latest_blockers SMALLINT;
BEGIN
    IF NEW.released_at IS NOT NULL
       AND (OLD.released_at IS NULL OR OLD.released_at <> NEW.released_at) THEN

        SELECT blocker_cnt INTO latest_blockers
        FROM audit_run
        WHERE product_id = NEW.id
        ORDER BY executed_at DESC
        LIMIT 1;

        IF latest_blockers IS NULL THEN
            RAISE EXCEPTION 'FORBIDDEN_ACTION: no audit_run for product %', NEW.id;
        END IF;
        IF latest_blockers > 0 THEN
            RAISE EXCEPTION 'FORBIDDEN_ACTION: % blocker(s) present', latest_blockers;
        END IF;
    END IF;
    RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER check_release
    BEFORE UPDATE OF released_at ON product
    FOR EACH ROW EXECUTE FUNCTION trg_check_release();

-- ---------------------------------------------------------------------
-- DR-LC-001 : audit_run · finding 불변성
--             (finding은 무시 · 확인 플래그만 UPDATE 허용)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_audit_run_immutable() RETURNS trigger AS $fn$
BEGIN
    RAISE EXCEPTION 'FORBIDDEN_ACTION: audit_run is immutable (PM-NG-004)';
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER audit_run_immutable
    BEFORE UPDATE ON audit_run
    FOR EACH ROW EXECUTE FUNCTION trg_audit_run_immutable();

CREATE OR REPLACE FUNCTION trg_finding_immutable() RETURNS trigger AS $fn$
BEGIN
    IF ROW(NEW.audit_run_id, NEW.rule_code, NEW.rule_version, NEW.severity,
           NEW.reason_code, NEW.message, NEW.evidence, NEW.patches)
       IS DISTINCT FROM
       ROW(OLD.audit_run_id, OLD.rule_code, OLD.rule_version, OLD.severity,
           OLD.reason_code, OLD.message, OLD.evidence, OLD.patches) THEN
        RAISE EXCEPTION
            'FORBIDDEN_ACTION: only dismissed_at / dismiss_reason / confirmed_at are mutable';
    END IF;
    RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER finding_immutable
    BEFORE UPDATE ON finding
    FOR EACH ROW EXECUTE FUNCTION trg_finding_immutable();

-- 배치 상태 1행
INSERT INTO batch_state (key, last_covered)
VALUES ('sync_list', NULL);

-- 전역 운영 설정 1행 (배치 시각 · 활성화 · 일일 호출 예산 — 전 계정 공통)
INSERT INTO system_setting (key) VALUES ('global');

-- 심사용 테스트 계정 (PM-TA-001 · PM-TA-008 · NF-CO-005)
-- 여기서 INSERT 하지 않는다. 계정은 애플리케이션 시드가 만든다 — `pnpm --filter api seed`.
-- 자격증명은 소스·스키마에 넣지 않고 환경변수(DEMO_ACCOUNT_EMAIL · DEMO_ACCOUNT_PASSWORD)로
-- 주입하며, 비밀번호는 회원가입과 같은 scrypt 해시로 저장한다 (apps/api/src/seed).

-- 계정 생성 시 기본값 복제 (DR-CF-002)
--   user_setting        1행
--   dwell_default       중분류 59행
--   indoor_outdoor_map  중분류 59행
--   target_profile      사전 제공 프로파일
-- 위 4종은 회원가입 트랜잭션에서 함께 생성한다. 빈 상태를 허용하지 않는다.

-- 데모 상품 시드 (PM-TA-003 · DR-TD-007)
-- 데모 계정의 상품 · 일정은 리포지토리의 시드 스크립트로 정의한다.
-- 복원(POST /api/v1/demo/reset)은 데모 계정 데이터 삭제 후 시드 재실행이며,
-- DB에 별도 스냅샷 테이블을 두지 않는다.
