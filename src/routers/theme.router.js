import express from "express";
import { getAllThemes, buyTheme, applyTheme, getMyThemeStatus } from "../controllers/theme.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { sessionLimiter } from "../middlewares/rateLimit.middleware.js";

const router = express.Router();

router.get("/", protect, getAllThemes);
router.get("/me", protect, getMyThemeStatus);
router.post("/:slug/buy", protect, sessionLimiter, buyTheme);
router.put("/apply", protect, sessionLimiter, applyTheme);

export default router;