# AGENTS.md: Calibr8 Backend

Repository knowledge for AI coding agents. Read this first, then open only the files a task needs. Verified against commit `31ee70c` plus the uncommitted 2026-11-27 security remediation, rounds 1 and 2 (see `SECURITY_REMEDIATION.md` and `SECURITY_REMEDIATION_ROUND2.md`, local files). If the code disagrees with this file, the code wins. Fix this file when that happens.

---

## 1. Project overview

Calibr8 is a coding-practice platform. Its features:
- DSA problems with judged Run and Submit;
- tiered verdicts;
- score, rating and tier;
- coins and a daily login reward;
- a daily problem with streaks;
- a theme store paid with coins;
- leaderboards;
- CS study material with MCQs;
- GitHub account linking.

| Concern | Technology |
|---|---|
| Runtime | Node.js 22, ES modules (`"type": "module"`), npm |
| HTTP | Express 5 (`req.body` is `undefined` when there is no body; the query parser is "simple") |
| Database | PostgreSQL on Neon, through Prisma Client 6.16 with driver adapters (`@prisma/adapter-neon` over WebSocket when the URL contains `neon.tech`, otherwise `@prisma/adapter-pg`) |
| Auth | Bearer JWT (HS256, `jsonwebtoken`), bcrypt (`bcryptjs`, cost 12) |
| Code execution | External **CodeBox** service (Judge0-compatible API plus `/batches`, isolate sandbox). It is the only execution engine: no code ever runs locally. |
| Other services | GitHub OAuth (linking only). `lib/storage.js` (Cloudflare R2) exists but is unused. |
| Scheduling | `node-cron` (IST timezone), `worker_threads` for the static complexity analyzer |

Sibling repositories in the parent folder, each with its own git repo:
- `../codebox`: the execution service. Express API, BullMQ/Redis queue, isolate worker, Docker Compose, Caddy.
- `../frontend`: React/Vite client. It keeps the JWT in `localStorage` (`../frontend/src/services/apiConfig.js`).

**CodeBox hosting (as of 2026-11-27):** the hosted CodeBox VPS was decommissioned. CodeBox now runs in Docker Desktop on the developer machine:
- defined by `../codebox/docker-compose.local.yml`, which binds the API to `127.0.0.1:2358`;
- isolate executor; the worker container is privileged, but its Node process runs as the unprivileged `codebox` user (`WORKER_USER`).

A hosted backend cannot reach it. Judging only works while that local stack is running. If Run or Submit returns `EXECUTION_UNAVAILABLE`, check `GET http://127.0.0.1:2358/health`. nodemon does not watch `.env`, so restart the backend after editing it.

To host CodeBox again, use `docker-compose.prod.yml`. It requires `DOMAIN` (HTTPS) and refuses weak tokens.

## 2. Repository structure

```
src/
  server.js            process entry: DB connect + topic upsert, listen, timers, graceful shutdown
  app.js               Express app: request id, security headers, CORS, body parsers, morgan, routes, errorHandler
  config/db.js         PrismaClient singleton (adapter choice by URL)
  config/jwt.js        secrets (fatal if short in production), JWT_EXPIRES_IN, SESSION_MAX_AGE_DAYS
  config/limits.js     ALL security/resource tunables: readLimit(name), defaults, bounds
  config/validateEnv.js startup validation (fatal for unsafe production settings, never prints secrets)
  config/mockDb.js     UNUSED (not imported anywhere)
  routers/*.router.js  one router per feature; index.router.js mounts them under /api/*
  controllers/*.js     request handlers; most business logic lives here
  services/            coinService, dailyProblemService (+cron), streakService (IST dates),
                       complexityAnalyzer.service (static analysis), complexityPool/Worker (worker threads),
                       passwordPool/passwordWorker (bcrypt in bounded worker threads)
  middlewares/         auth.middleware (protect, optionalAuth), rateLimit.middleware, error.middleware
  utils/               judge helpers (codeBuilder, codeboxClient, multiCaseHarness, outputComparator,
                       judgeAdmission, testcaseResults), rewards, jwt, bcrypt, tokenBlacklist,
                       validation, clientIp, problemResolver (problem + catalog caches), ApiError,
                       securityLog (redacted, flood-limited security events)
  profiling/           optional empirical complexity profiling (DB-backed job queue, CodeBox runs)
  data/                static catalogs (topics, store themes) upserted at startup or on demand
prisma/schema.prisma   data model; prisma/migrations/ = reference SQL (see §4); prisma/seed.js
prisma/sql/            owner-run SQL (least_privilege_runtime_role.sql: API role without DDL; not applied)
problems/*.json        bundled problem definitions (may differ from the DB, see §14)
study-material/        bundled study JSON (synced with scripts/upload-study.js)
scripts/               operator CLIs (uploads, seeding, daily-problem ops, benchmarks); lib/dbGuard.js
tests/                 node:test suites; helpers/dbCleanup.js; fixtures/
public/index.html      developer API console (served only in development/test or with SERVE_API_CONSOLE=true)
*.md                   API docs (APIdetails.md), execution docs, PRDs, previous audit, SECURITY_AUDIT.md
```

## 3. Application architecture

**Request lifecycle:**

