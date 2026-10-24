import { Router } from "express";
import { addProblem } from "../controllers/problem.controller.js";
import { protect, requireAdmin } from "../middlewares/auth.middleware.js";

const router = Router();

// POST /api/admin/problems - Admin only problem creation
router.post("/problems", protect, requireAdmin, addProblem);

export default router;
