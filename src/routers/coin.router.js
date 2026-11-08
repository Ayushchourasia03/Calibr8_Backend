import { Router } from "express";
import { protect, optionalAuth } from "../middlewares/auth.middleware.js";
import {
  getBalance,
  getHistory,
  getTodayDailyProblem,
  getDailyProblemHistoryController,
} from "../controllers/coin.controller.js";

const router = Router();

// GET /api/coins/balance - Requires Bearer token
router.get("/balance", protect, getBalance);

// GET /api/coins/history - Requires Bearer token
router.get("/history", protect, getHistory);

// GET /api/coins/daily-problem - Optional auth or public
router.get("/daily-problem", optionalAuth, getTodayDailyProblem);

// GET /api/coins/daily-problem/history - Optional auth or public
router.get("/daily-problem/history", optionalAuth, getDailyProblemHistoryController);

export default router;