```
server.js startup: enforceEnvironment() (config/validateEnv.js; unsafe production settings exit 1)
Client (Authorization: Bearer <jwt>)
 → app.js: X-Request-Id → security headers → CORS allow-list → apiLimiter (/api, per IP)
          → express.json/urlencoded (1 MB)
          → morgan (only status ≥ 400; path only, never bodies) → [static console if enabled]
 → routers/index.router.js → /api/<feature> router
 → protect | optionalAuth (middlewares/auth.middleware.js)
 → per-route limiter(s) (middlewares/rateLimit.middleware.js)
 → controller (validation inline + utils/validation.js) → services/utils
 → Prisma (config/db.js) and/or CodeBox (utils/codeboxClient.js)
 → JSON response | next(err) → middlewares/error.middleware.js
```

**Authentication flow.** `protect` does the following:
1. Reads the `Bearer` header.
2. Calls `verifyToken`, which accepts only HS256 with `iss=calibr8` and `aud=calibr8-api`, and requires `exp` (round 2).
3. Checks the revocation list (`revoked_tokens` by `jti`, fails closed) and loads the user, in parallel.
4. Rejects the token if the user is missing or if the token's `tv` claim differs from `users.tokenVersion`.
5. Sets `req.user` (a lean select), `req.token` and `req.auth = { decoded, tokenVersion }`.

`optionalAuth` does the same, but treats any failure as anonymous.

**Judging flow** (`controllers/execution.controller.js`):
1. `runCode` and `submitSolution` validate the language and the code size (≤ 64 KB).
2. `resolveProblem(slug)` loads the problem with all testcases and templates. It is cached for 60 s.
3. `buildFinalCode(problem, userCode, lang)` (`utils/codeBuilder.js`) wraps the user's function in the template's header and footer.
4. Submit only:
   - an identical asynchronous submission that is still being judged returns the existing one (`deduplicated: true`);
   - `assertSubmissionCapacity` caps a user's PROCESSING rows across instances (database count, `429 SUBMISSION_IN_PROGRESS`).
5. A **judge session** (`openJudgeSession` in `utils/judgeAdmission.js`, one per Run or Submit) admits the job. Round 2 replaced whole-evaluation slots:
   - opening checks the user's concurrent sessions (`JUDGE_MAX_SESSIONS_PER_USER`, `429 JUDGE_USER_BUSY`) and sandbox-time budget per window (`JUDGE_USER_BUDGET_MS`, smaller for accounts younger than `JUDGE_NEW_ACCOUNT_AGE_MS`; `429 EXECUTION_BUDGET_EXHAUSTED`);
   - `session.reserve()` waits for the first slot synchronously (`503 JUDGE_BUSY` after `JUDGE_QUEUE_TIMEOUT_MS`);
   - a **slot covers one CodeBox request** (one chunk). Every CodeBox call goes through `withExecutionSlot()`, which uses the current session from AsyncLocalStorage (`runWithJudgeSession`); outside a session it uses a one-off anonymous one;
   - waiting requests are served **lightest user first**: fewest running requests, then least recent sandbox time (decaying, `JUDGE_COST_HALF_LIFE_MS`; new accounts weigh `JUDGE_NEW_ACCOUNT_COST_WEIGHT` times more), then arrival. Later slots of a session wait up to `JUDGE_CONTINUATION_TIMEOUT_MS`;
   - every CodeBox request carries `X-Codebox-Tenant` (`codeboxTenantFor`: HMAC of the user id), so CodeBox enforces its per-user cap, budget and priority across all backend instances.
6. `executeCodeBatch` picks an execution path, in this order:
   - C/C++ uses the multi-case harness (`utils/multiCaseHarness.js`), only when `isHarnessSafeUserCode` allows it;
   - otherwise CodeBox `POST /batches` (long-poll), then `DELETE /batches/:id` once read;
   - otherwise legacy `/submissions/batch`.

   Chunks are run by `runInChunks`. With `stopOnTimeout`, nothing starts after a TLE. Large tiers start with a small chunk (`JUDGE_FIRST_CHUNK_CASES`); later chunks are sized from the observed per-case cost so one request stays near `JUDGE_TARGET_CHUNK_MS`. **Costs are sandbox time: per case max(CPU, wall)** (`sandboxCostMs`), because sleeping code uses wall time, not CPU (FV-1). With `failure` (`createFailureControl`), after the first failure only `JUDGE_POST_FAILURE_CPU_BUDGET_MS` more sandbox time is spent on the tier. The whole evaluation shares one budget (`createEvaluationBudget`, `JUDGE_EVALUATION_BUDGET_MS`); when it runs out nothing else starts. **Every CodeBox batch request carries a duration cap** (`max_duration_ms`): `JUDGE_BLIND_REQUEST_MAX_MS` while the session has run nothing yet (`requestDurationCapMs`), then 2 × `JUDGE_TARGET_CHUNK_MS`. CodeBox starts no testcase after the cap and returns the rest as skipped; `runInChunks` re-runs such cases in a later request. **A tier with unexecuted cases never passes** (Time Limit Exceeded; `budgetExceeded` when the evaluation budget ran out).
7. `judgeTestcase` decides each case's verdict:
   - an oversized output (`exceedsOutputLimit`) is Output Limit Exceeded;
   - otherwise `areOutputsEqual` (`utils/outputComparator.js`, linear-time) compares the output.
   - Verdicts are computed once per case (`verdictOf`), and long loops yield to the event loop.
