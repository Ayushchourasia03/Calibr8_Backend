import { Router } from "express";
import {
  getMe,
  updateMe,
  updateLanguage,
  getAllProblems,
  updateAcademicProfile,
} from "../controllers/user.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = Router();

// Authenticated profile management
router.get("/me", protect, getMe);
router.put("/me", protect, updateMe);
router.patch("/me/language", protect, updateLanguage);
router.patch("/me/academic", protect, updateAcademicProfile);

// Root aliases
router.get("/", protect, getMe);
router.put("/", protect, updateMe);
router.patch("/language", protect, updateLanguage);
router.patch("/academic", protect, updateAcademicProfile);
router.get("/all", protect, getAllProblems);

export default router;
