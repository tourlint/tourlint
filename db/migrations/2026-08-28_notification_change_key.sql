-- notification 재노출 판정 키 (DB 명세서 v1.7 · FR-MO-036)
--
-- 지문 두 컬럼을 유니크 키로 쓰던 것이 작동하지 않았다. 조건 2·3 알림은 그 콘텐츠가 어느
-- 일정에도 없어 지문 이력이 없고, 평범한 UNIQUE 는 NULL 이 든 행을 서로 다르게 본다 —
-- 제약이 걸려 있는데 아무것도 막지 않는 상태였다.
--
-- 여러 번 돌려도 안전하다.

-- ① 컬럼을 먼저 NULL 허용으로 넣는다. 기존 행이 있어도 실패하지 않게
ALTER TABLE notification ADD COLUMN IF NOT EXISTS change_key TEXT;

-- ② 기존 행 백필. 지문이 있으면 그 전이를, 없으면 행 id 를 키로 삼는다 —
--    과거 행끼리 뭉쳐 하나만 남기지 않으려고 id 를 쓴다 (이미 만들어진 알림은 그대로 둔다)
UPDATE notification
   SET change_key = CASE
         WHEN change_hash_to IS NOT NULL
           THEN 'FP:' || COALESCE(change_hash_from, '-') || ':' || change_hash_to
         ELSE 'LEGACY:' || id::text
       END
 WHERE change_key IS NULL;

ALTER TABLE notification ALTER COLUMN change_key SET NOT NULL;

-- ③ 유니크를 키 하나로 바꾼다
ALTER TABLE notification DROP CONSTRAINT IF EXISTS uq_notif_change;
ALTER TABLE notification ADD CONSTRAINT uq_notif_change
  UNIQUE (product_id, kto_content_id, change_key);

COMMENT ON COLUMN notification.change_key IS
    '재노출 판정 키 - FP:{직전지문|-}:{현재지문} (조건 1) · MT:{modifiedtime} (조건 2·3)';
COMMENT ON COLUMN notification.change_hash_from IS
    '변경 전 지문. 근거 표시용이며 재노출 판정에는 쓰지 않는다 - DB 명세서 v1.7';
