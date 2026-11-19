# Calibr8 — API Documentation & Contract Specification

> **Document version**: 3.0.0 (2026-11-18). Rewritten after checking every route, controller, service and middleware in `src/` line by line. Where this document and the code disagree, the code wins. Please report the mismatch.
> **Audience**: frontend/mobile engineers and AI coding agents integrating with the backend.
> **Base URL (dev)**: `http://localhost:3000` (`PORT` env, binds `0.0.0.0`)
> **Global prefix**: `/api` (plus `/health`, `/ping`, and the developer console at `/`)
> **Content-Type**: `application/json` (body limit **1 MB**, JSON or urlencoded)
> **Auth**: `Authorization: Bearer <jwt>` (HS256, default expiry `1d` via `JWT_EXPIRES_IN`)
> **Timestamps**: ISO 8601 UTC strings
> **Day boundaries**: daily login reward, daily problem and streak use IST (`Asia/Kolkata`, `YYYY-MM-DD`). The activity heatmap buckets by **UTC** day (see §7.3).
> **Languages**: `cpp` (GCC 13 / C++20), `c` (GCC 13), `java` (OpenJDK 17), `python` (Python 3.10), `javascript` (Node.js 22)

**Access legend** used below: **Public** = no token needed · **Protected** = valid token required (`401` otherwise) · **Optional** = works without a token; a valid token adds user-specific data. An invalid or revoked token on an Optional route is silently ignored.

See **§21 Known Issues** for behaviour found during the review that is probably unintended, and **Appendix A** for what changed since v2.1.

---

## Table of Contents

