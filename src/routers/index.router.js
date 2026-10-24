import { Router } from "express";
import path from "path";
import { fileURLToPath } from "url";
import authRouter from "./auth.router.js";
import userRouter from "./user.router.js";
import topicRouter from "./topic.router.js";
import onboardingRouter from "./onboarding.router.js";
import socialRouter from "./social.router.js";
import problemRouter from "./problem.router.js";
import studyRouter from "./study.router.js";
import executionRouter from "./execution.router.js";
import themeRouter from "./theme.router.js";
import adminRouter from "./admin.router.js";
import rankingRouter from "./ranking.router.js";

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
router.use("/api/themes", themeRouter);
router.use("/api/admin", adminRouter);
router.use("/api/rankings", rankingRouter);

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
        "Problem Catalogue (161 coding problems with testcases & multi-language starter templates)",
        "Code Execution Sandbox Runner & Submissions with Tier Evaluation",
        "GitHub OAuth Account Linking",
        "Admin Problem Management",
      ],
      apiGroups: {
        auth: "/api/auth",
        admin: "/api/admin",
        users: "/api/users",
        topics: "/api/topics",
        onboarding: "/api/onboarding",
        problems: "/api/problems",
        execution: "/api/execution",
        social: "/api/social",
        study: "/api/study",
        themes: "/api/themes",
      },
      endpoints: [
        { method: "GET", path: "/health", description: "Health check" },
        { method: "GET", path: "/ping", description: "Ping check" },
        { method: "GET", path: "/api/topics", description: "List all topics with categories" },
        { method: "GET", path: "/api/topics/dsa", description: "List DSA topics specifically" },
        { method: "GET", path: "/api/topics/:identifier", description: "Get specific topic details" },
        { method: "POST", path: "/api/auth/register", description: "Register new user account (Password >= 8 chars, <= 72 bytes, != email)" },
        { method: "POST", path: "/api/auth/login", description: "Authenticate and get JWT token (1d expiry)" },
        { method: "POST", path: "/api/auth/logout", description: "Revoke token persistently (Protected)" },
        { method: "POST", path: "/api/auth/refresh", description: "Refresh active token (Protected)" },
        { method: "GET", path: "/api/auth/me", description: "Verify token & retrieve current user (Protected)" },
        { method: "POST", path: "/api/auth/change-password", description: "Change user password (Protected)" },
        { method: "GET", path: "/api/users/me", description: "Get authenticated profile (Protected)" },
        { method: "PUT", path: "/api/users/me", description: "Update profile name (Protected)" },
        { method: "PATCH", path: "/api/users/me/language", description: "Update preferred programming language (Protected)" },
        { method: "POST", path: "/api/onboarding", description: "Complete skill calibration & set topic levels (Protected)" },
        { method: "GET", path: "/api/onboarding/status", description: "Get onboarding calibration status (Protected)" },
        { method: "PATCH", path: "/api/onboarding/language", description: "Update language preference (Protected)" },
        { method: "GET", path: "/api/problems", description: "List all problems with difficulty, testcase count & templates (Protected)" },
        { method: "GET", path: "/api/problems/:slug", description: "Get problem details with visible testcases & language starter templates (Protected)" },
        { method: "POST", path: "/api/admin/problems", description: "Create a problem definition (Admin only)" },
        { method: "GET", path: "/api/execution/languages", description: "Get supported languages (Protected)" },
        { method: "POST", path: "/api/execution/runs", description: "Run visible sample testcases with student stdout capture (Protected)" },
        { method: "POST", path: "/api/execution/submissions", description: "Asynchronous tiered submission evaluation - 202 Accepted (Protected)" },
        { method: "GET", path: "/api/execution/submissions/:id", description: "Get submission status and tier progress - Owner only (Protected)" },
        { method: "GET", path: "/api/social/:provider/link-url", description: "Get GitHub OAuth link URL (Protected)" },
        { method: "GET", path: "/api/social/:provider/callback", description: "OAuth callback handler with safe error codes & allow-list redirect" },
        { method: "DELETE", path: "/api/social/:provider", description: "Unlink social provider (Protected)" },
        { method: "GET", path: "/api/study/subjects", description: "List curriculum subjects (Public)" },
        { method: "GET", path: "/api/study/subjects/:subjectSlug", description: "Get subject chapters (Public)" },
        { method: "GET", path: "/api/study/topics/:topicSlug", description: "Get study topic reading & MCQs (Public)" },
        { method: "POST", path: "/api/study/topics/:topicSlug/submit", description: "Submit MCQ quiz answers & save progress (Protected)" },
      ],
    });
  }
});

export default router;
