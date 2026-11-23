import { Router } from "express";
import {
  getMe,
  getProfileOverview,
  getMyActivity,
  updateMe,
  updateProfile,
  updateLanguage,
  getAllProblems,
  updateAcademicProfile,
} from "../controllers/user.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { sessionLimiter } from "../middlewares/rateLimit.middleware.js";
import { deleteAccount } from "../controllers/auth.controller.js";

const router = Router();

// Authenticated profile management
router.get("/me/overview", protect, getProfileOverview);
router.get("/me", protect, getMe);
router.get("/me/activity", protect, getMyActivity);
router.put("/me", protect, updateMe);
router.patch("/me", protect, updateProfile);
router.patch("/me/language", protect, updateLanguage);
router.patch("/me/academic", protect, updateAcademicProfile);
router.delete("/me", protect, sessionLimiter, deleteAccount);

// Root aliases
router.get("/", protect, getMe);
router.put("/", protect, updateMe);
router.patch("/language", protect, updateLanguage);
router.patch("/academic", protect, updateAcademicProfile);
router.get("/all", protect, getAllProblems);

export default router;