8. Submit evaluates three tiers by position: 35%, then 70%, then the rest. Tiers short-circuit when one fails. The one-shot all-tiers batch is used only when cases × time limit is at most `JUDGE_ONE_SHOT_MAX_COST_MS` (30 s; lowering it changes `passedCount` after a TLE for mid-size problems). It is always a blind request (cap `JUDGE_BLIND_REQUEST_MAX_MS`); a one-shot that comes back with skipped cases is re-run per tier.
9. The verdict is persisted first. Then rewards (`utils/acceptedSubmissionReward.js`) and the daily-problem completion (`services/dailyProblemService.js`) run, and the solved count is recomputed.
10. Async submits return 202 and run in the background, tracked for graceful shutdown. Clients poll `GET /api/execution/submissions/:id` (owner only). Per-case results live only in an in-memory cache (30 min, byte-bounded), with hidden cases stripped by `publicTestResults`.

## 4. Database architecture

- **Connection:** `src/config/db.js` exports one `PrismaClient`. Raw SQL is always written as a `$queryRaw` tagged template.
- **Schema:** `prisma/schema.prisma`. Partial unique indexes are managed in SQL and are invisible to Prisma: `coin_transactions_daily_login_unique` and `coin_transactions_daily_problem_unique`.
- **Migrations:** the production Neon database was built with `prisma db push`. `prisma/migrations/` is historical and reference SQL (`migrations_backup/` is older still). **Never run `prisma migrate deploy` against Neon.** To change the schema:
  1. Write additive SQL.
  2. Run a drift check: `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`. Prisma ignores partial indexes in this diff.
  3. Apply with `npx prisma db execute --file <sql>`, only with owner approval.
- **Key tables:**
  - `users`: profile, rating, score, coins, streak, `tokenVersion`, `lastLoginISTDate`.
  - `submissions`: code, status, counts; `userId` nullable, cascade on delete.
  - `problems`, `testcases` (`isVisible`; hidden cases are never sent to clients), `code_templates` (JSON header/footer/userTemplate), `examples`.
  - `user_problem_progress`: PK `(userId, problemId)`, the first-solve gate.
  - `coin_transactions`: audit log, `istDate`.
  - `daily_problems`: one row per IST day, never updated; problem FK `RESTRICT`.
  - `daily_problem_completions`: PK `(userId, dailyProblemId)`.
  - `themes`, `user_themes` (unique `(userId, themeId)`), `revoked_tokens` (also stores OAuth link nonces as `oauth-nonce:<uuid>`), `social_accounts`, `topics`, `user_topics`, `dsa_topics`, `Study*`, `complexity_profiles` (row doubles as job record).
- **Transactions and idempotency conventions:**
  - Interactive `prisma.$transaction(async (tx) => …)`.
  - Idempotency through unique keys: `createMany({ skipDuplicates: true })` followed by "count === 0 means already done".
  - Conditional `updateMany` claims, for example a coin decrement guarded by `coins >= price`.
  - `SELECT … FOR UPDATE` on the user row before writing an absolute rating.
  - Balance changes use atomic `{ increment }`.

## 5. API architecture

- Everything is under `/api/<group>`. Groups: `auth`, `users`, `topics`, `onboarding`, `problems`, `execution` (alias `execute`), `social`, `study`, `themes`, `rankings`, `coins`, `daily-problem`.
- There is no versioning.
- Health endpoints: `/health` and `/api/health` (liveness), `/health/ready` (database and CodeBox).
- `GET /` returns the endpoint list.
- The full contract is in `APIdetails.md`; it may lag behind the code.
- **Success shape:** `{ success: true, ... }`. A few study endpoints return bare arrays or objects.
- **Error shape** (`middlewares/error.middleware.js`): `{ success: false, code, message, details? }`. Throw `new ApiError(status, message, CODE, details?)` from `utils/ApiError.js` and pass errors to `next(err)`. 5xx responses carry generic messages, and Prisma errors are logged as class and code only.
- **Validation:** inline checks plus `utils/validation.js` (`requireText`, `optionalText`, `requireEmail`, `queryString`, `FIELD_LIMITS`). There is no schema library. Guard `req.body ?? {}`.
- **Rate limiting:** in-memory and per instance. Available limiters:
  - `apiLimiter` (global, every `/api` request, per IP);
  - `authLimiter`, `registerLimiter`, `sessionLimiter`;
  - `runLimiter`, `submitLimiter`, `analyzeLimiter`, `inFlightLimiter`, `oauthCallbackLimiter`;
  - `createRateLimiter({ ..., name })` for custom ones.

  Every 429 emits a `rate_limited` security event. Client IPs come from `utils/clientIp.js` (IPv6 grouped per /64), which depends on `trust proxy` (`app.js`).
