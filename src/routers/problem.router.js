import { Router } from "express";
import {
  getAllProblems,
  getProblemBySlug,
  getProblemStarterTemplate,
  addProblem,
} from "../controllers/problem.controller.js";
import {
  runCode,
  submitSolution,
} from "../controllers/execution.controller.js";
import { protect, requireAdmin, optionalAuth } from "../middlewares/auth.middleware.js";

const router = Router();

// Catalog reads are public; mutations remain protected.
router.get("/", getAllProblems);

// POST /api/problems - moved to /api/admin/problems; retained with strict admin-only check
router.post("/", protect, requireAdmin, addProblem);

// GET /api/problems/:slug - problem detail with visible testcases & starter templates
router.get("/:slug", getProblemBySlug);

// GET /api/problems/:slug/starter or /template - fetch function template for selected language
router.get("/:slug/starter", getProblemStarterTemplate);
router.get("/:slug/template", getProblemStarterTemplate);

// Execution endpoints at problem scope:
// POST /api/problems/:slug/run - run visible test cases
router.post("/:slug/run", optionalAuth, runCode);

// POST /api/problems/:slug/submit - submit solution for full tier judging
router.post("/:slug/submit", optionalAuth, submitSolution);

export default router;
