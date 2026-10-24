import { Router } from "express";
import { getMe, updateMe, updateLanguage , getAllProblems} from "../controllers/user.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = Router();

// Profile routes
router.get("/me", protect, getMe);
router.put("/me", protect, updateMe);
router.patch("/me/language", protect, updateLanguage);

// Root relative aliases (when mounted at /me or /api/users)
router.get("/", protect, getMe);
router.put("/", protect, updateMe);
router.patch("/language", protect, updateLanguage);

router.get("/all",protect,  getAllProblems);

export default router;




