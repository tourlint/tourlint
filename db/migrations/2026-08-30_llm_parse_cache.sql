-- LLM 정규화 폴백 캐시 (F03 · EI-LM-005 · NF-MT-001 · DB 명세서 v2.0)
--
-- 러너는 매 검수마다 parseOperatingInfo 를 새로 돈다. 거기서 LLM 을 직접 부르면 같은
-- 상품을 세 번 검수했을 때 message 까지 같아야 한다는 NF-MT-001 이 흔들린다 —
-- temperature 0 도 매번 같은 답을 보장하지 않는다. 조각 단위로 답을 붙잡아 둔다.
--
-- ⚠️ 원문을 담지 않는다. 키는 sha256(purpose+model+fragment) 이고 값은 해석 결과다
--    (DR-PR-001 · DB 명세서 6-4). 조각 자체는 어디에도 남지 않는다.
CREATE TABLE IF NOT EXISTS llm_parse_cache (
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
