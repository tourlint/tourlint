-- T1 · T2 수요 신호 산출 결과 (F14 · FR-RU-110~122 · DB 명세서 v1.9)
--
-- 배치가 미리 산출해 두고 조회는 읽기만 한다 (2026-08-30 결정). 요청마다 공사를 부르면
-- 레이더 화면을 열 때마다 예산이 나간다 — 참조 조회는 그럴 이유가 없다.
--
-- 공사 원문을 담지 않는다. `by_type` 은 `contentTypeId` → 건수 분포일 뿐이다.
CREATE TABLE IF NOT EXISTS demand_signal (
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

CREATE INDEX IF NOT EXISTS idx_signal_lookup ON demand_signal(signal_type, region_key, window_from);
