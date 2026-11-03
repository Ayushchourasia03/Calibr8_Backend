import { Router } from "express";
import {
  getLanguages,
  runCode,
  submitSolution,
  getSubmissionStatus,
  getComplexityAnalysis,
} from "../controllers/execution.controller.js";
import { protect, optionalAuth } from "../middlewares/auth.middleware.js";
import {
  inFlightLimiter,
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
router.get("/submissions/:id", protect, getSubmissionStatus);

// POST /api/execution/analyze-complexity - standalone static & empirical complexity analysis
router.post("/analyze-complexity", optionalAuth, runLimiter, getComplexityAnalysis);

// ==========================================
// BACKWARD-COMPATIBLE ALIASES
// ==========================================
router.post("/runs", protect, runLimiter, inFlightLimiter, runCode);
router.post("/submissions", protect, submitLimiter, inFlightLimiter, submitSolution);

export default router;
