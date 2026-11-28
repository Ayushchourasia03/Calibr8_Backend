import { Router } from "express";
import {
  getLanguages,
  runCode,
  submitSolution,
  getSubmissionStatus,
  getComplexityAnalysis,
  getSubmissionComplexity,
} from "../controllers/execution.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import {
  analyzeLimiter,
  inFlightLimiter,
  pollLimiter,
  runLimiter,
  submitLimiter,
} from "../middlewares/rateLimit.middleware.js";
const router = Router();

// ==========================================
// TARGET PUBLIC EXECUTION APIS (PRD Sec 7)
// ==========================================

// GET /api/execution/languages - supported language definitions
router.get("/languages", getLanguages);

// POST /api/execution/run - execute sample visible test cases
router.post("/run", protect, runLimiter, inFlightLimiter, runCode);

// POST /api/execution/submit - full multi-tier judging
router.post("/submit", protect, submitLimiter, inFlightLimiter, submitSolution);

// GET /api/execution/submissions/:id - poll submission status, verdict & complexity
router.get("/submissions/:id", protect, pollLimiter, getSubmissionStatus);
router.get("/submissions/:id/complexity", protect, pollLimiter, getSubmissionComplexity);

// POST /api/execution/analyze-complexity - standalone static & empirical complexity analysis
// Authenticated: the analyzer is CPU-heavy (it runs in a worker pool with a hard timeout).
router.post("/analyze-complexity", protect, analyzeLimiter, getComplexityAnalysis);

// ==========================================
// BACKWARD-COMPATIBLE ALIASES
// ==========================================
router.post("/runs", protect, runLimiter, inFlightLimiter, runCode);
router.post("/submissions", protect, submitLimiter, inFlightLimiter, submitSolution);

export default router;
