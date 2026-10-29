import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
  getLanguages,
  runCode,
  submitSolution,
  getSubmissionStatus,
} from "../controllers/execution.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
const router = Router();

// Rate limiter: 30 requests per minute
const runLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, code: "TOO_MANY_REQUESTS", message: "Rate limit reached. Please wait a moment." },
});

// GET /api/execution/languages
router.get("/languages", getLanguages);

// POST /api/execution/runs (and /run alias) - run sample test cases synchronously
router.post("/runs", runLimiter, protect, runCode);
router.post("/run", runLimiter, protect, runCode);

// POST /api/execution/submissions (and /submit alias) - full multi-tier submission
router.post("/submissions", runLimiter, protect, submitSolution);
router.post("/submit", runLimiter, protect, submitSolution);

// GET /api/execution/submissions/:id - poll submission status & tier progress
router.get("/submissions/:id", protect, getSubmissionStatus);

export default router;