CREATE INDEX "submissions_userId_status_createdAt_idx"
ON "submissions"("userId", "status", "createdAt");