import { Router } from "express";
import {
  getAllProblems,
  getProblemBySlug,
  addProblem,
} from "../controllers/problem.controller.js";
import {protect} from "../middlewares/auth.middleware.js";
const router = Router();

// GET /api/problems or /problems - list all
router.get("/",protect, getAllProblems);

// POST /api/problems - add problem
router.post("/", protect,addProblem);

// GET /api/problems/:slug - problem detail with testcases + templates
router.get("/:slug",protect, getProblemBySlug);

export default router;
