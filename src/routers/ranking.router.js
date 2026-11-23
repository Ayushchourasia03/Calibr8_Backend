import { Router } from "express";
import { getRankings } from "../controllers/ranking.controller.js";
import { optionalAuth } from "../middlewares/auth.middleware.js";
import { createRateLimiter } from "../middlewares/rateLimit.middleware.js";
import { clientIpKey } from "../utils/clientIp.js";

const rankingsLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => `rankings:${req.user?.id || clientIpKey(req)}`,
});

const router = Router();
// Public: minimal leaderboard. Signed in: regional fields, scope filters and
// the caller's own row marked with isCurrentUser.
router.get("/", optionalAuth, rankingsLimiter, getRankings);
export default router;
