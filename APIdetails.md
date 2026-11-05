# Calibr8 — Complete Frontend Developer & AI Agent API Documentation

> **Document Version**: 2.0.0 (Production Release)  
> **Target Audience**: Frontend Engineers, Mobile Developers (React, Next.js, Vue, React Native, Flutter, Swift, Kotlin), and AI Coding Agents.  
> **Backend Base URL**: `http://localhost:3000` (Dev server binds to `0.0.0.0:3000`).  
> **Global API Prefix**: `/api` (with root convenience routes `/health`, `/ping`, and developer console at `/`).  
> **Default Content-Type**: `application/json`  
> **Default Auth Scheme**: `Authorization: Bearer <jwt-token>`  
> **All Time Formats**: ISO 8601 UTC strings (e.g., `2026-10-24T12:00:00.000Z`).  
> **Supported Programming Languages**: `cpp` (GCC 13 / C++20), `c` (GCC 13), `java` (OpenJDK 17), `python` (Python 3.10), `javascript` (Node.js 22).

---

## Table of Contents

1. [Global API Protocols & Design Principles](#1-global-api-protocols--design-principles)
2. [Master Error Codes & HTTP Status Taxonomy](#2-master-error-codes--http-status-taxonomy)
3. [Complete TypeScript Type Definitions](#3-complete-typescript-type-definitions)
4. [Frontend Client Implementation Guide (Fetch & Axios Interceptors)](#4-frontend-client-implementation-guide)
5. [System & Health APIs](#5-system--health-apis)
6. [Authentication & Session Lifecycle APIs (`/api/auth`)](#6-authentication--session-lifecycle-apis-apiauth)
7. [User Profile, Academic & Solve Status APIs (`/api/users`)](#7-user-profile-academic--solve-status-apis-apiusers)
8. [Topics & Categories APIs (`/api/topics`)](#8-topics--categories-apis-apitopics)
9. [Onboarding & Baseline Skill Calibration APIs (`/api/onboarding`)](#9-onboarding--baseline-skill-calibration-apis-apionboarding)
10. [Problems Catalogue & Details APIs (`/api/problems`)](#10-problems-catalogue--details-apis-apiproblems)
11. [Code Execution Sandbox, Submissions & Complexity APIs (`/api/execution`)](#11-code-execution-sandbox-submissions--complexity-apis-apiexecution)
12. [Social & GitHub OAuth Account Linking APIs (`/api/social`)](#12-social--github-oauth-account-linking-apis-apisocial)
13. [Computer Science Curriculum & Study Material APIs (`/api/study`)](#13-computer-science-curriculum--study-material-apis-apistudy)
14. [Themes, Store & Personalization APIs (`/api/themes`)](#14-themes-store--personalization-apis-apithemes)
15. [Global Rankings & Leaderboard APIs (`/api/rankings`)](#15-global-rankings--leaderboard-apis-apirankings)
16. [Gamification, Scoring, Streaks & Tiers Mathematics](#16-gamification-scoring-streaks--tiers-mathematics)
17. [Rate Limits, Quotas & Security Governance](#17-rate-limits-quotas--security-governance)
18. [Zero-Config Dual-Tier Database & Auto-Healing Architecture](#18-zero-config-dual-tier-database--auto-healing-architecture)

---

## 1. Global API Protocols & Design Principles

### 1.1 Architectural Pattern
The Calibr8 backend follows a clean **Router-Controller-Model** pattern:
- **Routers** (`src/routers/*.router.js`): Responsible exclusively for route matching, mounting middleware (authentication, rate limits, in-flight execution counters), and delegating to controllers.
- **Controllers** (`src/controllers/*.controller.js`): Encapsulate domain logic, input validation, transaction boundaries, and response formatting.
- **Utilities & Services** (`src/utils/`, `src/services/`): Self-contained algorithms for code building, driver injection, output comparison, gamification rewards, and AST complexity parsing.
- **Database Layer** (`src/config/db.js`, `prisma/schema.prisma`): Transparent proxy connecting either to PostgreSQL/Neon or maintaining state via an in-memory database store when running without an external database.

### 1.2 Response Shape Consistency

#### Single Entity or Action Response
Endpoints returning an individual object or completing an operation return a standard payload wrapped with `success: true`:
```json
{
  "success": true,
  "message": "Operation completed successfully.",
  "data": { ... }
}
```

#### Collections & Catalogues
Endpoints returning lists return the data array along with a count metadata:
```json
{
  "success": true,
  "count": 25,
  "data": [ ... ]
}
```

#### Asynchronous Queued Jobs
Endpoints that initiate asynchronous long-running jobs (such as multi-tier code evaluation) return HTTP `202 Accepted` with a tracking ID and polling URL:
```json
{
  "success": true,
  "submissionId": "sub_1740001234_abc89f",
  "status": "QUEUED",
  "pollUrl": "/api/execution/submissions/sub_1740001234_abc89f",
  "message": "Submission received and queued for execution."
}
```

### 1.3 Strict Anti-Information Leak Policy
Hidden testcases used for grading student code **are never exposed to the client**:
1. When retrieving problem details via `GET /api/problems/:slug`, only test cases with `isVisible === true` are returned.
2. In submission evaluation results (`POST /api/execution/submissions` and `GET /api/execution/submissions/:id`), all case items are filtered through `publicTestResults()`. Hidden test cases have their `input`, `expected`, and `actual` fields stripped, leaving only `testIndex`, `isVisible: false`, `passed`, `status`, `time`, and `memory`.
3. In `firstFailure`, if the failing test case is hidden, the system emits an obfuscated message (e.g. `"Failed on hidden evaluation test case #4."`) without leaking inputs or expected values.

---

## 2. Master Error Codes & HTTP Status Taxonomy

Every error emitted by the backend (4xx and 5xx) strictly adheres to this JSON schema:

```json
{
  "success": false,
  "code": "ERROR_CODE_STRING",
  "message": "Human-friendly explanation of the error.",
  "details": {}
}
```

### Complete Error Code Registry

| HTTP Status | Error Code | Description / Trigger Scenario | Resolution / Client Action |
| :--- | :--- | :--- | :--- |
| `400 Bad Request` | `VALIDATION_ERROR` | Missing required payload fields or invalid data types. | Inspect `message` and supply required fields. |
| `400 Bad Request` | `INVALID_EMAIL` | Email fails standard RFC regex format. | Prompt user for a valid email format. |
| `400 Bad Request` | `WEAK_PASSWORD` | Password has fewer than 8 characters. | Prompt user for a password of at least 8 characters. |
| `400 Bad Request` | `PASSWORD_TOO_LONG` | Password exceeds bcrypt 72-byte limit. | Restrict password length to $\le 72$ bytes. |
| `400 Bad Request` | `PASSWORD_EQUALS_EMAIL` | Password matches the user's email address. | Enforce distinct password from email. |
| `400 Bad Request` | `MISSING_CODE` | Code string is null, empty, or whitespace-only. | Ensure editor content is non-empty before running. |
| `400 Bad Request` | `FUNCTION_ONLY_REQUIRED` | Student submitted `main()` or entrypoint wrapper. | Strip `main()` and submit only the solution function/class. |
| `400 Bad Request` | `INSUFFICIENT_COINS` | Coin balance lower than theme purchase price. | Solve problems to earn required coins. |
| `400 Bad Request` | `ALREADY_OWNED` | User already owns the requested theme. | Switch directly to theme via `PUT /api/themes/apply`. |
| `400 Bad Request` | `NO_TESTCASES` | Problem has no sample testcases configured for run. | Contact platform administrator. |
| `401 Unauthorized` | `UNAUTHORIZED` | Missing or invalid `Authorization: Bearer <token>` header. | Redirect user to login or refresh token. |
| `401 Unauthorized` | `INVALID_CREDENTIALS` | Incorrect email or password during login. | Display invalid credentials message. |
| `401 Unauthorized` | `TOKEN_REVOKED` | Token was invalidated via `POST /api/auth/logout`. | Clear local storage and prompt user to log in again. |
| `401 Unauthorized` | `TOKEN_EXPIRED` | JWT has passed its `exp` expiration timestamp. | Call `POST /api/auth/refresh` or re-authenticate. |
| `401 Unauthorized` | `INVALID_CURRENT_PASSWORD` | Old password mismatch during password update. | Verify existing password before submitting change. |
| `403 Forbidden` | `FORBIDDEN` | Access denied (e.g. attempting to apply unowned theme). | Purchase theme before applying. |
| `404 Not Found` | `NOT_FOUND` | Problem, topic, chapter, subject, or theme does not exist. | Verify slug/ID parameters in the route. |
| `404 Not Found` | `SUBMISSION_NOT_FOUND` | Submission ID does not exist or belongs to another user. | Verify submission ownership. |
| `409 Conflict` | `EMAIL_ALREADY_EXISTS` | Registration email already registered in system. | Suggest password recovery or login. |
| `409 Conflict` | `SOCIAL_ALREADY_LINKED` | Social account already attached to another profile. | Log in with that social provider instead. |
| `413 Payload Too Large` | `CODE_TOO_LARGE` | Submitted code string exceeds 64 KB limit. | Reduce code size or remove large embedded literals. |
| `422 Unprocessable` | `UNSUPPORTED_LANGUAGE` | Language not in `[cpp, c, java, python, javascript]`. | Select a supported language from the dropdown. |
| `429 Too Many Requests` | `RATE_LIMITED` | User/IP exceeded rate limit for runs, submits, or auth. | Back off and display remaining cooldown timer. |
| `429 Too Many Requests` | `IN_FLIGHT_LIMIT_EXCEEDED`| More than 2 concurrent executions running for this user. | Wait for active run/submit job to settle. |
| `503 Service Unavailable` | `EXECUTION_UNAVAILABLE` | Codebox VPS is unconfigured, unreachable, or timed out. | Display temporary execution outage banner. |
| `503 Service Unavailable` | `DATABASE_UNAVAILABLE` | Database connection lost and unable to recover. | Retry operation shortly. |
| `503 Service Unavailable` | `SUBMISSION_STORAGE_UNAVAILABLE` | Failed to persist submission state to database. | Prompt user to retry submission. |
| `500 Server Error` | `INTERNAL_ERROR` | Unhandled runtime exception. | Details logged on server; sanitized for client. |

---

## 3. Complete TypeScript Type Definitions

Include these interfaces in your frontend client codebase (`src/types/calibr8-api.ts`):

```typescript
// ==========================================
// 1. Core User, Auth & Profile
// ==========================================

export type SupportedLanguage = "cpp" | "c" | "java" | "python" | "javascript";
export type UserDifficulty = "easy" | "medium" | "hard";

export type UserTier =
  | "Pulse I"
  | "Pulse II"
  | "Pulse III"
  | "Prism I"
  | "Prism II"
  | "Prism III"
  | "Aurora I"
  | "Aurora II"
  | "Aurora III"
  | "Eclipse I"
  | "Eclipse II"
  | "Eclipse III"
  | "Zenith I"
  | "Zenith II";

export interface UserHeaderStats {
  rating: number;
  tier: UserTier;
  score: number;
  scoreUnits: number;
  coins: number;
  streak: number;
  longestStreak: number;
}

export interface SocialAccount {
  id: string;
  provider: "github";
  providerUserId: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  connectedAt: string;
}

export interface UserTopicLevel {
  id: string;
  userId: string;
  topicId: string;
  level: "easy" | "medium" | "hard";
  topic?: Topic;
}

export interface User {
  id: string;
  email: string;
  name: string;
  difficulty: UserDifficulty | null;
  rating: number;
  score: number;
  streak: number;
  longestStreak: number;
  strictPercent: number;
  tier: UserTier;
  college: string | null;
  branch: string | null;
  batch: string | null;
  state: string | null;
  country: string;
  coins: number;
  onboarded: boolean;
  preferredLanguage: SupportedLanguage;
  activeThemeId?: string | null;
  createdAt: string;
  updatedAt: string;
  socialAccounts?: SocialAccount[];
  topics?: UserTopicLevel[];
}

export interface AuthResponse {
  success: boolean;
  message: string;
  token: string;
  isNewUser?: boolean;
  user: User;
}

export interface AuthSessionResponse {
  success: boolean;
  user: User;
  stats: UserHeaderStats;
}

export interface UserActivityMatrix {
  [dateIso: string]: number; // e.g. "2026-10-29": 3
}

export interface UserActivityResponse {
  success: boolean;
  activity: UserActivityMatrix;
  total: number;
  activeDays: number;
}

export interface UserOverviewResponse {
  success: boolean;
  user: User;
  activity: UserActivityMatrix;
  total: number;
  activeDays: number;
}

// ==========================================
// 2. Topics & Categories
// ==========================================

export interface Topic {
  id: string;
  slug: string;
  name: string;
  category: "DSA" | "CORE";
}

export interface TopicsListResponse {
  success: boolean;
  count: number;
  topics: Topic[];
  dsaTopics: Topic[];
  coreTopics: Topic[];
}

export interface DsaCategory {
  id: string;
  slug: string;
  name: string;
  order: number;
  totalProblems: number;
}

// ==========================================
// 3. Problems Catalogue
// ==========================================

export interface ProblemCatalogueItem {
  id: string;
  problemNumber: number;
  slug: string;
  title: string;
  difficulty: "Easy" | "Medium" | "Hard";
  timeLimit: number;
  memoryLimit: number;
  solvedCount: number;
  tags: string[];
  isSolved?: boolean;
  _count?: {
    testcases: number;
    templates: number;
  };
}

export interface ProblemsListResponse {
  success: boolean;
  count: number;
  total: number;
  page: number;
  pageSize: number;
  data: ProblemCatalogueItem[];
}

export interface TestCase {
  testIndex: number;
  isVisible: boolean;
  input: string;
  output: string;
  stdinSmall?: string;
  expectedSmall?: string;
}

export interface ProblemDetail {
  id: string;
  problemNumber: number;
  slug: string;
  title: string;
  description: string;
  difficulty: "Easy" | "Medium" | "Hard";
  timeLimit: number;
  memoryLimit: number;
  solvedCount: number;
  tags: string[];
  testcases: TestCase[]; // Strictly sample visible cases only
  templates: Record<SupportedLanguage, string>;
  templatesMap?: Record<SupportedLanguage, string>;
}

// ==========================================
// 4. Code Execution & Submissions
// ==========================================

export type ExecutionCaseStatus =
  | "Accepted"
  | "Wrong Answer"
  | "Runtime Error"
  | "Time Limit Exceeded"
  | "Compilation Error";

export interface ExecutionLanguage {
  key: SupportedLanguage;
  label: string;
  version: string;
  judge0Id: number;
  starterAvailable: boolean;
  monacoLanguage: string;
}

export interface RunCaseResult {
  index: number;
  testIndex: number;
  isVisible: boolean;
  input: string;
  expected: string;
  actual: string;
  studentStdout: string;
  status: ExecutionCaseStatus;
  passed: boolean;
  timeMs: number;
  cpuTimeMs?: number;
  wallTimeMs?: number;
  memoryKb: number;
  inputBytes?: number;
  errorText?: string | null;
}

export interface RunResponse {
  success: boolean;
  status: ExecutionCaseStatus;
  passedCount: number;
  totalCount: number;
  cases: RunCaseResult[];
}

export interface SubmissionQueuedResponse {
  success: boolean;
  submissionId: string;
  status: "QUEUED";
  pollUrl: string;
  message: string;
  problem: {
    slug: string;
    title: string;
  };
}

export interface SubmissionReward {
  awarded: boolean;
  points: number;
  scoreDelta: number;
  coinsEarned: number;
  stats: UserHeaderStats;
}

export interface SubmissionFirstFailure {
  testIndex: number;
  status: string;
  errorText?: string | null;
  input?: string;
  expected?: string;
  actual?: string;
  message: string;
}

export interface PublicSubmissionCase {
  testIndex: number;
  isVisible: boolean;
  passed: boolean;
  status: string;
  time?: number;
  memory?: number;
  input?: string;     // Included ONLY if isVisible: true
  expected?: string;  // Included ONLY if isVisible: true
  actual?: string;    // Included ONLY if isVisible: true
}

export interface ComplexityEstimate {
  bestEstimate: string; // e.g. "O(n)", "O(n log n)", "O(n^2)"
  confidence: "low" | "medium" | "high";
  explanation?: string;
}

export interface ComplexityAnalysisResult {
  time: ComplexityEstimate;
  space: ComplexityEstimate;
  details?: {
    nestedLoops: number;
    recursionDetected: boolean;
    dataStructuresAllocated: string[];
    empiricalPoints?: Array<{ n: number; timeMs: number }>;
  };
}

export interface SubmissionDetail {
  id: string;
  problemId: string;
  language: SupportedLanguage;
  status:
    | "QUEUED"
    | "PROCESSING"
    | "ACCEPTED"
    | "WRONG_ANSWER"
    | "RUNTIME_ERROR"
    | "TIME_LIMIT_EXCEEDED"
    | "COMPILATION_ERROR"
    | "ERROR";
  verdict: string;
  tierReached:
    | "Tier 0 (Failed)"
    | "Tier 1 (Brute Force)"
    | "Tier 2 (Better)"
    | "Tier 3 (Optimal)";
  passedCount: number;
  totalCount: number;
  time: string | null;
  memory: number | null;
  createdAt: string;
  reward?: SubmissionReward | null;
  rewardError?: boolean;
  firstFailure?: SubmissionFirstFailure | null;
  results: PublicSubmissionCase[];
  complexity?: ComplexityAnalysisResult | null;
  problem: {
    slug: string;
    title: string;
  };
}

// ==========================================
// 5. CS Curriculum & Study Materials
// ==========================================

export interface StudySubject {
  id: string;
  slug: "cn" | "dbms" | "oops" | "os" | "system-design";
  name: string;
  description: string | null;
  icon: string | null;
  order: number;
  _count: {
    chapters: number;
  };
}

export interface StudyChapter {
  id: string;
  slug: string;
  name: string;
  subjectId: string;
  order: number;
  _count?: {
    topics: number;
  };
}

export interface StudyMCQ {
  id: string;
  question: string;
  options: string[];
  difficulty: "Easy" | "Medium" | "Hard";
  order: number;
  // Note: correctIndex and explanation are strictly stripped for unsubmitted quizzes
}

export interface StudyTopicDetail {
  id: string;
  slug: string;
  name: string;
  order: number;
  content: string; // Comprehensive Markdown article
  isPublished: boolean;
  chapter: {
    id: string;
    slug: string;
    name: string;
    subject: {
      slug: string;
      name: string;
    };
  };
  mcqs: StudyMCQ[];
}

export interface MCQEvaluationResult {
  mcqId: string;
  correct: boolean;
  userAnswer: number;
  correctIndex: number;
  explanation: string;
}

export interface StudyQuizSubmitResponse {
  success: boolean;
  totalQuestions: number;
  score: number;
  percentage: number;
  results: MCQEvaluationResult[];
}

// ==========================================
// 6. Themes & Personalization
// ==========================================

export interface Theme {
  id: string;
  slug: string;
  name: string;
  price: number;
  previewColor: string | null;
  cssVars?: Record<string, string>;
  isDefault: boolean;
  owned: boolean;
  applied: boolean;
  canAfford: boolean;
}

export interface UserThemesStatusResponse {
  success: boolean;
  coins: number;
  activeTheme: string;
  ownedThemes: string[];
  stats?: UserHeaderStats;
}

// ==========================================
// 7. Rankings & Leaderboards
// ==========================================

export interface RankedUser {
  id: string;
  name: string;
  score: number;
  rating: number;
  streak: number;
  strictPercent: number;
  tier: UserTier;
  college: string | null;
  branch: string | null;
  batch: string | null;
  state: string | null;
  country: string;
  createdAt: string;
}

export interface RankingsResponse {
  success: boolean;
  count: number;
  data: RankedUser[];
}
```

---

## 4. Frontend Client Implementation Guide

### 4.1 Production Fetch Interceptor with Automatic Token Management

```typescript
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

interface RequestOptions extends RequestInit {
  requiresAuth?: boolean;
}

export async function apiRequest<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const { requiresAuth = true, headers: customHeaders, ...restOptions } = options;

  const headers = new Headers(customHeaders || {});
  if (!headers.has("Content-Type") && !(restOptions.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  if (requiresAuth && typeof window !== "undefined") {
    const token = localStorage.getItem("calibr8_token");
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  const url = `${API_BASE_URL}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;

  const response = await fetch(url, {
    ...restOptions,
    headers,
  });

  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    // Auto-logout on token invalidation
    if (response.status === 401 && typeof window !== "undefined") {
      localStorage.removeItem("calibr8_token");
      localStorage.removeItem("calibr8_user");
      window.dispatchEvent(new Event("calibr8_session_expired"));
    }
    // Rejects with standardized error payload { success: false, code, message, details }
    throw payload;
  }

  return payload as T;
}
```

### 4.2 React Hook for Polling Asynchronous Submissions

```typescript
import { useState, useEffect, useRef } from "react";
import { apiRequest } from "./apiClient";
import type { SubmissionDetail } from "./types";

export function useSubmissionPoller(submissionId: string | null, pollIntervalMs = 1000) {
  const [submission, setSubmission] = useState<SubmissionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<any>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!submissionId) return;

    let isSubscribed = true;
    setLoading(true);

    const poll = async () => {
      try {
        const res = await apiRequest<{ success: boolean; submission: SubmissionDetail }>(
          `/api/execution/submissions/${submissionId}`
        );

        if (!isSubscribed) return;
        setSubmission(res.submission);

        const status = res.submission.status;
        const terminalStates = [
          "ACCEPTED",
          "WRONG_ANSWER",
          "RUNTIME_ERROR",
          "TIME_LIMIT_EXCEEDED",
          "COMPILATION_ERROR",
          "ERROR",
        ];

        if (!terminalStates.includes(status)) {
          timerRef.current = setTimeout(poll, pollIntervalMs);
        } else {
          setLoading(false);
        }
      } catch (err) {
        if (!isSubscribed) return;
        setError(err);
        setLoading(false);
      }
    };

    poll();

    return () => {
      isSubscribed = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [submissionId, pollIntervalMs]);

  return { submission, loading, error };
}
```

---

## 5. System & Health APIs

### 5.1 Root Manifest & Developer Console
- **Method & Route**: `GET /`
- **Protected**: No
- **Headers**:
  - `Accept: application/json` $\rightarrow$ Returns comprehensive JSON service manifest with features, naming conventions, and API groups.
  - `Accept: text/html` $\rightarrow$ Serves the interactive developer dashboard (`public/index.html`) with embedded test suites and 1-click authentication.
- **Success Response (`200 OK`)**:
```json
{
  "service": "Calibr8 Backend API",
  "status": "online",
  "version": "1.2.0",
  "architecture": {
    "pattern": "Router-Controller-Model",
    "namingConvention": "*.router.js, *.controller.js"
  },
  "features": [
    "User Registration, Login, Logout & Token Revocation",
    "DSA Topic Level Calibration (Easy, Mid, Hard)",
    "Beginner 1-Click Preset (Auto-sets all DSA topics to Easy, rating 800)",
    "Composite Rating Calculation & Difficulty Mapping",
    "Profile Management & Language Preferences",
    "Problem Catalogue (161 coding problems with testcases & multi-language starter templates)",
    "Code Execution Sandbox Runner & Submissions with Tier Evaluation",
    "GitHub OAuth Account Linking"
  ],
  "apiGroups": {
    "auth": "/api/auth",
    "users": "/api/users",
    "topics": "/api/topics",
    "onboarding": "/api/onboarding",
    "problems": "/api/problems",
    "execution": "/api/execution",
    "social": "/api/social",
    "study": "/api/study",
    "themes": "/api/themes",
    "rankings": "/api/rankings"
  }
}
```

### 5.2 Health Check
- **Method & Route**: `GET /health` or `GET /api/health`
- **Protected**: No
- **Success Response (`200 OK`)**:
```json
{
  "status": "ok",
  "service": "Calibr8 Backend",
  "timestamp": "2026-10-24T12:00:00.000Z"
}
```

### 5.3 Ping Check
- **Method & Route**: `GET /ping` or `GET /api/ping`
- **Protected**: No
- **Success Response (`200 OK`)**: Plain text `pong`.

---

## 6. Authentication & Session Lifecycle APIs (`/api/auth`)

### 6.1 Register Account
Creates a new student account, hashes the password via bcrypt (salt rounds: 10), initializes default gamification stats (100 coins, rating: 800, tier: "Prism I"), and returns a signed JWT.

- **Method & Route**: `POST /api/auth/register`
- **Protected**: No
- **Rate Limit**: 30 requests / 15 minutes / IP
- **Content-Type**: `application/json`
- **Request Body**:
```json
{
  "email": "student@example.com",
  "password": "StrongPassword123",
  "name": "Alex Mercer"
}
```
*Validation Rules*:
- `email`: Required, valid email string, normalized to lowercase.
- `password`: Required, 8–72 characters, must not match email (case-insensitive).
- `name`: Required, non-empty trimmed string.

- **Success Response (`201 Created`)**:
```json
{
  "success": true,
  "message": "User registered successfully.",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "isNewUser": true,
  "user": {
    "id": "u-45a8-bc91-2309",
    "email": "student@example.com",
    "name": "Alex Mercer",
    "difficulty": null,
    "rating": 800,
    "score": 0,
    "coins": 100,
    "onboarded": false,
    "preferredLanguage": "cpp"
  }
}
```

---

### 6.2 User Login
Authenticates credentials against stored bcrypt hash and generates a signed JWT (1-day expiration).

- **Method & Route**: `POST /api/auth/login`
- **Protected**: No
- **Rate Limit**: 30 requests / 15 minutes / IP
- **Request Body**:
```json
{
  "email": "student@example.com",
  "password": "StrongPassword123"
}
```

- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "message": "Login successful.",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "isNewUser": false,
  "user": {
    "id": "u-45a8-bc91-2309",
    "email": "student@example.com",
    "name": "Alex Mercer",
    "difficulty": "medium",
    "rating": 1200,
    "score": 450,
    "coins": 100,
    "onboarded": true,
    "preferredLanguage": "python"
  }
}
```

---

### 6.3 Verify Auth Session & Header Stats
Validates active token, restores session via database or auto-healing, and returns user details alongside compact header stats.

- **Method & Route**: `GET /api/auth/me` (Alias: `GET /api/auth/verify`)
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "user": {
    "id": "u-45a8-bc91-2309",
    "email": "student@example.com",
    "name": "Alex Mercer",
    "difficulty": "medium",
    "rating": 1200,
    "coins": 100,
    "onboarded": true,
    "preferredLanguage": "python",
    "socialAccounts": [],
    "topics": []
  },
  "stats": {
    "rating": 1200,
    "tier": "Prism II",
    "score": 450,
    "scoreUnits": 4500,
    "coins": 100,
    "streak": 3,
    "longestStreak": 7
  }
}
```

---

### 6.4 Refresh Active Token
Generates a fresh JWT for an authenticated user without requiring re-entering credentials.

- **Method & Route**: `POST /api/auth/refresh`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "message": "Token refreshed successfully.",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

### 6.5 Change Password
Validates the user's existing password and updates it with a new bcrypt-hashed value.

- **Method & Route**: `POST /api/auth/change-password`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Request Body**:
```json
{
  "currentPassword": "OldPassword123",
  "newPassword": "NewStrongPassword456"
}
```
*Validation*: `newPassword` must be $\ge 8$ characters, $\le 72$ bytes, and differ from the user's email.

- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "message": "Password changed successfully."
}
```

---

### 6.6 Logout & Token Revocation
Permanently revokes the presenting JWT token by extracting its unique `jti` identifier and persisting it to the blacklist store until token expiration.

- **Method & Route**: `POST /api/auth/logout`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "message": "Logged out successfully. Token has been revoked."
}
```

---

## 7. User Profile, Academic & Solve Status APIs (`/api/users`)

### 7.1 Get Profile Details
- **Method & Route**: `GET /api/users/me` (Alias: `GET /api/users/`)
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "user": {
    "id": "u-45a8-bc91-2309",
    "email": "student@example.com",
    "name": "Alex Mercer",
    "difficulty": "medium",
    "rating": 1200,
    "score": 3400,
    "streak": 14,
    "longestStreak": 14,
    "strictPercent": 92,
    "tier": "Prism II",
    "college": "AKGEC",
    "branch": "CSE",
    "batch": "2026",
    "state": "UP",
    "country": "India",
    "coins": 120,
    "onboarded": true,
    "preferredLanguage": "cpp",
    "createdAt": "2026-09-10T08:00:00.000Z",
    "updatedAt": "2026-10-24T06:00:00.000Z",
    "socialAccounts": [],
    "topics": [
      {
        "id": "ut-1",
        "topicId": "t-1",
        "level": "medium",
        "topic": {
          "id": "t-1",
          "slug": "dsa-arrays",
          "name": "DSA - Arrays",
          "category": "DSA"
        }
      }
    ]
  }
}
```

---

### 7.2 Combined Profile Overview (Profile + 371-Day Activity)
Engineered for the profile screen to fetch user data and historical heatmap activity in a single round-trip.

- **Method & Route**: `GET /api/users/me/overview`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "user": {
    "id": "u-45a8-bc91-2309",
    "email": "student@example.com",
    "name": "Alex Mercer",
    "college": "AKGEC",
    "branch": "CSE",
    "batch": "2026",
    "state": "UP",
    "country": "India",
    "socialAccounts": [],
    "topics": []
  },
  "activity": {
    "2026-10-28": 2,
    "2026-10-29": 1
  },
  "total": 3,
  "activeDays": 2
}
```

---

### 7.3 Update Profile Name & Academic Information
- **Method & Route**: `PATCH /api/users/me`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Request Body** (at least one field required):
```json
{
  "name": "Alexander Mercer",
  "college": "AKGEC",
  "branch": "Computer Science",
  "batch": "2026",
  "state": "UP",
  "country": "India"
}
```

- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "user": {
    "id": "u-45a8-bc91-2309",
    "name": "Alexander Mercer",
    "email": "student@example.com",
    "college": "AKGEC",
    "branch": "Computer Science",
    "batch": "2026",
    "state": "UP",
    "country": "India"
  }
}
```

---

### 7.4 Update Preferred Programming Language
Updates the default language used to load editor starter templates and execution payloads.

- **Method & Route**: `PATCH /api/users/me/language` (Alias: `PATCH /api/users/language`)
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Request Body**:
```json
{
  "language": "python"
}
```
*Allowed options*: `cpp`, `c`, `java`, `python`, `javascript`.

- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "language": "python"
}
```

---

### 7.5 Get Successful Submission Activity Matrix
Returns daily counts of submissions that passed 100% of testcases over the trailing 371 days.

- **Method & Route**: `GET /api/users/me/activity`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "activity": {
    "2026-10-28": 2,
    "2026-10-29": 1
  },
  "total": 3,
  "activeDays": 2
}
```

---

### 7.6 List All Problems with User Solve Status
Returns problem catalogue items formatted specifically for track views, showing whether the authenticated user has solved each problem.

- **Method & Route**: `GET /api/users/all`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "message": "Problems fetched successfully",
  "data": [
    {
      "name": "Two Sum",
      "slug": "two-sum-001",
      "number": 1,
      "topic": "Arrays & Hashing",
      "topicSlug": "arrays-and-hashing",
      "level": "easy",
      "levelDisplay": "easy",
      "solvedPercentage": 74,
      "isSolved": true
    }
  ]
}
```

---

## 8. Topics & Categories APIs (`/api/topics`)

### 8.1 List All Calibration Topics
- **Method & Route**: `GET /api/topics`
- **Protected**: No (Public)
- **Query Parameters**:
  - `category` (optional): Filter to `'dsa'` or `'core'`.
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "count": 9,
  "topics": [
    { "id": "t-1", "slug": "dsa-arrays", "name": "DSA - Arrays", "category": "DSA" },
    { "id": "t-2", "slug": "dsa-graphs-dp", "name": "DSA - Graphs & DP", "category": "DSA" },
    { "id": "t-6", "slug": "dbms", "name": "DBMS", "category": "CORE" }
  ],
  "dsaTopics": [
    { "id": "t-1", "slug": "dsa-arrays", "name": "DSA - Arrays", "category": "DSA" }
  ],
  "coreTopics": [
    { "id": "t-6", "slug": "dbms", "name": "DBMS", "category": "CORE" }
  ]
}
```

---

### 8.2 List Structured DSA Categories (Tracks Page)
- **Method & Route**: `GET /api/topics/dsa/categories` (Public Alias: `GET /api/topics/categories`)
- **Protected**: No (Public)
- **Success Response (`200 OK`)**:
```json
[
  {
    "id": "cat-1",
    "slug": "arrays-and-hashing",
    "name": "Arrays & Hashing",
    "order": 1,
    "totalProblems": 24
  },
  {
    "id": "cat-2",
    "slug": "two-pointers",
    "name": "Two Pointers",
    "order": 2,
    "totalProblems": 14
  }
]
```

---

### 8.3 Get Problems in a DSA Category
- **Method & Route**: `GET /api/topics/dsa/:slug/problems`
- **Protected**: No (Public)
- **Path Parameter**: `:slug` (e.g. `arrays-and-hashing`)
- **Query Parameters**:
  - `difficulty` (optional): `'Easy'`, `'Medium'`, or `'Hard'`.
  - `search` (optional): Keyword search matching problem title or slug.
- **Success Response (`200 OK`)**:
```json
{
  "topic": {
    "id": "cat-1",
    "slug": "arrays-and-hashing",
    "name": "Arrays & Hashing"
  },
  "count": 12,
  "problems": [
    {
      "id": "p-1",
      "problemNumber": 1,
      "slug": "two-sum-001",
      "title": "Two Sum",
      "difficulty": "Easy",
      "tags": ["Array", "Hash Table"]
    }
  ]
}
```

---

## 9. Onboarding & Baseline Skill Calibration APIs (`/api/onboarding`)

### 9.1 Submit Skill Calibration
Calibrates student skill across DSA topics, calculates initial Elo rating, sets `user.onboarded = true`, and links topic levels in an atomic transaction.

- **Method & Route**: `POST /api/onboarding` (Alias: `PUT /api/onboarding/levels`)
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Rate Limit**: 20 requests per minute per user

#### Supported Modes:
1. **Granular Per-Topic Selection** (Recommended for UI sliders):
```json
{
  "topicSelections": [
    { "topicId": "dsa-arrays", "difficulty": "easy" },
    { "topicId": "dsa-graphs-dp", "difficulty": "medium" },
    { "topicId": "dsa-trees", "difficulty": "hard" }
  ]
}
```
2. **Global Preset**:
```json
{
  "difficulty": "medium",
  "topicIds": "all"
}
```
3. **1-Click Beginner Preset**:
```json
{
  "beginner": true
}
```

- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "user": {
    "id": "u-45a8-bc91-2309",
    "email": "student@example.com",
    "name": "Alex Mercer",
    "difficulty": "medium",
    "rating": 1200,
    "onboarded": true,
    "preferredLanguage": "cpp",
    "topics": [
      {
        "id": "ut-1",
        "userId": "u-45a8-bc91-2309",
        "topicId": "t-1",
        "level": "medium",
        "topic": {
          "id": "t-1",
          "slug": "dsa-arrays",
          "name": "DSA - Arrays",
          "category": "DSA"
        }
      }
    ]
  }
}
```

---

### 9.2 Get Onboarding Status
- **Method & Route**: `GET /api/onboarding/status`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "user": {
    "id": "u-45a8-bc91-2309",
    "email": "student@example.com",
    "name": "Alex Mercer",
    "difficulty": "medium",
    "rating": 1200,
    "onboarded": true,
    "preferredLanguage": "cpp",
    "topics": [ ... ]
  }
}
```

---

## 10. Problems Catalogue & Details APIs (`/api/problems`)

### 10.1 List All Problems
- **Method & Route**: `GET /api/problems`
- **Protected**: Optional (if token is provided, `isSolved` is calculated per problem)
- **Query Parameters**:
  - `difficulty` (optional): `'Easy'`, `'Medium'`, or `'Hard'`.
  - `topic` (optional): Filter by topic slug (e.g. `arrays-and-hashing`).
  - `search` (optional): Search query matching problem title or slug.
  - `status` (optional): `'solved'`, `'unsolved'`.
  - `page` (optional): Integer $\ge 1$ (default `1`).
  - `pageSize` (optional): Integer $1 \dots 100$ (default `25`).

- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "count": 10,
  "total": 161,
  "page": 1,
  "pageSize": 10,
  "data": [
    {
      "id": "p-1",
      "problemNumber": 1,
      "slug": "two-sum",
      "title": "Two Sum",
      "difficulty": "Easy",
      "timeLimit": 1000,
      "memoryLimit": 256,
      "solvedCount": 420,
      "tags": ["Array", "Hash Table"],
      "isSolved": false,
      "_count": {
        "testcases": 5,
        "templates": 5
      }
    }
  ]
}
```

---

### 10.2 Get Problem Details & Starter Templates
- **Method & Route**: `GET /api/problems/:slug`
- **Protected**: No (Public)
- **Security Rule**: Strict anti-leak policy. Only testcases with `isVisible: true` are returned. Hidden test cases are completely omitted.
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "problem": {
    "id": "p-1",
    "problemNumber": 1,
    "slug": "two-sum",
    "title": "Two Sum",
    "description": "Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.\n\nYou may assume that each input would have exactly one solution, and you may not use the same element twice.",
    "difficulty": "Easy",
    "timeLimit": 1000,
    "memoryLimit": 256,
    "solvedCount": 420,
    "tags": ["Array", "Hash Table"],
    "testcases": [
      {
        "testIndex": 0,
        "isVisible": true,
        "input": "4 9\n2 7 11 15",
        "output": "0 1"
      },
      {
        "testIndex": 1,
        "isVisible": true,
        "input": "3 6\n3 2 4",
        "output": "1 2"
      }
    ],
    "templates": {
      "cpp": "class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        // Write code here\n    }\n};",
      "python": "class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        # Write code here\n        pass",
      "javascript": "class Solution {\n    twoSum(nums, target) {\n        // Write code here\n    }\n}",
      "java": "class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        // Write code here\n    }\n}",
      "c": "int* twoSum(int* nums, int numsSize, int target, int* returnSize) {\n    // Write code here\n}"
    }
  }
}
```

---

## 11. Code Execution Sandbox, Submissions & Complexity APIs (`/api/execution`)

### 11.1 Supported Language Definitions
- **Method & Route**: `GET /api/execution/languages`
- **Protected**: No (Public)
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "languages": [
    {
      "key": "python",
      "label": "Python 3",
      "version": "Python 3.10",
      "judge0Id": 71,
      "starterAvailable": true,
      "monacoLanguage": "python"
    },
    {
      "key": "javascript",
      "label": "JavaScript",
      "version": "Node.js 22",
      "judge0Id": 63,
      "starterAvailable": true,
      "monacoLanguage": "javascript"
    },
    {
      "key": "cpp",
      "label": "C++ (GCC)",
      "version": "GCC 13 (C++20)",
      "judge0Id": 54,
      "starterAvailable": true,
      "monacoLanguage": "cpp"
    },
    {
      "key": "c",
      "label": "C (GCC)",
      "version": "GCC 13",
      "judge0Id": 50,
      "starterAvailable": true,
      "monacoLanguage": "c"
    },
    {
      "key": "java",
      "label": "Java (OpenJDK)",
      "version": "OpenJDK 17",
      "judge0Id": 62,
      "starterAvailable": true,
      "monacoLanguage": "java"
    }
  ]
}
```

---

### 11.2 Run Sample Testcases
Executes student code against **visible/sample test cases only** (`isVisible: true`). Captures debug output via result markers without polluting evaluation.

- **Method & Route**: `POST /api/execution/runs` (Aliases: `POST /api/execution/run`, `POST /api/execute/run`, `POST /api/problems/:slug/run`)
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Rate Limit**: 10 runs per minute per user; Max 2 in-flight executions.
- **Request Body**:
```json
{
  "slug": "two-sum",
  "language": "python",
  "code": "class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        seen = {}\n        for i, n in enumerate(nums):\n            diff = target - n\n            if diff in seen:\n                return [seen[diff], i]\n            seen[n] = i\n        return []"
}
```

- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "status": "Accepted",
  "passedCount": 2,
  "totalCount": 2,
  "cases": [
    {
      "index": 0,
      "testIndex": 0,
      "isVisible": true,
      "input": "4 9\n2 7 11 15",
      "expected": "0 1",
      "actual": "0 1",
      "studentStdout": "",
      "status": "Accepted",
      "passed": true,
      "timeMs": 42,
      "cpuTimeMs": 42,
      "wallTimeMs": 55,
      "memoryKb": 12840,
      "inputBytes": 16,
      "errorText": null
    }
  ]
}
```

---

### 11.3 Submit Solution for Full Evaluation
Evaluates student code across all testcases (sample + hidden) using true tier short-circuiting.

- **Method & Route**: `POST /api/execution/submissions` (Aliases: `POST /api/execution/submit`, `POST /api/execute/submit`)
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Rate Limit**: 6 submissions per minute per user; Max 2 in-flight executions.
- **Request Body**:
```json
{
  "slug": "two-sum",
  "language": "python",
  "code": "class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        ...",
  "wait": false
}
```

#### Execution Modes:
1. **Asynchronous Mode (`wait: false` or omitted)**: Returns `202 Accepted` immediately with `submissionId` and polling URL.
```json
{
  "success": true,
  "submissionId": "sub_1740001234_abc89f",
  "status": "QUEUED",
  "pollUrl": "/api/execution/submissions/sub_1740001234_abc89f",
  "message": "Submission received and queued for execution.",
  "problem": {
    "slug": "two-sum",
    "title": "Two Sum"
  }
}
```

2. **Synchronous Mode (`wait: true` or route `/api/execute/submit`)**: Holds connection until evaluation completes, returning `200 OK` with full verdict, rewards, and sanitized testcase results.

---

### 11.4 Poll Submission Status & Verdict
- **Method & Route**: `GET /api/execution/submissions/:id`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Security Rule**: Owner-only. Non-owners receive `404 SUBMISSION_NOT_FOUND`.
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "submission": {
    "id": "sub_1740001234_abc89f",
    "problemId": "p-two-sum",
    "language": "python",
    "status": "ACCEPTED",
    "verdict": "ACCEPTED",
    "tierReached": "Tier 3 (Optimal)",
    "passedCount": 5,
    "totalCount": 5,
    "time": "52ms",
    "memory": 13400,
    "createdAt": "2026-11-02T22:00:00.000Z",
    "reward": {
      "awarded": true,
      "points": 10,
      "scoreDelta": 100,
      "coinsEarned": 30,
      "stats": {
        "rating": 810,
        "tier": "Prism I",
        "score": 10,
        "scoreUnits": 100,
        "coins": 130,
        "streak": 1,
        "longestStreak": 1
      }
    },
    "rewardError": false,
    "firstFailure": null,
    "results": [
      {
        "testIndex": 0,
        "isVisible": true,
        "passed": true,
        "status": "Accepted",
        "input": "4 9\n2 7 11 15",
        "expected": "0 1",
        "actual": "0 1"
      },
      {
        "testIndex": 2,
        "isVisible": false,
        "passed": true,
        "status": "Accepted",
        "time": 48,
        "memory": 13400
      }
    ],
    "complexity": {
      "time": {
        "bestEstimate": "O(n)",
        "confidence": "high"
      },
      "space": {
        "bestEstimate": "O(n)",
        "confidence": "high"
      }
    },
    "problem": {
      "slug": "two-sum",
      "title": "Two Sum"
    }
  }
}
```

---

### 11.5 Standalone Complexity Analysis
Performs static AST and structural complexity analysis of student code.

- **Method & Route**: `POST /api/execution/analyze-complexity`
- **Protected**: Optional
- **Rate Limit**: 10 requests / minute
- **Request Body**:
```json
{
  "code": "def twoSum(nums, target):\n    for i in range(len(nums)):\n        for j in range(i + 1, len(nums)):\n            if nums[i] + nums[j] == target:\n                return [i, j]",
  "language": "python",
  "problemSlug": "two-sum"
}
```

- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "complexity": {
    "time": {
      "bestEstimate": "O(n^2)",
      "confidence": "high"
    },
    "space": {
      "bestEstimate": "O(1)",
      "confidence": "high"
    }
  }
}
```

---

## 12. Social & GitHub OAuth Account Linking APIs (`/api/social`)

### 12.1 Get GitHub OAuth Authorization URL
- **Method & Route**: `GET /api/social/:provider/link-url`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Path Parameter**: `:provider` (`github`)
- **Query Parameter**: `redirectUri` (optional destination frontend URL)
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "url": "https://github.com/login/oauth/authorize?client_id=...&scope=read:user%20user:email&state=..."
}
```

---

### 12.2 OAuth Callback Handler
- **Method & Route**: `GET /api/social/:provider/callback`
- **Protected**: No
- **Query Parameters**:
  - `code`: GitHub authorization temporary exchange code.
  - `state`: Cryptographically signed HMAC state containing userId and redirect URL.
- **Behavior**: Exchanges code for access token via GitHub API, retrieves profile, attaches account to user profile, and redirects back to `FRONTEND_URL` with short error/success codes.

---

### 12.3 Unlink Social Account
- **Method & Route**: `DELETE /api/social/:provider`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "message": "GitHub account unlinked successfully."
}
```

---

## 13. Computer Science Curriculum & Study Material APIs (`/api/study`)

### 13.1 List All Subjects
- **Method & Route**: `GET /api/study/subjects`
- **Protected**: No (Public)
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "count": 5,
  "subjects": [
    {
      "id": "subj-1",
      "slug": "cn",
      "name": "Computer Networks",
      "description": "Foundations of modern networking, OSI/TCP-IP models, protocols, and cloud routing.",
      "order": 1,
      "_count": { "chapters": 13 }
    },
    {
      "id": "subj-2",
      "slug": "dbms",
      "name": "Database Management Systems",
      "description": "Relational algebra, normalization, transaction processing, and PostgreSQL internals.",
      "order": 2,
      "_count": { "chapters": 16 }
    },
    {
      "id": "subj-3",
      "slug": "os",
      "name": "Operating Systems",
      "description": "Process scheduling, virtual memory, paging, and kernel synchronization primitives.",
      "order": 3,
      "_count": { "chapters": 16 }
    },
    {
      "id": "subj-4",
      "slug": "oops",
      "name": "Object-Oriented Programming",
      "description": "Core paradigms, SOLID design principles, and GoF design patterns.",
      "order": 4,
      "_count": { "chapters": 14 }
    },
    {
      "id": "subj-5",
      "slug": "system-design",
      "name": "System Design",
      "description": "Distributed architectures, microservices, caching topologies, and high-availability patterns.",
      "order": 5,
      "_count": { "chapters": 16 }
    }
  ]
}
```

---

### 13.2 Get Subject Details & Chapter Index
- **Method & Route**: `GET /api/study/subjects/:subjectSlug` (Alias: `GET /api/study/subjects/:subjectSlug/chapters`)
- **Protected**: No (Public)
- **Path Parameter**: `:subjectSlug` (`cn`, `dbms`, `os`, `oops`, `system-design`)
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "subject": {
    "id": "subj-1",
    "slug": "cn",
    "name": "Computer Networks",
    "chapters": [
      {
        "id": "chap-1",
        "slug": "01-networking-fundamentals",
        "name": "Networking Foundations & Switching",
        "order": 1,
        "_count": { "topics": 1 }
      }
    ]
  }
}
```

---

### 13.3 Get Chapter Topics
- **Method & Route**: `GET /api/study/chapters/:chapterId/topics`
- **Protected**: No (Public)
- **Path Parameter**: `:chapterId`
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "topics": [
    {
      "id": "top-1",
      "slug": "01-networking-foundations-and-switching",
      "name": "Networking Foundations and Switching",
      "order": 1
    }
  ]
}
```

---

### 13.4 Get Study Topic Reading Article & MCQs
Returns deep Markdown technical literature alongside practice MCQs.

- **Method & Route**: `GET /api/study/topics/:topicSlug`
- **Protected**: No (Public)
- **Path Parameter**: `:topicSlug` (e.g. `01-networking-foundations-and-switching`)
- **Security Rule**: `correctIndex` and `explanation` are strictly hidden until submitted.
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "topic": {
    "id": "st-1",
    "slug": "01-networking-foundations-and-switching",
    "name": "Networking Foundations and Switching",
    "order": 1,
    "content": "# Networking Foundations and Switching\n\nComputer networks interconnect computing nodes...",
    "isPublished": true,
    "chapter": {
      "id": "chap-1",
      "slug": "01-networking-fundamentals",
      "name": "Networking Foundations & Switching",
      "subject": {
        "slug": "cn",
        "name": "Computer Networks"
      }
    },
    "mcqs": [
      {
        "id": "mcq-1",
        "question": "Which layer in the OSI model is responsible for end-to-end reliability and flow control?",
        "options": [
          "Network Layer",
          "Transport Layer",
          "Data Link Layer",
          "Session Layer"
        ],
        "difficulty": "Easy",
        "order": 1
      }
    ]
  }
}
```

---

### 13.5 Submit Study Topic MCQ Quiz
Evaluates answers, returns explanations and correct answers, and saves quiz performance.

- **Method & Route**: `POST /api/study/topics/:topicSlug/submit`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Path Parameter**: `:topicSlug`
- **Request Body**:
```json
{
  "answers": [
    { "mcqId": "mcq-1", "selectedOption": 1 }
  ]
}
```

- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "totalQuestions": 1,
  "score": 1,
  "percentage": 100,
  "results": [
    {
      "mcqId": "mcq-1",
      "correct": true,
      "userAnswer": 1,
      "correctIndex": 1,
      "explanation": "The Transport Layer (Layer 4) provides transparent transfer of data between end users, providing reliable data transfer services including flow and error control."
    }
  ]
}
```

---

## 14. Themes, Store & Personalization APIs (`/api/themes`)

### 14.1 List Store Themes
Returns all visual themes with ownership, pricing, and affordability flags calculated for the authenticated user.

- **Method & Route**: `GET /api/themes`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "themes": [
    {
      "id": "th-default",
      "slug": "default",
      "name": "Calibr8 Dark",
      "price": 0,
      "previewColor": "#0b0f19",
      "isDefault": true,
      "owned": true,
      "applied": true,
      "canAfford": true
    },
    {
      "id": "th-orbit",
      "slug": "orbit",
      "name": "Orbit",
      "price": 50,
      "previewColor": "#1e1b4b",
      "isDefault": false,
      "owned": false,
      "applied": false,
      "canAfford": true
    }
  ]
}
```

---

### 14.2 Get Active Theme Status & Coin Balance
- **Method & Route**: `GET /api/themes/me`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "coins": 100,
  "activeTheme": "default",
  "ownedThemes": ["default"],
  "stats": {
    "rating": 800,
    "tier": "Prism I",
    "score": 0,
    "coins": 100,
    "streak": 0,
    "longestStreak": 0
  }
}
```

---

### 14.3 Purchase Theme with Coins
Deducts coins and grants theme ownership atomically.

- **Method & Route**: `POST /api/themes/:slug/buy`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Path Parameter**: `:slug` (e.g. `orbit`, `frost`, `editorial`, `mono`, `racer`, `arcade`)
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "message": "Bought Orbit",
  "theme": {
    "slug": "orbit",
    "applied": true,
    "owned": true
  },
  "coins": 50,
  "stats": {
    "rating": 800,
    "tier": "Prism I",
    "score": 0,
    "scoreUnits": 0,
    "coins": 50,
    "streak": 0,
    "longestStreak": 0
  }
}
```

---

### 14.4 Apply Owned Theme
- **Method & Route**: `PUT /api/themes/apply`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Request Body**:
```json
{
  "slug": "orbit"
}
```

- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "activeTheme": "orbit",
  "message": "Orbit applied"
}
```

---

## 15. Global Rankings & Leaderboard APIs (`/api/rankings`)

### 15.1 Get Leaderboard Rankings
Returns competitive student rankings with multi-dimensional filtering.

- **Method & Route**: `GET /api/rankings`
- **Protected**: No (Public)
- **Query Parameters**:
  - `scope` (optional): Filter scope (`'college'`, `'batch'`, `'state'`, or `'country'`).
  - `college` (optional): Exact college name (e.g. `'AKGEC'`).
  - `batch` (optional): Graduation batch year (e.g. `'2026'`).
  - `state` (optional): State / Province (e.g. `'UP'`).
  - `country` (optional): Country (e.g. `'India'`).
  - `limit` (optional): Integer $1 \dots 100$ (default `50`).

- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "count": 2,
  "data": [
    {
      "id": "u-rank-1",
      "name": "Riya Verma",
      "score": 48210,
      "rating": 1790,
      "streak": 132,
      "strictPercent": 88,
      "tier": "Zenith II",
      "college": "AKGEC",
      "branch": "CSE",
      "batch": "2026",
      "state": "UP",
      "country": "India",
      "createdAt": "2026-08-15T10:00:00.000Z"
    },
    {
      "id": "u-rank-2",
      "name": "Kabir Singh",
      "score": 46950,
      "rating": 1690,
      "streak": 97,
      "strictPercent": 74,
      "tier": "Eclipse III",
      "college": "AKGEC",
      "branch": "CSE",
      "batch": "2026",
      "state": "UP",
      "country": "India",
      "createdAt": "2026-08-20T10:00:00.000Z"
    }
  ]
}
```

