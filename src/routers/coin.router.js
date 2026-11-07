import { Router } from "express";
import { protect, optionalAuth } from "../middlewares/auth.middleware.js";
import { getHistory, getTodayDailyProblem } from "../controllers/coin.controller.js";

const router = Router();

// GET /api/coins/history - Authenticated user coin audit history
router.get("/history", protect, getHistory);

// GET /api/coins/daily-problem - Today's daily problem metadata
router.get("/daily-problem", optionalAuth, getTodayDailyProblem);

export default router;
