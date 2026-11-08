ALTER TABLE "daily_problems" ADD COLUMN IF NOT EXISTS "cycle" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS "daily_problems_cycle_idx" ON "daily_problems"("cycle");

CREATE TABLE IF NOT EXISTS "daily_problem_completions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "dailyProblemId" TEXT NOT NULL,
  "submissionId" TEXT,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "daily_problem_completions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "daily_problem_completions_userId_dailyProblemId_key" ON "daily_problem_completions"("userId", "dailyProblemId");
CREATE INDEX IF NOT EXISTS "daily_problem_completions_userId_idx" ON "daily_problem_completions"("userId");
CREATE INDEX IF NOT EXISTS "daily_problem_completions_dailyProblemId_idx" ON "daily_problem_completions"("dailyProblemId");

DO $$ BEGIN
  ALTER TABLE "daily_problem_completions" ADD CONSTRAINT "daily_problem_completions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "daily_problem_completions" ADD CONSTRAINT "daily_problem_completions_dailyProblemId_fkey" FOREIGN KEY ("dailyProblemId") REFERENCES "daily_problems"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
