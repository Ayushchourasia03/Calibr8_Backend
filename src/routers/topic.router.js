import { Router } from "express";
import {
  getAllTopics,
  getDsaTopics,
  getTopicDetail,
  getAllDsaTopics,
  getProblemsByDsaTopic,
} from "../controllers/topic.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = Router();

// GET /api/topics/dsa - only DSA calibration topics
router.get("/dsa", protect, getDsaTopics);

// GET /api/topics/dsa/categories - all structured DSA topic categories
router.get("/dsa/categories", protect,getAllDsaTopics);
router.get("/categories", getAllDsaTopics);

// GET /api/topics/dsa/:slug/problems - problems grouped by DSA topic
router.get("/dsa/:slug/problems",protect, getProblemsByDsaTopic);

// GET /api/topics - all topics
router.get("/",protect, getAllTopics);

// GET /api/topics/:identifier - single topic by ID or slug (must be after specific sub-routes)
router.get("/:identifier",protect, getTopicDetail);

export default router;
