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

// GET /api/topics/dsa - DSA calibration topics for onboarding
router.get("/dsa", getDsaTopics);

// GET /api/topics/dsa/categories - all structured DSA topic categories
router.get("/dsa/categories", protect, getAllDsaTopics);
router.get("/categories", getAllDsaTopics);

// DSA category problem lists contain public catalog metadata.
router.get("/dsa/:slug/problems", getProblemsByDsaTopic);

// GET /api/topics - all topics
router.get("/",  getAllTopics);

// GET /api/topics/:identifier - single topic by ID or slug (must be after specific sub-routes)
router.get("/:identifier", protect, getTopicDetail);

export default router;