- **`apiLimiter` is identity-aware (round 2):** a request with a validly signed, unexpired session token (HMAC check only, no database) is budgeted per user (`API_USER_RATE_LIMIT_MAX`) plus a high per-IP ceiling (`API_AUTHENTICATED_IP_RATE_LIMIT_MAX`); everything else per IP (`API_RATE_LIMIT_MAX`). Submission polling has its own per-user `pollLimiter` (`POLL_RATE_LIMIT_MAX`); readiness probes have `healthLimiter`.
- **Readiness** (`utils/readiness.js`): single flight, result reused for `READINESS_CACHE_MS`; liveness `/health` has no dependencies.
- **Request logging** (`utils/logLimiter.js`): one morgan line per failed request (registered before the limiters), within `LOG_HTTP_4XX_MAX_PER_MINUTE` / `LOG_HTTP_5XX_MAX_PER_MINUTE` (checked before formatting; the rest summarized once a minute); request-derived text goes through `sanitizeLogText`. The error handler never logs 4xx itself; it sets `res.locals.errorCode` for the request line.
- **Error codes added by the remediation:** `JUDGE_USER_BUSY` (429), `SUBMISSION_IN_PROGRESS` (429), `AUTH_BUSY` (503), `INVALID_CREDENTIALS_FORMAT` (400), `TOO_MANY_TOPICS` (400), `REGISTER_RATE_LIMITED` (429); round 2: `EXECUTION_BUDGET_EXHAUSTED` (429, `details.retryAfterSeconds`), `TOO_MANY_PARAMETERS` (413). A Submit stopped by its evaluation budget is `TIME_LIMIT_EXCEEDED` with `firstFailure.budgetExceeded: true`.

## 6. Authentication and authorization

- **Tokens:**
  - Claims: `id`, `tv` (tokenVersion), `auth_time`, `jti`, `iat`, `exp`.
  - Issued by `signSessionToken` (`utils/jwt.js`). Lifetime `JWT_EXPIRES_IN` (default 1d).
  - `/api/auth/refresh` rotates the token and carries `auth_time` forward, up to `SESSION_MAX_AGE_DAYS` (default 30).
- **Revocation:**
  - logout revokes the current `jti` (`utils/tokenBlacklist.js`);
  - logout-all and change-password increment `users.tokenVersion`;
  - account deletion cascades.
- **Login protection:**
  - `authLimiter` (per IP) plus a per-(email, IP) lockout (`assertLoginAllowed`, `recordFailedLogin`; keys are a hash of the email);
  - oversized input (email over 254, password over 1024 bytes) is rejected before any work;
  - bcrypt runs in a bounded worker pool (`services/passwordPool.js`; `503 AUTH_BUSY` when saturated; after 5 worker crashes within 60 s it hashes in-thread);
  - unknown emails still cost one bcrypt compare (constant dummy hash in `utils/bcrypt.js`);
  - failed logins, lockouts, rejected tokens and session revocations are logged by `utils/securityLog.js` (no emails, passwords or tokens).
- **Authorization model:** there are no roles and no admin API. Every resource is scoped to `req.user.id`. Submission reads are owner-only and return 404 to other users. Administrative work happens only through `scripts/` with database credentials.
- **OAuth (GitHub):**
  1. `link-url` issues a state JWT signed with `OAUTH_STATE_SECRET` and bound to the user.
  2. `callback` (unauthenticated, rate-limited, each state usable once) exchanges the code and redirects to the frontend with a sealed AES-GCM `link_code`.
  3. `POST /complete` links the account, only for the same signed-in user, with a single-use nonce.
  GitHub access tokens are never stored.

## 7. Environment configuration

Names only; never put values here. `.env.example` lists most of them. In the Req. column, ✔ means required and "prod" means required in production.

