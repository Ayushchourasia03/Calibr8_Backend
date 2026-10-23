import { Router } from "express";
import {
  getAvailableLanguages,
  runCode,
  submitCode,
  getSubmission,
} from "../controllers/execution.controller.js";

const router = Router();

router.get("/languages", getAvailableLanguages);
router.post("/runs", runCode);
router.post("/submissions", submitCode);
router.get("/submissions/:id", getSubmission);

export default router;
