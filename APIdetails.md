# Calibr8 — Unified API Documentation & Contract Specification

> **Document Version**: 2.1.0 (merged from "Frontend Developer & AI Agent API Documentation" v2.0.0 and "API Documentation & Contract Specification" v2.1.0)
> **Target Audience**: Frontend/mobile engineers (React, Next.js, Vue, React Native, Flutter, Swift, Kotlin) and AI coding agents.
> **Base URL (dev)**: `http://localhost:3000` (binds to `0.0.0.0:3000`)
> **Global Prefix**: `/api` (plus root convenience routes `/health`, `/ping`, and developer console at `/`)
> **Content-Type**: `application/json`
> **Auth**: `Authorization: Bearer <jwt-token>`
> **Timestamps**: ISO 8601 UTC strings (e.g. `2026-10-24T12:00:00.000Z`)
> **Day boundaries (all gamification)**: IST — `Asia/Kolkata`, UTC+05:30, `YYYY-MM-DD`
> **Supported languages**: `cpp` (GCC 13 / C++20), `c` (GCC 13), `java` (OpenJDK 17), `python` (Python 3.10), `javascript` (Node.js 22)

> See **Appendix A** for what was corrected/removed during the merge and **Appendix B** for items still needing verification against the source code.

---

## Table of Contents