| Variable | Req. | Purpose |
|---|---|---|
| `DATABASE_URL` | ✔ | PostgreSQL / Neon connection string (choice of adapter) |
| `JWT_SECRET`, `OAUTH_STATE_SECRET` | ✔ prod | HMAC keys. Must differ from each other. Minimum 32 characters in production (startup throws otherwise), 24 elsewhere; shorter values get a random per-process secret in development. |
| `JWT_EXPIRES_IN`, `SESSION_MAX_AGE_DAYS` | – | Token lifetime (default `1d`; unparsable or over 7d is fatal in production) and absolute session cap (default 30) |
| `NODE_ENV` | ✔ prod | `production` enables HSTS, trust proxy (default 1), strict secrets and strict CodeBox TLS. `development`/`test` enable localhost CORS and the API console. |
| `PORT` / `APP_PORT` | – | Listen port (default 3000) |
| `FRONTEND_URL` | ✔ | Comma-separated CORS allow-list; also the OAuth redirect target |
| `BACKEND_URL` | prod | Public base URL, used to build the OAuth `redirect_uri` (503 without it in production) |
| `TRUST_PROXY` | prod | Hop count, `true`/`false`, or an Express trust string. Must match the real proxy chain. |
| `CODEBOX_URL`, `CODEBOX_TOKEN` | ✔ | Execution service URL and `X-Auth-Token` |
| `CODEBOX_ALLOW_INSECURE_HTTP` | – | Allows `http://` to loopback (any environment) and to private addresses or Docker service names (outside production only). Plain HTTP to a public host is always refused. |
| Security/resource limits (`JUDGE_*`, `PASSWORD_HASH_*`, `API_RATE_LIMIT_*`, `REGISTER_RATE_LIMIT_*`, `OAUTH_CALLBACK_RATE_LIMIT_MAX`, `REQUEST_TIMEOUT_MS`, `CODEBOX_MAX_RESPONSE_BYTES`, `COMPLEXITY_WORKER_MAX_HEAP_MB`, `SECURITY_LOG_MAX_PER_MINUTE`) | – | Defaults and bounds live in `src/config/limits.js` (documented in `.env.example`). Out-of-range values are fatal in production. |
| `CODEBOX_BATCH_EXECUTION_ENABLED`, `CODEBOX_MULTICASE_ENABLED`, `CODEBOX_MULTICASE_MAX_CASES`, `CODEBOX_MAX_CONCURRENT_BATCHES`, `CODEBOX_BATCH_WAIT_MS`, `CODEBOX_BATCH_MAX_CASES`, `CODEBOX_MAX_CPU_TIME_LIMIT`, `CODEBOX_MAX_WALL_TIME_LIMIT` | – | Execution-path tuning |
| `JUDGE_MAX_CONCURRENT`, `JUDGE_MAX_QUEUE`, `JUDGE_QUEUE_TIMEOUT_MS` | – | Judge scheduler per instance: concurrent CodeBox requests, waiting first requests, first-slot wait (4 / 40 / 30000) |
| `COMPLEXITY_WORKERS`, `COMPLEXITY_TIMEOUT_MS`, `COMPLEXITY_MAX_QUEUE` | – | Static-analyzer worker pool |
| `COMPLEXITY_PROFILING_ENABLED` (+ `_CONCURRENCY`, `_MAX_INPUT_SIZE`, `_REPETITIONS`, `_TIMEOUT_MS`, `_MAX_PENDING`, `_MAX_ATTEMPTS`, `_CPU_LIMIT_SEC`, `_WALL_LIMIT_SEC`, `_PER_RUN_LIMIT_MS`, `_STOP_ABOVE_MS`, `_MEMORY_LIMIT_MB`) | – | Background empirical profiling; off by default |
| `PROBLEM_CACHE_TTL_MS`, `PROBLEM_CACHE_MAX_BYTES`, `CATALOG_CACHE_TTL_MS`, `CATALOG_STATS_CACHE_TTL_MS`, `SUBMISSION_CACHE_MAX_BYTES` | – | In-memory cache tuning |
| `ENABLE_CRON_JOBS` | – | Set to `false` on all replicas except one |
| `SERVE_API_CONSOLE` | – | `true` serves `public/` in production too; `false` never serves it |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | for linking | GitHub OAuth app |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | – | Unused R2 client (`lib/storage.js`) |
| `TEST_DATABASE_NAME` | – | `scripts/test-isolated.mjs` (must end in `_test`) |
| `LEADERBOARD_REGIONAL_FIELDS` | – | Regional fields shown in other users' leaderboard rows: `all` (default), `none`, or a list (SA-L10 is a product decision) |
| Round-2 limits (`JUDGE_MAX_SESSIONS_PER_USER`, `JUDGE_CONTINUATION_TIMEOUT_MS`, `JUDGE_COST_HALF_LIFE_MS`, `JUDGE_USER_BUDGET_*`, `JUDGE_NEW_ACCOUNT_*`, `JUDGE_EVALUATION_BUDGET_MS`, `JUDGE_TARGET_CHUNK_MS`, `JUDGE_BLIND_REQUEST_MAX_MS`, `API_USER_RATE_LIMIT_MAX`, `API_AUTHENTICATED_IP_RATE_LIMIT_MAX`, `POLL_RATE_LIMIT_MAX`, `READINESS_CACHE_MS`, `HEALTH_RATE_LIMIT_MAX`, `LOG_HTTP_*_MAX_PER_MINUTE`) | – | `src/config/limits.js`, documented in `.env.example` |

## 8. Important business logic

| Workflow | Where |
|---|---|
| Register / login / refresh / logout / change password / delete account | `src/controllers/auth.controller.js` (routes in `auth.router.js`, `user.router.js`) |
| Daily login coin (+1, once per IST day) | `src/services/coinService.js` `grantDailyLoginReward` (called by register, login, `/me`, refresh) |
| Run / submit / tiered judging / submission polling | `src/controllers/execution.controller.js` (also mounted in `problem.router.js`) |
| User code → executable source | `src/utils/codeBuilder.js` `buildFinalCode`, plus templates in the DB (`code_templates`) |
| C/C++ multi-case harness and its safety gate | `src/utils/multiCaseHarness.js` |
| Output comparison | `src/utils/outputComparator.js` (exact BigInt integers; `[x]` equals `x`; case-insensitive `true`/`false`) |
| First-solve reward (score = points × 10, Elo-style rating, tier) | `src/utils/acceptedSubmissionReward.js`; tiers in `src/utils/userHeaderStats.js` |
| Daily problem (selection, cron, completion +2 coins, streak) | `src/services/dailyProblemService.js`, `src/services/streakService.js`, `scripts/dailyProblem.js` |
| Theme store (buy and apply with coins) | `src/controllers/theme.controller.js`, `coinService.debitThemePurchase`, `src/data/storeThemes.js` |
| Onboarding calibration (seeds the rating only before the first solve) | `src/controllers/onboarding.controller.js` |
| Leaderboard (guests get a minimal view; signed-in users get regional fields and scopes) | `src/controllers/ranking.controller.js` |
| Problem catalog, solve status, caches | `src/utils/problemResolver.js`, `src/controllers/problem.controller.js`, `src/controllers/topic.controller.js` |
| Study material and MCQ grading (not persisted) | `src/controllers/study.controller.js`, `scripts/upload-study.js` |
| GitHub linking | `src/controllers/social.controller.js` |
| Complexity analysis (static, worker pool) / profiling (CodeBox, DB queue) | `src/services/complexity*.js` / `src/profiling/*` |

