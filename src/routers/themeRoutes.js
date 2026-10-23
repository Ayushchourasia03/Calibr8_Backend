import express from "express";
import { getAllThemes, buyTheme, applyTheme, getMyThemeStatus } from '../controllers/themeController.js';
import {  protect  } from "../middlewares/auth.middleware.js"; // your auth middleware


const router = express.Router();

router.get("/", protect , getAllThemes);           // GET /api/themes -> screenshot
router.get("/me", protect , getMyThemeStatus);     // GET /api/themes/me -> for instant shift
router.post("/:slug/buy", protect , buyTheme);     // POST /api/themes/arcade/buy
router.put("/apply", protect , applyTheme);        // PUT /api/themes/apply {slug: 'frost'}

export default router;