---

## 16. Gamification, Scoring, Streaks & Tiers Mathematics

### 16.1 Problem Solved Reward Matrix
Upon an accepted submission passing 100% of testcases, rewards are granted based on problem difficulty:

| Problem Difficulty | Points Awarded | Score Units Delta ($\times 10$) | Coins Credited |
| :--- | :--- | :--- | :--- |
| **Easy** | **10 Points** | $+100$ Score Units | $+30$ Coins |
| **Medium** | **25 Points** | $+250$ Score Units | $+60$ Coins |
| **Hard** | **50 Points** | $+500$ Score Units | $+90$ Coins |

*Idempotency & Re-Solve Rules*:
- Points and coins are awarded **only once per problem per user** (verified via `user_problem_progress`).
- If a user re-submits an already solved problem, `awarded: false`, `points: 0`, and `coinsEarned: 0` are returned. However, the user's daily streak is still refreshed if completed today!

### 16.2 Streak Mechanics
1. **Day Boundary**: Computed relative to UTC day boundaries (`YYYY-MM-DD`).
2. **First Solve of Day**:
   - If user's `lastStreakDate` was yesterday: `streak = streak + 1`.
   - If user's `lastStreakDate` was today: streak remains unchanged.
   - If user's `lastStreakDate` was before yesterday (gap $\ge 2$ days): `streak = 1`.