## 9. Testing

- **Framework:** built-in `node:test` with `node:assert/strict`. Files are `tests/*.test.js` plus `tests/codeboxComparison.e2e.js`.
- **`npm test` uses the real `.env` `DATABASE_URL` (the production Neon database) and `CODEBOX_URL` (currently the local Docker CodeBox), by owner decision.** Do not add test-database overrides or guards that block it. Rules for any test that writes to the database:
  - tag everything it creates with a per-run id (`RUN_TAG`, a per-run far-future `TEST_YEAR` for daily problems);
  - delete only its own rows (`tests/helpers/dbCleanup.js`);
  - never clean up by a bare prefix, a fixed id or a fixed date;
  - keep CodeBox traffic small, and do not retry on `EXECUTION_UNAVAILABLE`;
  - before a run, make sure no other test run is active.
- **Isolated alternative:** `npm run test:isolated -- --setup`, then `npm run test:isolated [files]`. It uses a separate `<db>_test` database on the server named in `DATABASE_URL`, and sends unmocked CodeBox calls to an unreachable host.
- **Fully local runs (how the 2026-11-27 remediation was verified):**
  1. Start a throwaway Postgres: `docker run -d -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=… postgres:16-alpine`.
  2. Export `DATABASE_URL` pointing at it. Environment variables override `.env`, and dotenv never overwrites them.
  3. Run `node scripts/test-isolated.mjs --setup` to create and seed `<db>_test`.
  4. Run `node --test --test-concurrency=1 tests/*.test.js tests/*.e2e.js` with `DATABASE_URL` set to that `_test` database.
  5. Optionally set `CODEBOX_URL`, `CODEBOX_TOKEN` and `CODEBOX_ALLOW_INSECURE_HTTP=true` for a loopback CodeBox.

  This changes nothing in the repository defaults.
- **Remediation regression tests:**
  - `remediationJudge` (comparator, admission, judging cost; no database);
  - `remediationPlatform` (transport policy, password pool, login bounds, OAuth state, startup validation, security log; no database writes);
  - `remediationApiLimit` (global limiter);
  - `remediationPasswordPool` (password-pool circuit breaker; no database);
  - `remediationSubmissionLimits` (database writes, RUN_TAG-tagged);
  - round 2: `remediationRound2Judge` (wall-time accounting, evaluation budget, scheduler fairness, tenant header; CodeBox mocked) and `remediationRound2Platform` (identity-aware limits, campus NAT, polling, readiness, log flood, FV-7/FV-9, leaderboard switch).
- **Real-sandbox attack tests (opt-in; never against a CodeBox other people use):** `tests/judgeDos.e2e.js` skips unless `JUDGE_DOS_E2E=1`, a loopback `CODEBOX_URL` and `JUDGE_DOS_WORKER=<worker container>` are set; `JUDGE_DOS_DISRUPT=1` with `JUDGE_DOS_REDIS` also stops Redis and kills the worker. CodeBox has its own suite, `../codebox/tests/e2e/sandbox.e2e.test.js` (`CODEBOX_E2E_URL`, `CODEBOX_E2E_TOKEN`, `CODEBOX_E2E_WORKER`, optionally `CODEBOX_E2E_DISRUPT=1` with `CODEBOX_E2E_REDIS`). Run both against a separate compose project with its own isolate `cg_root` (see `SECURITY_REMEDIATION_ROUND2.md`).
- **Suites that need neither the database nor CodeBox** (verified):
  - `unitUtilities`, `complexityAnalyzer`, `streakService`, `dailyProblemSelection`, `testcaseResults`, `problemSolvedCount`, `multiCaseHarness`, `securityHardening`;
  - `judgingVerdicts` (mocks `fetch`).
  - Run them with `node --test tests/<name>.test.js`.
  - Note: `npm run test:unit` also includes `cors` and `securityAndMiddleware`, which import the app; `cors` performs a real login lookup.
- **Single suite:** `node --test tests/<file>.test.js`, or one of the `npm run test:<name>` shortcuts in `package.json`.

## 10. Development commands (from `package.json`)

| Task | Command |
|---|---|
| Install (runs `prisma generate` on postinstall) | `npm install` |
| Development server (nodemon) | `npm run dev` |
| Production start | `npm start` (`node src/server.js`) |
| Tests | `npm test` (see §9), `npm run test:unit`, `npm run test:integration`, `npm run test:coverage`, `npm run test:isolated` |
| "Lint" (syntax check only, `node --check` over `src/` and `tests/`; there is no ESLint) | `npm run lint` |
| Build (no-op) | `npm run build` |
| Prisma client | `npm run prisma:generate` |
| Schema push (**writes the `.env` database; owner approval required**) | `npm run db:push` |
| Seed topics and themes (upsert) | `npm run seed` / `npm run db:seed` |
| Problems / study upload | `node scripts/upload-problem.js <path> [--update \| --testcases-only]`, `npm run problems:seed`, `npm run study:sync` |
| Daily-problem operations | `npm run daily:status`, `npm run daily:ensure`, `node scripts/dailyProblem.js prune-future [--apply]` |
| Solved-count resync | `npm run problems:sync-solved-counts` |
| Local CodeBox (Docker Desktop) | `docker compose -f ../codebox/docker-compose.local.yml up -d --build` (API on `127.0.0.1:2358`). `scripts/devStack.js` is untracked work in progress from another session; the `npm run up`/`down` scripts it mentions do not exist in `package.json`. |

