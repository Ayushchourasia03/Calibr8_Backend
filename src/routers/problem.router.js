import { Router } from "express";
import {
  getAllProblems,
  getProblemBySlug,
  addProblem,
} from "../controllers/problem.controller.js";
import { protect, requireAdmin } from "../middlewares/auth.middleware.js";

const router = Router();

// GET /api/problems - list all problems
router.get("/", protect, getAllProblems);

// POST /api/problems - moved to /api/admin/problems; retained with strict admin-only check
router.post("/", protect, requireAdmin, addProblem);

// GET /api/problems/:slug - problem detail with visible testcases & starter templates
router.get("/:slug", protect, getProblemBySlug);

export default router;