3. **Longest Streak**: Updated continuously: `longestStreak = Math.max(longestStreak, streak)`.

### 16.3 Competitive Rating Bands & Tiers

| Rating Range | Tier Label | Division Width |
| :--- | :--- | :--- |
| $700 \dots 899$ | **Pulse** (Pulse I: 700–766, Pulse II: 767–833, Pulse III: 834–899) | 67 pts / div |
| $900 \dots 1099$ | **Prism** (Prism I: 900–966, Prism II: 967–1033, Prism III: 1034–1099) | 67 pts / div |
| $1100 \dots 1299$ | **Aurora** (Aurora I: 1100–1166, Aurora II: 1167–1233, Aurora III: 1234–1299) | 67 pts / div |
| $1300 \dots 1499$ | **Eclipse** (Eclipse I: 1300–1366, Eclipse II: 1367–1433, Eclipse III: 1434–1499) | 67 pts / div |
| $1500+$ | **Zenith** (Zenith I: 1500–1599, Zenith II: 1600+) | 100 pts / div |

---

## 17. Rate Limits, Quotas & Security Governance

### 17.1 Standard Rate Limiting Policy
To prevent denial of service and ensure equitable sandbox throughput:
- **Authentication** (`/api/auth/register`, `/api/auth/login`): **30 requests / 15 minutes / IP**.
- **Sample Run** (`/api/execution/runs`): **10 runs / minute / user**.
- **Submissions** (`/api/execution/submissions`): **6 submissions / minute / user**.
- **Concurrent In-Flight Limit**: Maximum **2 active runs/submissions per user** simultaneously. If exceeded, returns `429 RATE_LIMITED` with message `"Another execution is already running. Please wait."`.