Destructive scripts (`reset-and-upload`, `bulk-push`, `seedProblems --update`, `seedRanking`) refuse a remote database unless given `--confirm=<host>` (`scripts/lib/dbGuard.js`). No migration-deploy, Docker or CI pipeline exists in this repository.

## 11. Important architectural decisions

- **CodeBox is the only execution engine.** If it is unavailable, the API answers 503 `EXECUTION_UNAVAILABLE`, and judging never falls back to local execution. Its Redis keeps payloads, so keep requests small. Harness submissions are deleted after reading.
- **Verdicts are never guessed.** Only infrastructure errors fall through to the next execution path. Hidden-case data never leaves the server.
- **In-process state:** limits, caches, judge admission and OAuth nonces exist per instance. Scheduled jobs are idempotent, so several instances are safe; set `ENABLE_CRON_JOBS=false` on all but one.
- **Day boundaries use IST** (`Asia/Kolkata`, via `streakService.js`). Daily-problem rows are never updated after creation.
- **Rewards derive only from a persisted ACCEPTED verdict,** and only on the first solve.
- **Bearer tokens, no cookies,** so CSRF protection is not needed. CORS uses an exact-origin allow-list.
- **Schema is managed with `db push` plus additive SQL** (§4).
- **Tunables are centralised** in `src/config/limits.js`. Read them with `readLimit(name)`; never parse `process.env` ad hoc for a limit. `src/config/validateEnv.js` validates them at startup.
- **Judge fairness over raw throughput:** capacity is scheduled per CodeBox request, lightest user first; every evaluation has a total sandbox-time budget; costs count wall time. Slow or sleeping code is cut off (post-failure budget, evaluation budget), and it can hold a slot only for one bounded chunk. Fast failures are still judged across the whole tier, so `passedCount` keeps its meaning.
- **CodeBox owns the sandbox boundary** (isolate: no network, per-box uid and cgroup). Its static source filter is not a security boundary; trivial run-time path building bypasses it.

## 12. Security rules (must be preserved)

- Derive ownership only from `req.user.id`. Never accept a user id, a role, or a score, coin or rating value from the client.
- Every new route that reads or writes user data uses `protect`. Every new route that runs code, or does expensive work, also needs a limiter and must stay authenticated.
- Never weaken `protect`: the user must exist, `tokenVersion` must match, revocation fails closed, and HS256/`iss`/`aud` are pinned.
- SQL goes through Prisma methods or `$queryRaw` tagged templates. Never use `$queryRawUnsafe`, and never concatenate strings into SQL.
- Never expose hidden testcases, template header/footer, `passwordHash` or `tokenVersion`. Use `publicTestResults` and the existing `select` lists.
- Reward, coin and streak writes stay inside transactions with their idempotency keys and conditional updates. Never use read-modify-write on balances.
- Never measure judging cost in CPU time alone: use `sandboxCostMs` (max of CPU and wall per case). Never hold a judge slot across more than one CodeBox request; new CodeBox calls go through `withExecutionSlot()` inside a judge session.
- Keep CPU-heavy work off the event loop. Anything that processes user-controlled text (comparator, analyzer, regexes) must be linear or run in a bounded worker. Bound every user-controlled size before using it. Program output is compared only through `judgeTestcase` (size limit first). Password hashing goes only through `utils/bcrypt.js` (worker pool).
- Never write a regex in which two quantifiers can match the same characters (`\d+\.?\d*`, `(a+)+`, `.*.*`) when it is applied to user input. Add a 64 KB adversarial timing test with it.
- CodeBox calls go only through `utils/codeboxClient.js`, which enforces TLS or loopback and bounded responses. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- In `../codebox`, root-owned code must never follow paths that sandboxed code can influence. Use `readBoxFile` / `writeBoxFile` / `assertNoLinks` (`src/executor/IsolateExecutor.js`). Authenticate before parsing bodies or spending rate-limit budget (`src/api/server.js`).
- Security events go through `utils/securityLog.js`, which drops credential-like fields. Never log emails, passwords, tokens, code or testcase input.
- Validate input at the server boundary. Do not relax validation to make a test pass.
- Never log request bodies, code, tokens or Prisma error messages. Never print or commit secrets, and do not add values to `.env.example`.
- Do not run destructive scripts, `db:push`, or raw SQL against the `.env` database without explicit owner approval. Do not commit `SECURITY_AUDIT.md` or other audit material to a public repository.

## 13. Important files reference

