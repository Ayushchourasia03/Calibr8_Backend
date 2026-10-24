import { Router } from "express";
import { getRankings } from "../controllers/ranking.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = Router();
router.get("/", getRankings);
export default router;