import { Router } from "express";
import {
  getAvailableLanguages,
  runCode,
  submitCode,
  getSubmission,
} from "../controllers/execution.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { runLimiter, submitLimiter, inFlightLimiter } from "../middlewares/rateLimit.middleware.js";

const router = Router();

// GET /api/execution/languages
router.get("/languages", protect, getAvailableLanguages);

// POST /api/execution/runs - protected, rate limited (10/min), in-flight cap
router.post("/runs", protect, runLimiter, inFlightLimiter, runCode);

// POST /api/execution/submissions - protected, rate limited (6/min), in-flight cap, returns 202
router.post("/submissions", protect, submitLimiter, inFlightLimiter, submitCode);

// GET /api/execution/submissions/:id - protected, owner only (returns 404 otherwise)
router.get("/submissions/:id", protect, getSubmission);

export default router;