| Task | Files to inspect |
|---|---|
| Add an API endpoint | `src/routers/<feature>.router.js`, `src/routers/index.router.js`, `src/controllers/<feature>.controller.js`, `src/middlewares/*`, `src/utils/validation.js`, `APIdetails.md` |
| Modify authentication / sessions | `src/controllers/auth.controller.js`, `src/middlewares/auth.middleware.js`, `src/utils/jwt.js`, `src/config/jwt.js`, `src/utils/tokenBlacklist.js`, `src/utils/bcrypt.js`, `src/middlewares/rateLimit.middleware.js` |
| Modify authorization | Ownership checks inside controllers (no central RBAC); `protect` / `optionalAuth` in routers |
| Change the database schema | `prisma/schema.prisma`, additive SQL (see §4), `prisma/migrations/` (reference), `tests/helpers/dbCleanup.js` |
| Judging / execution | `src/controllers/execution.controller.js` (`judgeTestcase`, `runInChunks`, `createFailureControl`, `assertSubmissionCapacity`), `src/utils/codeBuilder.js`, `src/utils/codeboxClient.js`, `src/utils/multiCaseHarness.js`, `src/utils/outputComparator.js`, `src/utils/judgeAdmission.js`, `CODE_EXECUTION_SYSTEM_DOCUMENTATION.md`, `../codebox/src/` |
| Limits / configuration validation | `src/config/limits.js`, `src/config/validateEnv.js`, `.env.example` |
| CodeBox security (auth, budgets, sandbox files) | `../codebox/src/api/server.js`, `../codebox/src/api/middleware/{auth,rateLimit,errorHandler}.js`, `../codebox/src/executor/IsolateExecutor.js`, `../codebox/docker/worker/{Dockerfile,entrypoint.sh}`, `../codebox/docker-compose.*.yml`, `../codebox/Caddyfile`, `../codebox/tests/security.test.js` |
| Rewards / coins / daily problem | `src/utils/acceptedSubmissionReward.js`, `src/services/coinService.js`, `src/services/dailyProblemService.js`, `src/services/streakService.js`, `README_COIN.md` |
| Problems / catalog / uploads | `src/utils/problemResolver.js`, `src/controllers/problem.controller.js`, `scripts/upload-problem.js`, `problems/*.json` |
| Add tests | `tests/*.test.js` (follow `RUN_TAG` tagging), `tests/helpers/dbCleanup.js`, `package.json` scripts |
| Configuration / startup / shutdown | `src/server.js`, `src/app.js`, `src/config/*`, `.env.example` |
| Security posture / open issues | `SECURITY_AUDIT.md` (Appendices B and C: status per finding), `SECURITY_REMEDIATION.md`, `FINAL_SECURITY_VERIFICATION.md`, `SECURITY_REMEDIATION_ROUND2.md` (all local, git-ignored); `BACKEND_PRODUCTION_AUDIT.md` (previous audit, §15 status) |

## 14. Known issues and technical debt

See `SECURITY_AUDIT.md` Appendices B and C (status of every finding) and `SECURITY_REMEDIATION_ROUND2.md` §10 (owner actions, residual risks). After the 2026-11-27 remediation (rounds 1 and 2, uncommitted), what remains is:
- **Owner actions:**
  - rotate the credentials kept in `.env` notes (SA-H6);
  - check hosted environments for the released CodeBox IP (SA-H3);
  - all three GitHub repositories are **public** and expose the previous audit (SA-M7);
  - set `NODE_ENV`/`TRUST_PROXY`/`JWT_EXPIRES_IN=1d` on the host (SA-M3, SA-L3);
  - apply `prisma/sql/least_privilege_runtime_role.sql` and confirm PITR (SA-M5).
- **Residual design risks:**
  - many free accounts each still get a bounded share of judge capacity (SA-M4: email verification or CAPTCHA is a product decision);
  - a slow but correct submission costs at most `JUDGE_EVALUATION_BUDGET_MS` of sandbox time, then is judged Time Limit Exceeded;
  - rate limits, OAuth nonces and the backend scheduler are per instance; the per-user cap, budget and priority are cross-instance only inside CodeBox (SA-I7);
  - tokens are in frontend `localStorage` (SA-L3).
- **CodeBox:** no production host. Re-host only with `docker-compose.prod.yml` (TLS, firewall, new token), size it for the expected load, and set `JUDGE_MAX_CONCURRENT` to match. The local stack's default token is public: set `CODEBOX_LOCAL_TOKEN` (and the backend's `CODEBOX_TOKEN`) to a private value.
- **Dependencies:** the Prisma CLI chain needs a major upgrade (with the 6.16/7.10 alignment) on staging.
- **Debt:**
  - `src/config/mockDb.js` and `lib/storage.js` are unused;
  - `@prisma/client` 6.16 is paired with adapters 7.10;
  - `walkthrough.md` describes a migration that does not exist;
  - `problems/*.json` is not an exact mirror of the DB (use `upload-problem.js --testcases-only` when only testcases change, and compare field by field before `--update`);
  - `daily_problems` history contains inconsistencies from earlier test runs, plus pre-seeded future rows. Do not "repair" production rows without owner approval.

## 15. Instructions for future AI agents

- Read AGENTS.md before beginning any repository-related task.
- Do not scan the entire repository by default.
- Use the file references in this document to locate relevant implementation files.
- Inspect only the files necessary for the requested task.
- Follow the actual architecture and existing coding conventions.
- Before modifying anything, understand its dependencies and side effects.
- Do not assume that documentation is more accurate than the implementation.
- If the task involves an undocumented area, inspect the relevant source files and update AGENTS.md with verified knowledge.
- Update AGENTS.md whenever meaningful architectural changes are made.
- Never store secrets or sensitive user information in AGENTS.md.
- Do not repeatedly reread unrelated files.
- Do not blindly trust outdated documentation.
