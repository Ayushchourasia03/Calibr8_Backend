-- CreateTable
CREATE TABLE "public"."complexity_profiles" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "language" TEXT NOT NULL,
    "problemSlug" TEXT NOT NULL,
    "timeComplexity" TEXT,
    "timeConfidence" TEXT,
    "spaceComplexity" TEXT,
    "spaceConfidence" TEXT,
    "confidence" TEXT,
    "inputSizes" JSONB,
    "measurements" JSONB,
    "baseline" JSONB,
    "analysis" JSONB,
    "durationMs" INTEGER,
    "failureReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "complexity_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "complexity_profiles_submissionId_key" ON "public"."complexity_profiles"("submissionId");

-- CreateIndex
CREATE INDEX "complexity_profiles_status_nextAttemptAt_idx" ON "public"."complexity_profiles"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "public"."complexity_profiles" ADD CONSTRAINT "complexity_profiles_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "public"."submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