1. [Architecture, Principles & Business Rules](#1-architecture-principles--business-rules)
2. [Error Codes & HTTP Status Taxonomy](#2-error-codes--http-status-taxonomy)
3. [TypeScript Type Definitions](#3-typescript-type-definitions)
4. [Frontend Client Implementation Guide](#4-frontend-client-implementation-guide)
5. [System & Health APIs](#5-system--health-apis)
6. [Authentication & Session Lifecycle (`/api/auth`)](#6-authentication--session-lifecycle-apiauth)
7. [User Profile & Academic APIs (`/api/users`)](#7-user-profile--academic-apis-apiusers)
8. [Topics & Categories (`/api/topics`)](#8-topics--categories-apitopics)
9. [Onboarding & Skill Calibration (`/api/onboarding`)](#9-onboarding--skill-calibration-apionboarding)
10. [Problems Catalogue (`/api/problems`)](#10-problems-catalogue-apiproblems)
11. [Code Execution, Submissions & Complexity (`/api/execution`)](#11-code-execution-submissions--complexity-apiexecution)
12. [Daily Problem of the Day (`/api/daily-problem`)](#12-daily-problem-of-the-day-apidaily-problem)
13. [Coins & Theme Store (`/api/coins`, `/api/themes`)](#13-coins--theme-store-apicoins-apithemes)
14. [Rankings & Leaderboard (`/api/rankings`)](#14-rankings--leaderboard-apirankings)
15. [CS Curriculum & Study Material (`/api/study`)](#15-cs-curriculum--study-material-apistudy)
16. [Social & GitHub OAuth Linking (`/api/social`)](#16-social--github-oauth-linking-apisocial)
17. [Gamification: Scoring, Streaks & Tiers](#17-gamification-scoring-streaks--tiers)
18. [Rate Limits, Quotas & Security](#18-rate-limits-quotas--security)
19. [Dual-Tier Database & Auto-Healing Architecture](#19-dual-tier-database--auto-healing-architecture)
20. [Automated Test Suite](#20-automated-test-suite)
- [Appendix A — Merge Changelog](#appendix-a--merge-changelog-what-was-fixed-or-removed)
- [Appendix B — Open Items to Verify](#appendix-b--open-items-to-verify-against-code)

---

## 1. Architecture, Principles & Business Rules

### 1.1 Architectural Pattern
Router-Controller-Model:
- **Routers** (`src/routers/*.router.js`): route matching, middleware (auth, rate limits, in-flight counters), delegation.
- **Controllers** (`src/controllers/*.controller.js`): domain logic, validation, transactions, response shaping.
- **Utilities & Services** (`src/utils/`, `src/services/`): code building, driver injection, output comparison, gamification, AST complexity parsing, coin and daily-problem services.
- **Database layer** (`src/config/db.js`, `prisma/schema.prisma`): transparent proxy to PostgreSQL/Neon, or an in-memory store when no `DATABASE_URL` is set.

### 1.2 Business Rules (authoritative)
1. **Default account**: every new user starts with `100 coins`, `streak: 0`, `longestStreak: 0`, `rating: 800` (tier **Pulse II**).
2. **IST day boundary**: daily login rewards, daily problem rotation, and streaks all use the `Asia/Kolkata` date string (`YYYY-MM-DD`); days start at `00:00:00 IST`. UTC or client-local dates are never used for day boundaries.
3. **Never-block rule**: coin/reward computation never fails or crashes login, registration, or submissions. On storage errors, safe defaults (`granted: false`, `coins: 0`) are returned with HTTP 200.
4. **Single authority for coins**: only `src/services/coinService.js` and `src/services/dailyProblemService.js` may modify `User.coins`. Every change writes an immutable `CoinTransaction` audit row with `balanceAfter`.
5. **Anti-information leak**: hidden testcases (`isVisible: false`) never expose `input`, `expected`, or `actual`.
6. **Function-only submissions**: submit a function/class solution only. Code defining `main()` is rejected with `400 FUNCTION_ONLY_REQUIRED`.

### 1.3 Response Shapes

**Single entity / action**
```json
{ "success": true, "message": "Operation completed successfully.", "data": { } }
```

**Collections**
```json
{ "success": true, "count": 25, "data": [ ] }
```
(Some endpoints use a named key instead of `data`, e.g. `topics`, `languages`, `history`; see each endpoint.)

**Asynchronous jobs** return `202 Accepted`:
```json
{
  "success": true,
  "submissionId": "sub_1740001234_abc89f",
  "status": "QUEUED",
  "pollUrl": "/api/execution/submissions/sub_1740001234_abc89f",
  "message": "Submission received and queued for execution."
}
```

### 1.4 Strict Anti-Information-Leak Policy
1. `GET /api/problems/:slug` returns only testcases with `isVisible === true`.
2. Submission results pass through `publicTestResults()`: hidden cases keep only `testIndex`, `isVisible: false`, `passed`, `status`, `time`, `memory`.
3. If the first failure is a hidden case, `firstFailure` is obfuscated (e.g. `"Failed on hidden evaluation test case #4."`).

---

## 2. Error Codes & HTTP Status Taxonomy

Every 4xx/5xx response uses this schema:
```json
{
  "success": false,
  "code": "ERROR_CODE_STRING",
  "message": "Human-friendly explanation of the error.",
  "details": {}
}
```

| HTTP | Code | Trigger | Client action |
| :--- | :--- | :--- | :--- |
| 400 | `VALIDATION_ERROR` | Missing required fields / invalid types | Fix payload per `message` |
| 400 | `INVALID_EMAIL` | Email fails format check | Ask for a valid email |
| 400 | `WEAK_PASSWORD` | Password < 8 characters | Require ≥ 8 characters |
| 400 | `PASSWORD_TOO_LONG` | Password > 72 bytes (bcrypt limit) | Limit to ≤ 72 bytes |
| 400 | `PASSWORD_EQUALS_EMAIL` | Password equals email | Require a different password |
| 400 | `MISSING_CODE` | Code empty/whitespace | Block empty runs client-side |
| 400 | `FUNCTION_ONLY_REQUIRED` | Code contains `main()`/entrypoint | Remove `main()`; submit function/class only |
| 400 | `INSUFFICIENT_COINS` | Balance < theme price | Earn more coins |
| 400 | `ALREADY_OWNED` | Theme already owned | Use `PUT /api/themes/apply` |
| 400 | `NO_TESTCASES` | Problem has no sample testcases | Contact admin |
| 401 | `UNAUTHORIZED` | Bearer token missing/invalid | Redirect to login |
| 401 | `INVALID_CREDENTIALS` | Wrong email/password | Show error |
| 401 | `TOKEN_REVOKED` | Token revoked via logout | Clear storage, re-login |
| 401 | `TOKEN_EXPIRED` | JWT past `exp` | Refresh or re-login |
| 401 | `INVALID_CURRENT_PASSWORD` | Wrong old password on change | Re-enter current password |
| 403 | `FORBIDDEN` | Access denied (e.g. applying an unowned theme) | Purchase first |
| 404 | `NOT_FOUND` | Problem/topic/chapter/subject/theme/user missing | Check slug/ID |
| 404 | `SUBMISSION_NOT_FOUND` | Unknown ID or not owner | Verify ownership |
| 409 | `EMAIL_ALREADY_EXISTS` | Email already registered | Suggest login |
| 409 | `SOCIAL_ALREADY_LINKED` | Social account linked to another profile | Log in with that provider |
| 413 | `CODE_TOO_LARGE` | Code > 64 KB | Reduce size |
| 422 | `UNSUPPORTED_LANGUAGE` | Not in `[cpp, c, java, python, javascript]` | Pick a supported language |
| 429 | `RATE_LIMITED` | Rate limit exceeded, or > 2 concurrent executions (see Appendix B-1) | Back off, show cooldown |
| 503 | `EXECUTION_UNAVAILABLE` | CodeBox runner unconfigured/unreachable/timed out | Show outage banner |
| 503 | `DATABASE_UNAVAILABLE` | DB connection lost, unrecoverable | Retry shortly |
| 503 | `SUBMISSION_STORAGE_UNAVAILABLE` | Could not persist submission | Ask user to retry |
| 500 | `INTERNAL_ERROR` | Unhandled exception (sanitized) | Retry / report |

---

## 3. TypeScript Type Definitions

Put in `src/types/calibr8-api.ts`:

```typescript
// ===== 1. Core User, Auth & Profile =====
export type SupportedLanguage = "cpp" | "c" | "java" | "python" | "javascript";
export type UserDifficulty = "easy" | "medium" | "hard";

export type UserTier =
  | "Pulse I" | "Pulse II" | "Pulse III"
  | "Prism I" | "Prism II" | "Prism III"
  | "Aurora I" | "Aurora II" | "Aurora III"
  | "Eclipse I" | "Eclipse II" | "Eclipse III"
  | "Zenith I" | "Zenith II";

export interface UserHeaderStats {
  rating: number;
  tier: UserTier;
  score: number;
  scoreUnits: number; // score * 10
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

export interface LoginRewards {
  coinsEarnedToday: number;
  loginCoins: number;
  isNewDay: boolean; // first login of the IST day
}

export interface AuthResponse {
  success: boolean;
  message: string;
  token: string;
  isNewUser?: boolean;
  user: User;
  rewards?: LoginRewards; // login only
}

export interface AuthSessionResponse {
  success: boolean;
  user: User;
  stats: UserHeaderStats;
}

export interface UserActivityMatrix {
  [dateIso: string]: number; // "2026-10-29": 3
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

// ===== 2. Topics =====
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

// ===== 3. Problems =====
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
  _count?: { testcases: number; templates: number };
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
  testcases: TestCase[]; // visible sample cases only
  templates: Record<SupportedLanguage, string>;
  templatesMap?: Record<SupportedLanguage, string>;
}

// ===== 4. Execution & Submissions =====
export type ExecutionCaseStatus =
  | "Accepted" | "Wrong Answer" | "Runtime Error"
  | "Time Limit Exceeded" | "Compilation Error";

export interface ExecutionLanguage {
  key: SupportedLanguage;
  label: string;
  version: string;
  judge0Id: number;
  starterAvailable: boolean;
  monacoLanguage: string;
}

// Run (sample-case) result item. Time/memory field naming differs between
// source docs — see Appendix B-2. Treat both variants as optional.
export interface RunCaseResult {
  index?: number;
  testIndex: number;
  isVisible: boolean;
  input: string;
  expected: string;
  actual: string;
  studentStdout?: string;
  status: ExecutionCaseStatus;
  passed: boolean;
  time?: number;     // ms
  memory?: number;   // KB
  timeMs?: number;
  memoryKb?: number;
  cpuTimeMs?: number;
  wallTimeMs?: number;
  inputBytes?: number;
  errorText?: string | null;
}

export interface RunResponse {
  success: boolean;
  verdict: ExecutionCaseStatus;
  status: ExecutionCaseStatus;
  passedCount: number;
  totalCount: number;
  results: RunCaseResult[];
  complexity?: ComplexityAnalysisResult | null;
}

export interface SubmissionQueuedResponse {
  success: boolean;
  submissionId: string;
  verdict?: "QUEUED";
  status: "QUEUED";
  pollUrl: string;
  message: string;
  problem: { slug: string; title: string };
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
  input?: string;    // only if isVisible
  expected?: string; // only if isVisible
  actual?: string;   // only if isVisible
}

export interface ComplexityEstimate {
  bestEstimate: string; // "O(n)", "O(n log n)", "O(n^2)"
  confidence: "low" | "medium" | "high";
  explanation?: string;
}

export interface ComplexityAnalysisResult {
  time: ComplexityEstimate;
  space: ComplexityEstimate;
  summary?: string;
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
    | "QUEUED" | "PROCESSING" | "ACCEPTED" | "WRONG_ANSWER"
    | "RUNTIME_ERROR" | "TIME_LIMIT_EXCEEDED" | "COMPILATION_ERROR" | "ERROR";
  verdict: string;
  tierReached:
    | "Tier 0 (Failed)" | "Tier 1 (Brute Force)"
    | "Tier 2 (Better)" | "Tier 3 (Optimal)";
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
  problem: { slug: string; title: string };
}

// ===== 5. Daily Problem =====
export interface DailyProblemResponse {
  success: boolean;
  istDate: string;
  problem: {
    id: string; slug: string; title: string;
    difficulty: "Easy" | "Medium" | "Hard";
    description?: string; tags?: string[]; solvedCount?: number;
  };
  reward: { coins: number; streak: number; description?: string };
  completed: boolean;
  solvedToday?: boolean;
  rewardClaimed?: boolean;
  completedAt?: string | null;
  streak?: number;
  longestStreak?: number;
  nextRefreshMs?: number;
  nextRefreshTime: string; // "12:00 AM IST"
}

// ===== 6. Study =====
export interface StudySubject {
  id: string;
  slug: "cn" | "dbms" | "oops" | "os" | "system-design";
  name: string;
  description: string | null;
  icon: string | null;
  order: number;
  _count: { chapters: number };
}

export interface StudyChapter {
  id: string;
  slug: string;
  name: string;
  subjectId: string;
  order: number;
  _count?: { topics: number };
}

export interface StudyMCQ {
  id: string;
  question: string;
  options: string[];
  difficulty: "Easy" | "Medium" | "Hard";
  order: number;
  // correctIndex & explanation are stripped until submission
}

export interface StudyTopicDetail {
  id: string;
  slug: string;
  name: string;
  order: number;
  content: string; // Markdown article
  isPublished: boolean;
  chapter: {
    id: string; slug: string; name: string;
    subject: { slug: string; name: string };
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

// ===== 7. Themes =====
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

// ===== 8. Rankings =====
export interface RankedUser {
  rank?: number;
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
  total?: number;
  data: RankedUser[]; // see Appendix B-3 (alt. key: "rankings")
}
```

---

## 4. Frontend Client Implementation Guide

### 4.1 Fetch Interceptor with Token Management

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
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }

  const url = `${API_BASE_URL}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  const response = await fetch(url, { ...restOptions, headers });

  const isJson = (response.headers.get("content-type") || "").includes("application/json");
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      localStorage.removeItem("calibr8_token");
      localStorage.removeItem("calibr8_user");
      window.dispatchEvent(new Event("calibr8_session_expired"));
    }
    throw payload; // { success: false, code, message, details }
  }
  return payload as T;
}
```

### 4.2 React Hook: Polling Async Submissions

```typescript
import { useState, useEffect, useRef } from "react";
import { apiRequest } from "./apiClient";
import type { SubmissionDetail } from "./types";

const TERMINAL = ["ACCEPTED", "WRONG_ANSWER", "RUNTIME_ERROR",
                  "TIME_LIMIT_EXCEEDED", "COMPILATION_ERROR", "ERROR"];

export function useSubmissionPoller(submissionId: string | null, pollIntervalMs = 1000) {
  const [submission, setSubmission] = useState<SubmissionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<any>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!submissionId) return;
    let active = true;
    setLoading(true);

    const poll = async () => {
      try {
        const res = await apiRequest<{ success: boolean; submission: SubmissionDetail }>(
          `/api/execution/submissions/${submissionId}`
        );
        if (!active) return;
        setSubmission(res.submission);
        if (!TERMINAL.includes(res.submission.status)) {
          timerRef.current = setTimeout(poll, pollIntervalMs);
        } else {
          setLoading(false);
        }
      } catch (err) {
        if (!active) return;
        setError(err);
        setLoading(false);
      }
    };
    poll();

    return () => {
      active = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [submissionId, pollIntervalMs]);

  return { submission, loading, error };
}
```

---

## 5. System & Health APIs

### 5.1 `GET /` — Root Manifest & Developer Console (content-negotiated)
- **Protected**: No
- `Accept: text/html` → interactive developer dashboard (`public/index.html`) with embedded tests and 1-click demo login.
- `Accept: application/json` → service manifest:
```json
{
  "service": "Calibr8 Backend API",
  "status": "online",
  "version": "1.2.0",
  "architecture": { "pattern": "Router-Controller-Model", "namingConvention": "*.router.js, *.controller.js" },
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
    "auth": "/api/auth", "users": "/api/users", "topics": "/api/topics",
    "onboarding": "/api/onboarding", "problems": "/api/problems",
    "execution": "/api/execution", "social": "/api/social", "study": "/api/study",
    "themes": "/api/themes", "rankings": "/api/rankings",
    "dailyProblem": "/api/daily-problem", "coins": "/api/coins"
  }
}
```
> The `version: "1.2.0"` is the manifest's own service version, separate from this document's version. The feature list and `apiGroups` shown are the original ones plus `dailyProblem`/`coins`, which exist per the other sections (see Appendix B-8).

### 5.2 `GET /health` · `GET /api/health`
- **Protected**: No
```json
{ "status": "ok", "service": "Calibr8 Backend", "timestamp": "2026-11-09T08:50:00.000Z" }
```

### 5.3 `GET /ping` · `GET /api/ping`
- **Protected**: No — returns plain text `pong`.

---

## 6. Authentication & Session Lifecycle (`/api/auth`)

### 6.1 `POST /api/auth/register`
Creates an account; bcrypt hash (salt rounds 10); defaults: 100 coins, rating 800, tier **Pulse II**; returns a signed JWT.
- **Protected**: No · **Rate limit**: 30 req / 15 min / IP
- **Body**:
```json
{ "email": "student@example.com", "password": "StrongPassword123", "name": "Alex Mercer" }
```
- **Validation**: `email` required, valid, lowercased; `password` required, 8–72 bytes, must not equal email (case-insensitive); `name` required, non-empty after trim.
- **`201 Created`**:
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
    "tier": "Pulse II",
    "score": 0,
    "coins": 100,
    "streak": 0,
    "longestStreak": 0,
    "onboarded": false,
    "preferredLanguage": "cpp"
  }
}
```

### 6.2 `POST /api/auth/login`
Verifies credentials, issues a JWT (1-day expiry), and awards **+1 daily login coin** on the first login of each IST day.
- **Protected**: No · **Rate limit**: 30 req / 15 min / IP
- **Body**: `{ "email": "student@example.com", "password": "StrongPassword123" }`
- **`200 OK`**:
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
    "tier": "Aurora II",
    "score": 450,
    "coins": 101,
    "onboarded": true,
    "preferredLanguage": "python"
  },
  "rewards": { "coinsEarnedToday": 1, "loginCoins": 1, "isNewDay": true }
}
```
On later logins the same day, `loginCoins` is `0` and `isNewDay` is `false`.

### 6.3 `GET /api/auth/me` · alias `GET /api/auth/verify`
Validates the token, restores the session (DB or auto-heal), returns the user and compact header stats.
- **Protected**: Yes
```json
{
  "success": true,
  "user": {
    "id": "u-45a8-bc91-2309",
    "email": "student@example.com",
    "name": "Alex Mercer",
    "difficulty": "medium",
    "rating": 1200,
    "coins": 101,
    "onboarded": true,
    "preferredLanguage": "python",
    "socialAccounts": [],
    "topics": []
  },
  "stats": {
    "rating": 1200, "tier": "Aurora II", "score": 450, "scoreUnits": 4500,
    "coins": 101, "streak": 3, "longestStreak": 7
  }
}
```

### 6.4 `POST /api/auth/refresh`
Issues a fresh JWT for an authenticated user.
- **Protected**: Yes
```json
{ "success": true, "message": "Token refreshed successfully.", "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }
```

### 6.5 `POST /api/auth/change-password`
- **Protected**: Yes
- **Body**: `{ "currentPassword": "OldPassword123", "newPassword": "NewStrongPassword456" }`
- **Validation**: `newPassword` ≥ 8 chars, ≤ 72 bytes, ≠ email. Wrong current password → `401 INVALID_CURRENT_PASSWORD`.
- **`200 OK`**: `{ "success": true, "message": "Password changed successfully." }`

### 6.6 `POST /api/auth/logout`
Revokes the presenting JWT by storing its `jti` in a blacklist until expiry.
- **Protected**: Yes
- **`200 OK`**: `{ "success": true, "message": "Logged out successfully. Token has been revoked." }`

---

## 7. User Profile & Academic APIs (`/api/users`)

All endpoints below are **Protected**.

### 7.1 `GET /api/users/me` · alias `GET /api/users/`
Full profile including calibrated topics and preferred language.
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
    "tier": "Aurora II",
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
        "id": "ut-1", "topicId": "t-1", "level": "medium",
        "topic": { "id": "t-1", "slug": "dsa-arrays", "name": "DSA - Arrays", "category": "DSA" }
      }
    ]
  }
}
```

### 7.2 `GET /api/users/me/overview`
Profile + 371-day activity heatmap in one round-trip (for the profile screen).
```json
{
  "success": true,
  "user": {
    "id": "u-45a8-bc91-2309", "email": "student@example.com", "name": "Alex Mercer",
    "college": "AKGEC", "branch": "CSE", "batch": "2026", "state": "UP", "country": "India",
    "coins": 101, "streak": 3, "longestStreak": 5, "rating": 850, "tier": "Pulse III",
    "socialAccounts": [], "topics": []
  },
  "activity": { "2026-11-08": 2, "2026-11-09": 1 },
  "total": 3,
  "activeDays": 2
}
```

### 7.3 `GET /api/users/me/activity`
Daily counts of fully accepted (100% testcases) submissions over the trailing 371 days, keyed by `YYYY-MM-DD`.
```json
{ "success": true, "activity": { "2026-11-08": 2, "2026-11-09": 1 }, "total": 3, "activeDays": 2 }
```

### 7.4 `PATCH /api/users/me` · `PUT /api/users/me`
Updates name and academic info. At least one field required.
```json
{ "name": "Alexander Mercer", "college": "AKGEC", "branch": "Computer Science", "batch": "2026", "state": "UP", "country": "India" }
```
**`200 OK`**: `{ "success": true, "user": { "id": "...", "name": "...", "email": "...", "college": "...", "branch": "...", "batch": "...", "state": "...", "country": "..." } }`

### 7.5 `PATCH /api/users/me/language` · alias `PATCH /api/users/language`
Sets the default language for editor templates and executions. Allowed: `cpp`, `c`, `java`, `python`, `javascript`.
- **Body**: `{ "language": "python" }` → **`200 OK`**: `{ "success": true, "language": "python" }`

### 7.6 `GET /api/users/all`
All problems annotated with the user's solve status, shaped for track views.
```json
{
  "success": true,
  "message": "Problems fetched successfully",
  "data": [
    {
      "name": "Two Sum", "slug": "two-sum-001", "number": 1,
      "topic": "Arrays & Hashing", "topicSlug": "arrays-and-hashing",
      "level": "easy", "levelDisplay": "easy",
      "solvedPercentage": 74, "isSolved": true
    }
  ]
}
```

---

## 8. Topics & Categories (`/api/topics`)

### 8.1 `GET /api/topics`
- **Protected**: No · **Query**: `category` = `dsa` | `core` (optional)
```json
{
  "success": true,
  "count": 3,
  "topics": [
    { "id": "t-1", "slug": "dsa-arrays", "name": "DSA - Arrays", "category": "DSA" },
    { "id": "t-2", "slug": "dsa-graphs-dp", "name": "DSA - Graphs & DP", "category": "DSA" },
    { "id": "t-6", "slug": "dbms", "name": "DBMS", "category": "CORE" }
  ],
  "dsaTopics": [ { "id": "t-1", "slug": "dsa-arrays", "name": "DSA - Arrays", "category": "DSA" } ],
  "coreTopics": [ { "id": "t-6", "slug": "dbms", "name": "DBMS", "category": "CORE" } ]
}
```
*(Example is truncated; the real list is longer.)*

### 8.2 `GET /api/topics/dsa`
- **Protected**: No — DSA-only calibration topics.

### 8.3 `GET /api/topics/dsa/categories` · alias `GET /api/topics/categories`
- **Protected**: No — structured DSA category groups with problem counts (Tracks page).
```json
[
  { "id": "cat-1", "slug": "arrays-and-hashing", "name": "Arrays & Hashing", "order": 1, "totalProblems": 24 },
  { "id": "cat-2", "slug": "two-pointers", "name": "Two Pointers", "order": 2, "totalProblems": 14 }
]
```

### 8.4 `GET /api/topics/dsa/:slug/problems`
- **Protected**: No · **Query**: `difficulty` (`Easy|Medium|Hard`), `search` (title/slug keyword)
```json
{
  "topic": { "id": "cat-1", "slug": "arrays-and-hashing", "name": "Arrays & Hashing" },
  "count": 12,
  "problems": [
    { "id": "p-1", "problemNumber": 1, "slug": "two-sum-001", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array", "Hash Table"] }
  ]
}
```

### 8.5 `GET /api/topics/:identifier`
- **Protected**: Yes — topic details by ID or unique slug.

---

## 9. Onboarding & Skill Calibration (`/api/onboarding`)

### 9.1 `POST /api/onboarding` · alias `PUT /api/onboarding/levels`
Calibrates skill per topic, computes the initial Elo rating, sets `onboarded = true`, and links topic levels in one atomic transaction.
- **Protected**: Yes · **Rate limit**: 20 req/min/user
- `topicId` values accept the topic **slug** (e.g. `dsa-arrays`) as shown below.

**Mode 1 — per-topic selection (recommended for sliders):**
```json
{
  "topicSelections": [
    { "topicId": "dsa-arrays", "difficulty": "easy" },
    { "topicId": "dsa-graphs-dp", "difficulty": "medium" },
    { "topicId": "dsa-trees", "difficulty": "hard" }
  ]
}
```
**Mode 2 — global preset:** `{ "difficulty": "medium", "topicIds": "all" }` (an explicit array of topic slugs/IDs is also accepted)
**Mode 3 — 1-click beginner preset:** `{ "beginner": true }` (all DSA topics Easy, rating 800)

**`200 OK`**:
```json
{
  "success": true,
  "user": {
    "id": "u-45a8-bc91-2309", "email": "student@example.com", "name": "Alex Mercer",
    "difficulty": "medium", "rating": 1200, "onboarded": true, "preferredLanguage": "cpp",
    "topics": [
      {
        "id": "ut-1", "userId": "u-45a8-bc91-2309", "topicId": "t-1", "level": "medium",
        "topic": { "id": "t-1", "slug": "dsa-arrays", "name": "DSA - Arrays", "category": "DSA" }
      }
    ]
  }
}
```

### 9.2 `GET /api/onboarding/status`
- **Protected**: Yes — returns the same `{ success, user }` shape as above.

---

## 10. Problems Catalogue (`/api/problems`)

### 10.1 `GET /api/problems`
- **Protected**: Optional (with a token, `isSolved` is computed per problem)
- **Query**: `difficulty` (`Easy|Medium|Hard`), `topic` (slug), `search` (title or slug), `status` (`solved|unsolved`, needs auth), `page` (≥ 1, default 1), `pageSize` (1–100, default 25)
```json
{
  "success": true,
  "count": 1,
  "total": 161,
  "page": 1,
  "pageSize": 25,
  "data": [
    {
      "id": "p-1", "problemNumber": 1, "slug": "two-sum", "title": "Two Sum",
      "difficulty": "Easy", "timeLimit": 1000, "memoryLimit": 256, "solvedCount": 420,
      "tags": ["Array", "Hash Table"], "isSolved": false,
      "_count": { "testcases": 5, "templates": 5 }
    }
  ]
}
```

### 10.2 `GET /api/problems/:slug`
- **Protected**: No. Only `isVisible: true` testcases are returned; hidden ones are omitted entirely.
```json
{
  "success": true,
  "problem": {
    "id": "p-1", "problemNumber": 1, "slug": "two-sum", "title": "Two Sum",
    "description": "Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.\n\nYou may assume that each input would have exactly one solution, and you may not use the same element twice.",
    "difficulty": "Easy", "timeLimit": 1000, "memoryLimit": 256, "solvedCount": 420,
    "tags": ["Array", "Hash Table"],
    "testcases": [
      { "testIndex": 0, "isVisible": true, "input": "4 9\n2 7 11 15", "output": "0 1" },
      { "testIndex": 1, "isVisible": true, "input": "3 6\n3 2 4", "output": "1 2" }
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

### 10.3 `GET /api/problems/:slug/starter` · `GET /api/problems/:slug/template`
- **Protected**: No · **Query**: `language` = `python|cpp|c|java|javascript`
- Returns the clean starter function signature for the editor.

### 10.4 `POST /api/problems/:slug/run`
Problem-scoped alias of the execution run endpoint (§11.2). **Protected**.

### 10.5 `POST /api/problems/:slug/submit`
Problem-scoped alias of the execution submit endpoint (§11.3). **Protected**.

---

## 11. Code Execution, Submissions & Complexity (`/api/execution`)

### 11.1 `GET /api/execution/languages`
- **Protected**: No
```json
{
  "success": true,
  "languages": [
    { "key": "python", "label": "Python 3", "version": "Python 3.10", "judge0Id": 71, "starterAvailable": true, "monacoLanguage": "python" },
    { "key": "javascript", "label": "JavaScript", "version": "Node.js 22", "judge0Id": 63, "starterAvailable": true, "monacoLanguage": "javascript" },
    { "key": "cpp", "label": "C++ (GCC)", "version": "GCC 13 (C++20)", "judge0Id": 54, "starterAvailable": true, "monacoLanguage": "cpp" },
    { "key": "c", "label": "C (GCC)", "version": "GCC 13", "judge0Id": 50, "starterAvailable": true, "monacoLanguage": "c" },
    { "key": "java", "label": "Java (OpenJDK)", "version": "OpenJDK 17", "judge0Id": 62, "starterAvailable": true, "monacoLanguage": "java" }
  ]
}
```

### 11.2 Run Sample Testcases
Runs code against **visible sample testcases only**. Debug output is captured via result markers without polluting evaluation.
- **Route**: `POST /api/execution/runs` · aliases `POST /api/execution/run`, `POST /api/execute/run`, `POST /api/problems/:slug/run`
- **Protected**: Yes · **Rate limit**: 10 runs/min/user; max 2 in-flight executions
- **Body**:
```json
{
  "slug": "two-sum",
  "language": "python",
  "code": "class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        seen = {}\n        for i, n in enumerate(nums):\n            diff = target - n\n            if diff in seen:\n                return [seen[diff], i]\n            seen[n] = i\n        return []"
}
```
Per the v2.1 spec, a custom `stdin` may be supplied instead of a problem slug (see Appendix B-6).
- **`200 OK`**:
```json
{
  "success": true,
  "verdict": "Accepted",
  "status": "Accepted",
  "passedCount": 2,
  "totalCount": 2,
  "results": [
    {
      "testIndex": 0, "isVisible": true, "passed": true, "status": "Accepted",
      "input": "4 9\n2 7 11 15", "expected": "0 1", "actual": "0 1",
      "time": 42, "memory": 12840
    }
  ],
  "complexity": {
    "time": { "bestEstimate": "O(n)", "confidence": "high" },
    "space": { "bestEstimate": "O(n)", "confidence": "high" }
  }
}
```

### 11.3 Submit Solution for Full Evaluation
Evaluates across sample + hidden testcases with true **tier short-circuiting**: if Tier 1 fails, execution halts and Tier 2/3 batches are not run.
- **Route**: `POST /api/execution/submissions` · aliases `POST /api/execution/submit`, `POST /api/execute/submit`, `POST /api/problems/:slug/submit`
- **Protected**: Yes · **Rate limit**: 6 submissions/min/user; max 2 in-flight executions
- **Body**:
```json
{ "slug": "two-sum", "language": "python", "code": "class Solution:\n    ...", "wait": false }
```

**Mode 1 — Asynchronous** (`/submissions` with `wait: false` or omitted) → `202 Accepted`:
```json
{
  "success": true,
  "submissionId": "sub_1740001234_abc89f",
  "verdict": "QUEUED",
  "status": "QUEUED",
  "pollUrl": "/api/execution/submissions/sub_1740001234_abc89f",
  "message": "Submission received and queued for execution.",
  "problem": { "slug": "two-sum", "title": "Two Sum" }
}
```

**Mode 2 — Synchronous** (`wait: true`, or routes `/submit`, `/execute/submit`) → `200 OK`:
```json
{
  "success": true,
  "submissionId": "sub_1740001234_abc89f",
  "verdict": "ACCEPTED",
  "status": "ACCEPTED",
  "tierReached": "Tier 3 (Optimal)",
  "passedCount": 5,
  "totalCount": 5,
  "time": "52ms",
  "memory": 13400,
  "createdAt": "2026-11-02T22:00:00.000Z",
  "firstFailure": null,
  "reward": {
    "awarded": true,
    "points": 10,
    "scoreDelta": 100,
    "coinsEarned": 0,
    "stats": { "rating": 810, "tier": "Pulse II", "score": 10, "scoreUnits": 100, "coins": 100, "streak": 1, "longestStreak": 1 }
  },
  "rewardError": false,
  "results": [
    { "testIndex": 0, "isVisible": true, "passed": true, "status": "Accepted", "input": "4 9\n2 7 11 15", "expected": "0 1", "actual": "0 1" },
    { "testIndex": 2, "isVisible": false, "passed": true, "status": "Accepted", "time": 48, "memory": 13400 }
  ],
  "complexity": {
    "time": { "bestEstimate": "O(n)", "confidence": "high" },
    "space": { "bestEstimate": "O(n)", "confidence": "high" }
  },
  "problem": { "slug": "two-sum", "title": "Two Sum" }
}
```

### 11.4 `GET /api/execution/submissions/:id`
Polls status/verdict. **Protected, owner-only**; non-owners get `404 SUBMISSION_NOT_FOUND`.
Response: `{ "success": true, "submission": SubmissionDetail }` — same fields as the synchronous body above, nested under `submission` and including `id`, `problemId`, `language`. Poll until `status` is terminal (see §4.2).

### 11.5 `POST /api/execution/analyze-complexity`
Static AST/lexical complexity analysis.
- **Protected**: Optional · **Rate limit**: 10 req/min
- **Body**:
```json
{
  "code": "def twoSum(nums, target):\n    for i in range(len(nums)):\n        for j in range(i + 1, len(nums)):\n            if nums[i] + nums[j] == target:\n                return [i, j]",
  "language": "python",
  "problemSlug": "two-sum"
}
```
- **`200 OK`**:
```json
{
  "success": true,
  "complexity": {
    "time": { "bestEstimate": "O(n^2)", "confidence": "high" },
    "space": { "bestEstimate": "O(1)", "confidence": "high" },
    "summary": "Nested loops over the input."
  }
}
```

---

## 12. Daily Problem of the Day (`/api/daily-problem`)

### 12.1 Architecture & Selection
- **Rotation**: automatically at exactly `12:00 AM IST` (`Asia/Kolkata`) daily.
- **Selection (FR-01)**: random problem from the existing `problems` table; avoids repeating yesterday's when ≥ 2 problems exist; no separate banks or cycles.
- **Recovery & concurrency (FR-02)**: startup check recovers from restarts; **lazy generation** — if today's record is missing when requested, it is generated on demand; in-flight Promise locking plus DB uniqueness `@@unique([istDate])` prevents duplicates.
- **Completion & rewards (FR-03, FR-04, FR-06)**: `DailyProblemCompletion` (composite key `@@id([userId, dailyProblemId])`); on the first ACCEPTED solve grants **+2 coins** (`CoinTransaction type: "DAILY_PROBLEM"`) and **+1 streak** (consecutive days increment; a missed day resets to 1 on the next solve); `longestStreak = max(longestStreak, streak)`. Fully idempotent.
- **Daily login reward (FR-05)**: first login of an IST day grants **+1 coin** (`type: "DAILY_LOGIN"`); independent of, and does not alter, the streak.

### 12.2 `GET /api/daily-problem` · alias `GET /api/coins/daily-problem`
- **Protected**: Optional
```json
{
  "success": true,
  "istDate": "2026-11-09",
  "problem": {
    "id": "two-sum", "slug": "two-sum", "title": "Two Sum", "difficulty": "Easy",
    "description": "Given an array of integers nums and an integer target...",
    "tags": ["Array", "Hash Table"], "solvedCount": 42
  },
  "reward": { "coins": 2, "streak": 1, "description": "+2 coins and +1 streak for your first ACCEPTED submission on today's challenge" },
  "completed": false,
  "solvedToday": false,
  "rewardClaimed": false,
  "completedAt": null,
  "streak": 3,
  "longestStreak": 5,
  "nextRefreshMs": 67123000,
  "nextRefreshTime": "12:00 AM IST"
}
```

### 12.3 `GET /api/daily-problem/history` · alias `GET /api/coins/daily-problem/history`
- **Protected**: Optional · **Query**: `page` (default 1), `limit` (default 30, max 100). Ordered by `istDate` descending.
```json
{
  "success": true, "count": 30, "total": 35, "page": 1, "totalPages": 2,
  "history": [
    {
      "id": "dp_2026-11-09", "istDate": "2026-11-09", "createdAt": "2026-11-09T00:00:00.000Z", "completed": true,
      "problem": { "id": "two-sum", "slug": "two-sum", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array", "Hash Table"], "solvedCount": 42 }
    }
  ]
}
```

---

## 13. Coins & Theme Store (`/api/coins`, `/api/themes`)

### 13.1 `GET /api/coins/balance`
- **Protected**: Yes — coin balance, current streak, longest streak, last login date.

### 13.2 `GET /api/coins/history`
- **Protected**: Yes · **Query**: `limit` (default 20), `offset` (default 0)
- Paginated audit log of `CoinTransaction` rows.

### 13.3 `GET /api/themes`
- **Protected**: Yes — all themes with `owned`, `applied`, `canAfford` computed for the user.
```json
{
  "success": true,
  "themes": [
    { "id": "th-default", "slug": "default", "name": "Calibr8 Dark", "price": 0, "previewColor": "#0b0f19", "isDefault": true, "owned": true, "applied": true, "canAfford": true },
    { "id": "th-orbit", "slug": "orbit", "name": "Orbit", "price": 50, "previewColor": "#1e1b4b", "isDefault": false, "owned": false, "applied": false, "canAfford": true }
  ]
}
```

### 13.4 `GET /api/themes/me`
- **Protected**: Yes — active theme, owned themes, coin balance.
```json
{
  "success": true, "coins": 100, "activeTheme": "default", "ownedThemes": ["default"],
  "stats": { "rating": 800, "tier": "Pulse II", "score": 0, "scoreUnits": 0, "coins": 100, "streak": 0, "longestStreak": 0 }
}
```

### 13.5 `POST /api/themes/:slug/buy`
Atomically deducts coins and grants ownership (audit row written). Slugs: `orbit`, `frost`, `editorial`, `mono`, `racer`, `arcade`, …
- **Protected**: Yes · Errors: `INSUFFICIENT_COINS`, `ALREADY_OWNED`, `NOT_FOUND`
```json
{
  "success": true,
  "message": "Bought Orbit",
  "theme": { "slug": "orbit", "applied": true, "owned": true },
  "coins": 50,
  "stats": { "rating": 800, "tier": "Pulse II", "score": 0, "scoreUnits": 0, "coins": 50, "streak": 0, "longestStreak": 0 }
}
```

### 13.6 `PUT /api/themes/apply`
Applies an owned/default theme. Unowned → `403 FORBIDDEN`.
- **Body**: `{ "slug": "orbit" }` → `{ "success": true, "activeTheme": "orbit", "message": "Orbit applied" }`

---

## 14. Rankings & Leaderboard (`/api/rankings`)

### `GET /api/rankings`
- **Protected**: No. Sorted by `score` descending. Sensitive fields (`passwordHash`) are never returned.
- **Query**: `scope` (`global|college|batch|state|country`), `college`, `batch`, `state`, `country`, `limit` (1–100, default 50), `skip` (default 0)
```json
{
  "success": true,
  "count": 2,
  "data": [
    {
      "id": "u-rank-1", "name": "Riya Verma", "score": 48210, "rating": 1790, "streak": 132,
      "strictPercent": 88, "tier": "Zenith II", "college": "AKGEC", "branch": "CSE",
      "batch": "2026", "state": "UP", "country": "India", "createdAt": "2026-08-15T10:00:00.000Z"
    },
    {
      "id": "u-rank-2", "name": "Kabir Singh", "score": 46950, "rating": 1690, "streak": 97,
      "strictPercent": 74, "tier": "Zenith II", "college": "AKGEC", "branch": "CSE",
      "batch": "2026", "state": "UP", "country": "India", "createdAt": "2026-08-20T10:00:00.000Z"
    }
  ]
}
```
> The v2.1 spec shows the list under a `rankings` key with `rank` and `total` fields; see Appendix B-3.

---

## 15. CS Curriculum & Study Material (`/api/study`)

### 15.1 `GET /api/study/subjects` — Public
```json
{
  "success": true, "count": 5,
  "subjects": [
    { "id": "subj-1", "slug": "cn", "name": "Computer Networks", "description": "Foundations of modern networking, OSI/TCP-IP models, protocols, and cloud routing.", "order": 1, "_count": { "chapters": 13 } },
    { "id": "subj-2", "slug": "dbms", "name": "Database Management Systems", "description": "Relational algebra, normalization, transaction processing, and PostgreSQL internals.", "order": 2, "_count": { "chapters": 16 } },
    { "id": "subj-3", "slug": "os", "name": "Operating Systems", "description": "Process scheduling, virtual memory, paging, and kernel synchronization primitives.", "order": 3, "_count": { "chapters": 16 } },
    { "id": "subj-4", "slug": "oops", "name": "Object-Oriented Programming", "description": "Core paradigms, SOLID design principles, and GoF design patterns.", "order": 4, "_count": { "chapters": 14 } },
    { "id": "subj-5", "slug": "system-design", "name": "System Design", "description": "Distributed architectures, microservices, caching topologies, and high-availability patterns.", "order": 5, "_count": { "chapters": 16 } }
  ]
}
```

### 15.2 `GET /api/study/subjects/:subjectSlug` · alias `.../chapters` — Public
`:subjectSlug` ∈ `cn`, `dbms`, `os`, `oops`, `system-design`.
```json
{
  "success": true,
  "subject": {
    "id": "subj-1", "slug": "cn", "name": "Computer Networks",
    "chapters": [ { "id": "chap-1", "slug": "01-networking-fundamentals", "name": "Networking Foundations & Switching", "order": 1, "_count": { "topics": 1 } } ]
  }
}
```

### 15.3 `GET /api/study/chapters/:chapterId/topics` — Public
```json
{ "success": true, "topics": [ { "id": "top-1", "slug": "01-networking-foundations-and-switching", "name": "Networking Foundations and Switching", "order": 1 } ] }
```

### 15.4 `GET /api/study/topics/:topicSlug` — Public
Markdown article plus practice MCQs. `correctIndex` and `explanation` are hidden until submission.
```json
{
  "success": true,
  "topic": {
    "id": "st-1", "slug": "01-networking-foundations-and-switching", "name": "Networking Foundations and Switching", "order": 1,
    "content": "# Networking Foundations and Switching\n\nComputer networks interconnect computing nodes...",
    "isPublished": true,
    "chapter": { "id": "chap-1", "slug": "01-networking-fundamentals", "name": "Networking Foundations & Switching", "subject": { "slug": "cn", "name": "Computer Networks" } },
    "mcqs": [
      { "id": "mcq-1", "question": "Which layer in the OSI model is responsible for end-to-end reliability and flow control?", "options": ["Network Layer", "Transport Layer", "Data Link Layer", "Session Layer"], "difficulty": "Easy", "order": 1 }
    ]
  }
}
```

### 15.5 `POST /api/study/topics/:topicSlug/submit` — Protected
Grades answers, returns correct answers and explanations, and saves quiz performance.
- **Body**: `{ "answers": [ { "mcqId": "mcq-1", "selectedOption": 1 } ] }`
- **`200 OK`**:
```json
{
  "success": true, "totalQuestions": 1, "score": 1, "percentage": 100,
  "results": [
    { "mcqId": "mcq-1", "correct": true, "userAnswer": 1, "correctIndex": 1, "explanation": "The Transport Layer (Layer 4) provides transparent transfer of data between end users, providing reliable data transfer services including flow and error control." }
  ]
}
```

---

## 16. Social & GitHub OAuth Linking (`/api/social`)

### 16.1 `GET /api/social/:provider/link-url` — Protected
Returns a GitHub OAuth URL with HMAC-SHA256-signed `state` (contains userId and redirect). `:provider` = `github`. Optional query `redirectUri`.
```json
{ "success": true, "url": "https://github.com/login/oauth/authorize?client_id=...&scope=read:user%20user:email&state=..." }
```

### 16.2 `GET /api/social/:provider/callback` — Public
Query: `code`, `state`. Exchanges the code for a token, fetches the profile, attaches the account, then redirects to `FRONTEND_URL` with short success/error codes (e.g. `CANCELLED`, `EXPIRED`, `UNKNOWN_PROVIDER`). Open-redirect defenses are enforced. Already-linked-elsewhere → `SOCIAL_ALREADY_LINKED`.

### 16.3 `DELETE /api/social/:provider` — Protected
`{ "success": true, "message": "GitHub account unlinked successfully." }`

---

## 17. Gamification: Scoring, Streaks & Tiers

### 17.1 Problem-Solved Reward Matrix
On an accepted submission passing 100% of testcases:

| Difficulty | Points | Score units (×10) | Coins |
| :--- | :--- | :--- | :--- |
| Easy | 10 | +100 | 0 |
| Medium | 25 | +250 | 0 |
| Hard | 50 | +500 | 0 |

- Normal problem solves award **no coins**. Only today's Daily Problem awards **+2 coins** (via `coinService` / `dailyProblemService`), once per user per IST day. The daily login awards **+1 coin**.
- **Idempotency**: points/score are awarded **once per problem per user** (tracked in `user_problem_progress`). Re-submitting a solved problem returns `awarded: false`, `points: 0`, `coinsEarned: 0`, but the daily streak is still refreshed if it is the first solve of the day.

### 17.2 Streak Mechanics (IST)
1. **Day boundary**: IST date `YYYY-MM-DD` (`Asia/Kolkata`).
2. **First solve of the day**:
   - `lastStreakDate` = yesterday → `streak += 1`
   - `lastStreakDate` = today → unchanged
   - gap ≥ 2 days → `streak = 1`
3. `longestStreak = max(longestStreak, streak)`.

### 17.3 Rating Bands & Tiers

| Rating | Tier | Divisions |
| :--- | :--- | :--- |
| 700–899 | **Pulse** | I: 700–766 · II: 767–833 · III: 834–899 |
| 900–1099 | **Prism** | I: 900–966 · II: 967–1033 · III: 1034–1099 |
| 1100–1299 | **Aurora** | I: 1100–1166 · II: 1167–1233 · III: 1234–1299 |
| 1300–1499 | **Eclipse** | I: 1300–1366 · II: 1367–1433 · III: 1434–1499 |
| 1500+ | **Zenith** | I: 1500–1599 · II: 1600+ |

Examples: rating 800 → **Pulse II** (default for new users); 850 → Pulse III; 1200 → Aurora II; 1690 → Zenith II.

---

## 18. Rate Limits, Quotas & Security

### 18.1 Rate Limits
| Scope | Limit |
| :--- | :--- |
| `/api/auth/register`, `/api/auth/login` | 30 requests / 15 min / IP |
| `/api/onboarding` | 20 requests / min / user |
| Sample runs (`/api/execution/runs`) | 10 / min / user |
| Submissions (`/api/execution/submissions`) | 6 / min / user |
| `/api/execution/analyze-complexity` | 10 / min |
| In-flight executions | max 2 concurrent per user |

Exceeding the in-flight cap returns `429` with message `"Another execution is already running. Please wait."` (code: see Appendix B-1).

### 18.2 Security Headers & Limits
- `Content-Security-Policy` (scripts, styles, fonts, frame ancestors), `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`. CORS uses an origin allow-list.
- **Code size**: max 64 KB → `413 CODE_TOO_LARGE`. Code containing `main()` → `400 FUNCTION_ONLY_REQUIRED`.

---

## 19. Dual-Tier Database & Auto-Healing Architecture

```
Incoming API request
        |
        v
Auth middleware (JWT validation)
        |
        v
   DATABASE_URL set?
     YES /      \ NO
        v        v
 PrismaClient   Transparent model proxy
 (PostgreSQL /  (InMemoryStore fallback)
  Neon)
        |  (on connection error)
        +------------>  InMemoryStore
```

**InMemoryStore** provides: 14 calibrated topics (DSA & Core), 10 store themes, a pre-seeded demo student, the full CS curriculum (5 subjects, 75+ chapters, 150+ topics and MCQs), and the multi-tier evaluation sandbox.

**Demo credentials**: `student@example.com` / `StrongPassword123` · 100 coins · rating 800 (Pulse II) · available via the `⚡ 1-Click Demo Login` button on `/`.

---

## 20. Automated Test Suite

38 test suites run with the Node native test runner (`node --test`).
```bash
npm test                  # all suites
npm run test:unit         # utilities, algorithms, calculators
npm run test:integration  # HTTP + business logic
npm run test:coverage     # experimental coverage
```

| Suite | Type | Verifies |
|---|---|---|
| `authLifecycle` | Integration | Register, password limits (8–72), duplicate 409, login, refresh, logout revocation |
| `userManagement` | Integration | Profile, academic info, overview, activity, problem list with status |
| `topicsCatalog` | Integration | Topics, categories, counts, beginner preset |
| `problemEndpoints` | Integration | Listing, filters, templates, problem-scoped run/submit |
| `executionVerdicts` | Integration | Multi-tier judging, short-circuiting, all verdicts, testcase privacy |
| `executionBatch` | Integration | 20-case batch chunking, runner headers, large sets |
| `executionLanguage` | Unit | Languages, Judge0 IDs, normalization |
| `executionOptimization` | Integration | Submission cache, polling, non-owner 404 |
| `complexityAnalyzer` | Unit | 19 AST regression tests |
| `automatedDailyProblem` | Integration | IST rotation, streak and history |
| `dailyLoginReward` | Integration | IST day boundary +1 login coin, duplicate suppression |
| `dailyProblemReward` | Integration | +2 coins, +1 streak on first ACCEPTED |
| `coinServiceAndHistory` | Integration | Balance, audit pagination (`limit`, `offset`), fallback defaults |
| `coinReward.integration` | Integration | Atomic coin ledger integrity |
| `themeStoreLifecycle` | Integration | Catalogue, deduction, double-purchase rejection, activation |
| `rankingsLeaderboard` | Integration | Score-desc order, scope filters, limit clamping |
| `studyModule` | Integration | Subjects → topics, MCQ grading, explanations |
| `socialAuth` | Integration | HMAC state signing, error redirects, open-redirect defense, unlink |
| `securityAndMiddleware` | Integration | Health/ping, headers, rate limiting, in-flight limiter, error format |
| `unitUtilities` | Unit | `ApiError`, `outputComparator`, `codeBuilder`, `userHeaderStats`, jwt, bcrypt, activity |
| `cors` | Integration | Origin allow-list, preflight, rejection |
| `problemSecurity` | Integration | Hidden testcase redaction, 503 fallback when runner unreachable |
| `streakService` | Unit | IST boundaries, increment, missed-day reset |

All tests set `DATABASE_URL = ""`, so the in-memory store handles everything: no network calls and no production data touched.

---

## Appendix A — Merge Changelog (what was fixed or removed)

**Wrong or contradictory content corrected**
1. **Default tier**: the first doc said new users (rating 800) are "Prism I", but its own tier table puts 800 in Pulse II. Fixed everywhere to **Pulse II**.
2. **Other mismatched tiers in examples** (rating vs tier did not agree with the table): rating 1200 "Prism II" → Aurora II; rating 810 "Prism I" → Pulse II; rating 1690 "Eclipse III" → Zenith II; rating 1820 "Zenith I" → Zenith II.
3. **Streak timezone**: the first doc said UTC in the streak section but IST in the Daily Problem section. Unified to **IST**.
4. **Reward payload**: the second doc showed `reward: { coinsEarned: 10, pointsEarned: 15 }`, which contradicts the reward matrix (Easy = 10 points, 0 coins). Replaced with the matrix-consistent payload (`awarded`, `points`, `scoreDelta`, `coinsEarned`, `stats`).
5. **`RunResponse` type** declared `cases` while every example used `results`. Type now uses `results`.
6. **Onboarding `topicIds`**: the second doc used `["arrays","two-pointers"]`, which don't match seeded slugs (`dsa-arrays`, …). Uses the first doc's slugs.
7. **Table of contents** listed 18 sections while the document had 20; rebuilt.
8. **Truncated examples** whose `count` didn't match the list (e.g. `count: 9` with 3 items; history `totalPages: 4`) were corrected or marked as truncated.
9. **Stale "default balance" examples**: reward example showed `coins: 130` with `coinsEarned: 0`; set to a consistent value.
10. **Login response**: added the `rewards` object (from the second doc); the first doc omitted the daily login coin from its login example.

**Duplicates merged into one place**: health/ping/root, all auth endpoints, error schema, IST rules, themes, study, social, daily problem, rankings, execution languages, complexity analysis.

**Dropped as lower-quality duplicates**: generic error codes `BAD_REQUEST` / `CONFLICT` (replaced by the granular codes), and the vague "Public / Protected" access note on categories (set to Public).

**Added from the second doc (not in the first)**: business rules (never-block, single coin authority), `/api/coins/balance` and `/history`, `GET /api/topics/dsa` and `/:identifier`, `/api/problems/:slug/starter|template`, `/api/problems/:slug/submit`, `PUT /api/users/me`, rankings `skip` and `scope=global`.

---

## Appendix B — Open Items to Verify Against Code

These could not be resolved from the two documents alone; the version chosen is stated.

| # | Item | Doc 1 says | Doc 2 says | Chosen |
|---|---|---|---|---|
| 1 | In-flight limit error code | `IN_FLIGHT_LIMIT_EXCEEDED` (error table) but `RATE_LIMITED` (limits section) | — | `RATE_LIMITED` |
| 2 | Run result field names | `time`/`memory` (example) vs `timeMs`/`memoryKb`/`index` (type) | `timeMs`/`memoryKb`/`index` | Example shape; both optional in type |
| 3 | Rankings response key | `data` | `rankings` (+ `rank`, `total`) | `data`; `rank`/`total` optional |
| 4 | Study quiz submit format | Array `[{mcqId, selectedOption}]`; response `totalQuestions/percentage/results` | Map `{mcq-1: 1}`; response `total/passed/feedback` | Doc 1 |
| 5 | Pagination param on problems | `pageSize` (default 25) | `limit` (default 20) | `pageSize` |
| 6 | Run with custom `stdin`, no slug | not mentioned | supported | Mentioned as v2.1 behavior |
| 7 | Streak semantics | One `streak` (any first solve of the day) and a separate "Daily Problem streak" | one `streak` | Unclear whether they are the same field; confirm |
| 8 | Manifest `features`/`apiGroups` | no `daily-problem`/`coins` | uses those routes | Added them to `apiGroups` |
| 9 | Rating below 700 | tier undefined | — | Confirm the floor/clamp |
| 10 | Test count | "38 suites" but only 23 listed | — | Table lists key suites only |
