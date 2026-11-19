-- Remove any duplicate DAILY_LOGIN rows (keep earliest) before enforcing uniqueness.
DELETE FROM "coin_transactions" a
USING "coin_transactions" b
WHERE a."type" = 'DAILY_LOGIN' AND b."type" = 'DAILY_LOGIN'
  AND a."userId" = b."userId" AND a."istDate" = b."istDate"
  AND (a."createdAt", a."id") > (b."createdAt", b."id");

-- At most one daily login reward per user per IST day (partial index; other types unaffected).
CREATE UNIQUE INDEX IF NOT EXISTS "coin_transactions_daily_login_unique"
  ON "coin_transactions" ("userId", "istDate")
  WHERE "type" = 'DAILY_LOGIN';
