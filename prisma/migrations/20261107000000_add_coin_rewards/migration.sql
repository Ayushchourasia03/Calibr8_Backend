ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastLoginISTDate" TEXT;

CREATE TABLE IF NOT EXISTS "coin_transactions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "referenceId" TEXT,
  "istDate" TEXT NOT NULL,
  "balanceAfter" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coin_transactions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "coin_transactions_userId_createdAt_idx" ON "coin_transactions"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "coin_transactions_userId_type_istDate_idx" ON "coin_transactions"("userId", "type", "istDate");

CREATE TABLE IF NOT EXISTS "daily_problems" (
  "id" TEXT NOT NULL,
  "istDate" TEXT NOT NULL,
  "problemId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "daily_problems_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "daily_problems_istDate_key" ON "daily_problems"("istDate");
CREATE INDEX IF NOT EXISTS "daily_problems_istDate_idx" ON "daily_problems"("istDate");
CREATE INDEX IF NOT EXISTS "daily_problems_problemId_idx" ON "daily_problems"("problemId");

DO $$ BEGIN
  ALTER TABLE "coin_transactions" ADD CONSTRAINT "coin_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "daily_problems" ADD CONSTRAINT "daily_problems_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "problems"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