### 17.2 Security Headers & Sandboxing
- `Content-Security-Policy`: Restricts scripts, styles, fonts, and sets frame ancestors.
- `X-Content-Type-Options`: `nosniff`.
- `X-Frame-Options`: `SAMEORIGIN`.
- `Referrer-Policy`: `strict-origin-when-cross-origin`.
- **Code Payload Ceiling**: Maximum allowable source code size is **64 KB** (`413 CODE_TOO_LARGE`). Submissions containing `main()` or entrypoint definitions are blocked upfront (`400 FUNCTION_ONLY_REQUIRED`).

---

## 18. Zero-Config Dual-Tier Database & Auto-Healing Architecture

Calibr8 includes an intelligent, zero-configuration database layer designed to work reliably in every environment:

```
                      +-----------------------------+
                      | Incoming API / HTTP Request |
                      +-----------------------------+
                                     |
                                     v
                        +-------------------------+
                        |  Auth Middleware        |
                        |  (JWT Token Validation) |
                        +-------------------------+
                                     |
                                     v
                       +---------------------------+
                       |    Is DATABASE_URL set?   |
                       +---------------------------+
                               /           \
                       YES    /             \    NO
                             v               v
                +---------------------+   +---------------------------+
                | PrismaClient Engine |   | Transparent Model Proxy   |
                | (PostgreSQL / Neon) |   | (InMemoryStore Fallback)  |
                +---------------------+   +---------------------------+
                             |                           |
                  (On Connection Error)                  |
                             +---------------------------+
                                           |
                                           v
                       +---------------------------------------+
                       | InMemoryStore Features:               |
                       | - 14 Calibrated Topics (DSA & Core)   |
                       | - 10 Store Themes                     |
                       | - Pre-seeded Demo Student Account:    |
                       |   student@example.com                 |
                       |   PW: StrongPassword123 (100 coins)   |
                       | - Full CS Curriculum (5 Subjects,     |
                       |   75+ Chapters, 150+ Topics & MCQs)   |
                       | - Multi-tier Code Evaluation Sandbox  |
                       +---------------------------------------+
```

### Pre-Seeded Demo Credentials
- **Email**: `student@example.com`
- **Password**: `StrongPassword123`
- **Initial Balance**: `100` Coins (sufficient to purchase themes)
- **Rating**: `800` (Prism I Tier)
- **1-Click Authentication**: Available directly on the interactive dashboard (`/`) via the `⚡ 1-Click Demo Login` button.
