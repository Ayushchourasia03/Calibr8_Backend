import { Router } from "express";
import {
  getLinkUrl,
  handleCallback,
  completeLink,
  unlinkProvider,
} from "../controllers/social.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { sessionLimiter } from "../middlewares/rateLimit.middleware.js";

const router = Router();

// GET /api/social/:provider/link-url - get OAuth authorization URL
router.get("/:provider/link-url", protect, sessionLimiter, getLinkUrl);

// GET /api/social/:provider/callback - OAuth callback handler (redirects with ?link_code)
router.get("/:provider/callback", handleCallback);

// POST /api/social/:provider/complete - link the provider account to the signed-in user
router.post("/:provider/complete", protect, sessionLimiter, completeLink);

// DELETE /api/social/:provider - unlink provider from account
router.delete("/:provider", protect, sessionLimiter, unlinkProvider);

export default router;
