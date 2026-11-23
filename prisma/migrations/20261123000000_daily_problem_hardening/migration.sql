-- Daily problem hardening. Additive and idempotent: safe to re-run.
BEGIN;

-- Deleting a problem that was a daily problem used to cascade into
-- daily_problems and, from there, daily_problem_completions, erasing history
-- and users' completions. Refuse the delete instead.
ALTER TABLE "daily_problems" DROP CONSTRAINT IF EXISTS "daily_problems_problemId_fkey";
ALTER TABLE "daily_problems" ADD CONSTRAINT "daily_problems_problemId_fkey"
  FOREIGN KEY ("problemId") REFERENCES "problems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one daily-problem reward per user per IST day, enforced by the
-- database even if a completion row goes missing.
CREATE UNIQUE INDEX IF NOT EXISTS "coin_transactions_daily_problem_unique"
  ON "coin_transactions" ("userId", "istDate")
  WHERE "type" = 'DAILY_PROBLEM';

COMMIT;
