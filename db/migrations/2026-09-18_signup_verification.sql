-- 신규 가입에만 적용. 기존 계정·세션·상품 데이터 변경 없음.
BEGIN;
CREATE TABLE IF NOT EXISTS signup_verification (
    email TEXT PRIMARY KEY,
    verification_id UUID NOT NULL UNIQUE,
    code_hash TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    delivered BOOLEAN NOT NULL DEFAULT FALSE,
    last_sent_at TIMESTAMPTZ NOT NULL,
    window_started_at TIMESTAMPTZ NOT NULL,
    send_count INT NOT NULL CHECK (send_count BETWEEN 1 AND 5)
);
CREATE INDEX IF NOT EXISTS idx_signup_verification_retention ON signup_verification(last_sent_at);
CREATE TABLE IF NOT EXISTS auth_email_rate_limit (
    bucket TEXT PRIMARY KEY,
    count INT NOT NULL CHECK (count > 0),
    expires_at TIMESTAMPTZ NOT NULL
);
COMMIT;
