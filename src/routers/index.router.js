import { Router } from "express";
import path from "path";
import { fileURLToPath } from "url";
import authRouter from "./auth.router.js";
import userRouter from "./user.router.js";
import topicRouter from "./topic.router.js";
import onboardingRouter from "./onboarding.router.js";
import socialRouter from "./social.router.js";
import problemRouter from "./problem.router.js";
import studyRouter from "./study.routes.js";
import executionRouter from "./execution.router.js";
import themeRoutes from "./themeRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = Router();
// Health & utility routes
router.get("/ping", (req, res) => res.status(200).send("pong"));
router.get("/api/ping", (req, res) => res.status(200).send("pong"));
const handleHealth = (req, res) =>
  res.status(200).json({
    status: "ok",
    service: "Calibr8 Backend",
    timestamp: new Date().toISOString(),
  });
router.get("/health", handleHealth);
router.get("/api/health", handleHealth);
// Consistent /api/* routing namespace
router.use("/api/auth", authRouter);
router.use("/api/users", userRouter);
router.use("/api/topics", topicRouter);
router.use("/api/onboarding", onboardingRouter);
router.use("/api/problems", problemRouter);
router.use("/api/social", socialRouter);
router.use("/api/study", studyRouter);
router.use("/api/execution", executionRouter);
router.use("/api/themes", themeRoutes);

// Root endpoint: API documentation & interactive developer dashboard
router.get("/", (req, res) => {
  if (req.accepts("html")) {
    res.sendFile(path.join(__dirname, "../../public/index.html"));
  } else {
    res.status(200).json({
      service: "Calibr8 Backend API",
      status: "online",
      version: "1.2.0",
      architecture: {
        pattern: "Router-Controller-Model",
        namingConvention: "*.router.js, *.controller.js",
      },
      features: [
        "User Registration, Login, Logout & Token Revocation",
        "DSA Topic Level Calibration (Easy, Mid, Hard)",
        "Beginner 1-Click Preset (Auto-sets all DSA topics to Easy, rating 800)",
        "Composite Rating Calculation & Difficulty Mapping",
        "Profile Management & Language Preferences",
        "Problem Catalogue (15 coding problems with testcases & multi-language starter templates)",
        "GitHub OAuth Account Linking",
      ],
      apiGroups: {
        auth: "/api/auth",
        users: "/api/users",
        topics: "/api/topics",
        onboarding: "/api/onboarding",
        problems: "/api/problems",
        social: "/api/social",
      },
      endpoints: [
        { method: "GET", path: "/health", description: "Health check" },
        { method: "GET", path: "/ping", description: "Ping check" },
        { method: "GET", path: "/api/topics", description: "List all topics with categories" },
        { method: "GET", path: "/api/topics/dsa", description: "List DSA topics specifically" },
        { method: "GET", path: "/api/topics/:identifier", description: "Get specific topic details" },
        { method: "POST", path: "/api/auth/register", description: "Register new user account" },
        { method: "POST", path: "/api/auth/login", description: "Authenticate and get JWT token" },
        { method: "POST", path: "/api/auth/logout", description: "Revoke token (Protected)" },
        { method: "GET", path: "/api/auth/me", description: "Verify token & retrieve current user (Protected)" },
        { method: "POST", path: "/api/auth/change-password", description: "Change user password (Protected)" },
        { method: "GET", path: "/api/users/me", description: "Get authenticated profile (Protected)" },
        { method: "PUT", path: "/api/users/me", description: "Update profile name (Protected)" },
        { method: "PATCH", path: "/api/users/me/language", description: "Update preferred programming language (Protected)" },
        { method: "POST", path: "/api/onboarding", description: "Complete skill calibration & set topic levels (Protected)" },
        { method: "GET", path: "/api/onboarding/status", description: "Get onboarding calibration status (Protected)" },
        { method: "PATCH", path: "/api/onboarding/language", description: "Update language preference (Protected)" },
        { method: "GET", path: "/api/problems", description: "List all problems with difficulty, testcase count & templates" },
        { method: "GET", path: "/api/problems/:slug", description: "Get problem details with testcases & language starter templates" },
        { method: "POST", path: "/api/problems", description: "Create a problem definition (Admin)" },
        { method: "GET", path: "/api/social/:provider/link-url", description: "Get GitHub OAuth link URL (Protected)" },
        { method: "GET", path: "/api/social/:provider/callback", description: "OAuth callback handler" },
        { method: "DELETE", path: "/api/social/:provider", description: "Unlink social provider (Protected)" },
      ],
    });
  }
});

export default router;
