-- Persistent JWT revocation list (logout / refresh). Only the token id (jti)
-- is stored, never the raw bearer token.
CREATE TABLE IF NOT EXISTS "revoked_tokens" (
    "jti" TEXT NOT NULL,
    "userId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revoked_tokens_pkey" PRIMARY KEY ("jti")
);

CREATE INDEX IF NOT EXISTS "revoked_tokens_expiresAt_idx" ON "revoked_tokens"("expiresAt");

-- Global leaderboard: ORDER BY score DESC LIMIT n without a scope filter.
CREATE INDEX IF NOT EXISTS "users_score_idx" ON "users"("score");

-- Study topics are looked up by slug alone (unique key is chapterId+slug).
CREATE INDEX IF NOT EXISTS "StudyTopic_slug_idx" ON "StudyTopic"("slug");
