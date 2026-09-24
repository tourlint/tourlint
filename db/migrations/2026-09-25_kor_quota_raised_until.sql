-- 국문 관광정보 트래픽 증설 마지막 날 (#789 · DB 명세서 system_setting).
--
-- 증설이 연장되면 배포 없이 이 값만 바꾼다 — 10.01 – 11.05 는 배포 금지다 (NF-AV-010).
--   DATABASE_URL=... node scripts/batch_switch.mjs --kor-until 2026-11-05
--
-- **더하기만 한다.** 기존 행은 기본값(2026-10-11)을 받고, 이 칸을 모르는 구 코드도 그대로 돈다.
-- 앱은 칸이 없는 DB 에서도 기본값 10-11 로 읽으므로 배포와 적용 순서가 어긋나도 된다.
-- 여러 번 돌려도 된다.
ALTER TABLE system_setting
    ADD COLUMN IF NOT EXISTS kor_quota_raised_until DATE NOT NULL DEFAULT DATE '2026-10-11';

COMMENT ON COLUMN system_setting.kor_quota_raised_until IS
    '국문 관광정보 트래픽 증설 마지막 날(KST · 포함). 다음 날부터 daily_quota 가 800 을 넘어도 800 - #777 · #789';
