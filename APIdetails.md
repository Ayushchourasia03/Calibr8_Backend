# Calibr8 Backend — API Reference

> **Source of truth is the code in `src/`.** This document was rebuilt from the code on 2026-11-22. If the code and this document disagree, the code wins. Please update this file in the same PR that changes an endpoint.
>
> Companion document: **[code exec system.md](code%20exec%20system.md)** explains in depth how Run / Submit execute code (CodeBox requests, harness, tiers, verdicts).

---

## Contents

1. [Quick endpoint index](#1-quick-endpoint-index)
2. [Server, stack and global request pipeline](#2-server-stack-and-global-request-pipeline)
3. [Authentication](#3-authentication)
4. [Response and error conventions](#4-response-and-error-conventions)
5. [Rate limiting and execution concurrency](#5-rate-limiting-and-execution-concurrency)
6. [Shared object shapes (TypeScript)](#6-shared-object-shapes-typescript)
7. [System and health](#7-system-and-health)
8. [Auth — `/api/auth`](#8-auth--apiauth)
9. [Users and profile — `/api/users`](#9-users-and-profile--apiusers)
10. [Topics — `/api/topics`](#10-topics--apitopics)
11. [Onboarding and calibration — `/api/onboarding`](#11-onboarding-and-calibration--apionboarding)
12. [Problems — `/api/problems`](#12-problems--apiproblems)
13. [Code execution — `/api/execution` (alias `/api/execute`)](#13-code-execution--apiexecution-alias-apiexecute)
14. [Daily problem — `/api/daily-problem`](#14-daily-problem--apidaily-problem)
15. [Coins — `/api/coins`](#15-coins--apicoins)
16. [Theme store — `/api/themes`](#16-theme-store--apithemes)
17. [Rankings — `/api/rankings`](#17-rankings--apirankings)
18. [Study material — `/api/study`](#18-study-material--apistudy)
19. [Social / GitHub OAuth — `/api/social`](#19-social--github-oauth--apisocial)
20. [Gamification rules (points, score, rating, tiers, coins, streaks)](#20-gamification-rules)
21. [Data model reference](#21-data-model-reference)
22. [Background jobs and startup behaviour](#22-background-jobs-and-startup-behaviour)
23. [Environment variables](#23-environment-variables)
24. [Caching and multi-instance behaviour](#24-caching-and-multi-instance-behaviour)
25. [Known quirks and gotchas](#25-known-quirks-and-gotchas)

---

## 1. Quick endpoint index

**Auth legend**

- **Public**: no token needed.
- **Optional**: a valid token is used when present. A missing, invalid, expired or revoked token silently makes the request anonymous.
- **Protected**: requires a valid, non-revoked `Authorization: Bearer <token>` for a user that still exists.
- **Owner**: Protected, and the resource must belong to the caller. Otherwise the response is 404.

**Limit legend**: `auth` = 30 per 15 min per IP · `run` = 10 per min · `submit` = 6 per min · `2⇉` = at most 2 execution jobs in flight per user/IP (see [§5](#5-rate-limiting-and-execution-concurrency)).

| Method | Path | Auth | Limits | Purpose |
|---|---|---|---|---|
| GET | `/` | Public | – | HTML landing page or JSON service info (content-negotiated) |
| GET | `/health`, `/api/health` | Public | – | Health check JSON |
| GET | `/ping`, `/api/ping` | Public | – | Plain-text `pong` |
| POST | `/api/auth/register` | Public | auth | Create account, returns token |
| POST | `/api/auth/login` | Public | auth | Log in, returns token |
| POST | `/api/auth/logout` | Protected | – | Revoke current token |
| POST | `/api/auth/refresh` | Protected | – | New token, old one revoked |
| GET | `/api/auth/me`, `/api/auth/verify` | Protected | – | Current user + header stats (+ daily login coin) |
| POST | `/api/auth/change-password` | Protected | – | Change password |
| GET | `/api/users/me` (alias `GET /api/users`) | Protected | – | Profile |
| GET | `/api/users/me/overview` | Protected | – | Profile + submission activity heatmap |
| GET | `/api/users/me/activity` | Protected | – | Submission activity heatmap only |
| PUT | `/api/users/me` (alias `PUT /api/users`) | Protected | – | Update name |
| PATCH | `/api/users/me` | Protected | – | Update name + academic fields |
| PATCH | `/api/users/me/language` (alias `PATCH /api/users/language`) | Protected | – | Preferred language |
| PATCH | `/api/users/me/academic` (alias `PATCH /api/users/academic`) | Protected | – | Academic fields |
| GET | `/api/users/all` | Protected | – | All problems with solve status + solved % |
| GET | `/api/topics` | Public | – | Calibration topics (`?category=dsa\|core`) |
| GET | `/api/topics/dsa` | Public | – | DSA calibration topics |
| GET | `/api/topics/categories` | Public | – | DSA problem categories with counts |
| GET | `/api/topics/dsa/categories` | **Protected** | – | Same as above |
| GET | `/api/topics/dsa/:slug/problems` | Public | – | Problems in one DSA category |
| GET | `/api/topics/:identifier` | Protected | – | One calibration topic by id or slug |
| POST | `/api/onboarding` (alias `PUT /api/onboarding/levels`) | Protected | – | Save calibration, compute rating |
| GET | `/api/onboarding/status` | Protected | – | Calibration status |
| PATCH | `/api/onboarding/language` | Protected | – | Preferred language |
| GET | `/api/problems` | Optional | – | Problem catalogue with filters |
| GET | `/api/problems/:slug` | Public | – | Problem detail, visible testcases, starter code |
| GET | `/api/problems/:slug/starter` (alias `/template`) | Public | – | Starter template(s) |
| POST | `/api/problems/:slug/run` | **Optional** | run, 2⇉ | Run visible testcases |
| POST | `/api/problems/:slug/submit` | **Optional** | submit, 2⇉ | Submit (async 202 by default) |
| GET | `/api/execution/languages` | Public | – | Supported languages |
| POST | `/api/execution/run` (alias `/runs`) | Protected | run, 2⇉ | Run visible testcases / custom stdin |
| POST | `/api/execution/submit` | Protected | submit, 2⇉ | Submit, **synchronous** 200 |
| POST | `/api/execution/submissions` | Protected | submit, 2⇉ | Submit, **asynchronous** 202 |
| GET | `/api/execution/submissions/:id` | Owner | – | Poll a submission |
| GET | `/api/execution/submissions/:id/complexity` | Owner | – | Empirical complexity profile |
| POST | `/api/execution/analyze-complexity` | Optional | run | Static complexity analysis of code |
| GET | `/api/daily-problem` (alias `/api/coins/daily-problem`) | Optional | – | Today's daily problem + user status |
| GET | `/api/daily-problem/history` (alias `/api/coins/daily-problem/history`) | Optional | – | Past daily problems |
| GET | `/api/coins/balance` | Protected | – | Coins and streak |
| GET | `/api/coins/history` | Protected | – | Coin transaction log |
| GET | `/api/themes` | Protected | – | Theme catalogue with ownership |
| GET | `/api/themes/me` | Protected | – | Active and owned themes |
| POST | `/api/themes/:slug/buy` | Protected | – | Buy a theme (also applies it) |
| PUT | `/api/themes/apply` | Protected | – | Apply an owned theme |
| GET | `/api/rankings` | Public | – | Leaderboard |
| GET | `/api/study/subjects` | Public | – | Study subjects |
| GET | `/api/study/subjects/:subjectSlug` (alias `/chapters`) | Public | – | Subject with chapters |
| GET | `/api/study/chapters/:chapterId/topics` | Public | – | Topics of a chapter |
| GET | `/api/study/topics/:topicSlug` | Public | – | Topic content + MCQs |
| POST | `/api/study/topics/:topicSlug/submit` | Protected | – | Grade MCQ answers |
| GET | `/api/social/:provider/link-url` | Protected | – | GitHub OAuth authorize URL |
| GET | `/api/social/:provider/callback` | Public | – | OAuth redirect target (browser) |
| DELETE | `/api/social/:provider` | Protected | – | Unlink provider |

Every route in the execution router is mounted twice, so **every `/api/execution/...` path also works as `/api/execute/...`** (for example `/api/execute/run` and `/api/execute/submissions/:id`).

---

## 2. Server, stack and global request pipeline

### 2.1 Stack

| Concern | Implementation |
|---|---|
| Runtime | Node.js, ES modules (`"type": "module"`) |
| HTTP | Express 5 ([src/app.js](src/app.js), [src/server.js](src/server.js)) |
| Database | PostgreSQL via Prisma 6 ([prisma/schema.prisma](prisma/schema.prisma)). [src/config/db.js](src/config/db.js) uses the Neon serverless adapter when `DATABASE_URL` contains `neon.tech`, otherwise the `pg` adapter. |
| Auth | JWT (`jsonwebtoken`), bcrypt (`bcryptjs`, 10 rounds) |
| Scheduling | `node-cron` (daily problem at 00:00 Asia/Kolkata) |
| Code execution | External CodeBox VPS (Judge0-compatible). See [code exec system.md](code%20exec%20system.md). |
| Pattern | `routers/*.router.js` → middlewares → `controllers/*.controller.js` → `services/` and `utils/` → Prisma |

The server listens on `0.0.0.0:${PORT}` (default **3000**).

### 2.2 Router mounting ([src/routers/index.router.js](src/routers/index.router.js))

| Mount path | Router file |
|---|---|
| `/api/auth` | [auth.router.js](src/routers/auth.router.js) |
| `/api/users` | [user.router.js](src/routers/user.router.js) |
| `/api/topics` | [topic.router.js](src/routers/topic.router.js) |
| `/api/onboarding` | [onboarding.router.js](src/routers/onboarding.router.js) |
| `/api/problems` | [problem.router.js](src/routers/problem.router.js) |
| `/api/social` | [social.router.js](src/routers/social.router.js) |
| `/api/study` | [study.router.js](src/routers/study.router.js) |
| `/api/themes` | [theme.router.js](src/routers/theme.router.js) |
| `/api/rankings` | [ranking.router.js](src/routers/ranking.router.js) |
| `/api/execution` **and** `/api/execute` | [execution.router.js](src/routers/execution.router.js) |
| `/api/coins` | [coin.router.js](src/routers/coin.router.js) |
| `/api/daily-problem`, `/api/daily-problem/history` | handlers from [coin.controller.js](src/controllers/coin.controller.js), mounted directly |

### 2.3 Global pipeline (order matters, from [src/app.js](src/app.js))

1. **`trust proxy`**: from `TRUST_PROXY` (a hop count, `true`/`false`, or an Express trust string). The default is `1` in production and off elsewhere. This decides `req.ip`, which keys the IP-based rate limits.
2. **Security headers** on every response:
   - `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' https:; connect-src 'self' https:; frame-ancestors 'self' https://*.run.app https://*.google.com https://*.aistudio.google.com https://*.googleusercontent.com;`
   - `X-Content-Type-Options: nosniff`
   - `Referrer-Policy: strict-origin-when-cross-origin`
3. **CORS** (`cors` package, `credentials: true`):
   - Allowed origins are every comma-separated entry of `FRONTEND_URL`, each normalised to its origin. Outside production, `http://localhost:5173` and `http://127.0.0.1:5173` are also allowed.
   - Requests without an `Origin` header (curl, server-to-server) are allowed.
   - A disallowed origin gets no CORS headers, so the browser blocks the response. The server still runs the handler.
4. **Body parsing**: `express.json({ limit: "1mb" })` and `express.urlencoded({ extended: true, limit: "1mb" })`.
5. **Logging**: `morgan` logs `:method :path :status :response-time ms` **only for responses with status ≥ 400**. Request bodies (submitted code) are never logged.
6. **Static files**: `public/` is served with `index: false` (for example `GET /index.html`).
7. **Routers** (above).
8. **Error handler**: [src/middlewares/error.middleware.js](src/middlewares/error.middleware.js) (see [§4](#4-response-and-error-conventions)).
9. **Unknown routes**: there is no JSON catch-all. Express's default handler answers with **404 and an HTML body** (`Cannot GET /x`), not the JSON error shape.

---

## 3. Authentication

### 3.1 Tokens

| Property | Value |
|---|---|
| Transport | `Authorization: Bearer <token>` header. No cookies are set or read. |
| Algorithm | HS256 (jsonwebtoken default), signed with `JWT_SECRET` |
| Payload | `{ id: <userId>, email, jti: <random UUID>, iat, exp }` |
| Lifetime | `JWT_EXPIRES_IN`, default `"1d"` |
| Issued by | `register`, `login`, `refresh` |
| Revoked by | `logout`, `refresh` (the old token) |

**Secret handling** ([src/config/jwt.js](src/config/jwt.js)):

- In production `JWT_SECRET` must be at least 32 characters. If it is not, the server logs a warning and generates a **random secret per process**. Every token then becomes invalid on restart, and tokens are not portable between instances.
- Outside production the minimum is 24 characters, otherwise a built-in development fallback is used.
- `OAUTH_STATE_SECRET` follows the same rules and **must differ from `JWT_SECRET`**. The process throws at startup if they are equal.

### 3.2 `protect` middleware ([src/middlewares/auth.middleware.js](src/middlewares/auth.middleware.js))

1. Reads `Authorization`. It must start with `Bearer ` and contain a token, otherwise **401 `UNAUTHORIZED`** "No token provided. Please log in."
2. `jwt.verify`. An expired token gives **401 `TOKEN_EXPIRED`**. A malformed, badly signed or not-yet-valid token gives **401 `INVALID_TOKEN`**.
3. In parallel, it runs the revocation check and the user lookup.
4. A revoked token gives **401 `TOKEN_REVOKED`**. A deleted user gives **401 `UNAUTHORIZED`** "Account no longer exists. Please log in again." Accounts are never recreated from token claims.
5. It sets `req.token` and sets `req.user` to `{ id, email, name, difficulty, rating, score, streak, longestStreak, tier, coins, onboarded, preferredLanguage, createdAt, updatedAt }`.

Database errors propagate to the error handler, which returns 503 `DATABASE_UNAVAILABLE` or 500.

### 3.3 `optionalAuth` middleware

Same checks, but **never fails**. If anything is wrong (no header, bad or expired token, revoked token, unknown user, DB error), the request continues as anonymous with `req.user` undefined.

### 3.4 Revocation store ([src/utils/tokenBlacklist.js](src/utils/tokenBlacklist.js))

- Revoked tokens are stored in table `revoked_tokens`, keyed by `jti`, or by `sha256:<hash>` for legacy tokens without a `jti`, together with the token's expiry. The raw token is never stored.
- In-memory caches:
  - **revoked**: entries are kept until the token expires.
  - **confirmed not revoked**: entries live 30 seconds (at most 50,000 entries).

  A token revoked on one instance can therefore still be accepted by another instance for up to 30 s.
- Expired rows are purged every hour (see [§22](#22-background-jobs-and-startup-behaviour)).
- If the table does not exist (Prisma `P2021`), revocation silently degrades to in-memory only.

### 3.5 Password rules (register and change-password)

| Rule | Error |
|---|---|
| A string with at least 8 characters | 400 `WEAK_PASSWORD` "Password must be at least 8 characters long." |
| At most 72 **bytes** in UTF-8 (bcrypt limit) | 400 `PASSWORD_TOO_LONG` "Password cannot exceed 72 bytes." |
| Not equal to the email (case-insensitive, trimmed) | 400 `PASSWORD_EQUALS_EMAIL` "Password must differ from the email address." |

### 3.6 Daily-login side effect

`register`, `login`, `refresh`, `GET /api/auth/me` and `GET /api/auth/verify` all call `grantDailyLoginReward`. It grants **+1 coin the first time per IST calendar day** (idempotent, race-safe). It never changes the streak, and it never fails the request.

---

## 4. Response and error conventions

### 4.1 Success bodies

Most JSON success bodies contain `"success": true`. **These do not:**

| Endpoint | Body |
|---|---|
| `GET /ping`, `/api/ping` | plain text `pong` |
| `GET /health`, `/api/health` | `{ status, service, timestamp }` |
| `GET /api/topics/categories`, `/api/topics/dsa/categories` | bare JSON **array** |
| `GET /api/topics/dsa/:slug/problems` | `{ topic, count, problems }` |
| `GET /api/study/subjects`, `/chapters/:chapterId/topics` | bare JSON **array** |
| `GET /api/study/subjects/:subjectSlug`, `/topics/:topicSlug` | bare JSON **object** |
| `GET /api/social/:provider/link-url` | `{ url }` |
| `GET /api/social/:provider/callback` | HTTP **302 redirect** |

**Verdict endpoints (run, submit, poll) return HTTP 200 even when the user's code fails** (Wrong Answer, Compilation Error, TLE, and so on). Read the `verdict`/`status` field. Non-2xx responses mean the request itself failed.

### 4.2 Error body

```json
{
  "success": false,
  "code": "MACHINE_READABLE_CODE",
  "message": "Human readable message.",
  "details": { "optional": "extra data" }
}
```

`details` is present only on some errors, for example `{ "retryAfterSeconds": 42 }` on rate limits, `{ "required": 450, "have": 120 }` on `INSUFFICIENT_COINS`, and `{ "owned": true }` on `ALREADY_OWNED`.

### 4.3 How the error handler maps errors (in order)

| Case | Status | `code` | `message` |
|---|---|---|---|
| `ApiError` thrown by app code | `err.status` | `err.code` | `err.message` (shown even for 5xx) |
| Prisma unique violation `P2002` | 409 | `CONFLICT` | "A record with that `<field>` already exists." |
| Prisma init error, `P1000`–`P1003`, or a message containing "No database host" / "connection string" / "DATABASE_URL" | 503 | `DATABASE_UNAVAILABLE` | "Database service is unavailable." |
| Anything else | `err.status`, or 400 for `ValidationError`, else 500 | `err.code` or the status default | for ≥ 500: "Internal server error."; otherwise `err.message` |

Consequences:

- Malformed JSON gives **400 `BAD_REQUEST`** with the parser's message.
- A body over 1 MB gives **413 `CODE_TOO_LARGE`** "request entity too large". The default code for 413 is `CODE_TOO_LARGE`.
- Unexpected 5xx errors may carry a raw `code` such as a Prisma error code (`P2025`) or a Node error code, but the message is always hidden.

Default codes by status ([src/utils/ApiError.js](src/utils/ApiError.js)):

| Status | Code |
|---|---|
| 400 | `BAD_REQUEST` |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT` |
| 413 | `CODE_TOO_LARGE` |
| 422 | `UNPROCESSABLE_ENTITY` |
| 429 | `RATE_LIMITED` |
| 503 | `JUDGE_UNAVAILABLE` |
| other | `INTERNAL_ERROR` |

### 4.4 Error code catalogue

| Code | Status | Raised by |
|---|---|---|
| `UNAUTHORIZED` | 401 | `protect` (no token, deleted account), study submit |
| `TOKEN_EXPIRED` / `INVALID_TOKEN` / `TOKEN_REVOKED` | 401 | `protect` |
| `AUTH_RATE_LIMITED` | 429 | register, login |
| `RATE_LIMITED` | 429 | run / submit / in-flight limiters |
| `VALIDATION_ERROR` | 400 | register (missing fields) |
| `INVALID_EMAIL` | 400 | register |
| `WEAK_PASSWORD`, `PASSWORD_TOO_LONG`, `PASSWORD_EQUALS_EMAIL` | 400 | register, change-password |
| `EMAIL_ALREADY_EXISTS` | 409 | register |
| `MISSING_CREDENTIALS` | 400 | login |
| `INVALID_CREDENTIALS` | 401 | login |
| `MISSING_FIELDS`, `INVALID_CURRENT_PASSWORD` | 400 | change-password |
| `CONFLICT` | 409 | any Prisma unique violation |
| `DATABASE_UNAVAILABLE` | 503 | DB down or misconfigured |
| `BAD_REQUEST` | 400 | default for many validations (onboarding, profile, theme apply, …) |
| `NOT_FOUND` | 404 | problem, topic, subject, theme, template not found |
| `INVALID_STATUS` | 400 | `GET /api/problems?status=` other than `solved`/`todo` |
| `UNSUPPORTED_LANGUAGE` | 422 | run / submit |
| `MISSING_CODE` | 400 | run / submit / analyze-complexity |
| `CODE_TOO_LARGE` | 413 | run / submit (> 64 KB), body > 1 MB |
| `FUNCTION_ONLY_REQUIRED` | 400 | run / submit (code contains `main`) |
| `NO_TESTCASES` | 422 or 400 | run / submit (problem has no testcases / no visible testcases) |
| `EXECUTION_UNAVAILABLE` | 503 | CodeBox not configured, unreachable, timed out or returned errors |
| `EXECUTION_AUTH_FAILED` | 500 | CodeBox rejected `CODEBOX_TOKEN` (HTTP 401/403) |
| `SUBMISSION_STORAGE_UNAVAILABLE` | 503 | submission row or verdict could not be saved (logged-in users) |
| `SUBMISSION_NOT_FOUND` | 404 | poll / complexity of a missing or someone else's submission |
| `NO_ELIGIBLE_PROBLEMS` | 503 | daily problem when the problems table is empty |
| `DAILY_PROBLEM_NOT_FOUND` | 404 | daily problem lookup failure |
| `ALREADY_OWNED`, `INSUFFICIENT_COINS` | 400 | theme buy |
| `USER_NOT_FOUND` | 404 | theme buy |
| `FORBIDDEN` | 403 | theme apply when the theme is not owned |
| `UNKNOWN_PROVIDER` | 404 | social link-url when provider ≠ `github` |

---

## 5. Rate limiting and execution concurrency

Source: [src/middlewares/rateLimit.middleware.js](src/middlewares/rateLimit.middleware.js). All limiters are **in-memory, per process**.

| Limiter | Applied to | Key | Window | Max | On exceed |
|---|---|---|---|---|---|
| `authLimiter` | register **and** login (one shared counter) | `auth:<ip>` | 15 min | 30 | 429 `AUTH_RATE_LIMITED` "Too many login or registration attempts. Please try again in a few minutes." |
| `runLimiter` | every run route **and** `analyze-complexity` (one shared counter) | `run:<userId or ip>` | 60 s | 10 | 429 `RATE_LIMITED` "Run rate limit exceeded. You can perform at most 10 runs per minute." |
| `submitLimiter` | every submit route (one shared counter) | `submit:<userId or ip>` | 60 s | 6 | 429 `RATE_LIMITED` "Submission rate limit exceeded. You can submit at most 6 times per minute." |
| `inFlightLimiter` | every run **and** submit route (not analyze) | `user:<id>` or `ip:<ip>` | concurrent | 2 | 429 `RATE_LIMITED` "Maximum 2 code execution jobs in flight simultaneously." |

Behaviour details:

- **Fixed windows.** A window starts at the first request for a key and resets `windowMs` later. Requests that get rejected still increment the counter.
- **Headers on every rate-limited route**: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (seconds until the window resets). On a 429 the response also has a `Retry-After` header (seconds) and `details.retryAfterSeconds`. The in-flight limiter sets neither.
- **Order** on run and submit routes is auth → rate limiter → in-flight limiter. A request rejected by the in-flight limiter has already used one rate-limit unit.
- **In-flight slot lifetime**: released when the HTTP response finishes or the connection closes. Asynchronous submissions (202) **keep the slot until background judging completes**, so two queued submissions block a third run or submit from the same user.
- On problem-scoped routes (`/api/problems/:slug/run|submit`) with no token, all limits are keyed by IP.
- With several backend instances, each instance has its own counters.

---

## 6. Shared object shapes (TypeScript)

```ts
type ISODate = string;   // "2026-11-22T10:15:30.123Z"
type ISTDate = string;   // "2026-11-22" (calendar day in Asia/Kolkata)
type Lang = "cpp" | "c" | "java" | "python" | "javascript";

/** Returned as `stats` by auth, theme buy and submit rewards. See utils/userHeaderStats.js */
interface UserHeaderStats {
  rating: number;        // users.rating (default 800)
  tier: string;          // COMPUTED from rating, e.g. "Pulse II" (not the stored users.tier)
  score: number;         // floor(scoreUnits / 10) = sum of problem points earned
  scoreUnits: number;    // raw users.score (points × 10)
  coins: number;         // falls back to 100 if null
  streak: number;
  longestStreak: number;
}

/** Calibration topic (table `topics`) */
interface Topic { id: string; slug: string; name: string; category: "DSA" | "CORE" | string; }

/** User's calibrated topic (table `user_topics`) */
interface UserTopic { id: string; userId: string; topicId: string; level: string; topic: Topic; }

/** Linked social account (table `social_accounts`) */
interface SocialAccount {
  id: string; userId: string; provider: "github";
  providerUserId: string; username: string | null; name: string | null; email: string | null;
  avatarUrl: string | null; profileUrl: string | null; bio: string | null; headline: null;
  stats: { publicRepos: number; followers: number; following: number } | null;
  connectedAt: ISODate;
}

/** Full user row minus passwordHash (returned by register and login only) */
interface SafeUser {
  id: string; email: string; phone: string | null; name: string;
  difficulty: "easy" | "medium" | "hard" | null; rating: number; score: number;
  streak: number; longestStreak: number; strictPercent: number; tier: string;
  college: string | null; branch: string | null; batch: string | null;
  state: string | null; country: string | null;            // country defaults to "India"
  onboarded: boolean; preferredLanguage: Lang;              // default "cpp"
  coins: number;                                            // default 100
  activeThemeId: string | null; lastStreakDate: ISODate | null; lastLoginISTDate: ISTDate | null;
  createdAt: ISODate; updatedAt: ISODate;
  socialAccounts: SocialAccount[]; topics: UserTopic[];
}

/** Profile user returned by /api/users/me, /overview, PATCH /me */
interface ProfileUser {
  id: string; email: string; name: string; difficulty: string | null; rating: number;
  score: number; streak: number; strictPercent: number; tier: string;
  college: string | null; branch: string | null; batch: string | null;
  state: string | null; country: string | null; coins: number; onboarded: boolean;
  preferredLanguage: Lang; createdAt: ISODate; updatedAt: ISODate;
  socialAccounts: SocialAccount[]; topics: UserTopic[];
}

/** Static complexity summary attached to run/submit/poll responses */
interface ComplexitySummary {
  time:  { bestEstimate: string; confidence: "low" | "medium" | "high" | "unknown" } | null;
  space: { bestEstimate: string; confidence: "low" | "medium" | "high" | "unknown" } | null;
  summary: string | null;  // e.g. "Time: O(n), Space: O(n) auxiliary, O(1) output (O(n) total)"
}

/** Per-testcase status strings (run results, submit results, firstFailure.status) */
type CaseStatus =
  | "Accepted" | "Wrong Answer" | "Time Limit Exceeded" | "Memory Limit Exceeded"
  | "Runtime Error" | "Compilation Error" | "Output Limit Exceeded" | "Cancelled";

/** Final submission verdict (submit, poll) */
type SubmissionVerdict =
  | "ACCEPTED" | "WRONG_ANSWER" | "TIME_LIMIT_EXCEEDED" | "MEMORY_LIMIT_EXCEEDED"
  | "RUNTIME_ERROR" | "COMPILATION_ERROR"
  | "PROCESSING"   // stored while judging
  | "QUEUED"       // only in the 202 response, never stored
  | "ERROR";       // background judging crashed (async submissions only)

type TierReached = "Tier 0 (Failed)" | "Tier 1 (Brute Force)" | "Tier 2 (Better)" | "Tier 3 (Optimal)";

/** Reward for an accepted submission (null when anonymous or not accepted) */
interface SolveReward {
  awarded: boolean;          // false = problem was already solved before
  points: 0 | 10 | 25 | 50;  // easy / medium / hard (0 when not awarded)
  scoreDelta: number;        // points × 10 (scoreUnits added)
  coinsEarned: number;       // 0, or 2 if this also completed today's daily problem
  stats: UserHeaderStats;    // stats AFTER the update
}

interface DailyProblemReward { granted: boolean; coins: 0 | 2; }
```

---

## 7. System and health

### `GET /` — Public

The response is content-negotiated with `req.accepts(["html","json"])`:

- **HTML preferred** (browsers): sends `public/index.html`.
- **Otherwise**: 200 JSON `{ service: "Calibr8 Backend API", status: "online", version: "1.2.0", architecture, features[], apiGroups{}, endpoints[] }`.

The `endpoints` list there is hard-coded and **partly out of date**. For example, it marks `/api/execution/languages` as protected and omits several routes. Use this document instead.

### `GET /health` · `GET /api/health` — Public

```json
{ "status": "ok", "service": "Calibr8 Backend", "timestamp": "2026-11-22T10:15:30.123Z" }
```

This does **not** check the database or CodeBox.

### `GET /ping` · `GET /api/ping` — Public

200 with `text/html` body `pong`.

---

## 8. Auth — `/api/auth`

Controller: [src/controllers/auth.controller.js](src/controllers/auth.controller.js)

### 8.1 `POST /api/auth/register`

| | |
|---|---|
| Auth | Public |
| Middleware | `authLimiter` |

**Body**

| Field | Type | Rules |
|---|---|---|
| `email` | string | required; trimmed and lowercased; must match `^[^\s@]+@[^\s@]+\.[^\s@]+$` |
| `password` | string | required; see [§3.5](#35-password-rules-register-and-change-password) |
| `name` | string | required; trimmed before saving |

**What the backend does**

1. Checks that all 3 fields are present, otherwise 400 `VALIDATION_ERROR` "email, password, and name are required."
2. Normalises the email and checks the regex, otherwise 400 `INVALID_EMAIL`.
3. Validates the password, otherwise `WEAK_PASSWORD` / `PASSWORD_TOO_LONG` / `PASSWORD_EQUALS_EMAIL`.
4. Looks up the email. If it exists: 409 `EMAIL_ALREADY_EXISTS`. A concurrent duplicate insert instead gives 409 `CONFLICT`.
5. Hashes the password with bcrypt (10 rounds) and inserts into `users`. All defaults apply: rating 800, coins 100, tier "Prism I", country "India", preferredLanguage "cpp".
6. Signs a JWT.
7. Grants the daily login reward: +1 coin, writes `coin_transactions` (`DAILY_LOGIN`), sets `lastLoginISTDate`.
8. Removes `passwordHash` and responds.

**201 response**

```json
{
  "success": true,
  "user": {
    "id": "6b1d8c2e-…", "email": "asha@example.com", "phone": null, "name": "Asha",
    "difficulty": null, "rating": 800, "score": 0, "streak": 0, "strictPercent": 0,
    "tier": "Prism I", "college": null, "branch": null, "batch": null, "state": null,
    "country": "India", "onboarded": false, "createdAt": "…", "updatedAt": "…",
    "preferredLanguage": "cpp", "coins": 101, "activeThemeId": null,
    "lastStreakDate": null, "longestStreak": 0, "lastLoginISTDate": "2026-11-22",
    "socialAccounts": [], "topics": []
  },
  "stats": { "rating": 800, "tier": "Pulse II", "score": 0, "scoreUnits": 0, "coins": 101, "streak": 0, "longestStreak": 0 },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "isNewUser": true,
  "rewards": { "coinsEarnedToday": 1, "loginCoins": 1, "streak": 0, "longestStreak": 0, "isNewDay": true }
}
```

**Errors**: 400 (validation codes above), 409, 429 `AUTH_RATE_LIMITED`, 503.

### 8.2 `POST /api/auth/login`

| | |
|---|---|
| Auth | Public |
| Middleware | `authLimiter` (shares its counter with register) |

**Body**: `{ "email": string, "password": string }`. The email is trimmed and lowercased.

**What the backend does**

1. If either field is missing: 400 `MISSING_CREDENTIALS` "email and password are required."
2. Loads the user with `socialAccounts` and `topics.topic`. Unknown email or wrong password both give **401 `INVALID_CREDENTIALS`** "Invalid email or password."
3. Signs a new JWT. Old tokens stay valid; login does not revoke them.
4. Grants the daily login reward (+1 coin the first time per IST day). Reward failures are swallowed and reported as zeros.

**200 response**: same shape as register, but with `"isNewUser": false`. `rewards` contains `{ coinsEarnedToday, loginCoins, streak, longestStreak, isNewDay }`. On the second login of a day, `coinsEarnedToday: 0, loginCoins: 0, isNewDay: false`.

Note: a non-string `email` makes `.trim()` throw, which returns 500.

### 8.3 `POST /api/auth/logout`

| | |
|---|---|
| Auth | Protected |
| Body | none |

Revokes the current token: its `jti` and expiry go into `revoked_tokens` and the local cache.

**200**: `{ "success": true, "message": "Logged out successfully." }`

Because the route uses `protect`, an already expired token gets 401 `TOKEN_EXPIRED`. The frontend should simply discard the token in that case.

### 8.4 `POST /api/auth/refresh`

| | |
|---|---|
| Auth | Protected (the current token must still be valid) |
| Body | none |

**What the backend does**: loads the user, grants the daily login reward, signs a new token, revokes the old token, then responds.

**200**

```json
{
  "success": true,
  "token": "eyJ…new",
  "user": {
    "id": "…", "email": "…", "name": "…", "difficulty": "medium", "rating": 1230, "score": 350,
    "streak": 3, "longestStreak": 5, "tier": "Prism II", "coins": 142, "onboarded": true,
    "preferredLanguage": "cpp", "createdAt": "…", "updatedAt": "…",
    "socialAccounts": [], "topics": [ /* UserTopic[] */ ]
  },
  "stats": { /* UserHeaderStats */ },
  "rewards": { "coinsEarnedToday": 0, "loginCoins": 0, "isNewDay": false }
}
```

**Errors**: 401 (all `protect` codes, and "Account no longer exists").

### 8.5 `GET /api/auth/me` · `GET /api/auth/verify`

| | |
|---|---|
| Auth | Protected |

**What the backend does**: grants the daily login reward first, so opening the app counts as today's login. It then reads the user and today's earned coins (the sum of positive `coin_transactions.amount` for today's IST date) in parallel.

**200**

```json
{
  "success": true,
  "user": {
    "id": "…", "email": "…", "name": "…", "difficulty": "easy", "rating": 830, "score": 100,
    "streak": 1, "longestStreak": 1, "coins": 104,
    "lastStreakDate": "2026-11-22T05:01:12.000Z", "lastLoginISTDate": "2026-11-22",
    "tier": "Pulse II", "onboarded": true, "preferredLanguage": "cpp",
    "createdAt": "…", "updatedAt": "…", "socialAccounts": [], "topics": [],
    "todayISTDate": "2026-11-22",
    "coinsEarnedToday": 3,
    "loginCoins": 0
  },
  "stats": { /* UserHeaderStats */ }
}
```

`loginCoins` is 1 only on the call that actually granted today's login coin. `coinsEarnedToday` includes login, daily-problem and any other positive transactions of the IST day.

### 8.6 `POST /api/auth/change-password`

| | |
|---|---|
| Auth | Protected |

**Body**: `{ "oldPassword": string, "newPassword": string }`

**Order of checks**

1. Both fields present, otherwise 400 `MISSING_FIELDS`.
2. User exists, otherwise 404 `NOT_FOUND`.
3. `newPassword` rules, otherwise 400 `WEAK_PASSWORD` / `PASSWORD_TOO_LONG` / `PASSWORD_EQUALS_EMAIL`. These are checked **before** the old password.
4. `oldPassword` matches, otherwise 400 `INVALID_CURRENT_PASSWORD` "Current password is incorrect."
5. Saves the new bcrypt hash.

**200**: `{ "success": true, "message": "Password updated successfully." }`

⚠ Existing tokens, including those on other devices, **stay valid** after a password change.

---

## 9. Users and profile — `/api/users`

Controller: [src/controllers/user.controller.js](src/controllers/user.controller.js). All routes are **Protected**.

### 9.1 `GET /api/users/me` · alias `GET /api/users`

**200**: `{ "success": true, "user": ProfileUser }` (see [§6](#6-shared-object-shapes-typescript)).

404 "User not found." (code `NOT_FOUND`) is practically unreachable because `protect` already checked the user.

### 9.2 `GET /api/users/me/overview`

Runs the profile read and the activity aggregation in parallel.

**200**

```json
{
  "success": true,
  "user": { /* ProfileUser */ },
  "activity": { "2026-11-20": 2, "2026-11-22": 1 },
  "total": 3,
  "activeDays": 2
}
```

**Activity definition** (shared with 9.3):

- Counts rows in `submissions` for the user with `status = 'ACCEPTED'`, `totalCount > 0` and `passedCount = totalCount`, created in the **last 371 days**.
- Rows are grouped by **UTC** calendar day (`YYYY-MM-DD`). The counts are submissions, not distinct problems: re-solving counts again.
- Raw SQL is used. If raw SQL fails, the same aggregation is computed in JS.

### 9.3 `GET /api/users/me/activity`

**200**: `{ "success": true, "activity": { "YYYY-MM-DD": number }, "total": number, "activeDays": number }`

### 9.4 `PUT /api/users/me` · alias `PUT /api/users`

**Body**: `{ "name": string }`. It must be non-empty after trimming, otherwise 400 "Name cannot be empty." (code `BAD_REQUEST`).

**200**: `{ "success": true, "user": ProfileUser }`, but **without** `socialAccounts`.

### 9.5 `PATCH /api/users/me`

Updates any subset of the profile fields in one request.

| Field | Type | Rule |
|---|---|---|
| `name` | string | if present, must be a non-empty string after trimming, otherwise 400 "Name cannot be empty." |
| `college`, `branch`, `batch`, `state`, `country` | any | if present, saved as `String(value ?? "").trim()`, so `null` becomes `""` |

At least one field is required, otherwise 400 "At least one profile field must be provided."

**200**: `{ "success": true, "user": ProfileUser }` (with `socialAccounts`).

### 9.6 `PATCH /api/users/me/language` · alias `PATCH /api/users/language`

**Body**: `{ "language": "cpp" | "c" | "java" | "python" | "javascript" }`. The value is trimmed and lowercased. Aliases such as `c++` or `py` are **not** accepted here.

**200**: `{ "success": true, "language": "python" }`

**400**: "Invalid language. Allowed options: cpp, c, java, python, javascript"

### 9.7 `PATCH /api/users/me/academic` · alias `PATCH /api/users/academic`

**Body**: any of `college`, `branch`, `batch`, `state`, `country`. Each present field is saved as `String(value).trim()`. Note that `null` becomes the string `"null"` here, unlike 9.5.

At least one field is required, otherwise 400 "At least one academic field (college, branch, batch, state, country) must be provided."

**200**

```json
{
  "success": true,
  "message": "Academic profile saved",
  "user": { "id": "…", "name": "…", "email": "…", "college": "IIT X", "branch": "CSE", "batch": "2027", "state": "MH", "country": "India", "updatedAt": "…" }
}
```

These fields drive the scopes of `GET /api/rankings`.

### 9.8 `GET /api/users/all`

Lists every problem with the caller's solve status. It counts users and loads problems, with the caller's `ACCEPTED` submissions, in parallel.

**200**

```json
{
  "success": true,
  "message": "Problems fetched successfully",
  "data": [
    {
      "name": "Two Sum", "slug": "two-sum", "number": 1,
      "topic": "Array", "topicSlug": "arrays",
      "level": "easy", "levelDisplay": "easy",
      "solvedPercentage": 12,
      "isSolved": true
    }
  ]
}
```

- `level` is the lowercased problem difficulty. `levelDisplay` is the same, except `"medium"` becomes `"mid"`.
- `topic` and `topicSlug` come from the `dsa_topics` relation and are `null` when the problem has none.
- `solvedPercentage = round(problem.solvedCount / totalUsers × 100)`.
- `isSolved` is true when the caller has an `ACCEPTED` submission with `totalCount > 0 && passedCount === totalCount`.

---

## 10. Topics — `/api/topics`

Controller: [src/controllers/topic.controller.js](src/controllers/topic.controller.js)

There are **two different topic systems**:

- **Calibration topics** (table `topics`) are used by onboarding. They are seeded at startup from [src/data/topicCatalog.js](src/data/topicCatalog.js): 10 DSA topics (`dsa-arrays`, `dsa-strings`, `dsa-recursion`, `dsa-graphs`, `dsa-sliding-window`, `dsa-dp`, `dsa-graphs-dp`, `dsa-linked-list`, `dsa-stack-queue`, `dsa-trees`) and 4 CORE topics (`aptitude`, `dbms`, `oops`, `system-design`).
- **DSA problem categories** (table `dsa_topics`) group problems via `problems.dsaTopicId`.

### 10.1 `GET /api/topics` — Public

**Query**: `category` (optional). `dsa` returns topics whose category is `DSA` (case-insensitive). `core` returns everything else. Any other value, or no value, returns all topics. Topics are ordered by name.

**200**

```json
{ "message": "Topics fetched successfully", "success": true, "count": 14,
  "topics": [ { "id": "uuid", "slug": "aptitude", "name": "Aptitude", "category": "CORE" } ] }
```

### 10.2 `GET /api/topics/dsa` — Public

**200**: `{ "success": true, "count": 10, "topics": Topic[], "dsaTopics": Topic[] }`. Both arrays are identical.

### 10.3 `GET /api/topics/categories` (Public) · `GET /api/topics/dsa/categories` (**Protected**)

Returns DSA problem categories with problem counts as a **bare array**:

```json
[ { "id": "cm…", "slug": "arrays", "name": "Array", "order": 1, "totalProblems": 42 } ]
```

- Categories are read from `dsa_topics` ordered by `order`.
- **If that table is empty**, a built-in list is used, with ids `dsa-<slug>`: arrays, linked-list, strings, math, two-pointers, sliding-window, stack, binary-search, trees, graphs, dynamic-programming. Any other `topicSlug` found on problems is added to it.
- `totalProblems` counts catalogue problems where `problem.topicSlug === slug`, or the problem topic equals the category name (case-insensitive), or the slug is `arrays` and the topic contains "array".

### 10.4 `GET /api/topics/dsa/:slug/problems` — Public

**Query**: `difficulty` (exact, case-insensitive) and `search` (same semantics as `GET /api/problems`).

**200** (no `success` field)

```json
{
  "topic": { "id": "cm…", "slug": "arrays", "name": "Array" },
  "count": 2,
  "problems": [ { "id": "cm…", "problemNumber": 1, "slug": "two-sum", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array"] } ]
}
```

An unknown slug **never returns 404**. A topic object is synthesised from the slug (for example `two-pointers` becomes "Two Pointers") and the problem list is usually empty.

### 10.5 `GET /api/topics/:identifier` — Protected

Looks up a calibration topic by `id` first, then by `slug`.

- **200**: `{ "success": true, "topic": Topic }`
- **404**: "Topic '<identifier>' not found." (code `NOT_FOUND`)

---

## 11. Onboarding and calibration — `/api/onboarding`

Controller: [src/controllers/onboarding.controller.js](src/controllers/onboarding.controller.js). All routes are **Protected**.

### 11.1 `POST /api/onboarding` · alias `PUT /api/onboarding/levels`

Saves the user's calibration: which DSA topics, at which level. It also computes `rating` and `difficulty`.

**Body**: every field is optional, but at least one topic must result.

| Field | Type | Meaning |
|---|---|---|
| `beginner` | `true` | One-click preset: `difficulty = "easy"` and **all** DSA topics |
| `difficulty` | string | Base level for topics without their own level. Accepted: `easy`/`beginner`, `medium`/`mid`/`intermediate`, `hard`/`advanced`. Default `easy`. |
| `topicIds` | `string[]` or `"all"` | Topic ids **or** slugs, all at the base level. `"all"` selects every DSA topic. |
| `topicSelections` | `Array<string or { topicId, difficulty? , level? }>` | Per-topic levels. Strings get level `easy`. |
| `topicLevels` | `Array<{ topicId, level? , difficulty? }>` | Dashboard alias. When non-empty it **replaces** `topicSelections`. |

**What the backend does**

1. If `beginner === true`, it forces `difficulty = "easy"` and `topicIds = "all"`.
2. It builds the list of topic identifiers from `topicSelections` (or `topicLevels`), else from `topicIds`.
3. If `topicIds === "all"`, **or** a `difficulty` was given with no topics, it selects every DSA topic.
4. An empty list gives 400 "Please select at least 1 topic."
5. It resolves identifiers against **DSA topics only** (by id or slug). Any unknown or CORE topic gives 400 "One or more topic IDs are invalid."
6. It normalises the base difficulty. An invalid value gives 400 "difficulty must be one of: easy (beginner), medium (mid), hard (advanced)."
7. Topics without an explicit level inherit the base difficulty.
8. **Rating** is the average of the per-topic level scores, where easy = 800, medium = 1200, hard = 1600. An unknown per-topic level counts as easy. The result is rounded.
9. **Difficulty** is `hard` if the rating is at least 1400, `medium` if at least 1000, otherwise `easy`.
10. In one transaction: update `users` (`difficulty`, `rating`, `onboarded = true`), delete **all** existing `user_topics` of the user, insert the new ones, and re-read the user.

**200**

```json
{
  "success": true,
  "user": {
    "id": "…", "email": "…", "name": "…", "difficulty": "medium", "rating": 1067,
    "onboarded": true, "preferredLanguage": "cpp", "createdAt": "…", "updatedAt": "…",
    "topics": [ { "id": "…", "userId": "…", "topicId": "…", "level": "mid", "topic": { "id": "…", "slug": "dsa-arrays", "name": "DSA - Arrays", "category": "DSA" } } ]
  }
}
```

Notes:

- `user_topics.level` stores the **raw** per-topic string you sent, for example `"mid"` or `"advanced"`. Only inherited levels are normalised.
- Onboarding overwrites `rating`, including rating already earned by solving. It does **not** update the stored `users.tier`.

Errors: 400 (codes default to `BAD_REQUEST`), 401, 503.

### 11.2 `GET /api/onboarding/status`

**200**

```json
{ "success": true, "user": { "id": "…", "email": "…", "name": "…", "difficulty": "easy", "rating": 800, "onboarded": true, "preferredLanguage": "cpp", "topics": [ /* UserTopic[] */ ] } }
```

### 11.3 `PATCH /api/onboarding/language`

Identical to [§9.6](#96-patch-apiusersmelanguage--alias-patch-apiuserslanguage). **Body**: `{ "language": "cpp" }`. **200**: `{ "success": true, "language": "cpp" }`.

---

## 12. Problems — `/api/problems`

Controller: [src/controllers/problem.controller.js](src/controllers/problem.controller.js). Data access: [src/utils/problemResolver.js](src/utils/problemResolver.js).

### 12.1 `GET /api/problems` — Optional

**Query**

| Param | Meaning |
|---|---|
| `difficulty` | Exact, case-insensitive match against `Easy` / `Medium` / `Hard` |
| `search` | Case-insensitive substring match on title, slug, problem number, computed topic, difficulty or any tag |
| `topic` | Exact (trimmed, case-insensitive) match on the computed `topic` name, for example `Array` |
| `status` | `solved` or `todo`. Any other value gives 400 `INVALID_STATUS` "Status must be either 'solved' or 'todo'." Without a token every problem counts as unsolved, so `solved` returns `[]`. |

**What the backend does**

1. Loads the **catalogue**, which is cached for 30 s (`CATALOG_CACHE_TTL_MS`). Concurrent loads are de-duplicated. The catalogue holds all problems ordered by `problemNumber` plus acceptance statistics from `submissions` grouped by `(problemId, status)`.
2. If the caller is authenticated, loads the set of problem ids where they have an `ACCEPTED` submission with `totalCount > 0`.
3. Applies the filters.

**200**

```json
{
  "success": true,
  "count": 1,
  "data": [
    {
      "id": "cm…", "problemNumber": 1, "slug": "two-sum", "title": "Two Sum", "difficulty": "Easy",
      "tags": ["Array"], "solvedCount": 37, "createdAt": "…",
      "dsaTopic": { "name": "Array", "slug": "arrays" },
      "timeLimit": 1000, "memoryLimit": 256,
      "_count": { "examples": 3, "testcases": 5, "templates": 5 },
      "topic": "Array", "topicSlug": "arrays",
      "acceptanceRate": 41.7,
      "points": 10,
      "isSolved": false
    }
  ]
}
```

| Field | Derivation |
|---|---|
| `topic` | `dsaTopic.name`, else `tags[0]`, else the `topic` (or first tag) in the bundled `problems/<slug>.json`, else `"Other"` |
| `topicSlug` | `dsaTopic.slug`, else the slugified `topic` |
| `tags` | the stored tags, or `[topic]` when there are none (and the topic is not "Other") |
| `acceptanceRate` | accepted ÷ all submissions of the problem (every status, including PROCESSING and ERROR) × 100, rounded to one decimal; `null` when there are no submissions |
| `points` | 10 for Easy, 25 for Medium, 50 for Hard |
| `timeLimit` | milliseconds |
| `memoryLimit` | megabytes |

### 12.2 `GET /api/problems/:slug` — Public

`:slug` can be a slug (`two-sum`), a numeric `problemNumber` (`1`), a slug with a numeric suffix that resolves to its base slug (`two-sum-2` → `two-sum`), or a problem `id`. Resolved problems are cached for 60 s (`PROBLEM_CACHE_TTL_MS`, at most 300 entries).

**200**

```json
{
  "success": true,
  "data": {
    "id": "cm…", "problemNumber": 1, "slug": "two-sum", "title": "Two Sum",
    "description": "Given an array of integers nums …",
    "difficulty": "Easy", "timeLimit": 1000, "memoryLimit": 256, "solvedCount": 37,
    "tags": ["Array"],
    "examples": [ { "id": "cm…", "order": 0, "input": "nums = [2, 7, 11, 15], target = 9", "output": "[0, 1]", "explanation": "Because nums[0] + nums[1] == 9, we return [0, 1]." } ],
    "testcases": [ { "testIndex": 0, "isVisible": true, "input": "4 9\n2 7 11 15", "output": "0 1", "stdinSmall": "4 9\n2 7 11 15", "expectedSmall": "0 1" } ],
    "templates":     { "cpp": "class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n …", "python": "…", "java": "…", "c": "…", "javascript": "…" },
    "userTemplates": { "…": "same as templates" },
    "templatesArray": [ { "id": "cm…", "problemId": "cm…", "language": "cpp", "code": "{\"userTemplate\":\"…\",\"header\":\"…\",\"footer\":\"…\"}" } ]
  }
}
```

- `testcases` contains **visible testcases only**. Hidden ones are never returned. `input`/`stdinSmall` are raw stdin and `output`/`expectedSmall` are the expected stdout.
- `examples` are display examples for the statement, sorted by `order`. They are **not** what Run executes.
- `templates` and `userTemplates` map each language to the starter code for the editor (the `userTemplate` only, without header or footer). A language with no stored template falls back to a generic default.
- `templatesArray` holds the raw `code_templates` rows. Their `code` is a JSON string that **includes the judge header and footer** (the driver `main()`).

**404**: "Problem '<slug>' not found." (code `NOT_FOUND`)

### 12.3 `GET /api/problems/:slug/starter` · `GET /api/problems/:slug/template` — Public

**Query**: `language` (optional).

- Without `language`: `{ "success": true, "data": { "slug": "two-sum", "templates": { "cpp": "…", "python": "…" } } }`
- With `language`: `{ "success": true, "data": { "slug": "two-sum", "language": "cpp", "template": "class Solution { … }" } }`

The language is normalised for the lookup (`c++`, `py`, `js` work), but the response echoes the lowercased input. A supported language with no stored template returns a generic default template.

**404**: problem not found, or "No <language> template found for this problem." The latter happens only for unsupported language names.

### 12.4 `POST /api/problems/:slug/run` — Optional · run limiter · 2⇉

Same as [§13.2](#132-run--post-apiexecutionrun), with the problem taken from the URL. Anonymous use is allowed and rate-limited per IP. The `stdin` custom-input mode is **not** available here, because a slug is always present.

### 12.5 `POST /api/problems/:slug/submit` — Optional · submit limiter · 2⇉

Same as [§13.3](#133-submit), with the problem taken from the URL.

- **Asynchronous by default**: returns 202 with a `pollUrl`. Send `"wait": true` in the body, or `?wait=true`, to get the full verdict synchronously.
- ⚠ Anonymous callers get a 202 but **cannot poll**, because the poll route requires the owner's token. Anonymous callers should always send `wait: true`.
- Anonymous accepted submissions earn no rewards.

---

## 13. Code execution — `/api/execution` (alias `/api/execute`)

Router: [src/routers/execution.router.js](src/routers/execution.router.js). Controller: [src/controllers/execution.controller.js](src/controllers/execution.controller.js). **Internals** (CodeBox requests, harness, fallbacks, tiers) are in [code exec system.md](code%20exec%20system.md). This section is the HTTP contract.

### 13.1 `GET /api/execution/languages` — Public

**200**

```json
{
  "success": true,
  "languages": [
    { "key": "python",     "label": "Python 3",       "version": "Python 3.10",    "judge0Id": 71, "starterAvailable": true, "monacoLanguage": "python" },
    { "key": "javascript", "label": "JavaScript",     "version": "Node.js 22",     "judge0Id": 63, "starterAvailable": true, "monacoLanguage": "javascript" },
    { "key": "cpp",        "label": "C++ (GCC)",      "version": "GCC 13 (C++20)", "judge0Id": 54, "starterAvailable": true, "monacoLanguage": "cpp" },
    { "key": "c",          "label": "C (GCC)",        "version": "GCC 13",         "judge0Id": 50, "starterAvailable": true, "monacoLanguage": "c" },
    { "key": "java",       "label": "Java (OpenJDK)", "version": "OpenJDK 17",     "judge0Id": 62, "starterAvailable": true, "monacoLanguage": "java" }
  ]
}
```

The list is static. `judge0Id` is the `language_id` the backend sends to CodeBox.

### 13.2 Run — `POST /api/execution/run`

**Routes**

| Route | Auth | Middleware |
|---|---|---|
| `POST /api/execution/run`, `/api/execution/runs`, `/api/execute/run`, `/api/execute/runs` | **Protected** | `protect` → `runLimiter` → `inFlightLimiter` |
| `POST /api/problems/:slug/run` | Optional | `optionalAuth` → `runLimiter` → `inFlightLimiter` |

**Body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `slug` / `problemSlug` / `problemId` | string | yes, unless using custom-input mode | Precedence: URL `:slug`, then `slug`, then `problemSlug`, then `problemId`. Accepts a slug, problem number or id (see §12.2). |
| `language` / `lang` | string | no, default `"cpp"` | `?language=` also works. Accepted (case-insensitive): `cpp`, `c++`, `c`, `java`, `python`, `py`, `python3`, `javascript`, `js`, `node`, `nodejs` |
| `userCode` / `code` / `source_code` / `sourceCode` | string | **yes** | Precedence in that order. At most **64 KB** in UTF-8. Must be **function-only**: no `main`. |
| `stdin` | string | no | Selects **custom-input mode**, used only when **no** problem identifier is sent. Otherwise it is ignored. |

**Function-only rule.** Unless the problem is a stdio problem (none currently are), the code is rejected with **400 `FUNCTION_ONLY_REQUIRED`** "Do not write main(), only write the required function solution." when it matches any of `\bmain\s*\(`, `\bint\s+main\b`, `\bvoid\s+main\b` or `\bdef\s+main\b`. This includes occurrences inside comments or strings.

**What the backend does** (problem mode)

1. Normalises the language, otherwise 422 `UNSUPPORTED_LANGUAGE`.
2. Validates the code: missing gives 400 `MISSING_CODE`; over 64 KB gives 413 `CODE_TOO_LARGE`.
3. Resolves the problem (cached), otherwise 404 `NOT_FOUND`. A problem with no testcases at all gives 422 `NO_TESTCASES`.
4. Builds the executable program (header + your code + driver footer), otherwise 400 `FUNCTION_ONLY_REQUIRED`.
5. Selects the **visible** testcases. None gives 400 `NO_TESTCASES` "No sample test cases configured for this problem."
6. Executes them on CodeBox (time limit = `problem.timeLimit` ms, memory = `problem.memoryLimit` MB).
7. Compares each output with the expected output using a tolerant comparator (whitespace, `[0,1]` vs `0 1`, `true`/`yes`, and so on).
8. Runs static complexity analysis of your code.
9. Responds. **Nothing is saved to the database**, and Run gives no rewards.

**200 response** (problem mode)

```json
{
  "success": true,
  "verdict": "Wrong Answer",
  "status": "Wrong Answer",
  "passedCount": 1,
  "totalCount": 2,
  "results": [
    {
      "index": 0, "testIndex": 0, "isVisible": true,
      "input": "4 9\n2 7 11 15", "expected": "0 1", "actual": "0 1", "studentStdout": "",
      "status": "Accepted", "passed": true,
      "timeMs": 3, "cpuTimeMs": 3, "wallTimeMs": 4, "memoryKb": 3520, "inputBytes": 13,
      "errorText": null
    },
    {
      "index": 1, "testIndex": 1, "isVisible": true,
      "input": "3 6\n3 2 4", "expected": "1 2", "actual": "0 2", "studentStdout": "",
      "status": "Wrong Answer", "passed": false,
      "timeMs": 2, "cpuTimeMs": 2, "wallTimeMs": 3, "memoryKb": 3480, "inputBytes": 9,
      "errorText": null
    }
  ],
  "complexity": {
    "time":  { "bestEstimate": "O(n^2)", "confidence": "high" },
    "space": { "bestEstimate": "O(1)",   "confidence": "high" },
    "summary": "Time: O(n^2), Space: O(1) auxiliary, O(1) output (O(1) total)"
  }
}
```

Field notes:

- `verdict` and `status` are identical: `"Accepted"` when every case passes, otherwise the **first** failing case's status.
- `results[].status` is one of the `CaseStatus` values in [§6](#6-shared-object-shapes-typescript).
- `actual` is the program's stdout, trimmed.
- `errorText` holds stderr, compiler output or a sandbox message, for example the compiler errors on a Compilation Error.
- `studentStdout` is always `""` (reserved).
- `timeMs` and `cpuTimeMs` are CPU time; `wallTimeMs` is wall-clock time; `memoryKb` is peak memory.
- `complexity` is `null` if the analyzer throws. When the analyzer cannot parse the code, `time` and `space` are `null` and `summary` is `"Complexity analysis unavailable"`.

**Custom-input mode** (`/api/execution/run` with `stdin` and no problem identifier): the code is wrapped by a generic driver and run once with your `stdin` (3 s time limit, 256 MB). There is no expected output.

```json
{
  "success": true, "verdict": "Accepted", "status": "Accepted", "passedCount": 1, "totalCount": 1,
  "results": [ { "index": 0, "testIndex": 0, "input": "5\n", "expected": "", "actual": "25", "studentStdout": "",
                 "status": "Accepted", "passed": true, "timeMs": 12, "memoryKb": 9100, "errorText": null } ]
}
```

In this mode, code-building errors (including `main()` present or an unsupported language) are returned as `status: "Compilation Error"` with the reason in `errorText`, still with HTTP 200. Without problem templates only the generic Python/JavaScript drivers actually call your function. C, C++ and Java code without a `main` will fail to link or compile.

**Errors**

| Status | Code | When |
|---|---|---|
| 400 | `MISSING_CODE` | no or empty code |
| 400 | `FUNCTION_ONLY_REQUIRED` | code contains `main` |
| 400 / 422 | `NO_TESTCASES` | no visible testcases (400) / no testcases at all (422) |
| 401 | `UNAUTHORIZED` etc. | Protected routes only |
| 404 | `NOT_FOUND` | unknown problem (also "Problem 'undefined' not found." when no identifier and no `stdin` are sent) |
| 413 | `CODE_TOO_LARGE` | code over 64 KB (or body over 1 MB) |
| 422 | `UNSUPPORTED_LANGUAGE` | unknown language |
| 429 | `RATE_LIMITED` | more than 10 runs per minute, or 2 jobs already in flight |
| 500 | `EXECUTION_AUTH_FAILED` | CodeBox rejected the backend token |
| 503 | `EXECUTION_UNAVAILABLE` | CodeBox not configured, down, timed out or erroring |

### 13.3 Submit

**Routes and mode**

| Route | Auth | Mode |
|---|---|---|
| `POST /api/execution/submit` | Protected | **synchronous** (200 with verdict) |
| `POST /api/execute/submit` | Protected | synchronous |
| `POST /api/execute/submissions` | Protected | synchronous (its URL contains `/execute/submit`) |
| `POST /api/execution/submissions` | Protected | **asynchronous** (202, then poll) |
| `POST /api/problems/:slug/submit` | Optional | asynchronous |

On any route, body `"wait": true` (a boolean) or query `?wait=true` forces synchronous mode. Middleware on all routes: auth → `submitLimiter` (6 per minute) → `inFlightLimiter` (2).

**Body**: the same fields as Run (`slug`/`problemSlug`/`problemId`, `language`/`lang`, `userCode`/`code`/`source_code`/`sourceCode`), plus optional `wait: boolean`. `stdin` is not supported.

**What the backend does**

1. Runs the same validation as Run (language, code, problem, testcases, function-only build).
2. Creates a `submissions` row with `status: "PROCESSING"` and `totalCount` = the number of **all** testcases.
   - Asynchronous mode awaits the insert before replying.
   - Synchronous mode inserts while the code runs.
   - If the insert fails, a logged-in caller gets 503 `SUBMISSION_STORAGE_UNAVAILABLE`. Anonymous callers continue with a temporary id `sub_<timestamp>_<random>`.
3. In parallel with execution, checks whether the user already solved this problem and prefetches the data the reward needs.
4. **Tiered judging** over all testcases in `testIndex` order:
   - **Tier 1** is the first 35%: `max(1, floor(n × 0.35))` cases.
   - **Tier 2** runs up to the 70% mark: `max(tier1 + 1, floor(n × 0.7))`.
   - **Tier 3** is the rest.
   - A tier runs only if every earlier tier fully passed. The first failing case decides the verdict.
5. **Verdict mapping** from the first failure: `Time Limit Exceeded` → `TIME_LIMIT_EXCEEDED`; `Memory Limit Exceeded` → `MEMORY_LIMIT_EXCEEDED`; `Compilation Error` → `COMPILATION_ERROR`; `Runtime Error` and `Output Limit Exceeded` → `RUNTIME_ERROR`; anything else (`Wrong Answer`, `Cancelled`) → `WRONG_ANSWER`. No failure gives `ACCEPTED`.
6. The following steps run in parallel:
   - **Verdict chain**: update the submission row (`status`, `passedCount`, `totalCount`, `time` = `"<maxCpuMs>ms"`, `memory` = max KB). On a **first** accepted solve it then recomputes `problems.solvedCount`.
   - **Rewards chain** (logged-in and accepted only): on a first solve, insert `user_problem_progress` and raise score, rating and tier ([§20](#20-gamification-rules)). Then try the daily-problem reward: +2 coins and the streak, if this problem is today's daily problem and it is the first completion today.
   - **Static complexity analysis.**
7. If the submission is accepted, saved, and profiling is enabled for the problem and language, it queues an empirical complexity profile (background job).
8. Caches the full result in memory for 30 minutes so polling can return per-testcase results.

**Synchronous 200 response**

```json
{
  "success": true,
  "submissionId": "cm3x9…",
  "verdict": "ACCEPTED",
  "status": "ACCEPTED",
  "tierReached": "Tier 3 (Optimal)",
  "passedCount": 5,
  "totalCount": 5,
  "time": "4ms",
  "memory": 3584,
  "results": [
    { "testIndex": 0, "input": "4 9\n2 7 11 15", "expected": "0 1", "actual": "0 1", "passed": true, "isVisible": true,
      "time": 3, "timeMs": 3, "cpuTimeMs": 3, "wallTimeMs": 4, "memory": 3520, "memoryKb": 3520, "inputBytes": 13,
      "status": "Accepted", "errorText": null },
    { "testIndex": 2, "isVisible": false, "passed": true, "status": "Accepted", "time": 2, "memory": 3500 }
  ],
  "firstFailure": null,
  "complexity": { "time": { "bestEstimate": "O(n)", "confidence": "high" }, "space": { "bestEstimate": "O(n)", "confidence": "medium" }, "summary": "…" },
  "complexityProfile": null,
  "reward": {
    "awarded": true, "points": 10, "scoreDelta": 100, "coinsEarned": 0,
    "stats": { "rating": 830, "tier": "Pulse II", "score": 10, "scoreUnits": 100, "coins": 101, "streak": 0, "longestStreak": 0 }
  },
  "rewardError": false,
  "dailyProblemReward": { "granted": false, "coins": 0 },
  "problem": { "slug": "two-sum", "title": "Two Sum" }
}
```

**Field reference**

| Field | Meaning |
|---|---|
| `submissionId` | `submissions.id` (cuid), or a temporary `sub_…` id for an anonymous submission whose insert failed |
| `verdict` / `status` | `SubmissionVerdict` |
| `tierReached` | Highest fully passed tier: `Tier 0 (Failed)` → `Tier 1 (Brute Force)` → `Tier 2 (Better)` → `Tier 3 (Optimal)`. Small problems have empty tiers: with 1 testcase an accepted submission shows `Tier 1 (Brute Force)`, and with 2 it shows `Tier 2 (Better)`. |
| `passedCount` / `totalCount` | Passed cases / **all** testcases. Cases in tiers that never ran count as not passed. |
| `time` | String `"<n>ms"`: the maximum CPU time over the executed cases |
| `memory` | Number: the maximum KB over the executed cases |
| `results` | **Only the executed cases**, in order. The failing tier is included in full; later tiers are omitted, as are cases skipped after a definitive TLE. **Hidden cases are redacted** to `{ testIndex, isVisible: false, passed, status, time, memory }`. Visible cases carry everything. |
| `firstFailure` | `null` when accepted. Otherwise `{ testIndex, status, errorText, input?, expected?, actual?, message }`. For a hidden case, `input`, `expected` and `actual` are omitted, `errorText` is `null`, and `message` is `"Failed on hidden evaluation test case #<k>."`, where `k` is the 1-based position among executed results. For a visible case, `message` is `"Failed sample test <k>: expected '<e>', got '<a>'"`. |
| `complexity` | `ComplexitySummary` (static analysis) or `null` |
| `complexityProfile` | `null`, or `{ "status": "PENDING", "url": "/api/execution/submissions/<id>/complexity" }` when an empirical profile was queued |
| `reward` | `SolveReward`, or `null` (anonymous, or not accepted). On a re-solve: `{ awarded: false, points: 0, scoreDelta: 0, coinsEarned: 0, stats }`. When the daily-problem reward was granted too, `coinsEarned` includes the +2 and `stats.coins` is the new balance. |
| `rewardError` | `true` if saving the reward failed. The verdict itself is still valid. |
| `dailyProblemReward` | `{ granted, coins }`. `granted: true, coins: 2` only on the first accepted submission of today's daily problem. |

**Failing example** (hidden case, Wrong Answer in tier 2)

```json
{
  "success": true, "submissionId": "cm3y…", "verdict": "WRONG_ANSWER", "status": "WRONG_ANSWER",
  "tierReached": "Tier 1 (Brute Force)", "passedCount": 2, "totalCount": 5, "time": "3ms", "memory": 3500,
  "results": [ { "testIndex": 0, "isVisible": true, "passed": true, "status": "Accepted", "…": "…" },
               { "testIndex": 1, "isVisible": true, "passed": true, "status": "Accepted", "…": "…" },
               { "testIndex": 2, "isVisible": false, "passed": false, "status": "Wrong Answer", "time": 2, "memory": 3480 } ],
  "firstFailure": { "testIndex": 2, "status": "Wrong Answer", "errorText": null, "message": "Failed on hidden evaluation test case #3." },
  "complexity": { "…": "…" }, "complexityProfile": null,
  "reward": null, "rewardError": false, "dailyProblemReward": { "granted": false, "coins": 0 },
  "problem": { "slug": "two-sum", "title": "Two Sum" }
}
```

**Asynchronous 202 response**

```json
{
  "success": true,
  "submissionId": "cm3x9…",
  "verdict": "QUEUED",
  "status": "QUEUED",
  "pollUrl": "/api/execution/submissions/cm3x9…",
  "message": "Submission received and queued for execution.",
  "problem": { "slug": "two-sum", "title": "Two Sum" }
}
```

Judging continues in the same backend process; there is no external queue. If background judging crashes, the row becomes `status: "ERROR"`.

**Errors**: everything listed for Run, plus 503 `SUBMISSION_STORAGE_UNAVAILABLE` (submission row or verdict could not be saved; logged-in callers only) and 429 for more than 6 submissions per minute. In synchronous mode, CodeBox failures surface as HTTP 503 or 500. The submission row then **stays `PROCESSING`**.

### 13.4 `GET /api/execution/submissions/:id` — Owner

Polls a submission. It returns **404 `SUBMISSION_NOT_FOUND`** "Submission not found." when the id does not exist **or** belongs to someone else. Anonymous submissions (`userId = null`) can never be polled.

**200**

```json
{
  "success": true,
  "submission": {
    "id": "cm3x9…", "problemId": "cm…", "language": "cpp",
    "verdict": "ACCEPTED", "status": "ACCEPTED",
    "tierReached": "Tier 3 (Optimal)",
    "passedCount": 5, "totalCount": 5, "time": "4ms", "memory": 3584, "createdAt": "…",
    "firstFailure": null,
    "results": [ /* same redaction as submit */ ],
    "complexity": { /* ComplexitySummary */ },
    "complexityProfile": { "status": "COMPLETED", "timeComplexity": "O(n)", "spaceComplexity": "O(1)", "confidence": "High", "url": "/api/execution/submissions/cm3x9…/complexity" },
    "reward": { /* SolveReward */ },
    "rewardError": false,
    "dailyProblemReward": { "granted": false, "coins": 0 },
    "problem": { "slug": "two-sum", "title": "Two Sum" }
  }
}
```

**Polling guidance**: poll about every 1 s while `status === "PROCESSING"`. Terminal statuses are `ACCEPTED`, `WRONG_ANSWER`, `TIME_LIMIT_EXCEEDED`, `MEMORY_LIMIT_EXCEEDED`, `RUNTIME_ERROR`, `COMPILATION_ERROR` and `ERROR`.

Data sources:

- `id`, `status`, counts, `time`, `memory` and `createdAt` come from the **database**.
- `results`, `firstFailure`, `tierReached`, `reward`, `dailyProblemReward` and `complexity` come from an **in-memory cache** (30 minutes, at most 2,000 entries, per backend instance). After it expires, after a restart, or on another instance:
  - `results` is `[]`, `firstFailure` and `reward` are `null`, `complexity` is `null`;
  - `tierReached` is re-derived from the counts: ACCEPTED → Tier 3; `passed ≥ floor(total × 0.7)` → Tier 2; `passed ≥ floor(total × 0.35)` → Tier 1; else Tier 0.
- `complexityProfile` comes from the cache, or for ACCEPTED submissions from the `complexity_profiles` table: `{ status, timeComplexity, spaceComplexity, confidence, url }`.
- `rewardError` is currently always `false` in poll responses, because it is not copied from the cache.
- `time` defaults to `"0ms"` and `memory` to `0` while the submission is processing.

### 13.5 `GET /api/execution/submissions/:id/complexity` — Owner

Returns the **empirical** complexity profile of an accepted submission. The profile is measured by running the solution on growing generated inputs in the background. It is enabled only when `COMPLEXITY_PROFILING_ENABLED=true`, and currently only for problem `add-two-numbers` in `cpp`. Ownership rules are the same as 13.4.

**200 when no profile exists**

```json
{ "success": true, "submissionId": "cm…", "status": "UNAVAILABLE",
  "reason": "Complexity profiling is disabled." }
```

The `reason` is one of:

- "Only accepted submissions are profiled."
- "Complexity profiling is disabled."
- "Complexity profiling is not available for this problem/language yet."
- "Profiling was not scheduled for this submission."

**200 when a profile exists**

```json
{
  "success": true,
  "submissionId": "cm…",
  "status": "COMPLETED",
  "language": "cpp",
  "time":  { "complexity": "O(n)", "confidence": "High", "method": "reference-normalized" },
  "space": { "complexity": "O(1)", "confidence": "High", "kind": "auxiliary (estimate)", "outputSpace": "O(n)" },
  "confidence": "High",
  "worstCase": true,
  "notes": [ "Worst-case inputs: All-9 digit lists: a carry at every position and an n+1 node result.", "Space is an estimate: …" ],
  "inputSizes": [250, 500, 1000, 2000, 4000, 8000, 16000],
  "measurements": {
    "time":  [ { "n": 250, "functionNs": 4100, "referenceNs": 3900, "repetitionsNs": [4100, 4200, 4150], "spread": 0.02 } ],
    "space": [ { "n": 250, "auxiliaryBytes": 0, "heapBytes": 4016, "stackBytes": 96, "outputBytes": 4016, "peakRssKb": 3600, "baselineRssKb": 3550 } ],
    "fits":  { "time": [ /* model fits */ ], "space": [ /* model fits */ ] },
    "raw":   [ /* per-size raw measurements */ ]
  },
  "failureReason": null,
  "attempts": 1,
  "durationMs": 2400,
  "createdAt": "…", "updatedAt": "…"
}
```

- `status` is `PENDING`, `RUNNING`, `COMPLETED`, `INCONCLUSIVE` or `FAILED`.
- `time` and `space` are `null` until known. `time.method` is `"reference-normalized"` (timed against a reference O(n) implementation) or `"raw"`.
- `measurements` is `null` until the status is `COMPLETED`, `INCONCLUSIVE` or `FAILED`.
- The confidence values here are capitalised: `High`, `Medium`, `Low` or `Inconclusive`.

### 13.6 `POST /api/execution/analyze-complexity` — Optional · run limiter

Static (no execution) time and space complexity estimate. It shares the 10-per-minute run budget and is **not** subject to the in-flight limit.

**Body**: `{ "code" | "userCode" | "source_code": string, "language" | "lang": string (default "python"), "slug" | "problemSlug": string (accepted but unused) }`. The language is not validated: JS/TS names, Python names, and everything else are treated as brace-style (C/C++/Java). Code over 200,000 characters gives an "unknown" result.

**200**

```json
{
  "success": true,
  "complexity": {
    "version": "3.0.1",
    "status": "completed",
    "summary": "Time: O(n), Space: O(n) auxiliary, O(1) output (O(n) total)",
    "time":  { "bestEstimate": "O(n)", "confidence": "high", "asymptoticClass": "LINEAR" },
    "detectedPatterns": ["linear_traversal"],
    "space": { "bestEstimate": "O(n)", "auxiliary": "O(n)", "output": "O(1)", "total": "O(n)", "confidence": "medium" }
  }
}
```

When the analyzer cannot parse the code: `{ "version": "3.0.1", "status": "unknown", "summary": "Complexity analysis unavailable", "limitations": ["<reason>"] }`.

**400 `MISSING_CODE`** when the code is empty. Results are cached in memory by SHA-256 of the normalised code, language and analyzer version.

---

## 14. Daily problem — `/api/daily-problem`

Service: [src/services/dailyProblemService.js](src/services/dailyProblemService.js). Handlers: [src/controllers/coin.controller.js](src/controllers/coin.controller.js).

**How it works**

- One problem per IST calendar day (table `daily_problems`, unique `istDate`). It is chosen at random from all problems, avoiding yesterday's problem when at least 2 problems exist.
- It is created by a cron job at 00:00 Asia/Kolkata, at startup, and lazily on first request. Creation is concurrency-safe.
- The first **ACCEPTED** submission of today's problem by a logged-in user grants +2 coins and advances the streak ([§20](#20-gamification-rules)), once per user per day.

### 14.1 `GET /api/daily-problem` · alias `GET /api/coins/daily-problem` — Optional

**200**

```json
{
  "success": true,
  "istDate": "2026-11-22",
  "problem": { "id": "cm…", "slug": "two-sum", "title": "Two Sum", "difficulty": "Easy", "description": "…", "tags": ["Array"], "solvedCount": 37 },
  "reward": { "coins": 2, "description": "+2 coins and +1 streak for your first ACCEPTED submission on today's challenge" },
  "completed": false,
  "solvedToday": false,
  "rewardClaimed": false,
  "completedAt": null,
  "streak": 3,
  "longestStreak": 5,
  "nextRefreshMs": 41234567,
  "nextRefreshTime": "12:00 AM IST"
}
```

- `completed`, `solvedToday` and `rewardClaimed` are identical. They are true when a `daily_problem_completions` row exists for the user and today's problem, or a `DAILY_PROBLEM` coin transaction exists for today.
- `completedAt` is the completion time, or `null`.
- `streak` and `longestStreak` are 0 for anonymous callers.
- `nextRefreshMs` is the milliseconds until the next 00:00 IST.
- Use `problem.slug` to open the problem.

**Errors**: 503 `NO_ELIGIBLE_PROBLEMS` (no problems in the database), 404 `DAILY_PROBLEM_NOT_FOUND`.

### 14.2 `GET /api/daily-problem/history` · alias `GET /api/coins/daily-problem/history` — Optional

**Query**: `page` (default 1, minimum 1) and `limit` (default 30, range 1–100).

**200**

```json
{
  "success": true, "count": 2, "total": 45, "page": 1, "totalPages": 23,
  "history": [
    { "id": "cm…", "istDate": "2026-11-22", "createdAt": "…", "completed": true,
      "problem": { "id": "cm…", "slug": "two-sum", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array"], "solvedCount": 37 } }
  ]
}
```

Entries are ordered newest first. `completed` is false for anonymous callers.

---

## 15. Coins — `/api/coins`

Controller: [src/controllers/coin.controller.js](src/controllers/coin.controller.js). Service: [src/services/coinService.js](src/services/coinService.js). This service is the only code that writes `users.coins` and `coin_transactions`.

### 15.1 `GET /api/coins/balance` — Protected

**200**: `{ "success": true, "coins": 142, "streak": 3, "longestStreak": 5, "lastLoginISTDate": "2026-11-22" }`

`lastLoginISTDate` falls back to the IST date of `lastStreakDate` when it is null.

### 15.2 `GET /api/coins/history` — Protected

**Query**: `limit` (default 20, clamped to 1–50; non-numeric values become 20) and `offset` (default 0, minimum 0).

**200**

```json
{
  "success": true,
  "transactions": [
    { "id": "cm…", "amount": 2,    "type": "DAILY_PROBLEM",  "referenceId": "cm3x9…(submissionId)", "istDate": "2026-11-22", "balanceAfter": 104, "createdAt": "…" },
    { "id": "cm…", "amount": 1,    "type": "DAILY_LOGIN",    "referenceId": "2026-11-22",           "istDate": "2026-11-22", "balanceAfter": 102, "createdAt": "…" },
    { "id": "cm…", "amount": -450, "type": "THEME_PURCHASE", "referenceId": "<themeId>",            "istDate": "2026-11-21", "balanceAfter": 12,  "createdAt": "…" }
  ]
}
```

Entries are ordered newest first. The transaction types are `DAILY_LOGIN` (+1), `DAILY_PROBLEM` (+2) and `THEME_PURCHASE` (−price).

---

## 16. Theme store — `/api/themes`

Controller: [src/controllers/theme.controller.js](src/controllers/theme.controller.js). The catalogue is defined in [src/data/storeThemes.js](src/data/storeThemes.js) and upserted into the `themes` table once per process, on first use. All routes are **Protected**.

| slug | name | price | previewColor |
|---|---|---|---|
| `default` | Default | 0 (`isDefault`) | `#2F7BFF` |
| `orbit` | Orbit | 450 | `#35E6FF` |
| `frost` | Frost | 400 | `#EEF0FA` |
| `editorial` | Editorial | 400 | `#F7F4EE` |
| `mono` | Monochrome | 350 | `#161616` |
| `pearl` | Pearl | 350 | `#ECECEE` |
| `arcade` | Arcade | 800 | `#FF2E97` |
| `racer` | Racer | 800 | `#FF1E1E` |
| `anime` | Sakura Manga | 700 | `#FF4F8B` |
| `comic` | Hero Comic | 700 | `#E5232B` |
| `storybook` | Storybook Kingdom | 700 | `#C9922E` |

### 16.1 `GET /api/themes`

**200**

```json
{
  "success": true,
  "coins": 142,
  "themes": [
    { "id": "…", "slug": "default", "name": "Default", "price": 0, "previewColor": "#2F7BFF", "isDefault": true,
      "owned": true, "applied": true, "canAfford": true }
  ]
}
```

- Themes are ordered by price ascending.
- `owned` is true for the default theme or a purchased theme.
- `applied` is true when the theme is the user's `activeThemeId`. If the user has no active theme, the default theme is applied.
- `canAfford` is `coins >= price`.

### 16.2 `GET /api/themes/me`

**200**: `{ "success": true, "coins": 142, "activeTheme": "orbit", "ownedThemes": ["orbit"] }`

`activeTheme` is `"default"` when none is set. `ownedThemes` lists purchased slugs only; the default theme is not included unless it was bought.

### 16.3 `POST /api/themes/:slug/buy`

**What the backend does**

1. The slug must be in the static catalogue, otherwise 404 `NOT_FOUND` "Theme not found".
2. In one transaction:
   - If the theme is already owned: 400 `ALREADY_OWNED` with `details: { owned: true }`.
   - An atomic conditional debit (`coins >= price`) **also sets `activeThemeId`**, so buying automatically applies the theme. Insufficient coins give 400 `INSUFFICIENT_COINS` with `details: { required, have }`.
   - Writes a `THEME_PURCHASE` coin transaction with `amount = −price`.
   - Creates the `user_themes` row.

**200**

```json
{
  "success": true,
  "message": "Bought Orbit",
  "theme": { "slug": "orbit", "applied": true, "owned": true },
  "coins": 12,
  "stats": { /* UserHeaderStats */ }
}
```

A concurrent double-buy that hits the unique index is also reported as 400 `ALREADY_OWNED`. A missing user gives 404 `USER_NOT_FOUND`.

### 16.4 `PUT /api/themes/apply`

**Body**: `{ "slug": "orbit" }`

| Status | Code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | "slug required" |
| 404 | `NOT_FOUND` | unknown slug |
| 403 | `FORBIDDEN` | "You don't own this theme, buy first" (the default theme is always allowed) |

**200**: `{ "success": true, "activeTheme": "orbit", "message": "Orbit applied" }`

---

## 17. Rankings — `/api/rankings`

Controller: [src/controllers/ranking.controller.js](src/controllers/ranking.controller.js).

### `GET /api/rankings` — Public

**Query**

| Param | Meaning |
|---|---|
| `scope` | `college`, `batch`, `state` or `country`. It filters only when the matching value param is also sent. Any other scope, or none, gives the global ranking. |
| `college` / `batch` / `state` / `country` | Exact, case-sensitive value for the chosen scope |
| `limit` | Default 50, clamped to 1–100 |

**200**

```json
{
  "success": true,
  "count": 2,
  "data": [
    { "id": "…", "name": "Asha", "score": 1850, "rating": 1310, "streak": 4, "strictPercent": 0, "tier": "Aurora I",
      "college": "IIT X", "branch": "CSE", "batch": "2027", "state": "MH", "country": "India", "createdAt": "…" }
  ]
}
```

- Users are sorted by `score` descending (`score` is **scoreUnits**; divide by 10 for points). There is no `rank` field: the rank is the array index + 1.
- No pagination offset is available.
- `tier` here is the **stored** tier, updated on each first solve, which can differ from the computed `stats.tier`.
- There is no `branch` scope.

---

## 18. Study material — `/api/study`

Controller: [src/controllers/study.controller.js](src/controllers/study.controller.js). Content is loaded from `study-material/**.json` by `npm run study:sync` ([scripts/upload-study.js](scripts/upload-study.js)).

### 18.1 `GET /api/study/subjects` — Public

**200** (bare array, ordered by `order`)

```json
[ { "id": "cm…", "slug": "dbms", "name": "DBMS", "description": "…", "icon": "…", "order": 1, "createdAt": "…", "_count": { "chapters": 16 } } ]
```

### 18.2 `GET /api/study/subjects/:subjectSlug` · alias `/api/study/subjects/:subjectSlug/chapters` — Public

**200** (bare object)

```json
{ "id": "cm…", "slug": "dbms", "name": "DBMS", "description": "…", "icon": "…", "order": 1, "createdAt": "…",
  "chapters": [ { "id": "cm…", "slug": "01-er-model", "name": "ER Model", "subjectId": "cm…", "order": 1, "_count": { "topics": 2 } } ] }
```

**404**: "Subject not found." (code `NOT_FOUND`)

### 18.3 `GET /api/study/chapters/:chapterId/topics` — Public

**200** (bare array, ordered by `order`): `[ { "id": "cm…", "slug": "what-is-er-model", "name": "What is ER Model", "order": 1 } ]`

An unknown chapter id returns `[]`, not 404.

### 18.4 `GET /api/study/topics/:topicSlug` — Public

**200** (bare object)

```json
{
  "id": "cm…", "slug": "what-is-er-model", "name": "…", "chapterId": "cm…", "order": 1,
  "content": "# Markdown lesson …", "isPublished": true, "createdAt": "…",
  "mcqs": [ { "id": "cm…", "question": "…", "options": ["A", "B", "C", "D"], "difficulty": "Easy", "order": 1, "explanation": "…" } ],
  "chapter": { "id": "cm…", "slug": "…", "name": "…", "subjectId": "…", "order": 1,
               "subject": { "id": "…", "slug": "dbms", "name": "DBMS", "description": "…", "icon": "…", "order": 1, "createdAt": "…" } }
}
```

- `correctIndex` is **not** returned here, but `explanation` is.
- Topic slugs are unique only within a chapter, so the first match wins.
- `isPublished` is not filtered.
- **404**: "Topic not found."

### 18.5 `POST /api/study/topics/:topicSlug/submit` — Protected

**Body**: `{ "answers": { "<mcqId>": <optionIndex: number> } }`. Answers are compared with `===`, so send **numbers**, not strings.

**200**

```json
{
  "success": true, "userId": "…", "topicSlug": "what-is-er-model", "score": 3, "total": 5,
  "result": [ { "mcqId": "cm…", "isCorrect": true, "correctIndex": 2, "explanation": "…" } ]
}
```

Grading only: **no progress is persisted**.

**Errors**: 401 `UNAUTHORIZED`, 404 `NOT_FOUND` "Topic not found."

---

## 19. Social / GitHub OAuth — `/api/social`

Controller: [src/controllers/social.controller.js](src/controllers/social.controller.js). Only provider `github` is supported.

### 19.1 `GET /api/social/:provider/link-url` — Protected

**200**: `{ "url": "https://github.com/login/oauth/authorize?client_id=…&redirect_uri=<BACKEND_URL>/api/social/github/callback&scope=read%3Auser+user%3Aemail&state=<jwt>" }`

- `state` is a JWT `{ userId, provider }` signed with `OAUTH_STATE_SECRET`, valid for **10 minutes**.
- `client_id` falls back to `demo-github-client-id` when `GITHUB_CLIENT_ID` is unset.
- **404 `UNKNOWN_PROVIDER`** for any provider other than `github`.

The frontend should navigate the browser to `url`.

### 19.2 `GET /api/social/:provider/callback` — Public (GitHub redirects the browser here)

**Query**: `code`, `state`, and optionally `error` and `redirect_uri`.

**What the backend does**

1. Computes the redirect target: the origin of `redirect_uri` if it is in the allow-list (`FRONTEND_URL` entries plus `localhost:5173` and `127.0.0.1:5173`), otherwise the first allowed origin.
2. Validates `code` and `state`, verifies the state JWT, and checks the provider and configuration.
3. Exchanges the code at `https://github.com/login/oauth/access_token`, then reads `/user` and, when no public email exists, `/user/emails` (the primary verified email). Each GitHub call has a 10 s timeout.
4. Refuses to link if this GitHub account is already linked to **another** user.
5. Upserts `social_accounts` with `{ providerUserId, username, name, email, avatarUrl, profileUrl, bio, headline: null, stats: { publicRepos, followers, following } }` and refreshes `connectedAt`.

**Result**: always a **302 redirect**:

- success: `<frontend>/?linked=github`
- failure: `<frontend>/?link_error=<CODE>`

| `link_error` | Meaning |
|---|---|
| `CANCELLED` | user denied, or `code`/`state` missing |
| `EXPIRED` | state JWT invalid or older than 10 minutes |
| `UNKNOWN_PROVIDER` | provider ≠ github |
| `CONFIGURATION` | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` missing |
| `AUTH_FAILED` | token exchange failed, or no GitHub user id |
| `ALREADY_LINKED` | this GitHub account belongs to another Calibr8 user |
| `SERVER_ERROR` | anything else (network, DB) |

### 19.3 `DELETE /api/social/:provider` — Protected

Deletes the caller's link for that provider (lowercased).

**200**: `{ "success": true, "count": { "count": 1 } }`. ⚠ `count` is the Prisma result object: read `count.count`. It is `0` when nothing was linked; that is not an error.

---

## 20. Gamification rules

### 20.1 Points and score (first accepted solve of a problem only)

Source: [src/utils/acceptedSubmissionReward.js](src/utils/acceptedSubmissionReward.js).

- "First solve" means the `user_problem_progress` row does not exist yet; its primary key is `(userId, problemId)`. Later accepted submissions of the same problem award nothing.

| Difficulty | `points` | `users.score` increment (scoreUnits = points × 10) |
|---|---|---|
| Easy (or unknown) | 10 | +100 |
| Medium | 25 | +250 |
| Hard | 50 | +500 |

`stats.score` is `floor(scoreUnits / 10)`, the sum of points.

### 20.2 Rating (Elo-style, first solve only)

```
problemRating = { easy: 800, medium: 1200, hard: 1600 }[difficulty] ?? 800
expected      = 1 / (1 + 10 ^ ((problemRating − userRating) / 400))
K             = 60 if solvedProblems (including this one) ≤ 10, else 32
newRating     = max(0, round(userRating + K × (1 − expected)))
```

Rating only goes up when solving. Examples starting from 800: Easy gives 830, Medium gives 855, Hard gives 859.

Onboarding **overwrites** the rating with the calibration average ([§11.1](#111-post-apionboarding--alias-put-apionboardinglevels)).

### 20.3 Tier labels (from rating)

`tierIndex = clamp(floor((rating − 700) / 200), 0, 5)`. Division = `clamp(floor((rating − tierFloor) / 66.67), 0, 2)`, where `tierFloor = 700 + 200 × tierIndex`.

| Rating | Tier | Divisions |
|---|---|---|
| < 900 | Pulse | I ≤ 766 · II 767–833 · III 834–899 (below 700 is always I) |
| 900–1099 | Flux | I +0–66 · II +67–133 · III +134–199 |
| 1100–1299 | Prism | same offsets |
| 1300–1499 | Aurora | same offsets |
| 1500–1699 | Eclipse | same offsets |
| ≥ 1700 | Zenith | I 1700–1766 · II 1767–1833 · III ≥ 1834 |

`stats.tier` is always computed from the rating. `users.tier` is stored, defaults to `"Prism I"`, and is rewritten only on a first solve.

### 20.4 Coins

| Event | Amount | Rule |
|---|---|---|
| New account | starts at **100** | DB default |
| Daily login | **+1** | first register/login/refresh/me/verify of the IST day; atomic claim on `users.lastLoginISTDate` |
| Daily problem | **+2** | first ACCEPTED submission of today's daily problem; one `daily_problem_completions` row per user per day |
| Theme purchase | **−price** | atomic conditional debit |
| Solving a normal problem | 0 | `coinsAwarded` is always 0 |

Every change is audited in `coin_transactions` with `balanceAfter`.

### 20.5 Streak (daily problem only)

Source: `computeDailyProblemStreak` in [src/services/streakService.js](src/services/streakService.js). All days are **IST** (Asia/Kolkata).

| Last daily-problem completion | New streak |
|---|---|
| never | 1 |
| today | unchanged (no second reward) |
| yesterday | streak + 1 |
| older | reset to 1 |

`longestStreak = max(longestStreak, streak)`. Logging in never changes the streak. A missed day is noticed only at the next completion: the stored `streak` is not reset at midnight.

---

## 21. Data model reference

Source: [prisma/schema.prisma](prisma/schema.prisma). Table names are in parentheses.

| Model (table) | Key fields | Notes |
|---|---|---|
| `User` (`users`) | `id` uuid, `email` unique, `phone` unique?, `passwordHash`, `name`, `difficulty?`, `rating`=800, `score`=0, `streak`=0, `longestStreak`=0, `strictPercent`=0, `tier`="Prism I", `college?`, `branch?`, `batch?`, `state?`, `country?`="India", `onboarded`=false, `preferredLanguage`="cpp" (column `preferred_language`), `coins`=100, `activeThemeId?`, `lastStreakDate?`, `lastLoginISTDate?` | indexes on `(college,score)`, `(branch,score)`, `(batch,score)`, `(state,score)`, `(country,score)`, `(score)` |
| `Topic` (`topics`) | `id` uuid, `slug` unique, `name`, `category`="CORE" | calibration topics |
| `UserTopic` (`user_topics`) | `userId`, `topicId`, `level`="easy" | unique `(userId, topicId)` |
| `SocialAccount` (`social_accounts`) | `provider`, `providerUserId`, profile fields, `stats` Json, `connectedAt` | unique `(userId, provider)` and `(provider, providerUserId)` |
| `Theme` (`themes`) | `slug` unique, `name`, `price`, `previewColor`, `cssVars?`, `isDefault` | |
| `UserTheme` (`user_themes`) | `userId`, `themeId`, `purchasedAt` | unique `(userId, themeId)` |
| `Problem` (`problems`) | `id` cuid, `problemNumber` unique autoincrement, `slug` unique, `title`, `description`, `difficulty`="Easy", `solvedCount`, `timeLimit`=1000 (ms), `memoryLimit`=256 (MB), `dsaTopicId?`, `tags` String[] | |
| `Example` (`examples`) | `problemId`, `order`, `input`, `output`, `explanation?` | statement examples |
| `Testcase` (`testcases`) | `problemId`, `testIndex`, `isVisible`, `stdinSmall`, `expectedSmall`, `sizeBytes`, `r2Key?` | unique `(problemId, testIndex)`; `r2Key` is not used at runtime |
| `CodeTemplate` (`code_templates`) | `problemId`, `language`, `code` (JSON string `{userTemplate, header, footer}` or plain code) | unique `(problemId, language)` |
| `DsaTopic` (`dsa_topics`) | `slug` unique, `name`, `order` | problem categories |
| `Submission` (`submissions`) | `id` cuid, `problemId`, `userId?`, `language`, `code`, `status`, `passedCount`, `totalCount`, `time?` ("12ms"), `memory?` (KB), `createdAt` | indexes `(problemId,status)`, `(userId,status)`, `(userId,status,createdAt)` |
| `UserProblemProgress` (`user_problem_progress`) | PK `(userId, problemId)`, `points`, `scoreAwarded`, `coinsAwarded`=0, `solvedAt` | one row per solved problem |
| `StudySubject` / `StudyChapter` / `StudyTopic` / `StudyMCQ` | slug/name/order hierarchy; `StudyMCQ.options` Json, `correctIndex` | default Prisma table names |
| `CoinTransaction` (`coin_transactions`) | `userId`, `amount`, `type`, `referenceId?`, `istDate`, `balanceAfter`, `createdAt` | indexes `(userId,createdAt)`, `(userId,type,istDate)` |
| `RevokedToken` (`revoked_tokens`) | `jti` PK, `userId?`, `expiresAt` | |
| `DailyProblem` (`daily_problems`) | `istDate` unique, `problemId` | |
| `DailyProblemCompletion` (`daily_problem_completions`) | PK `(userId, dailyProblemId)`, `submissionId?`, `completedAt` | |
| `ComplexityProfile` (`complexity_profiles`) | `submissionId` unique, `status`, `language`, `problemSlug`, time/space complexity and confidence, `inputSizes`/`measurements`/`baseline`/`analysis` Json, `attempts`, `nextAttemptAt`, `failureReason?` | doubles as the profiling job queue |

All user-owned rows cascade on user delete.

> The production database (Neon) was built with `prisma db push`. Apply schema changes as additive SQL. `npm test` uses `DATABASE_URL`, so run tests with `npm run test:isolated`, which uses a separate `_test` database.

---

## 22. Background jobs and startup behaviour

From [src/server.js](src/server.js):

| When | What |
|---|---|
| Boot, if `DATABASE_URL` is set | `prisma.$connect()` and upsert of the 14 calibration topics from `TOPIC_CATALOG` (warnings only, never fatal) |
| After listen | `startDailyProblemScheduler()`: ensures today's daily problem now, then a cron job `0 0 * * *` in `Asia/Kolkata` |
| After listen | Every **1 hour**: delete expired `revoked_tokens` rows |
| After listen | `startProfilingWorker()`: no-op unless `COMPLEXITY_PROFILING_ENABLED`. Recovers stale jobs, then processes the queue. |
| After listen | CodeBox health check: `GET ${CODEBOX_URL}/health` with a 3 s timeout. **Log only.** |
| `SIGINT` / `SIGTERM` | Stop the cron job and purge timer, stop accepting connections, wait up to **10 s** for in-flight requests, disconnect Prisma, exit 0. In-flight asynchronous submissions are not awaited and can be left `PROCESSING`. |

---

## 23. Environment variables

See [.env.example](.env.example).

| Variable | Default | Used for |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `NODE_ENV` | – | `production` changes CORS (no localhost), the secret minimums and `trust proxy` |
| `DATABASE_URL` | – | PostgreSQL. Neon adapter if the URL contains `neon.tech`. |
| `JWT_SECRET` | dev fallback | token signing (≥ 32 characters in production) |
| `JWT_EXPIRES_IN` | `1d` | token lifetime |
| `OAUTH_STATE_SECRET` | dev fallback | GitHub OAuth state; must differ from `JWT_SECRET` |
| `FRONTEND_URL` | – | comma-separated CORS origins and OAuth redirect allow-list |
| `BACKEND_URL` | `http://localhost:3000` | OAuth `redirect_uri` base |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | – | GitHub OAuth |
| `TRUST_PROXY` | 1 in production, else off | client IP for rate limits |
| `PROBLEM_CACHE_TTL_MS` | 60000 | resolved-problem cache (0 disables) |
| `CATALOG_CACHE_TTL_MS` | 30000 | problem catalogue cache (0 disables) |
| `CODEBOX_URL`, `CODEBOX_TOKEN` | – | **required** for Run and Submit (otherwise 503) |
| `CODEBOX_ALLOW_INSECURE_HTTP` | false | allow an `http://` CodeBox URL |
| `CODEBOX_MULTICASE_ENABLED` | true | C/C++ multi-case harness |
| `CODEBOX_MULTICASE_MAX_CASES` | 500 | cases per harness request |
| `CODEBOX_BATCH_EXECUTION_ENABLED` | `auto` in code (`false` in `.env.example`) | CodeBox `/batches` API: `auto` / `true` / `false` |
| `CODEBOX_BATCH_WAIT_MS` | 20000 | long-poll wait for `/batches` |
| `CODEBOX_BATCH_MAX_CASES` | 200 | maximum cases in the "all tiers in one batch" fast path |
| `CODEBOX_MAX_CONCURRENT_BATCHES` | 2 | parallel chunks per execution |
| `CODEBOX_MAX_CPU_TIME_LIMIT`, `CODEBOX_MAX_WALL_TIME_LIMIT` | 15, 20 (seconds) | sandbox limits for harness runs |
| `COMPLEXITY_PROFILING_ENABLED` | false | background empirical profiling |
| `COMPLEXITY_PROFILING_CONCURRENCY` / `_MAX_INPUT_SIZE` / `_REPETITIONS` / `_TIMEOUT_MS` / `_MAX_PENDING` / `_MAX_ATTEMPTS` | 1 / 16000 / 3 / 90000 / 50 / 3 | profiling job tuning |
| `COMPLEXITY_PROFILING_CPU_LIMIT_SEC` / `_WALL_LIMIT_SEC` / `_MEMORY_LIMIT_MB` / `_PER_RUN_LIMIT_MS` / `_STOP_ABOVE_MS` | 15 / 20 / 512 / 3000 / 1200 | profiling sandbox limits |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | – | [lib/storage.js](lib/storage.js) (Cloudflare R2). **Not imported by any runtime code.** |

---

## 24. Caching and multi-instance behaviour

Every cache below is **in-process memory**. With more than one backend instance, each instance has its own copy.

| Cache | TTL / size | Effect |
|---|---|---|
| Resolved problem (testcases + templates) | 60 s / 300 | Problem edits can take up to 60 s to appear in detail, run and submit. `solvedCount` is patched in place on first solves. |
| Problem catalogue | 30 s | List, categories and acceptance rates can lag by up to 30 s. |
| Bundled `problems/*.json` topic | forever | topic fallback |
| Submission results | 30 min / 2,000 | Per-testcase results in poll responses |
| Daily-problem lookup | 60 s | "is this today's daily problem?" check on submit |
| Token revocation | revoked until expiry; not-revoked 30 s | cross-instance revocation delay of up to 30 s |
| Theme catalogue seed | once per process | |
| Static complexity analyzer | 500 parsed / 1,000 results | |
| Rate limiter and in-flight counters | windows | limits are per instance |

---

## 25. Known quirks and gotchas

1. **Unknown routes return HTML 404**, not the JSON error shape.
2. **Async-submit routes and anonymous users**: `POST /api/problems/:slug/submit` returns 202 by default, but anonymous users cannot poll. Use `wait: true`.
3. `POST /api/execute/submissions` is **synchronous**, unlike `POST /api/execution/submissions`, because sync mode is detected by the substring `/execute/submit` in the URL.
4. The run budget (10 per minute) is **shared** between Run and `analyze-complexity`. The in-flight cap (2) is shared between Run and Submit.
5. `stats.tier` (computed) and `users.tier` / rankings `tier` (stored) can differ. New users show `"Prism I"` stored but `"Pulse II"` computed.
6. Poll responses lose per-test details after 30 minutes, after a restart, or on another instance. `rewardError` is always `false` in poll responses.
7. A synchronous submit that fails because of CodeBox leaves its row `PROCESSING` forever. Asynchronous failures are marked `ERROR`.
8. `PATCH /api/users/me/academic` stores `null` as the string `"null"`, while `PATCH /api/users/me` stores `""`.
9. `DELETE /api/social/:provider` returns `count` as an object: `{ "count": { "count": 1 } }`.
10. Study MCQ submission does not persist progress, and answers must be numbers.
11. Password change does not revoke existing tokens.
12. `GET /api/problems/:slug` → `templatesArray` exposes the judge driver (header/footer) code.
13. The JSON returned by `GET /` lists endpoints that are partly outdated.
14. `GET /api/problems` counts a problem as solved on any ACCEPTED submission with `totalCount > 0`. `GET /api/users/all` additionally requires `passedCount === totalCount`. Both conditions hold for every submission the judge marks ACCEPTED.
