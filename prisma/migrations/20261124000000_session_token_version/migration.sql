-- Session generation counter (audit finding M1). Additive and backward
-- compatible: the column has a default, existing code never selects it, and
-- every existing token counts as version 0 until the user's version changes.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
