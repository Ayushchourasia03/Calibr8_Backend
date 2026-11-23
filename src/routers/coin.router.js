import { Router } from "express";
import { protect } from "../middlewares/auth.middleware.js";
import { getBalance, getHistory } from "../controllers/coin.controller.js";

const router = Router();

// GET /api/coins/balance - Requires Bearer token
router.get("/balance", protect, getBalance);

// GET /api/coins/history - Requires Bearer token
router.get("/history", protect, getHistory);

export default router;