1. [Architecture & Business Rules](#1-architecture--business-rules)
2. [Errors, Status Codes & Rate-Limit Headers](#2-errors-status-codes--rate-limit-headers)
3. [TypeScript Type Definitions](#3-typescript-type-definitions)
4. [Frontend Client Guide](#4-frontend-client-guide)
5. [System & Health](#5-system--health)
6. [Authentication (`/api/auth`)](#6-authentication-apiauth)
7. [Users & Profile (`/api/users`)](#7-users--profile-apiusers)
8. [Topics & Categories (`/api/topics`)](#8-topics--categories-apitopics)
9. [Onboarding & Calibration (`/api/onboarding`)](#9-onboarding--calibration-apionboarding)
10. [Problems (`/api/problems`)](#10-problems-apiproblems)
11. [Code Execution (`/api/execution`, `/api/execute`)](#11-code-execution-apiexecution-apiexecute)
12. [Daily Problem (`/api/daily-problem`)](#12-daily-problem-apidaily-problem)
13. [Coins (`/api/coins`)](#13-coins-apicoins)
14. [Theme Store (`/api/themes`)](#14-theme-store-apithemes)
15. [Rankings (`/api/rankings`)](#15-rankings-apirankings)
16. [Study Material (`/api/study`)](#16-study-material-apistudy)
17. [Social / GitHub OAuth (`/api/social`)](#17-social--github-oauth-apisocial)
18. [Gamification: Points, Rating, Tiers, Streaks](#18-gamification-points-rating-tiers-streaks)
19. [Rate Limits & Security](#19-rate-limits--security)
20. [Database & Test Suite](#20-database--test-suite)
21. [Known Issues Found in Review](#21-known-issues-found-in-review)
22. [Endpoint Index](#22-endpoint-index)
- [Appendix A — Changes from v2.1](#appendix-a--changes-from-v21)

---

## 1. Architecture & Business Rules

### 1.1 Pattern
- **Routers** (`src/routers/*.router.js`): route matching, middleware (`protect`, `optionalAuth`, rate limiters, in-flight limiter).
- **Controllers** (`src/controllers/*.controller.js`): validation, transactions, response shaping.
- **Services / utils** (`src/services/`, `src/utils/`): coin ledger, daily problem, streaks, complexity analyzer, code builder, output comparison.
- **Database**: Prisma → PostgreSQL / Neon (`src/config/db.js`). Requires `DATABASE_URL`; connection failures return `503 DATABASE_UNAVAILABLE`.
- **Code runner**: external CodeBox service (`CODEBOX_URL` + `CODEBOX_TOKEN`, HTTPS unless `CODEBOX_ALLOW_INSECURE_HTTP=true`). Missing or unreachable → `503 EXECUTION_UNAVAILABLE`.

### 1.2 Business rules (as implemented)
1. **New account defaults**: `coins: 100`, `rating: 800`, `score: 0`, `streak: 0`, `longestStreak: 0`, `preferredLanguage: "cpp"`, `country: "India"`, `onboarded: false`. The stored `tier` column defaults to `"Prism I"`; the computed `stats.tier` for rating 800 is `"Pulse II"` (see §21-1). **Use `stats.tier` for display.**
2. **Coins** only change through `coinService.js` / `dailyProblemService.js`; each change writes a `CoinTransaction` row with `balanceAfter`. Sources: `DAILY_LOGIN` (+1), `DAILY_PROBLEM` (+2), `THEME_PURCHASE` (−price). **Normal problem solves award 0 coins.**
3. **Streak** advances **only** by solving the daily problem (not by logging in, not by solving other problems).
4. **Never-block**: reward failures never fail login or submission; they are logged and safe defaults are returned (`rewardError: true`, `dailyProblemReward: { granted: false, coins: 0 }`).
5. **Hidden testcases** never expose `input`, `expected`, `actual` or `errorText`.
6. **Function-only code**: for function-model problems, code containing a `main()` entry point is rejected with `400 FUNCTION_ONLY_REQUIRED`.

### 1.3 Response shapes. These are *not* uniform, so check each endpoint.
| Shape | Used by |
|---|---|
| `{ success: true, ...fields }` | most endpoints |
| `{ success: true, count, data: [...] }` | `GET /api/problems`, `GET /api/rankings` |
| `{ success: true, data: [...], message }` | `GET /api/users/all` |
| **Bare JSON array** (no `success`) | `GET /api/topics/categories`, `GET /api/topics/dsa/categories`, `GET /api/study/subjects`, `GET /api/study/chapters/:chapterId/topics` |
| **Bare JSON object** (no `success`) | `GET /api/topics/dsa/:slug/problems`, `GET /api/study/subjects/:subjectSlug`, `GET /api/study/topics/:topicSlug`, `GET /api/social/:provider/link-url` |
| `302` redirect | `GET /api/social/:provider/callback` |
| `text/plain` `pong` | `/ping`, `/api/ping` |

---

## 2. Errors, Status Codes & Rate-Limit Headers

Every error goes through `src/middlewares/error.middleware.js`:
```json
{ "success": false, "code": "ERROR_CODE", "message": "Human readable message", "details": { } }
```
`details` is present only when the error carries it (rate limits, theme purchase errors). 5xx messages are sanitized to `"Internal server error."` except for the explicit codes below.

When a controller throws without a specific code, the code defaults by status: `400 BAD_REQUEST`, `401 UNAUTHORIZED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 CONFLICT`, `413 CODE_TOO_LARGE`, `422 UNPROCESSABLE_ENTITY`, `429 RATE_LIMITED`, `503 JUDGE_UNAVAILABLE`, else `INTERNAL_ERROR`.

| HTTP | Code | Raised by |
|---|---|---|
| 400 | `VALIDATION_ERROR` | register: missing `email`/`password`/`name` |
| 400 | `MISSING_CREDENTIALS` | login: missing `email`/`password` |
| 400 | `MISSING_FIELDS` | change-password: missing `oldPassword`/`newPassword` |
| 400 | `INVALID_EMAIL` | register: email fails `^[^\s@]+@[^\s@]+\.[^\s@]+$` |
| 400 | `WEAK_PASSWORD` | password < 8 chars (register, change-password) |
| 400 | `PASSWORD_TOO_LONG` | password > 72 UTF-8 bytes |
| 400 | `PASSWORD_EQUALS_EMAIL` | password equals email (case-insensitive) |
| 400 | `INVALID_CURRENT_PASSWORD` | change-password: wrong `oldPassword` (**400, not 401**) |
| 400 | `BAD_REQUEST` | generic validation (profile, language, onboarding, theme apply without `slug`) |
| 400 | `INVALID_STATUS` | `GET /api/problems?status=` not `solved`/`todo` |
| 400 | `MISSING_CODE` | run/submit/analyze with empty code |
| 400 | `FUNCTION_ONLY_REQUIRED` | code defines `main()` on a function-model problem |
| 400 | `NO_TESTCASES` | run: problem has testcases but none are visible |
| 400 | `ALREADY_OWNED` | theme already owned. `details: { owned: true }` |
| 400 | `INSUFFICIENT_COINS` | theme price > balance. `details: { required, have }` |
| 401 | `UNAUTHORIZED` | no/malformed Bearer header, or account deleted |
| 401 | `INVALID_TOKEN` | bad signature / malformed JWT |
| 401 | `TOKEN_EXPIRED` | JWT past `exp` |
| 401 | `TOKEN_REVOKED` | token was logged out / refreshed away |
| 401 | `INVALID_CREDENTIALS` | login: unknown email or wrong password |
| 403 | `FORBIDDEN` | apply a theme you don't own |
| 404 | `NOT_FOUND` | problem, topic, subject, study topic, theme, user, template |
| 404 | `SUBMISSION_NOT_FOUND` | unknown submission or not the owner |
| 404 | `UNKNOWN_PROVIDER` | `link-url` with provider other than `github` |
| 404 | `USER_NOT_FOUND` | theme purchase for a vanished user |
| 404 | `DAILY_PROBLEM_NOT_FOUND` | daily problem could not be resolved |
| 409 | `EMAIL_ALREADY_EXISTS` | register with an existing email |
| 409 | `CONFLICT` | any other Prisma unique-constraint violation |
| 413 | `CODE_TOO_LARGE` | run/submit code > 64 KB |
| 422 | `UNSUPPORTED_LANGUAGE` | language not recognised (see §11.1 aliases) |
| 422 | `NO_TESTCASES` | run/submit: problem has no testcases at all |
| 429 | `AUTH_RATE_LIMITED` | register/login limiter. `details: { retryAfterSeconds }` |
| 429 | `RATE_LIMITED` | run/submit/analyze limiter (`details: { retryAfterSeconds }`) or > 2 in-flight executions (no `details`) |
| 500 | `EXECUTION_AUTH_FAILED` | CodeBox rejected `CODEBOX_TOKEN` |
| 500 | `INTERNAL_ERROR` | unhandled exception |
| 503 | `EXECUTION_UNAVAILABLE` | CodeBox unconfigured, unreachable, error status, or 15 s timeout |
| 503 | `DATABASE_UNAVAILABLE` | Prisma init / connection errors (`P1000`–`P1003`) |
| 503 | `SUBMISSION_STORAGE_UNAVAILABLE` | could not save an authenticated submission or its verdict |
| 503 | `NO_ELIGIBLE_PROBLEMS` | daily problem requested but the problems table is empty |

**Rate-limit headers** (on every request through a window limiter): `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (seconds). On `429` also `Retry-After` (seconds).

---

## 3. TypeScript Type Definitions

```typescript
// ===== Core =====
export type SupportedLanguage = "cpp" | "c" | "java" | "python" | "javascript";
export type Difficulty = "Easy" | "Medium" | "Hard";
export type UserDifficulty = "easy" | "medium" | "hard";

/** Computed tier: `${TierName} ${Division}`; see §18.3 */
export type TierName = "Pulse" | "Flux" | "Prism" | "Aurora" | "Eclipse" | "Zenith";
export type UserTier = `${TierName} ${"I" | "II" | "III"}`;

export interface UserHeaderStats {
  rating: number;
  tier: UserTier;       // computed from rating (authoritative for display)
  score: number;        // floor(scoreUnits / 10) = total points
  scoreUnits: number;   // raw User.score (points × 10)
  coins: number;
  streak: number;
  longestStreak: number;
}

export interface Topic { id: string; slug: string; name: string; category: string /* "DSA" | "CORE" */; }

export interface UserTopicLevel {
  id: string;
  userId: string;
  topicId: string;
  level: string;        // normally "easy" | "medium" | "hard" (see §21-12)
  topic: Topic;
}

export interface SocialAccount {
  id: string; userId: string; provider: "github"; providerUserId: string;
  username: string | null; name: string | null; email: string | null;
  avatarUrl: string | null; profileUrl: string | null; bio: string | null; headline: string | null;
  stats: { publicRepos: number; followers: number; following: number } | null;
  connectedAt: string;
}

/** Shape of `user` from GET /api/users/me, /me/overview, PATCH /api/users/me */
export interface UserProfile {
  id: string; email: string; name: string;
  difficulty: UserDifficulty | null;
  rating: number;
  score: number;        // raw score units
  streak: number;
  strictPercent: number;
  tier: string;         // stored column, may be stale (§21-1)
  college: string | null; branch: string | null; batch: string | null;
  state: string | null; country: string | null;
  coins: number;
  onboarded: boolean;
  preferredLanguage: SupportedLanguage;
  createdAt: string; updatedAt: string;
  socialAccounts: SocialAccount[];
  topics: UserTopicLevel[];
  // NOTE: longestStreak is NOT included here (§21-2); read it from stats or /api/coins/balance
}

// ===== Auth =====
export interface LoginRewards {
  coinsEarnedToday: number;
  loginCoins: number;   // 1 on first login of the IST day, else 0
  streak: number;
  longestStreak: number;
  isNewDay: boolean;
}

export interface AuthResponse {
  success: true;
  token: string;
  isNewUser: boolean;
  user: Record<string, unknown>;  // full user row minus passwordHash (+ socialAccounts, topics)
  stats: UserHeaderStats;
  rewards?: LoginRewards;         // login only
}

export interface SessionResponse {
  success: true;
  user: Record<string, unknown> & { todayISTDate: string; coinsEarnedToday: number };
  stats: UserHeaderStats;
}

export interface ActivitySummary {
  activity: Record<string, number>; // "2026-11-08": 2 (UTC day)
  total: number;
  activeDays: number;
}

// ===== Problems =====
export interface ProblemCatalogueItem {
  id: string; problemNumber: number; slug: string; title: string;
  difficulty: Difficulty;
  tags: string[];
  solvedCount: number;
  createdAt: string;
  dsaTopic: { name: string; slug: string } | null;
  timeLimit: number; memoryLimit: number;
  _count: { examples: number; testcases: number; templates: number };
  topic: string;            // resolved topic name, "Other" if unknown
  topicSlug: string;
  acceptanceRate: number | null; // % accepted submissions, 1 decimal
  points: 10 | 25 | 50;
  isSolved: boolean;
}

export interface ProblemExample { id: string; order: number; input: string; output: string; explanation: string | null; }
export interface VisibleTestcase { testIndex: number; isVisible: true; input: string; output: string; stdinSmall: string; expectedSmall: string; }

export interface ProblemDetail {
  id: string; problemNumber: number; slug: string; title: string; description: string;
  difficulty: Difficulty; timeLimit: number; memoryLimit: number; solvedCount: number; tags: string[];
  examples: ProblemExample[];
  testcases: VisibleTestcase[];                       // visible only
  templates: Partial<Record<SupportedLanguage, string>>;
  userTemplates: Partial<Record<SupportedLanguage, string>>; // same as templates
  templatesArray: Array<Record<string, unknown>>;     // raw template rows (§21-14)
}

// ===== Execution =====
export interface ExecutionLanguage {
  key: SupportedLanguage; label: string; version: string;
  judge0Id: number; starterAvailable: boolean; monacoLanguage: string;
}

/** Per-case status strings: "Accepted" | "Wrong Answer" | "Time Limit Exceeded" | "Runtime Error" | "Compilation Error" | other runner status */
export type CaseStatus = string;

export interface RunCaseResult {
  index: number; testIndex: number; isVisible: true;
  input: string; expected: string; actual: string; studentStdout?: string;
  status: CaseStatus; passed: boolean;
  timeMs: number; cpuTimeMs: number; wallTimeMs: number; memoryKb: number;
  inputBytes: number; errorText?: string | null;
}

export interface CompactComplexity {
  time: { bestEstimate: string; confidence: string } | null;
  space: { bestEstimate: string; confidence: string } | null;
  summary: string | null;
}

export interface RunResponse {
  success: true;
  verdict: CaseStatus; status: CaseStatus;   // first failing case's status, else "Accepted"
  passedCount: number; totalCount: number;
  results: RunCaseResult[];
  complexity: CompactComplexity | null;
}

export type SubmissionStatus =
  | "PROCESSING" | "ACCEPTED" | "WRONG_ANSWER" | "TIME_LIMIT_EXCEEDED"
  | "RUNTIME_ERROR" | "COMPILATION_ERROR" | "ERROR";

export type TierReached = "Tier 0 (Failed)" | "Tier 1 (Brute Force)" | "Tier 2 (Better)" | "Tier 3 (Optimal)";

export interface VisibleSubmissionCase {
  testIndex: number; isVisible: true; passed: boolean; status: CaseStatus;
  input: string; expected: string; actual: string;
  time: number; timeMs: number; cpuTimeMs: number; wallTimeMs: number;
  memory: number; memoryKb: number; inputBytes: number; errorText?: string | null;
}
export interface HiddenSubmissionCase {
  testIndex: number; isVisible: false; passed: boolean; status: CaseStatus; time: number; memory: number;
}

export interface FirstFailure {
  testIndex: number; status: CaseStatus; message: string;
  errorText: string | null;                    // null for hidden cases
  input?: string; expected?: string; actual?: string; // visible cases only
}

export interface SubmissionReward {
  awarded: boolean;      // false if this problem was already solved before
  points: number; scoreDelta: number;
  coinsEarned: number;   // 0, or 2 when it was today's daily problem
  stats: UserHeaderStats;
}

export interface SubmissionQueued {
  success: true; submissionId: string;
  verdict: "QUEUED"; status: "QUEUED";
  pollUrl: string; message: string;
  problem: { slug: string; title: string };
}

export interface SubmissionResult {
  success: true; submissionId: string;
  verdict: SubmissionStatus; status: SubmissionStatus;
  tierReached: TierReached;
  passedCount: number; totalCount: number;
  time: string;          // e.g. "52ms" (max across cases)
  memory: number;        // KB (max across cases)
  results: Array<VisibleSubmissionCase | HiddenSubmissionCase>;
  firstFailure: FirstFailure | null;
  complexity: CompactComplexity | null;
  reward: SubmissionReward | null;   // null when anonymous or not accepted
  rewardError: boolean;
  dailyProblemReward: { granted: boolean; coins: number };
  problem: { slug: string; title: string };
}

export interface SubmissionPoll {
  success: true;
  submission: Omit<SubmissionResult, "success" | "submissionId"> & {
    id: string; problemId: string; language: SupportedLanguage; createdAt: string;
  };
}

// ===== Daily problem / coins =====
export interface DailyProblemResponse {
  success: true; istDate: string;
  problem: { id: string; slug: string; title: string; difficulty: Difficulty; description: string; tags: string[]; solvedCount: number };
  reward: { coins: 2; description: string };
  completed: boolean; solvedToday: boolean; rewardClaimed: boolean; completedAt: string | null;
  streak: number; longestStreak: number;
  nextRefreshMs: number; nextRefreshTime: "12:00 AM IST";
}

export interface CoinTransaction {
  id: string; amount: number; type: "DAILY_LOGIN" | "DAILY_PROBLEM" | "THEME_PURCHASE";
  referenceId: string | null; istDate: string; balanceAfter: number; createdAt: string;
}

// ===== Themes =====
export interface StoreTheme {
  id: string; slug: string; name: string; price: number; previewColor: string | null;
  isDefault: boolean; owned: boolean; applied: boolean; canAfford: boolean;
}

// ===== Rankings =====
export interface RankedUser {
  id: string; name: string; score: number; rating: number; streak: number; strictPercent: number;
  tier: string; college: string | null; branch: string | null; batch: string | null;
  state: string | null; country: string | null; createdAt: string;
}

// ===== Study (bare responses, no `success`) =====
export interface StudySubject { id: string; slug: string; name: string; description: string | null; icon: string | null; order: number; createdAt: string; _count: { chapters: number }; }
export interface StudyChapter { id: string; slug: string; name: string; subjectId: string; order: number; _count?: { topics: number }; }
export interface StudyTopicSummary { id: string; slug: string; name: string; order: number; }
export interface StudyMCQ { id: string; question: string; options: string[]; difficulty: string; order: number; explanation: string | null; }
export interface StudyTopicDetail {
  id: string; slug: string; name: string; chapterId: string; order: number;
  content: string; isPublished: boolean; createdAt: string;
  mcqs: StudyMCQ[];                                   // correctIndex withheld
  chapter: StudyChapter & { subject: Omit<StudySubject, "_count"> };
}
export interface StudyQuizSubmitResponse {
  success: true; userId: string; topicSlug: string; score: number; total: number;
  result: Array<{ mcqId: string; isCorrect: boolean; correctIndex: number; explanation: string | null }>;
}
```

---

## 4. Frontend Client Guide

### 4.1 Fetch wrapper
```typescript
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

export async function apiRequest<T>(endpoint: string, options: RequestInit & { requiresAuth?: boolean } = {}): Promise<T> {
  const { requiresAuth = true, headers: custom, ...rest } = options;
  const headers = new Headers(custom || {});
  if (!headers.has("Content-Type") && rest.body) headers.set("Content-Type", "application/json");
  if (requiresAuth) {
    const token = localStorage.getItem("calibr8_token");
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch(`${API_BASE_URL}${endpoint}`, { ...rest, headers });
  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const payload = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401) {
      localStorage.removeItem("calibr8_token");
      window.dispatchEvent(new Event("calibr8_session_expired"));
    }
    throw payload; // { success: false, code, message, details? }
  }
  return payload as T;
}
```
After `POST /api/auth/refresh`, **replace the stored token immediately**. The old token is revoked.

### 4.2 Polling an async submission
`POST /api/execution/submissions` returns `202` with `status: "QUEUED"`, but polling returns `"PROCESSING"` until a verdict is stored. Treat both as pending.
```typescript
const PENDING = ["QUEUED", "PROCESSING"];

export async function waitForVerdict(submissionId: string, intervalMs = 1000) {
  for (;;) {
    const { submission } = await apiRequest<SubmissionPoll>(`/api/execution/submissions/${submissionId}`);
    if (!PENDING.includes(submission.status)) return submission;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
```
Poll soon after submitting: per-case `results`, `firstFailure`, `reward` and `complexity` are held in server memory for **30 minutes** only (§11.6). If you don't need async, send `wait: true` and get the verdict in one response.

---

## 5. System & Health

### 5.1 `GET /` (Public, content-negotiated)
- `Accept: text/html` → developer console (`public/index.html`).
- `Accept: application/json` → manifest: `{ service, status: "online", version: "1.2.0", architecture, features[], apiGroups{}, endpoints[] }`. The embedded `endpoints` list is hand-maintained and **out of date** (§21-10). Use §22 of this document instead.

### 5.2 `GET /health` · `GET /api/health` (Public)
```json
{ "status": "ok", "service": "Calibr8 Backend", "timestamp": "2026-11-18T08:50:00.000Z" }
```

### 5.3 `GET /ping` · `GET /api/ping` (Public)
Plain text `pong`.

---

## 6. Authentication (`/api/auth`)

### 6.1 `POST /api/auth/register` (Public · 30 req / 15 min / IP)
Body: `{ "email": "student@example.com", "password": "StrongPassword123", "name": "Alex Mercer" }`
- `email` trimmed and lowercased; `name` trimmed. Password rules: ≥ 8 chars, ≤ 72 bytes, ≠ email. bcrypt (10 rounds).

**`201 Created`**
```json
{
  "success": true,
  "user": {
    "id": "0b6c…", "email": "student@example.com", "phone": null, "name": "Alex Mercer",
    "difficulty": null, "rating": 800, "score": 0, "streak": 0, "strictPercent": 0,
    "tier": "Prism I", "college": null, "branch": null, "batch": null, "state": null, "country": "India",
    "onboarded": false, "createdAt": "…", "updatedAt": "…", "preferredLanguage": "cpp",
    "coins": 100, "activeThemeId": null, "lastStreakDate": null, "longestStreak": 0, "lastLoginISTDate": null,
    "socialAccounts": [], "topics": []
  },
  "stats": { "rating": 800, "tier": "Pulse II", "score": 0, "scoreUnits": 0, "coins": 100, "streak": 0, "longestStreak": 0 },
  "token": "eyJhbGciOi…",
  "isNewUser": true
}
```
Registration does **not** grant the daily login coin. That happens on the first `login`.

### 6.2 `POST /api/auth/login` (Public · 30 req / 15 min / IP)
Body: `{ "email": "student@example.com", "password": "StrongPassword123" }`

**`200 OK`**: `{ success, user, stats, token, isNewUser: false, rewards }`, where `user` has the same shape as register and
```json
"rewards": { "coinsEarnedToday": 1, "loginCoins": 1, "streak": 3, "longestStreak": 7, "isNewDay": true }
```
On later logins the same IST day, `loginCoins: 0`, `isNewDay: false`. If the reward step fails, login still succeeds with zeroed `rewards`.

### 6.3 `GET /api/auth/me` · `GET /api/auth/verify` (Protected)
```json
{
  "success": true,
  "user": {
    "id": "…", "email": "…", "name": "…", "difficulty": "medium", "rating": 1200, "score": 4500,
    "streak": 3, "longestStreak": 7, "coins": 101, "lastStreakDate": "…", "lastLoginISTDate": "2026-11-18",
    "tier": "Prism II", "onboarded": true, "preferredLanguage": "python", "createdAt": "…", "updatedAt": "…",
    "socialAccounts": [], "topics": [],
    "todayISTDate": "2026-11-18", "coinsEarnedToday": 1
  },
  "stats": { "rating": 1200, "tier": "Prism II", "score": 450, "scoreUnits": 4500, "coins": 101, "streak": 3, "longestStreak": 7 }
}
```

### 6.4 `POST /api/auth/refresh` (Protected)
Issues a new token **and revokes the presented one**.
```json
{ "success": true, "token": "eyJ…", "user": { "id": "…", "email": "…", "…": "…", "socialAccounts": [], "topics": [] }, "stats": { } }
```

### 6.5 `POST /api/auth/change-password` (Protected)
Body: **`{ "oldPassword": "OldPassword123", "newPassword": "NewStrongPassword456" }`** (field is `oldPassword`, not `currentPassword`).
- New password is validated first (`WEAK_PASSWORD`, `PASSWORD_TOO_LONG`, `PASSWORD_EQUALS_EMAIL`), then the old one (`400 INVALID_CURRENT_PASSWORD`).
- **`200`**: `{ "success": true, "message": "Password updated successfully." }`
- Existing tokens stay valid (§21-11).

### 6.6 `POST /api/auth/logout` (Protected)
Revokes the presented token (stored until its expiry). **`200`**: `{ "success": true, "message": "Logged out successfully." }`

---

## 7. Users & Profile (`/api/users`)

All Protected. Validation errors use the generic `400 BAD_REQUEST`.

### 7.1 `GET /api/users/me` · alias `GET /api/users`
`{ "success": true, "user": UserProfile }`. Fields: `id, email, name, difficulty, rating, score, streak, strictPercent, tier, college, branch, batch, state, country, coins, onboarded, preferredLanguage, createdAt, updatedAt, socialAccounts, topics[{…, topic}]`. **No `longestStreak`** (§21-2).

### 7.2 `GET /api/users/me/overview`
Profile plus activity in one call: `{ success, user: UserProfile, activity, total, activeDays }`.

### 7.3 `GET /api/users/me/activity`
`{ "success": true, "activity": { "2026-11-08": 2, "2026-11-09": 1 }, "total": 3, "activeDays": 2 }`
Counts submissions with `status = ACCEPTED` and `passedCount = totalCount > 0` over the last **371 days**, grouped by **UTC** calendar day.

### 7.4 `PUT /api/users/me` · alias `PUT /api/users`
Name only. Body `{ "name": "Jane Developer" }` → `{ success, user }` (profile fields + topics, without `socialAccounts`). Empty name → `400 "Name cannot be empty."`.

### 7.5 `PATCH /api/users/me`
Any of `name, college, branch, batch, state, country` (at least one). Academic values are stringified and trimmed (`null` becomes `""`). Returns `{ success, user: UserProfile }`.

### 7.6 `PATCH /api/users/me/academic` · alias `PATCH /api/users/academic`
Any of `college, branch, batch, state, country` (at least one).
```json
{ "success": true, "message": "Academic profile saved",
  "user": { "id": "…", "name": "…", "email": "…", "college": "AKGEC", "branch": "CSE", "batch": "2026", "state": "UP", "country": "India", "updatedAt": "…" } }
```

### 7.7 `PATCH /api/users/me/language` · alias `PATCH /api/users/language`
Body `{ "language": "python" }` (case-insensitive; exact keys only, no aliases). → `{ "success": true, "language": "python" }`

### 7.8 `GET /api/users/all`
All problems with the caller's solve status (track view), ordered by `problemNumber`.
```json
{
  "success": true,
  "data": [
    { "name": "Two Sum", "slug": "two-sum", "number": 1, "topic": "Array", "topicSlug": "arrays",
      "level": "easy", "levelDisplay": "easy", "solvedPercentage": 74, "isSolved": true }
  ],
  "message": "Problems fetched successfully"
}
```
`levelDisplay` is `"mid"` for medium. `solvedPercentage = round(solvedCount / totalUsers × 100)`. `topic`/`topicSlug` are `null` when the problem has no DSA topic.

---

## 8. Topics & Categories (`/api/topics`)

### 8.1 `GET /api/topics` (Public)
Query `category=dsa|core` (any other value returns all). Sorted by name.
```json
{ "message": "Topics fetched successfully", "success": true, "count": 2,
  "topics": [ { "id": "…", "slug": "dsa-arrays", "name": "DSA - Arrays", "category": "DSA" }, { "id": "…", "slug": "dbms", "name": "DBMS", "category": "CORE" } ] }
```

### 8.2 `GET /api/topics/dsa` (Public)
`{ success, count, topics, dsaTopics }`. `topics` and `dsaTopics` are the same list of DSA calibration topics.

### 8.3 `GET /api/topics/categories` (Public) · `GET /api/topics/dsa/categories` (**Protected**)
Same handler, **bare array**, ordered by `order`:
```json
[ { "id": "…", "slug": "arrays", "name": "Array", "order": 1, "totalProblems": 24 } ]
```
If the `DsaTopic` table is empty, a built-in default list (arrays, linked-list, strings, math, two-pointers, sliding-window, stack, binary-search, trees, graphs, dynamic-programming) plus any topics found on problems is returned.

### 8.4 `GET /api/topics/dsa/:slug/problems` (Public)
Query `difficulty` (case-insensitive), `search`. **Bare object** (no `success`):
```json
{ "topic": { "id": "…", "slug": "arrays", "name": "Array" }, "count": 1,
  "problems": [ { "id": "…", "problemNumber": 1, "slug": "two-sum", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array", "Hash Table"] } ] }
```
An unknown slug returns `200` with a synthesized topic and usually an empty list, not `404`.

### 8.5 `GET /api/topics/:identifier` (Protected)
Lookup by ID, then by slug → `{ success, topic }`; `404 NOT_FOUND` otherwise.

---

## 9. Onboarding & Calibration (`/api/onboarding`)

All Protected. No dedicated rate limit.

### 9.1 `POST /api/onboarding` · alias `PUT /api/onboarding/levels`
Sets per-topic levels, computes rating, sets `onboarded = true` and `difficulty`, replacing previous topic levels, all in one transaction. Only topics with category `DSA` are accepted; `topicId` may be an ID **or** a slug.

Accepted bodies (first match wins):
| Mode | Body |
|---|---|
| Beginner preset | `{ "beginner": true }` → all DSA topics at `easy` |
| Per topic | `{ "topicSelections": [ { "topicId": "dsa-arrays", "difficulty": "easy" }, … ] }` (items may also be plain ID strings → `easy`; `level` also accepted) |
| Dashboard alias | `{ "topicLevels": [ { "topicId": "dsa-arrays", "level": "hard" } ] }` |
| Global | `{ "difficulty": "medium", "topicIds": "all" }` or `topicIds: [ids/slugs]`; `difficulty` alone also means all DSA topics |

Difficulty aliases: `beginner→easy`, `mid|intermediate→medium`, `advanced→hard`. Topics without an explicit level get the request-level `difficulty` (default `easy`).

**Rating** = average of per-topic values (`easy 800`, `medium 1200`, `hard 1600`). `difficulty` = `hard` if rating ≥ 1400, `medium` if ≥ 1000, else `easy`. The stored `tier` column is **not** updated here (§21-1).

Errors (`400 BAD_REQUEST`): `"Please select at least 1 topic."`, `"One or more topic IDs are invalid."`, invalid `difficulty`.

**`200`**
```json
{ "success": true, "user": { "id": "…", "email": "…", "name": "…", "difficulty": "medium", "rating": 1200, "onboarded": true,
  "preferredLanguage": "cpp", "createdAt": "…", "updatedAt": "…",
  "topics": [ { "id": "…", "userId": "…", "topicId": "…", "level": "medium", "topic": { "id": "…", "slug": "dsa-arrays", "name": "DSA - Arrays", "category": "DSA" } } ] } }
```

### 9.2 `GET /api/onboarding/status`
`{ success, user: { id, email, name, difficulty, rating, onboarded, preferredLanguage, topics } }`

### 9.3 `PATCH /api/onboarding/language`
Same as §7.7.

---

## 10. Problems (`/api/problems`)

Problem lookup (`:slug`) accepts a slug, a numeric `problemNumber`, a problem ID, or a slug with a trailing `-<n>` (e.g. `two-sum-001` → `two-sum`). Problem details are cached in memory for 60 s, the catalogue for 30 s.

### 10.1 `GET /api/problems` (Optional)
Query (all optional):
- `difficulty`: `easy|medium|hard`, case-insensitive
- `topic`: matches the resolved topic **name**, case-insensitive (e.g. `Array`), **not** the slug
- `search`: substring of title, slug, number, topic, difficulty or any tag
- `status`: `solved` | `todo` (anything else → `400 INVALID_STATUS`; without a token `solved` is empty and `todo` is everything)

**No pagination**: the full filtered list is returned.
```json
{
  "success": true, "count": 1,
  "data": [ {
    "id": "…", "problemNumber": 1, "slug": "two-sum", "title": "Two Sum", "difficulty": "Easy",
    "tags": ["Array", "Hash Table"], "solvedCount": 420, "createdAt": "…",
    "dsaTopic": { "name": "Array", "slug": "arrays" }, "timeLimit": 1000, "memoryLimit": 256,
    "_count": { "examples": 2, "testcases": 12, "templates": 5 },
    "topic": "Array", "topicSlug": "arrays", "acceptanceRate": 61.5, "points": 10, "isSolved": false
  } ]
}
```

### 10.2 `GET /api/problems/:slug` (Public)
```json
{
  "success": true,
  "data": {
    "id": "…", "problemNumber": 1, "slug": "two-sum", "title": "Two Sum", "description": "…",
    "difficulty": "Easy", "timeLimit": 1000, "memoryLimit": 256, "solvedCount": 420, "tags": ["Array", "Hash Table"],
    "examples": [ { "id": "…", "order": 0, "input": "nums = [2,7,11,15], target = 9", "output": "[0,1]", "explanation": "…" } ],
    "testcases": [ { "testIndex": 0, "isVisible": true, "input": "4 9\n2 7 11 15", "output": "0 1", "stdinSmall": "4 9\n2 7 11 15", "expectedSmall": "0 1" } ],
    "templates": { "python": "class Solution:\n    def twoSum(self, nums, target):\n        pass", "cpp": "…" },
    "userTemplates": { "…": "same as templates" },
    "templatesArray": [ { "id": "…", "problemId": "…", "language": "python", "code": "…", "header": "…", "footer": "…" } ]
  }
}
```
Only `isVisible: true` testcases are returned.

### 10.3 `GET /api/problems/:slug/starter` · `GET /api/problems/:slug/template` (Public)
- No `language` → `{ "success": true, "data": { "slug": "two-sum", "templates": { "python": "…", … } } }`
- `?language=python` → `{ "success": true, "data": { "slug": "two-sum", "language": "python", "template": "…" } }`; `404` if that language has no template. Use exact keys (`py` is not accepted here).

### 10.4 `POST /api/problems/:slug/run` (**Optional** · 10/min · 2 in-flight)
Same as §11.2 with the slug taken from the path. Works without a token (rate limits then key on IP).

### 10.5 `POST /api/problems/:slug/submit` (**Optional** · 6/min · 2 in-flight)
Same as §11.3, but **asynchronous by default** (`202`) unless `wait: true` or `?wait=true`. Without a token there is no reward, and the submission **cannot be polled** (polling is owner-only), so anonymous callers must use `wait: true` (§21-3).

---

## 11. Code Execution (`/api/execution`, `/api/execute`)

`/api/execute/*` is a full mirror of `/api/execution/*` (same router).

### 11.1 `GET /api/execution/languages` (Public)
```json
{ "success": true, "languages": [
  { "key": "python", "label": "Python 3", "version": "Python 3.10", "judge0Id": 71, "starterAvailable": true, "monacoLanguage": "python" },
  { "key": "javascript", "label": "JavaScript", "version": "Node.js 22", "judge0Id": 63, "starterAvailable": true, "monacoLanguage": "javascript" },
  { "key": "cpp", "label": "C++ (GCC)", "version": "GCC 13 (C++20)", "judge0Id": 54, "starterAvailable": true, "monacoLanguage": "cpp" },
  { "key": "c", "label": "C (GCC)", "version": "GCC 13", "judge0Id": 50, "starterAvailable": true, "monacoLanguage": "c" },
  { "key": "java", "label": "Java (OpenJDK)", "version": "OpenJDK 17", "judge0Id": 62, "starterAvailable": true, "monacoLanguage": "java" } ] }
```
Run/submit accept these language aliases: `c++`→cpp, `py`/`python3`→python, `js`/`node`/`nodejs`→javascript. Default when omitted: `cpp`.

### 11.2 Run sample testcases
Routes: `POST /api/execution/run` · `/api/execution/runs` · `/api/execute/run` · `/api/execute/runs` (**Protected**) · `/api/problems/:slug/run` (Optional). Rate limit 10/min/user + max 2 in-flight.

Body fields (aliases accepted):
| Field | Aliases |
|---|---|
| `slug` | `problemSlug`, `problemId` (or path `:slug`) |
| `language` | `lang`, query `?language=` |
| `code` | `userCode`, `source_code`, `sourceCode` |
| `stdin` | optional: custom run, used only when **no** slug is given |

Checks in order: `422 UNSUPPORTED_LANGUAGE` → `400 MISSING_CODE` → `413 CODE_TOO_LARGE` (64 KB) → `404 NOT_FOUND` → `422 NO_TESTCASES` → `400 FUNCTION_ONLY_REQUIRED` → `400 NO_TESTCASES` (no visible cases) → runner errors (`503`).

**`200`** (all visible cases run in one batch):
```json
{
  "success": true, "verdict": "Accepted", "status": "Accepted", "passedCount": 2, "totalCount": 2,
  "results": [ {
    "index": 0, "testIndex": 0, "isVisible": true, "input": "4 9\n2 7 11 15", "expected": "0 1", "actual": "0 1",
    "studentStdout": "", "status": "Accepted", "passed": true,
    "timeMs": 42, "cpuTimeMs": 40, "wallTimeMs": 42, "memoryKb": 12840, "inputBytes": 13, "errorText": null
  } ],
  "complexity": { "time": { "bestEstimate": "O(n)", "confidence": "high" }, "space": { "bestEstimate": "O(n)", "confidence": "high" }, "summary": "Time: O(n), Space: …" }
}
```
`verdict` is the status of the first failing case (`"Wrong Answer"`, `"Time Limit Exceeded"`, `"Runtime Error"`, `"Compilation Error"`, …) or `"Accepted"`. `studentStdout` holds debug prints, separated from the evaluated output.

**Custom stdin run** (`stdin` and no slug): runs the code as-is once; output is **not** compared (`expected: ""`, verdict `"Accepted"` whenever it ran without error). Result items have `index, testIndex, input, expected, actual, studentStdout, status, passed, timeMs, memoryKb, errorText`; no `complexity`.

### 11.3 Submit for full evaluation
Routes and mode:
| Route | Auth | Mode |
|---|---|---|
| `POST /api/execution/submit` | Protected | **sync** (200) |
| `POST /api/execution/submissions` | Protected | **async** (202) unless `wait: true` / `?wait=true` |
| `POST /api/execute/submit` | Protected | **sync** |
| `POST /api/execute/submissions` | Protected | **sync** (§21-4) |
| `POST /api/problems/:slug/submit` | Optional | **async** unless `wait` (§21-3) |

Rate limit 6/min/user + max 2 in-flight (an async job keeps its slot until it finishes). Body: same fields as run (no `stdin`), plus optional `wait`.

**Async → `202 Accepted`**
```json
{ "success": true, "submissionId": "clx…", "verdict": "QUEUED", "status": "QUEUED",
  "pollUrl": "/api/execution/submissions/clx…", "message": "Submission received and queued for execution.",
  "problem": { "slug": "two-sum", "title": "Two Sum" } }
```

**Sync → `200 OK`**
```json
{
  "success": true, "submissionId": "clx…", "verdict": "ACCEPTED", "status": "ACCEPTED",
  "tierReached": "Tier 3 (Optimal)", "passedCount": 12, "totalCount": 12, "time": "52ms", "memory": 13400,
  "results": [
    { "testIndex": 0, "isVisible": true, "passed": true, "status": "Accepted", "input": "4 9\n2 7 11 15", "expected": "0 1", "actual": "0 1",
      "time": 42, "timeMs": 42, "cpuTimeMs": 40, "wallTimeMs": 42, "memory": 12840, "memoryKb": 12840, "inputBytes": 13, "errorText": null },
    { "testIndex": 5, "isVisible": false, "passed": true, "status": "Accepted", "time": 48, "memory": 13400 }
  ],
  "firstFailure": null,
  "complexity": { "time": { "bestEstimate": "O(n)", "confidence": "high" }, "space": { "bestEstimate": "O(n)", "confidence": "high" }, "summary": "…" },
  "reward": { "awarded": true, "points": 10, "scoreDelta": 100, "coinsEarned": 2,
              "stats": { "rating": 830, "tier": "Pulse II", "score": 10, "scoreUnits": 100, "coins": 103, "streak": 1, "longestStreak": 1 } },
  "rewardError": false,
  "dailyProblemReward": { "granted": true, "coins": 2 },
  "problem": { "slug": "two-sum", "title": "Two Sum" }
}
```
- `status` values: `ACCEPTED`, `WRONG_ANSWER`, `TIME_LIMIT_EXCEEDED`, `RUNTIME_ERROR`, `COMPILATION_ERROR` (from the first failure). Background crash → `ERROR`.
- `firstFailure` for a visible case: `{ testIndex, status, errorText, input, expected, actual, message: "Failed sample test 3: expected '…', got '…'" }`. For a hidden case: `{ testIndex, status, errorText: null, message: "Failed on hidden evaluation test case #7." }`.
- `reward` is `null` when anonymous or not fully accepted; `awarded: false` (0 points) when the problem was already solved before. See §18.

### 11.4 Tiered judging
All testcases (visible and hidden, ordered by `testIndex`) are split into three tiers. For `N` cases: Tier 1 = first `max(1, ⌊0.35N⌋)`; Tier 2 = up to index `max(tier1+1, ⌊0.7N⌋)`; Tier 3 = the rest. Each tier runs as one batch. If any case in a tier fails, the remaining tiers are **not executed**. `tierReached`: fail in T1 → `Tier 0 (Failed)`, fail in T2 → `Tier 1 (Brute Force)`, fail in T3 → `Tier 2 (Better)`, all pass → `Tier 3 (Optimal)`. `passedCount` only counts cases that actually ran.

### 11.5 `GET /api/execution/submissions/:id` (Protected, owner-only)
Non-owners and unknown IDs both get `404 SUBMISSION_NOT_FOUND`.
```json
{ "success": true, "submission": {
  "id": "clx…", "problemId": "…", "language": "python", "verdict": "ACCEPTED", "status": "ACCEPTED",
  "tierReached": "Tier 3 (Optimal)", "passedCount": 12, "totalCount": 12, "time": "52ms", "memory": 13400, "createdAt": "…",
  "firstFailure": null, "results": [ ], "complexity": { }, "reward": { }, "rewardError": false,
  "dailyProblemReward": { "granted": true, "coins": 2 }, "problem": { "slug": "two-sum", "title": "Two Sum" } } }
```
While evaluating, `status` is `PROCESSING`.

### 11.6 Submission detail retention
`status`, counts, `time`, `memory` are stored in PostgreSQL. `results`, `firstFailure`, `tierReached`, `reward`, `dailyProblemReward` and `complexity` live only in an **in-process cache (30 min, 2000 entries)**. After expiry or a restart, polling returns `results: []`, `firstFailure: null`, `reward: null`, `complexity: null` and an estimated `tierReached` (§21-5).

### 11.7 `POST /api/execution/analyze-complexity` (Optional · 10/min per user or IP)
Body: `code` (or `userCode`, `source_code`), `language` (or `lang`, default `python`, not validated), `slug` (or `problemSlug`, optional).
Returns the **full** analyzer report (not the compact form):
```json
{ "success": true, "complexity": {
  "version": "3.0.1", "status": "completed", "summary": "Time: O(n^2), Space: O(1) auxiliary, O(1) output (O(1) total)",
  "time": { "bestEstimate": "O(n^2)", "confidence": "high", "asymptoticClass": "…" },
  "space": { "bestEstimate": "O(1)", "auxiliary": "O(1)", "output": "O(1)", "total": "O(1)", "confidence": "high" },
  "detectedPatterns": [ "…" ], "…": "additional evidence fields" } }
```
On parse failure (or code > 200,000 chars) `status` is `"unknown"` with `summary: "Complexity analysis unavailable"` and a `limitations` array.

---

## 12. Daily Problem (`/api/daily-problem`)

### 12.1 How it works
- **Selection**: a random problem from the whole `problems` table, never the same as yesterday's when ≥ 2 problems exist. One record per IST date (`istDate` unique).
- **Creation**: cron at `00:00 Asia/Kolkata`, a check on server boot, and lazy creation on first request; concurrent requests are de-duplicated.
- **Reward**: on the first fully accepted submission (authenticated) whose problem is today's daily problem: **+2 coins** (`DAILY_PROBLEM` transaction) and streak advance (§18.4). Once per user per IST day; idempotent via `DailyProblemCompletion` + transaction check.

### 12.2 `GET /api/daily-problem` · alias `GET /api/coins/daily-problem` (Optional)
```json
{
  "success": true, "istDate": "2026-11-18",
  "problem": { "id": "…", "slug": "two-sum", "title": "Two Sum", "difficulty": "Easy", "description": "…", "tags": ["Array"], "solvedCount": 42 },
  "reward": { "coins": 2, "description": "+2 coins and +1 streak for your first ACCEPTED submission on today's challenge" },
  "completed": false, "solvedToday": false, "rewardClaimed": false, "completedAt": null,
  "streak": 3, "longestStreak": 5,
  "nextRefreshMs": 67123000, "nextRefreshTime": "12:00 AM IST"
}
```
Without a token, `completed`/`rewardClaimed` are `false` and streaks are `0`. Errors: `404 DAILY_PROBLEM_NOT_FOUND`, `503 NO_ELIGIBLE_PROBLEMS`.

### 12.3 `GET /api/daily-problem/history` · alias `GET /api/coins/daily-problem/history` (Optional)
Query `page` (≥ 1, default 1), `limit` (1–100, default 30). Newest first.
```json
{ "success": true, "count": 1, "total": 35, "page": 1, "totalPages": 2,
  "history": [ { "id": "clx…", "istDate": "2026-11-18", "createdAt": "…", "completed": true,
                 "problem": { "id": "…", "slug": "two-sum", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array"], "solvedCount": 42 } } ] }
```
`completed` is always `false` without a token.

---

## 13. Coins (`/api/coins`)

### 13.1 `GET /api/coins/balance` (Protected)
```json
{ "success": true, "coins": 103, "streak": 1, "longestStreak": 1, "lastLoginISTDate": "2026-11-18" }
```

### 13.2 `GET /api/coins/history` (Protected)
Query `limit` (1–50, default 20), `offset` (≥ 0, default 0). Newest first. No total count.
```json
{ "success": true, "transactions": [
  { "id": "…", "amount": 2, "type": "DAILY_PROBLEM", "referenceId": "clx…", "istDate": "2026-11-18", "balanceAfter": 103, "createdAt": "…" },
  { "id": "…", "amount": -350, "type": "THEME_PURCHASE", "referenceId": "<themeId>", "istDate": "2026-11-17", "balanceAfter": 101, "createdAt": "…" } ] }
```

---

## 14. Theme Store (`/api/themes`)

All Protected. Catalogue (seeded automatically from `src/data/storeThemes.js`):

| slug | name | price |
|---|---|---|
| `default` | Default | 0 (always owned) |
| `mono` | Monochrome | 350 |
| `pearl` | Pearl | 350 |
| `frost` | Frost | 400 |
| `editorial` | Editorial | 400 |
| `orbit` | Orbit | 450 |
| `anime` | Sakura Manga | 700 |
| `comic` | Hero Comic | 700 |
| `storybook` | Storybook Kingdom | 700 |
| `arcade` | Arcade | 800 |
| `racer` | Racer | 800 |

### 14.1 `GET /api/themes`
Sorted by price ascending.
```json
{ "success": true, "coins": 100, "themes": [
  { "id": "…", "slug": "default", "name": "Default", "price": 0, "previewColor": "#2F7BFF", "isDefault": true, "owned": true, "applied": true, "canAfford": true },
  { "id": "…", "slug": "mono", "name": "Monochrome", "price": 350, "previewColor": "#161616", "isDefault": false, "owned": false, "applied": false, "canAfford": false } ] }
```

### 14.2 `GET /api/themes/me`
```json
{ "success": true, "coins": 100, "activeTheme": "default", "ownedThemes": [] }
```
`ownedThemes` lists purchased slugs only (the default theme is not included unless bought).

### 14.3 `POST /api/themes/:slug/buy`
Atomically debits coins, records ownership and a `THEME_PURCHASE` transaction, and **applies the theme**.
```json
{ "success": true, "message": "Bought Monochrome", "theme": { "slug": "mono", "applied": true, "owned": true }, "coins": 50,
  "stats": { "rating": 800, "tier": "Pulse II", "score": 0, "scoreUnits": 0, "coins": 50, "streak": 0, "longestStreak": 0 } }
```
Errors: `404 NOT_FOUND` (unknown slug), `400 ALREADY_OWNED` (`details: { owned: true }`), `400 INSUFFICIENT_COINS` (`details: { required, have }`).

### 14.4 `PUT /api/themes/apply`
Body `{ "slug": "mono" }` → `{ "success": true, "activeTheme": "mono", "message": "Monochrome applied" }`.
Errors: `400 BAD_REQUEST` (no slug), `404 NOT_FOUND`, `403 FORBIDDEN` (not owned and not default).

---

## 15. Rankings (`/api/rankings`)

### `GET /api/rankings` (Public)
Sorted by `score` (raw units) descending. Query:
- `scope`: `college|batch|state|country`. The filter applies **only if the matching value is also given** (e.g. `scope=college&college=AKGEC`, exact, case-sensitive). No scope, `global`, or a missing value means everyone.
- `limit`: 1–100, default 50. **No offset/skip**, and no `rank` or `total` field.
```json
{ "success": true, "count": 1, "data": [
  { "id": "…", "name": "Riya Verma", "score": 48210, "rating": 1790, "streak": 132, "strictPercent": 88, "tier": "Zenith II",
    "college": "AKGEC", "branch": "CSE", "batch": "2026", "state": "UP", "country": "India", "createdAt": "…" } ] }
```
`tier` is the stored column (§21-1). Compute from `rating` (§18.3) for consistent display.

---

## 16. Study Material (`/api/study`)

Reads are Public and return **bare** JSON (no `success` wrapper).

### 16.1 `GET /api/study/subjects`
```json
[ { "id": "…", "slug": "cn", "name": "Computer Networks", "description": "…", "icon": null, "order": 1, "createdAt": "…", "_count": { "chapters": 13 } } ]
```
Subjects: `cn`, `dbms`, `os`, `oops`, `system-design`.

### 16.2 `GET /api/study/subjects/:subjectSlug` · alias `…/:subjectSlug/chapters`
```json
{ "id": "…", "slug": "cn", "name": "Computer Networks", "description": "…", "icon": null, "order": 1, "createdAt": "…",
  "chapters": [ { "id": "…", "slug": "01-networking-fundamentals", "name": "…", "subjectId": "…", "order": 1, "_count": { "topics": 1 } } ] }
```
`404 NOT_FOUND` for an unknown subject.

### 16.3 `GET /api/study/chapters/:chapterId/topics`
`[ { "id": "…", "slug": "01-networking-foundations-and-switching", "name": "…", "order": 1 } ]`. An unknown chapter returns `[]`.

### 16.4 `GET /api/study/topics/:topicSlug`
```json
{ "id": "…", "slug": "…", "name": "…", "chapterId": "…", "order": 1, "content": "# Markdown…", "isPublished": true, "createdAt": "…",
  "mcqs": [ { "id": "…", "question": "…", "options": ["A", "B", "C", "D"], "difficulty": "Easy", "order": 1, "explanation": "…" } ],
  "chapter": { "id": "…", "slug": "…", "name": "…", "subjectId": "…", "order": 1, "subject": { "id": "…", "slug": "cn", "name": "Computer Networks", "…": "…" } } }
```
`correctIndex` is withheld, but **`explanation` is returned before submission** (§21-6). Topic slugs are only unique per chapter; the first match is returned.

### 16.5 `POST /api/study/topics/:topicSlug/submit` (Protected)
Body: **map of MCQ id → selected option index (number)**:
```json
{ "answers": { "clx_mcq_1": 1, "clx_mcq_2": 0 } }
```
```json
{ "success": true, "userId": "…", "topicSlug": "…", "score": 1, "total": 2,
  "result": [ { "mcqId": "clx_mcq_1", "isCorrect": true, "correctIndex": 1, "explanation": "…" },
              { "mcqId": "clx_mcq_2", "isCorrect": false, "correctIndex": 3, "explanation": "…" } ] }
```
Comparison is strict (`"1"` ≠ `1`). Unanswered questions count as wrong. **Nothing is persisted** (§21-7).

---

## 17. Social / GitHub OAuth (`/api/social`)

Only `github` is supported.

### 17.1 `GET /api/social/:provider/link-url` (Protected)
**Bare** `{ "url": "https://github.com/login/oauth/authorize?client_id=…&redirect_uri=<BACKEND_URL>/api/social/github/callback&scope=read%3Auser+user%3Aemail&state=…" }`
`state` is a JWT `{ userId, provider }` signed with `OAUTH_STATE_SECRET` (must differ from `JWT_SECRET`), valid **10 minutes**. Other providers → `404 UNKNOWN_PROVIDER`.

### 17.2 `GET /api/social/:provider/callback` (Public)
Query: `code`, `state` (and GitHub's `error`). Always responds with a **302 redirect** to the frontend:
- success: `<frontend>/?linked=github`
- failure: `<frontend>/?link_error=<CODE>` with `CANCELLED` (missing code/state or user denied), `EXPIRED` (bad/expired state), `UNKNOWN_PROVIDER`, `CONFIGURATION` (GitHub client id/secret missing), `AUTH_FAILED`, `ALREADY_LINKED` (GitHub account linked to another user), `SERVER_ERROR`.

`<frontend>` is the origin of query `redirect_uri` if it is in the allow-list (`FRONTEND_URL` entries + `http://localhost:5173`, `http://127.0.0.1:5173`), else the first `FRONTEND_URL` entry. Paths are dropped, only the origin is used.

### 17.3 `DELETE /api/social/:provider` (Protected)
`{ "success": true, "count": { "count": 1 } }`. `count` is a nested object; `0` when nothing was linked. No `404`.

---

## 18. Gamification: Points, Rating, Tiers, Streaks

### 18.1 Points (first accepted solve of each problem)
| Difficulty | Points | Score units (`User.score`) | Coins |
|---|---|---|---|
| Easy | 10 | +100 | 0 |
| Medium | 25 | +250 | 0 |
| Hard | 50 | +500 | 0 |

"Accepted" = all testcases passed. Awarded once per user per problem (`UserProblemProgress`). Re-solves return `awarded: false, points: 0`. `stats.score = floor(User.score / 10)`.

### 18.2 Rating
- **Onboarding** sets the starting rating (§9.1).
- **Each first accepted solve** applies an Elo update: problem rating Easy 800 / Medium 1200 / Hard 1600; `expected = 1 / (1 + 10^((problemRating − rating) / 400))`; `K = 60` for the first 10 solved problems, then 32; `rating = round(rating + K × (1 − expected))` (min 0). The stored `tier` is updated at the same time.

### 18.3 Tiers (from `src/utils/userHeaderStats.js`)
Six 200-point bands starting at 700, each split into three divisions of ~66.7 points:

| Rating | Tier | I | II | III |
|---|---|---|---|---|
| < 900 | **Pulse** (clamps below 700) | < 767 | 767–833 | 834–899 |
| 900–1099 | **Flux** | 900–966 | 967–1033 | 1034–1099 |
| 1100–1299 | **Prism** | 1100–1166 | 1167–1233 | 1234–1299 |
| 1300–1499 | **Aurora** | 1300–1366 | 1367–1433 | 1434–1499 |
| 1500–1699 | **Eclipse** | 1500–1566 | 1567–1633 | 1634–1699 |
| ≥ 1700 | **Zenith** | 1700–1766 | 1767–1833 | ≥ 1834 |

Examples: 800 → Pulse II (new users) · 850 → Pulse III · 1200 → Prism II · 1600 → Eclipse II · 1790 → Zenith II.

### 18.4 Streaks (daily problem only, IST)
On a daily-problem reward, using `lastStreakDate` (converted to IST date):
- never set → `streak = 1`
- yesterday → `streak + 1`
- today → unchanged (cannot happen twice; reward is once per day)
- older → `streak = 1`

`longestStreak = max(longestStreak, streak)`. Logging in and solving other problems never change the streak. A missed day is only reflected when the next daily problem is solved. Until then the old value is still shown.

### 18.5 Coins summary
| Event | Coins | Type |
|---|---|---|
| First login of an IST day | +1 | `DAILY_LOGIN` |
| First accepted solve of today's daily problem | +2 | `DAILY_PROBLEM` |
| Theme purchase | −price | `THEME_PURCHASE` |

---

## 19. Rate Limits & Security

### 19.1 Limits (in-memory, per server process)
| Scope | Limit | Key |
|---|---|---|
| `POST /api/auth/register`, `/login` | 30 / 15 min | IP (`AUTH_RATE_LIMITED`) |
| Run routes (§11.2, §10.4) | 10 / min | user id, else IP |
| Submit routes (§11.3, §10.5) | 6 / min | user id, else IP |
| `POST /api/execution/analyze-complexity` | 10 / min (**shares the run bucket**) | user id, else IP |
| Concurrent run/submit executions | max 2 | user id, else IP. Message `"Maximum 2 code execution jobs in flight simultaneously."` |
| Code size (run/submit) | 64 KB | → `413 CODE_TOO_LARGE` |
| Request body | 1 MB | JSON and urlencoded |

There is **no** onboarding rate limit.

### 19.2 Security
- Headers: `Content-Security-Policy` (incl. `frame-ancestors 'self' https://*.run.app https://*.google.com …`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`. (No `X-Frame-Options`; framing is controlled by CSP.)
- CORS: origins from `FRONTEND_URL` (comma-separated) plus `http://localhost:5173` / `http://127.0.0.1:5173` outside production; requests with no `Origin` are allowed; `credentials: true`.
- `trust proxy`: `TRUST_PROXY` env (hop count / `true` / `false`), default `1` in production, so per-IP limits see the real client.
- Tokens: every JWT carries a `jti`; logout/refresh store it in a revocation table until expiry. `protect` also rejects tokens whose user no longer exists.
- Secrets: `JWT_SECRET` and `OAUTH_STATE_SECRET` must be ≥ 32 chars in production (otherwise an ephemeral random secret is used, which logs everyone out on restart).
- Logging: only failed requests (status ≥ 400) are logged, without bodies.

---

## 20. Database & Test Suite

### 20.1 Database
Prisma → PostgreSQL/Neon. Main tables: `users`, `topics`, user topics, `social_accounts`, problems / examples / testcases / templates, `submissions`, `user_problem_progress`, `themes` / user themes, `coin_transactions`, `daily_problems`, daily problem completions, revoked tokens, and the study tables (subjects → chapters → topics → MCQs). Seed and upload scripts live in `scripts/` (`upload-problem.js`, `reset-and-upload.js`, `bulk-push.js`, `seedProblems.js`, `seedDailyProblems.js`, `upload-study.js`, …).

### 20.2 Tests
**33** test files under `tests/`, run with the Node test runner:
```bash
npm test                  # all files (sequential)
npm run test:unit         # unitUtilities, complexityAnalyzer, streakService, testcaseResults, problemSolvedCount, acceptedSubmissionReward
npm run test:integration  # the remaining 27 files
npm run test:coverage
```
Files: `acceptedSubmissionReward`, `authLifecycle`, `automatedDailyProblem`, `codeboxBatchExecution`, `coinReward.integration`, `coinServiceAndHistory`, `complexityAnalyzer`, `cors`, `dailyLoginReward`, `dailyProblemReward`, `executionBatch`, `executionLanguages`, `executionOptimization`, `executionVerdicts`, `onboarding`, `problemEndpoints`, `problemSolvedCount`, `problemsCatalog`, `problemsecurity`, `profileApi`, `rankingsLeaderboard`, `securityAndMiddleware`, `socialAuth`, `streakService`, `studyModule`, `testcaseResults`, `themeCatalog`, `themeStoreLifecycle`, `themesPurchase`, `topicsCatalog`, `unitUtilities`, `userActivity`, `userManagement`. Integration tests need `DATABASE_URL`.

---

## 21. Known Issues Found in Review

The review found these behaviours in the code. They are documented as-is above. Most are worth fixing.

| # | Severity | Issue | Where |
|---|---|---|---|
| 1 | Medium | **Stored `tier` disagrees with computed tier.** `User.tier` defaults to `"Prism I"` (schema) and onboarding doesn't update it, while `stats.tier` for rating 800 is `"Pulse II"`. `/api/users/me`, rankings and register/login `user.tier` show the stale value until the first accepted solve. | `prisma/schema.prisma`, `onboarding.controller.js` |
| 2 | Low | `GET /api/users/me`, `/me/overview`, `PUT`/`PATCH /me` don't select `longestStreak`. | `user.controller.js` |
| 3 | Medium | `POST /api/problems/:slug/submit` is async by default (the sync check uses `req.path === "/submit"`, which is `/:slug/submit` here), unlike `/api/execution/submit`. Because the route is Optional-auth and polling is owner-only, **anonymous async submissions can never be read**. | `execution.controller.js` `isDirectExecuteRoute` |
| 4 | Low | `POST /api/execute/submissions` is synchronous (substring match on `/execute/submit`), while `/api/execution/submissions` is async. | same |
| 5 | Medium | Per-case results, `firstFailure`, `reward` and `complexity` of a submission are kept only in an in-process 30-min cache. After a restart, expiry, or on another instance, polling returns empty results and an *estimated* tier. | `execution.controller.js` |
| 6 | Medium | `GET /api/study/topics/:topicSlug` returns each MCQ's `explanation` before the quiz is submitted, which often gives away the answer. | `study.controller.js` |
| 7 | Low | Quiz submit says it "records user study progress" but persists nothing. String answers (`"1"`) are always marked wrong. | `study.controller.js` |
| 8 | Low | `DELETE /api/social/:provider` returns `count: { count: n }` (raw Prisma result) and doesn't validate the provider. | `social.controller.js` |
| 9 | Low | `GET /api/topics/dsa/categories` is Protected while its alias `/api/topics/categories` is Public, for the same data. | `topic.router.js` |
| 10 | Low | The JSON manifest at `GET /` has an outdated `endpoints` list (e.g. marks `/api/execution/languages` Protected, omits `/run`, `/submit`, `/analyze-complexity`, coins and daily-problem routes) and `apiGroups` lacks `coins`/`daily-problem`. | `index.router.js` |
| 11 | Low | `change-password` doesn't revoke other sessions, and returns `400` (not `401`) for a wrong old password. | `auth.controller.js` |
| 12 | Low | Onboarding stores per-topic levels as sent (e.g. `"mid"`, `"beginner"`) instead of normalizing them to `easy/medium/hard`. The rating math does normalize them. | `onboarding.controller.js` |
| 13 | Low | `GET /api/problems?topic=` matches the topic **name**, while most other APIs use slugs. | `problemResolver.js` |
| 14 | Low | `GET /api/problems/:slug` returns `templatesArray` (raw DB template rows, including driver `header`/`footer` code). Not secret test data, but more than the editor needs. | `problem.controller.js` |
| 15 | Info | Rate limiters, the in-flight counter, the submission cache and the problem cache are all in memory. Limits are per instance and reset on restart. | middlewares, controllers |
| 16 | Info | `analyze-complexity` shares the run limiter bucket, has no 64 KB code cap (only the 1 MB body limit / 200k-char analyzer cap), and doesn't validate `language`. | `execution.router.js` |
| 17 | Info | Activity heatmap groups by UTC day while all gamification uses IST, so solves between 00:00 and 05:30 IST land on the previous day. | `user.controller.js` |

---

## 22. Endpoint Index

69 routes (aliases counted). **P** = Protected, **O** = Optional, **–** = Public.

| Method | Path | Auth | § |
|---|---|---|---|
| GET | `/` | – | 5.1 |
| GET | `/health`, `/api/health` | – | 5.2 |
| GET | `/ping`, `/api/ping` | – | 5.3 |
| POST | `/api/auth/register` | – | 6.1 |
| POST | `/api/auth/login` | – | 6.2 |
| GET | `/api/auth/me`, `/api/auth/verify` | P | 6.3 |
| POST | `/api/auth/refresh` | P | 6.4 |
| POST | `/api/auth/change-password` | P | 6.5 |
| POST | `/api/auth/logout` | P | 6.6 |
| GET | `/api/users/me`, `/api/users` | P | 7.1 |
| GET | `/api/users/me/overview` | P | 7.2 |
| GET | `/api/users/me/activity` | P | 7.3 |
| PUT | `/api/users/me`, `/api/users` | P | 7.4 |
| PATCH | `/api/users/me` | P | 7.5 |
| PATCH | `/api/users/me/academic`, `/api/users/academic` | P | 7.6 |
| PATCH | `/api/users/me/language`, `/api/users/language` | P | 7.7 |
| GET | `/api/users/all` | P | 7.8 |
| GET | `/api/topics` | – | 8.1 |
| GET | `/api/topics/dsa` | – | 8.2 |
| GET | `/api/topics/categories` | – | 8.3 |
| GET | `/api/topics/dsa/categories` | P | 8.3 |
| GET | `/api/topics/dsa/:slug/problems` | – | 8.4 |
| GET | `/api/topics/:identifier` | P | 8.5 |
| POST | `/api/onboarding` | P | 9.1 |
| PUT | `/api/onboarding/levels` | P | 9.1 |
| GET | `/api/onboarding/status` | P | 9.2 |
| PATCH | `/api/onboarding/language` | P | 9.3 |
| GET | `/api/problems` | O | 10.1 |
| GET | `/api/problems/:slug` | – | 10.2 |
| GET | `/api/problems/:slug/starter`, `/template` | – | 10.3 |
| POST | `/api/problems/:slug/run` | O | 10.4 |
| POST | `/api/problems/:slug/submit` | O | 10.5 |
| GET | `/api/execution/languages` (+ `/api/execute/…`) | – | 11.1 |
| POST | `/api/execution/run`, `/runs` (+ `/api/execute/…`) | P | 11.2 |
| POST | `/api/execution/submit`, `/submissions` (+ `/api/execute/…`) | P | 11.3 |
| GET | `/api/execution/submissions/:id` (+ `/api/execute/…`) | P | 11.5 |
| POST | `/api/execution/analyze-complexity` (+ `/api/execute/…`) | O | 11.7 |
| GET | `/api/daily-problem`, `/api/coins/daily-problem` | O | 12.2 |
| GET | `/api/daily-problem/history`, `/api/coins/daily-problem/history` | O | 12.3 |
| GET | `/api/coins/balance` | P | 13.1 |
| GET | `/api/coins/history` | P | 13.2 |
| GET | `/api/themes` | P | 14.1 |
| GET | `/api/themes/me` | P | 14.2 |
| POST | `/api/themes/:slug/buy` | P | 14.3 |
| PUT | `/api/themes/apply` | P | 14.4 |
| GET | `/api/rankings` | – | 15 |
| GET | `/api/study/subjects` | – | 16.1 |
| GET | `/api/study/subjects/:subjectSlug`, `…/chapters` | – | 16.2 |
| GET | `/api/study/chapters/:chapterId/topics` | – | 16.3 |
| GET | `/api/study/topics/:topicSlug` | – | 16.4 |
| POST | `/api/study/topics/:topicSlug/submit` | P | 16.5 |
| GET | `/api/social/:provider/link-url` | P | 17.1 |
| GET | `/api/social/:provider/callback` | – | 17.2 |
| DELETE | `/api/social/:provider` | P | 17.3 |

The developer console (`public/index.html`, "All APIs Console") lists the same 69 routes with ready-to-send sample requests.

---

## Appendix A — Changes from v2.1

Corrections made after checking the code (v2.1 was wrong on these):

1. **Tier table**: there are six tiers including **Flux** (900–1099); bands are 200 wide up to Zenith at 1700+. 1200 is **Prism II** (was "Aurora II").
2. **Streak**: advances only through the daily problem, not on any first solve of the day.
3. **change-password** body is `oldPassword`/`newPassword`; wrong old password is `400`; success message is `"Password updated successfully."`.
4. **register/login** responses have no `message`, include `stats`, and return the full user row; login `rewards` also has `streak`/`longestStreak`.
5. **refresh** also returns `user` and `stats`, and revokes the old token. **logout** message is `"Logged out successfully."`.
6. **GET /api/problems** has no pagination (`page`/`pageSize`/`total` don't exist); `status` is `solved|todo`; item fields updated (`topic`, `topicSlug`, `acceptanceRate`, `points`, `dsaTopic`, `createdAt`).
7. **Problem-scoped run/submit** are Optional-auth, and problem-scoped submit is async by default.
8. **Run result** fields are `timeMs`/`memoryKb` (+ `index`, `cpuTimeMs`, `wallTimeMs`, `inputBytes`), not `time`/`memory`; custom `stdin` runs are supported.
9. **Submit** responses include `dailyProblemReward`; sync responses have no `createdAt`; `/api/execution/submit` is sync. Polling shows `PROCESSING`, not `QUEUED`.
10. **analyze-complexity** body key is `slug`/`problemSlug` and the response is the full analyzer report.
11. **GET /api/topics** has no `dsaTopics`/`coreTopics`; `/api/topics/dsa/categories` is Protected.
12. **Daily problem** `reward` has no `streak` field; history `id` is a cuid.
13. **Coins history** returns `{ transactions }`, limit capped at 50.
14. **Themes**: real catalogue and prices (Orbit is 450, not 50); `/themes/me` has no `stats`; buying also applies the theme.
15. **Rankings**: no `skip`; scope filters need the matching value.
16. **Study**: responses are bare arrays/objects; quiz `answers` is a map and the response is `{ score, total, result[{ isCorrect, … }] }`; explanations are visible before submission.
17. **Social**: `link-url` returns bare `{ url }`; state is a 10-min JWT; no `redirectUri` query; callback error codes listed; unlink returns `count`.
18. **Errors**: added `MISSING_CREDENTIALS`, `MISSING_FIELDS`, `INVALID_TOKEN`, `INVALID_STATUS`, `AUTH_RATE_LIMITED`, `UNKNOWN_PROVIDER`, `EXECUTION_AUTH_FAILED`, `NO_ELIGIBLE_PROBLEMS`, `DAILY_PROBLEM_NOT_FOUND`, `CONFLICT`; removed `SOCIAL_ALREADY_LINKED` (it's a redirect code `ALREADY_LINKED`).
19. **Security**: no `X-Frame-Options` header; no onboarding rate limit; in-flight limit is per user (IP only when anonymous); analyze shares the run bucket.
20. **Tests**: 33 files (not 38).
21. Removed v2.1's Appendix B. Every open item it listed is now settled against the code.
