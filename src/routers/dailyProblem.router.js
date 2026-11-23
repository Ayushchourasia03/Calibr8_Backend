import { Router } from "express";
import { optionalAuth } from "../middlewares/auth.middleware.js";
import { getToday, getHistory } from "../controllers/dailyProblem.controller.js";

const router = Router();

// GET /api/daily-problem - today's problem (+ caller status with a token)
router.get("/", optionalAuth, getToday);

// GET /api/daily-problem/history - past daily problems, newest first
router.get("/history", optionalAuth, getHistory);

export default router;
