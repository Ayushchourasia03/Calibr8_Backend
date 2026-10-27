import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { runCode } from "../controllers/execution.controller.js";

const router = Router();

// 1 user = 10 req/min - tera KVM1 crash nahi hoga
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Slow down bhai, 10 req/min only" }
});

router.post("/run", limiter, runCode);

export default router;