import { Router } from "express";
import { protect, optionalAuth } from "../middlewares/auth.middleware.js";
import {
  getBalance,
  getHistory,
  getTodayDailyProblem,
} from "../controllers/coin.controller.js";

const router = Router();

// GET /api/coins/balance - Requires Bearer token
router.get("/balance", protect, getBalance);

// GET /api/coins/history - Requires Bearer token
router.get("/history", protect, getHistory);

// GET /api/coins/daily-problem - Optional auth or public
router.get("/daily-problem", optionalAuth, getTodayDailyProblem);

export default router;
