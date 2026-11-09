-- 1. Clean up daily_problems table: drop cycle column and redundant indexes
DROP INDEX IF EXISTS "daily_problems_cycle_idx";
DROP INDEX IF EXISTS "daily_problems_istDate_idx";

ALTER TABLE "daily_problems" DROP COLUMN IF EXISTS "cycle";

-- 2. Clean up daily_problem_completions table: drop redundant surrogate id and unique constraint, establish composite primary key
ALTER TABLE "daily_problem_completions" DROP CONSTRAINT IF EXISTS "daily_problem_completions_pkey";
DROP INDEX IF EXISTS "daily_problem_completions_userId_dailyProblemId_key";
DROP INDEX IF EXISTS "daily_problem_completions_userId_idx";

ALTER TABLE "daily_problem_completions" DROP COLUMN IF EXISTS "id";
ALTER TABLE "daily_problem_completions" ADD CONSTRAINT "daily_problem_completions_pkey" PRIMARY KEY ("userId", "dailyProblemId");

-- 3. Clean up users table: drop duplicate active_theme_id column & constraint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_active_theme_id_fkey";
ALTER TABLE "users" DROP COLUMN IF EXISTS "active_theme_id";
