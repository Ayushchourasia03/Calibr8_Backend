import { Router } from "express";
import {
  getLanguages,
  runCode,
  submitSolution,
  getSubmissionStatus,
} from "../controllers/execution.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import {
  inFlightLimiter,
  runLimiter,
  submitLimiter,
} from "../middlewares/rateLimit.middleware.js";
const router = Router();

// GET /api/execution/languages
router.get("/languages", getLanguages);

// POST /api/execution/runs (and /run alias) - run sample test cases synchronously
router.post("/runs", protect, runLimiter, inFlightLimiter, runCode);
router.post("/run", protect, runLimiter, inFlightLimiter, runCode);

// POST /api/execution/submissions (and /submit alias) - full multi-tier submission
router.post(
  "/submissions",
  protect,
  submitLimiter,
  inFlightLimiter,
  submitSolution,
);
router.post("/submit", protect, submitLimiter, inFlightLimiter, submitSolution);

// GET /api/execution/submissions/:id - poll submission status & tier progress
router.get("/submissions/:id", protect, getSubmissionStatus);

export default router;
