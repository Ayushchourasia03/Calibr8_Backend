import { Router } from "express";
import {
  getAllTopics,
  getDsaTopics,
  getTopicDetail,
  getAllDsaTopics,
  getProblemsByDsaTopic,
} from "../controllers/topic.controller.js";

const router = Router();

// GET /api/topics/dsa - only DSA calibration topics
router.get("/dsa", getDsaTopics);

// GET /api/topics/dsa/categories - all structured DSA topic categories
router.get("/dsa/categories", getAllDsaTopics);
router.get("/categories", getAllDsaTopics);

// GET /api/topics/dsa/:slug/problems - problems grouped by DSA topic
router.get("/dsa/:slug/problems", getProblemsByDsaTopic);

// GET /api/topics - all topics
router.get("/", getAllTopics);

// GET /api/topics/:identifier - single topic by ID or slug (must be after specific sub-routes)
router.get("/:identifier", getTopicDetail);

export default router;
