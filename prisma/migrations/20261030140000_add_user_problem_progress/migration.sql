CREATE TABLE "user_problem_progress" (
    "userId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "scoreAwarded" INTEGER NOT NULL DEFAULT 0,
    "coinsAwarded" INTEGER NOT NULL DEFAULT 0,
    "solvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_problem_progress_pkey" PRIMARY KEY ("userId", "problemId")
);

CREATE INDEX "user_problem_progress_problemId_idx"
    ON "user_problem_progress"("problemId");

ALTER TABLE "user_problem_progress"
    ADD CONSTRAINT "user_problem_progress_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_problem_progress"
    ADD CONSTRAINT "user_problem_progress_problemId_fkey"
    FOREIGN KEY ("problemId") REFERENCES "problems"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
