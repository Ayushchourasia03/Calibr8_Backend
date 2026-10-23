import { Router } from "express";
import {
  getAvailableLanguages,
  runCode,
  submitCode,
  getSubmission,
} from "../controllers/execution.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
const router = Router();

router.get("/languages",protect, getAvailableLanguages);
router.post("/runs",protect, runCode);
router.post("/submissions",protect, submitCode);
router.get("/submissions/:id",protect, getSubmission);

export default router;
