# Backend Production Security & Reliability Audit

**System:** Calibr8 backend (`calibr8-backend` 1.0.0, Node.js 22, Express 5.3, Prisma 6.16 on Neon PostgreSQL)
**Audit date:** 2026-11-23
**Type:** Read-only static review plus safe local dynamic checks. No code, configuration, database or external service was changed. This file is the only file added to the repository.
**Scope:** `backend/` (all of `src/`, `prisma/`, `scripts/`, `tests/`, `public/`, `lib/`, package manifests, environment templates, git history). CodeBox (`../codebox`) was inspected only where it touches the backend: deployment exposure, rate limit, Redis and output limits.

> **Handle this report as confidential.** It describes exploitable weaknesses. Do not commit it to a public repository. No secret values are reproduced in it; secrets are referred to by name only.

---

## 1. Executive Summary

### Overall assessment

The core authorization model is sound:
- Every per-user resource is scoped to `req.user.id`.
- Reading someone else's submission returns 404.
- Raw SQL is parameterized.
- Coin and reward writes are protected by atomic updates and unique constraints.

The weaknesses cluster in availability, environment hygiene and the code-execution boundary:

- **Unauthenticated denial of service.** One anonymous HTTP request to the static complexity analyzer freezes the whole Node.js process for about 55 seconds (measured locally). The allowed rate of 10 requests per minute per IP is enough for one person to keep the API down.
- **No separation between development and production.** The local `.env`, the test suite and the admin scripts all point at the production Neon database and the production CodeBox judge. This has already corrupted live data (daily-problem history, Nov 15–22, 2026). One script truncates the problem and submission tables with no confirmation.
- **The shared judge can be exhausted by a single user.** Execution is reachable anonymously. Request and output sizes are not budgeted. CodeBox keeps payloads in a 256 MB Redis with no eviction. A single client can make judging fail for everyone.
- **Credentials handled insecurely.**
  - The backend sends its CodeBox token and all user source code over plain HTTP to a public IP address.
  - The `.env` file holds production credentials plus a plaintext hosting-provider password, inside a cloud-synced folder.

### Findings by severity

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 5 |
| MEDIUM | 11 |
| LOW | 10 |
| INFO | 4 |
| **Total** | **30** |

### Most critical risks

1. **[H1]** Event-loop denial of service through `POST /api/execution/analyze-complexity`. Confirmed dynamically.
2. **[H2]** Tests, scripts and local development operate directly on the production database and judge. Confirmed; past data loss.
3. **[H3]** No backend-wide admission control or byte budgets for the shared CodeBox judge. Likely.
4. **[H4]** CodeBox token and user code sent in cleartext. Confirmed in configuration.
5. **[H5]** Plaintext production secrets and a hosting password in a cloud-synced `.env`. Confirmed.

### Production readiness

**NOT PRODUCTION READY.** All five HIGH findings are well-bounded and fixable. See §13 for the order of work and §14 for the reasoning.

---

## 2. Architecture Overview

### Components

| Component | Implementation |
|---|---|
| HTTP API | Express 5.3 (ESM), `src/app.js`; entry point `src/server.js` listens on `0.0.0.0:$PORT` |
| Persistence | Prisma Client 6.16.1. `@prisma/adapter-neon` (WebSocket) when the URL contains `neon.tech`, otherwise `@prisma/adapter-pg` (`src/config/db.js`). 20 models (`prisma/schema.prisma`). The Neon schema was created with `prisma db push`, not migrations. |
| Code execution | External **CodeBox** service (Judge0-compatible API) on a separate VPS, reached through `src/utils/codeboxClient.js` with a static `X-Auth-Token`. CodeBox stack: Caddy, API, privileged isolate worker, Redis (256 MB, `noeviction`), Prometheus, Grafana. |
| Judging paths | C/C++: multi-case fork harness (`src/utils/multiCaseHarness.js`). Other languages: the CodeBox batch API, or legacy per-testcase submissions. Tiered short-circuit evaluation (35% / 70% / 100%) is in `src/controllers/execution.controller.js`. |
| Static analysis | `src/services/complexityAnalyzer.service.js`: 1,779 lines, regex and `@babel/parser` based, runs on the request thread. |
| Auth | HS256 JWT (`jsonwebtoken` 9.0.3) as a Bearer header. bcryptjs (cost 10). Revocation list in Postgres plus in-process cache. GitHub OAuth account linking. |
| Gamification | Coins, streaks, daily problem (`coinService.js`, `dailyProblemService.js`, `streakService.js`), themes store, Elo-like rating (`acceptedSubmissionReward.js`). |
| Background work | In-process only: node-cron daily-problem scheduler (hourly, plus 00:05 IST streak reset), hourly revoked-token purge, cache sweepers, Postgres-backed complexity-profiling queue (disabled by default), and detached submission evaluation for asynchronous submits. |
| Static UI | `public/index.html`, a 189 KB API explorer served at `/`. |

### Request lifecycle

```
Client
  → custom security-header middleware (CSP, nosniff, Referrer-Policy)
  → cors (allow-list from FRONTEND_URL; requests without an Origin are allowed)
  → express.json / urlencoded (1 MB)
  → morgan (logs only status ≥ 400, path only, no bodies)
  → express.static(public)
  → index.router  → /api/<group> router
      → protect | optionalAuth   (JWT verify → revocation check ∥ user lookup)
      → per-instance in-memory rate limiters / in-flight limiter (execution routes)
      → controller → service/util → Prisma (Neon) | CodeBox (HTTP) | GitHub (HTTPS)
  → errorHandler (uniform JSON; hides messages for 5xx)
```

### External dependencies

- Neon PostgreSQL (TLS, `sslmode=require`)
- CodeBox VPS (HTTP; see H4)
- GitHub OAuth and REST API (HTTPS, 10 s timeouts)
- Cloudflare R2 client defined in `lib/storage.js`, never imported (unused)

---

## 3. Critical and High-Severity Findings

There are no CRITICAL findings.

### [H1] Anonymous request freezes the entire API (event-loop blocking in the complexity analyzer)

- **Severity:** HIGH
- **Confidence:** Confirmed (reproduced locally)
- **Category:** Denial of service / resource exhaustion
- **Affected files:**
  - `src/routers/execution.router.js`
  - `src/controllers/execution.controller.js`
  - `src/services/complexityAnalyzer.service.js`
  - `src/app.js`
- **Relevant line numbers:**
  - `execution.router.js:36` (route uses `optionalAuth, runLimiter`)
  - `execution.controller.js:2049-2074` (no size check)
  - `execution.controller.js:1267` and `1800-1812` (analyzer also runs on every run and submit)
  - `complexityAnalyzer.service.js:8` (`MAX_CODE_LENGTH = 200_000`), `1602-1628`, `1658`
  - `app.js:66` (1 MB body limit)
- **Description:** `analyzeComplexity()` is CPU-bound and runs synchronously on the main event loop, even though it is declared `async`. Its cost grows roughly quadratically with input size. The only cap is 200,000 characters. The endpoint accepts anonymous callers, and anonymous callers are rate-limited only per IP, to 10 requests per minute per instance. While the analyzer runs, the process cannot serve any other request: auth, judging callbacks, health checks, all of it.
- **Technical evidence (local measurements, Node 22, this machine):**

  | Input (language) | Size | Blocking time |
  |---|---|---|
  | `[` repeated (javascript) | 16 KB / 32 KB / 64 KB | 487 ms / 1,791 ms / 6,169 ms |
  | `[` repeated (javascript) | 199 KB | **54,903 ms** |
  | `"\` repeated (cpp) | 199 KB | 13,257 ms |
  | `def f(n): for …: f(n-1)` (python) | 199 KB | 11,911 ms |

  End to end, the Express app was started locally with a dummy database URL and no CodeBox. One anonymous 64 KB `POST /api/execution/analyze-complexity` took 12,071 ms. A `GET /health` sent from a separate process during that request waited **12,021 ms**.
- **Reproduction scenario:** Send `POST /api/execution/analyze-complexity` with body `{"code": "<199,000 × '['>", "language": "javascript"}` and no token. Repeat 10 times per minute from one IP, or from several IPs, or rotate IPv6 addresses (see M3).
- **Potential impact:**
  - Complete, sustained outage of every API endpoint for all users.
  - Load balancers may mark the instance unhealthy and restart it.
  - In-flight asynchronous submissions are then lost (M9).
  - Authenticated users can do the same through run and submit, at 6–12 s per request with 64 KB of code.
- **Recommended remediation:**
  - Require authentication on `/analyze-complexity`.
  - Cap analyzer input at the submission limit (64 KB) or lower.
  - Run the analyzer in a `worker_threads` pool with a hard per-job timeout and a bounded queue.
  - Fix the super-linear paths, starting with deep bracket nesting through `buildAstIR` and string-escape scanning.
  - Treat a timeout as an "unknown" result instead of retrying.
  - Give the endpoint its own stricter limiter.

### [H2] Development, tests and admin scripts operate directly on the production database and judge

- **Severity:** HIGH
- **Confidence:** Confirmed (configuration, code and a prior incident)
- **Category:** Operational security / data integrity
- **Affected files:**
  - `.env` (untracked)
  - `package.json`
  - `tests/*.test.js`
  - `scripts/reset-and-upload.js`, `scripts/upload-problem.js`, `scripts/seedProblems.js`, `scripts/bulk-push.js`, `scripts/seedRanking.js`
- **Relevant line numbers:**
  - `package.json:12` (`"test": "node --test … tests/*.test.js"`)
  - `scripts/reset-and-upload.js:9-19` (`TRUNCATE TABLE "problems", "examples", "testcases", "code_templates", "submissions" RESTART IDENTITY CASCADE`, falling back to `DELETE FROM …`)
  - `scripts/seedRanking.js:24-39` (creates `rank{i}@test.com` users with the placeholder hash `"$2a$10$seed"`)
- **Description:**
  - The local `DATABASE_URL` points to the Neon production host (TLS, `sslmode=require`), and `CODEBOX_URL` points to the production CodeBox VPS.
  - 24 test files import the Prisma client or the app and create or delete real rows. Only `tests/dailyProblemSelection.test.js` forces a safe database URL.
  - None of the destructive scripts check which database they are connected to. The exception is `scripts/dailyProblem.js prune-future`, which is a dry run unless `--apply` is given.
  - `TRUNCATE … CASCADE` also empties every table with a foreign key to the truncated ones, regardless of `ON DELETE RESTRICT`: `daily_problems`, `daily_problem_completions`, `user_problem_progress`, `complexity_profiles`.
- **Technical evidence:**
  - The `.env` scheme and host were checked without printing values.
  - Daily-problem history in production for 2026-11-15 to 2026-11-22 was overwritten and re-created by older versions of the daily-problem tests. User completions were cascade-deleted while their coin transactions remained (found earlier in this engagement).
  - Team notes record that on 2026-11-20 test traffic against the real CodeBox filled its Redis and broke judging.
- **Reproduction scenario:** A developer runs `npm test`, `npm run test:integration` or `node scripts/reset-and-upload.js` with the standard `.env`.
- **Potential impact:**
  - Irreversible loss of all problems, submissions, solve progress and daily-problem history.
  - Corrupted leaderboards: fake `rank*@test.com` users on the public ranking.
  - Production judge outages caused by test traffic.
- **Recommended remediation:**
  - Use a separate Neon branch or database for development and tests, and a separate CodeBox instance or a mock.
  - Make every test and script refuse to run when the URL matches the production host, unless an explicit override flag is given.
  - Make destructive scripts dry-run by default.
  - Store production credentials only in the deployment platform's secret store.
  - Confirm point-in-time recovery is enabled before any further maintenance (see the §12 backups row).

### [H3] Shared CodeBox judge can be exhausted by one client: anonymous execution, no byte budgets, no global admission control

- **Severity:** HIGH
- **Confidence:** Likely. Supported by code, CodeBox configuration and a prior incident. Not reproduced against production, by design.
- **Category:** Availability / resource exhaustion / business-logic abuse
- **Affected files:**
  - `src/routers/problem.router.js`
  - `src/controllers/execution.controller.js`
  - `src/middlewares/rateLimit.middleware.js`
  - CodeBox: `docker-compose.prod.yml`, `src/executor/IsolateExecutor.js` (boundary only)
- **Relevant line numbers:**
  - `problem.router.js:32` and `35-41` (`optionalAuth` on `/:slug/run` and `/:slug/submit`)
  - `execution.controller.js:1547` (`userId = req.user?.id || null`)
  - `execution.controller.js:1621-1629` (database errors swallowed for anonymous users)
  - `execution.controller.js:1641-1645` (`wait: true` returns synchronous results to anyone)
  - `execution.controller.js:1132-1178` (custom `stdin` with no size check beyond the 1 MB body)
  - `execution.controller.js:41-65` and `1861` (submission cache: 2,000 entries, 30 min, no byte cap, stores every case's `input`, `expected`, `actual` and `errorText`, including hidden cases)
  - CodeBox `IsolateExecutor.js:14` (`MAX_OUTPUT_CHARS = 65536` per stream)
  - CodeBox `docker-compose.prod.yml:36` (`RATE_LIMIT_MAX_REQUESTS` default 200 for the whole backend client) and `:92` (`--maxmemory 256mb --maxmemory-policy noeviction`)
- **Description:** Full judging, including hidden testcases, is available without an account through `/api/problems/:slug/submit` with `{"wait": true}`. Limits exist only per user or IP and per process (M3). Nothing bounds the total data a request makes CodeBox store:
  - **Input:** custom-input runs accept about 1 MB of `stdin`.
  - **Output:** each testcase may return up to 64 K characters of stdout and 64 K of stderr. On a 200-case problem judged through the batch path (Python, Java, JS), wrong-answer cases do not stop the batch. A submission that prints maximum output per case can return about 25 MB. CodeBox keeps request payloads and results in Redis for about 1 hour under `noeviction`. The backend keeps the same results in its own unbounded-byte submission cache.
  - **Request budget:** CodeBox allows the whole backend 200 requests per window. A 500-case Python submission costs about 25 CodeBox requests, so one account at 6 submissions per minute can consume about 150 of them.
- **Technical evidence:**
  - The code paths and CodeBox limits are cited above.
  - Team incident notes from 2026-11-20: about 15 requests of 2.7 MB filled CodeBox Redis. Later requests over about 150 KB failed with HTTP 500 and worker jobs could not write results, so submissions stayed "processing".
- **Reproduction scenario (do not run against production):**
  1. An anonymous or newly registered user submits Python code that prints 64 KB per testcase to a problem with many testcases, 6 times per minute, from a few IPs or accounts.
  2. Alternatively, a signed-in user sends custom runs with 1 MB `stdin` 10 times per minute.
- **Potential impact:**
  - CodeBox Redis fills, or the shared request budget runs out. Every user's run and submit then fails with `EXECUTION_UNAVAILABLE` for up to an hour.
  - Backend heap grows by tens of MB per such submission. At 2,000 cache entries this can exhaust memory and crash the process.
  - Anonymous submissions also create rows with a null user, consuming storage.
- **Recommended remediation:**
  - Require authentication for every execution route.
  - Add a backend-wide concurrency semaphore or a durable queue in front of CodeBox, sized to CodeBox capacity.
  - Enforce byte budgets: custom `stdin` (for example 64 KB), total testcase bytes per request, and a per-case output limit close to the expected output size via `max_file_size`. Discard `actual` once a case fails comparison.
  - Store only compact results in the submission cache and cap its total bytes.
  - Have CodeBox delete results after the backend reads them, and give the result cache an eviction policy or more memory.
  - Add per-user daily execution quotas.

### [H4] CodeBox credential and all user source code travel in cleartext over the internet

- **Severity:** HIGH
- **Confidence:** Confirmed for the inspected configuration. The deployed backend's environment was not available (NOT VERIFIED).
- **Category:** Transport security / credential exposure
- **Affected files:**
  - `src/utils/codeboxClient.js`
  - `.env`
  - CodeBox `Caddyfile`
- **Relevant line numbers:**
  - `codeboxClient.js:33-46` (plain `http:` allowed when `CODEBOX_ALLOW_INSECURE_HTTP === "true"`)
  - `codeboxClient.js:62-68` (`X-Auth-Token` sent on every request)
  - CodeBox `Caddyfile` header comment: with no DOMAIN set, Caddy serves plain HTTP on `:80` without a certificate
- **Description:**
  - The inspected `.env` sets `CODEBOX_ALLOW_INSECURE_HTTP=true`, and `CODEBOX_URL` uses `http://` with a public IPv4 address.
  - Every judge call therefore carries the static 64-character CodeBox token and the user's source code unencrypted. This includes C/C++ harness requests that contain every hidden testcase input.
- **Technical evidence:** URL scheme and host type were checked programmatically, without printing values.
- **Reproduction scenario:** Any party on the network path (shared Wi-Fi, ISP, hosting network) captures one request and reads the `X-Auth-Token` header.
- **Potential impact:**
  - Direct, unmetered use of CodeBox: arbitrary code in its sandbox, Redis exhaustion (H3), and reading results.
  - Exposure of hidden testcases and users' code.
  - Requests can be tampered with to forge verdicts.
- **Recommended remediation:**
  - Put CodeBox behind TLS: a domain plus Caddy automatic HTTPS, or a private network or VPN between backend and VPS.
  - Rotate the token.
  - Restrict the CodeBox firewall to the backend's egress IPs.
  - Refuse to start in production when `CODEBOX_ALLOW_INSECURE_HTTP=true`.

### [H5] Plaintext production secrets and a hosting password stored in a cloud-synced `.env`

- **Severity:** HIGH
- **Confidence:** Confirmed by file inspection. Cloud sync status not verified.
- **Category:** Secrets management
- **Affected files:** `backend/.env` (git-ignored; not committed)
- **Relevant line numbers:** Not applicable (untracked file)
- **Description:**
  - Besides the expected `KEY=VALUE` entries, the file contains 48 free-text lines:
    - a **plaintext hosting-provider password**
    - an additional 64-character hex credential-like string (not the current CodeBox token)
    - VPS operations runbook notes
  - The same file holds the production `DATABASE_URL`, `JWT_SECRET`, `OAUTH_STATE_SECRET` and `CODEBOX_TOKEN`.
  - The repository lives under `OneDrive\Desktop`, which is normally synced to the cloud.
  - During this audit, the line containing the hosting password passed through the audit tool's output because it is not in `KEY=VALUE` form. Treat it as exposed.
- **Technical evidence:**
  - Key names and line structure were enumerated with values redacted.
  - `git log -- .env`: the committed version (`da92ac8`) is empty, and it was removed in `7354489`. No secret patterns were found in any of the 170 revisions.
- **Reproduction scenario:** Anyone with access to the synced folder, a backup of the laptop, or a shared screenshot of the file obtains database, JWT-signing, judge and hosting credentials.
- **Potential impact:**
  - Full compromise of the production database: read and write all user data.
  - Forging of JWTs for any user.
  - Control of the judge and the hosting account.
- **Recommended remediation:**
  - **Rotate the hosting-provider password and the unidentified hex credential now.**
  - Consider rotating the database password, `JWT_SECRET` (this logs all users out), `OAUTH_STATE_SECRET` and `CODEBOX_TOKEN`.
  - Keep only `KEY=VALUE` lines in `.env`, and move runbook notes to documentation that contains no secrets.
  - Use per-developer, non-production credentials.
  - Keep production secrets in the platform secret manager.
  - Move the working copy out of the synced folder.

---

## 4. Medium-Severity Findings

### [M1] Sessions cannot be invalidated: password change keeps tokens valid, and any token can be refreshed forever

- **Severity:** MEDIUM
- **Confidence:** Confirmed
- **Category:** Authentication / session management
- **Affected files:**
  - `src/controllers/auth.controller.js`
  - `src/middlewares/auth.middleware.js`
  - `src/config/jwt.js`
  - `src/routers/auth.router.js`
- **Relevant line numbers:**
  - `auth.controller.js:224-279` (refresh)
  - `auth.controller.js:348-383` (change password only updates the hash, at `:373`)
  - `auth.middleware.js:37-78`
  - `jwt.js:24`
  - `auth.router.js:18`
- **Description:**
  - Tokens carry no password version or session identifier that is checked. `protect` verifies only the signature, the revocation list and that the user exists.
  - `POST /api/auth/refresh` exchanges any valid token for a fresh one with no absolute session lifetime and no rate limit.
  - The inspected `.env` sets `JWT_EXPIRES_IN=7d`, while the API documentation states 1 day.
  - There is no "log out everywhere".
- **Technical evidence:** The code paths cited above.
- **Reproduction scenario:**
  1. An attacker steals a token, for example through XSS against the `localStorage` token used by the explorer at `public/index.html:1363`, or from a shared device.
  2. The victim changes their password.
  3. The attacker keeps calling `/refresh` every few days and keeps access indefinitely.
- **Potential impact:** Persistent account takeover with no remediation path for the user.
- **Recommended remediation:**
  - Add a `tokenVersion` (or `passwordChangedAt`) claim, check it in `protect`, and bump it on password change and on "log out all".
  - Use short-lived access tokens plus rotating refresh tokens (in httpOnly, SameSite cookies) with an absolute lifetime.
  - Rate-limit `/refresh`.

### [M2] OAuth account-linking CSRF: the state token is not bound to the initiating browser and can be replayed

- **Severity:** MEDIUM
- **Confidence:** Likely. Standard OAuth CSRF pattern; not exercised against GitHub.
- **Category:** Authentication / OAuth
- **Affected files:** `src/controllers/social.controller.js`
- **Relevant line numbers:**
  - `63-67` (state = JWT `{userId, provider}` with a 10-minute lifetime)
  - `94-114` (callback verifies only signature and expiry)
  - `166-174` (fetches the verified primary email)
  - `193-224` (links the GitHub identity to `payload.userId`)
- **Description:**
  - Whoever completes the GitHub flow with a given `state` is linked to the account that created that `state`.
  - Nothing ties the callback to the browser that started the flow: no nonce in a cookie or server session, and no one-time use.
- **Technical evidence:** The code paths cited above.
- **Reproduction scenario:**
  1. An attacker calls `GET /api/social/github/link-url` with their own account and sends the resulting GitHub authorize URL to a victim.
  2. If the victim has authorized the Calibr8 GitHub app before, GitHub redirects without asking.
  3. The victim's GitHub id, username, avatar, bio and primary verified email (even if private on GitHub) are stored on the attacker's account. The attacker reads them via `GET /api/users/me`, whose `socialAccounts` field includes them.
- **Potential impact:**
  - Disclosure of the victim's private email and profile.
  - The victim can no longer link their own GitHub account (`ALREADY_LINKED`).
- **Recommended remediation:**
  - Generate a random nonce per flow and store it in an httpOnly cookie or server-side, bound to the user.
  - Require it on the callback and consume it once.
  - Optionally require an in-app confirmation before linking.

### [M3] Rate limiting is in-memory, per instance and per raw IP

- **Severity:** MEDIUM
- **Confidence:** Confirmed (code). The IPv6 bypass depends on hosting (Likely).
- **Category:** API abuse / brute force
- **Affected files:**
  - `src/middlewares/rateLimit.middleware.js`
  - `src/app.js`
  - `src/routers/*`
- **Relevant line numbers:**
  - `rateLimit.middleware.js:12-67` (in-process `Map`), `:76` (auth key `auth:${req.ip}`), `:86-106`, `:108-160`
  - `app.js:19-26` (`trust proxy` from `TRUST_PROXY`, default 1 hop in production)
- **Description:**
  - Counters live in each process. They reset on restart or deploy and are not shared between instances.
  - Keys use the full client address, so an IPv6 client can rotate through its /64 to get fresh buckets.
  - Login is throttled only per IP, at 30 per 15 minutes. There is no per-account throttle, so distributed credential stuffing is not slowed.
  - Anonymous execution (H3) and the analyzer (H1) are keyed by IP.
  - If `TRUST_PROXY` does not match the real proxy chain, either every client shares one bucket (one attacker locks out everyone) or `X-Forwarded-For` becomes spoofable.
  - `express-rate-limit` is installed but unused.
- **Technical evidence:** The code paths cited above.
- **Reproduction scenario:** Rotate source addresses, or spread requests across instances.
- **Potential impact:** The protections behind H1 and H3, and the login brute-force defence, can be bypassed.
- **Recommended remediation:**
  - Use a shared store (Redis) or edge or WAF rate limiting.
  - Bucket IPv6 by /64.
  - Throttle per account and per email for login.
  - Verify the `trust proxy` hop count for the real deployment.

### [M4] Output comparator accepts wrong answers

- **Severity:** MEDIUM
- **Confidence:** Confirmed (local test of `areOutputsEqual`)
- **Category:** Business logic / judge correctness
- **Affected files:** `src/utils/outputComparator.js`
- **Relevant line numbers:** `14-56` (normalization through `JSON.parse` / `Number`), `37-38`, `65-99` (single-element-array leniency at `83-93`)
- **Description:** Outputs are converted to JavaScript numbers and normalized loosely before comparison:
  - Integers above 2^53 lose precision.
  - `yes` equals `true`, and `no` equals `false`.
  - `[5]` equals `5`.
  - `1e3` equals `1000`.
- **Technical evidence (local test results; each comparison returned `true`):**

  | Actual | Expected |
  |---|---|
  | `"9007199254740993"` | `"9007199254740992"` |
  | `"[9007199254740993]"` | `"[9007199254740992]"` |
  | `"yes"` | `"true"` |
  | `"[5]"` | `"5"` |
  | `"1e3"` | `"1000"` |

- **Reproduction scenario:** Submit a solution that is off by one on a 64-bit answer, or one that prints `yes` for a boolean problem.
- **Potential impact:** Incorrect solutions are accepted and earn score, rating, solved counts and the daily-problem reward.
- **Recommended remediation:**
  - Compare tokens exactly by default, whitespace-normalized.
  - Compare numbers as strings or BigInt.
  - Allow per-problem checkers (float tolerance, unordered output) that are explicitly opted into.

### [M5] C/C++ multi-case harness trusts code compiled into the same binary

- **Severity:** MEDIUM
- **Confidence:** Likely (code review; not executed against CodeBox)
- **Category:** Judge integrity / hidden test data exposure
- **Affected files:**
  - `src/utils/multiCaseHarness.js`
  - `src/utils/codeBuilder.js`
  - `src/controllers/execution.controller.js`
- **Relevant line numbers:**
  - `multiCaseHarness.js:173` (harness constructor `__attribute__((constructor(101)))`)
  - `multiCaseHarness.js:344-347` (harness appended after the user code)
  - `multiCaseHarness.js:370-410` (report parser)
  - `codeBuilder.js:344-357` (only `main(` is rejected)
  - `execution.controller.js:640-774`
- **Description:**
  - User code is compiled into the same binary as the harness and placed before it.
  - User code can declare a constructor with priority ≤ 101. That constructor runs in the harness parent process before the harness itself.
  - It then has access to stdin, which carries **all** testcase inputs for the chunk, including hidden ones.
  - It can write a forged `C8MC1` report claiming any per-case CPU time, memory and exit status. It could also dump the hidden inputs into the stdout of a visible case, which the API returns.
- **Technical evidence:** The code paths cited above.
- **Reproduction scenario:** A C++ submission adds `__attribute__((constructor(101))) static void x(){ /* read stdin, compute all answers, print forged report, _exit(0) */ }`.
- **Potential impact:**
  - Per-case time and memory limits can be bypassed, so a brute-force solution can be labelled "Tier 3 (Optimal)".
  - Hidden testcases can be exfiltrated, which enables hard-coded solutions.
  - Rankings lose integrity.
- **Recommended remediation:**
  - Reject constructor/destructor attributes, `init_priority`, `asm` and `#pragma` in user code, or compile the harness separately and link it with `-Wl,--wrap` in a sealed object.
  - Authenticate the report with a per-run random nonce passed out-of-band.
  - Close or replace stdin before any user code can run.

### [M6] Users can overwrite their own rating at any time through onboarding

- **Severity:** MEDIUM
- **Confidence:** Confirmed
- **Category:** Business logic / ranking integrity
- **Affected files:**
  - `src/controllers/onboarding.controller.js`
  - `src/routers/onboarding.router.js`
- **Relevant line numbers:**
  - `onboarding.controller.js:114-146` (rating = average of self-chosen levels, 800–1600, written at `:145`)
  - `onboarding.controller.js:156` (raw, unvalidated `level` strings stored)
  - `onboarding.router.js:11-12`
- **Description:**
  - `POST /api/onboarding` and `PUT /api/onboarding/levels` can be called repeatedly after onboarding. Each call replaces the earned `rating` with a self-assessed value.
  - `tier` is not recomputed, so the stored tier and the rating disagree.
  - Per-topic `level` values are stored exactly as sent, with any string accepted.
- **Technical evidence:** The code paths cited above.
- **Reproduction scenario:** `PUT /api/onboarding/levels {"difficulty":"hard"}` → rating 1600.
- **Potential impact:**
  - Leaderboard and profile ratings become meaningless.
  - The Elo baseline for future rewards can be manipulated.
  - Arbitrary strings are stored and rendered in profiles.
- **Recommended remediation:**
  - Allow calibration only while `onboarded=false`, or only before the first accepted solve.
  - Validate `level` against an enum.
  - Recompute `tier` together with `rating`.

### [M7] Public, unauthenticated leaderboard exposes personal data

- **Severity:** MEDIUM
- **Confidence:** Confirmed
- **Category:** Privacy / excessive data exposure
- **Affected files:**
  - `src/routers/ranking.router.js`
  - `src/controllers/ranking.controller.js`
- **Relevant line numbers:** `ranking.router.js:6`; `ranking.controller.js:8-49` (fields selected at `27-39`)
- **Description:**
  - `GET /api/rankings` needs no token.
  - It returns up to 100 users per call with internal user `id`, `name`, `college`, `branch`, `batch`, `state`, `country`, `createdAt`, `rating`, `streak` and `tier`.
  - The `scope` filters let anyone list the top users of a given college, batch or state.
  - There is no opt-out or visibility setting.
- **Technical evidence:** The code paths cited above.
- **Reproduction scenario:** `curl '/api/rankings?scope=college&college=<name>&limit=100'`
- **Potential impact:**
  - Profiling and targeting of students, for example for phishing.
  - Possible conflict with data-protection obligations such as India's DPDP Act. This was not assessed legally.
- **Recommended remediation:**
  - Require authentication, or publish a minimal public view (display name and score).
  - Add profile visibility settings.
  - Never expose internal ids.

### [M8] Unbounded user-controlled strings, amplified by the public leaderboard

- **Severity:** MEDIUM
- **Confidence:** Confirmed (code). Amplification was not measured.
- **Category:** Input validation / resource exhaustion
- **Affected files:**
  - `src/controllers/auth.controller.js`
  - `src/controllers/user.controller.js`
- **Relevant line numbers:**
  - `auth.controller.js:37-71` (`name` has no length limit)
  - `user.controller.js:174-184` (`PUT /me`)
  - `user.controller.js:322-341` (`PATCH /me`; any type coerced with `String()`)
  - `user.controller.js:386-395` (`PATCH /me/academic`)
- **Description:**
  - `name`, `college`, `branch`, `batch`, `state` and `country` accept any length, up to the 1 MB body limit.
  - These values are served without authentication by `/api/rankings`.
  - Accounts are free: 30 registrations per 15 minutes per IP.
- **Technical evidence:** The code paths cited above.
- **Reproduction scenario:**
  1. Create about 100 accounts that share an 8 KB `country` value and have about 900 KB names.
  2. Request `GET /api/rankings?scope=country&country=<that value>&limit=100` repeatedly.
  3. Each response is about 90 MB, serialized on the event loop.
- **Potential impact:**
  - Memory and CPU exhaustion, and database bloat.
  - Abusive or impersonating content shown to every user.
- **Recommended remediation:**
  - Use schema validation (zod, joi or similar) with length and character-set limits on every text field.
  - Cap response sizes.
  - Normalize Unicode.

### [M9] Asynchronous submissions are lost on restart, and rewards can commit while the verdict fails

- **Severity:** MEDIUM
- **Confidence:** Confirmed (code)
- **Category:** Reliability / data consistency
- **Affected files:**
  - `src/controllers/execution.controller.js`
  - `src/server.js`
- **Relevant line numbers:**
  - `execution.controller.js:1893-1910` (detached `runEvaluation()`)
  - `execution.controller.js:1713-1834` (`Promise.all` of the reward chain and the verdict chain)
  - `server.js:90-117` (shutdown waits up to 10 s for HTTP close, then `process.exit(0)`)
- **Description:**
  - The 202 path evaluates in memory after responding. A deploy, crash or the H1 freeze leaves rows in `PROCESSING` forever. Nothing sweeps or re-queues them.
  - Rewards (score, rating, daily-problem coins) and the verdict update run in parallel. If the verdict write fails, the client gets 503 or the row is marked `ERROR`, but the rewards have already been committed.
- **Technical evidence:** The code paths cited above. There is no `PROCESSING` sweeper anywhere in `src/`.
- **Reproduction scenario:** Submit, then restart the server during judging.
- **Potential impact:**
  - Users see submissions stuck "processing".
  - Inconsistent state between submissions and progress or coins.
  - Support load.
- **Recommended remediation:**
  - Move judging to a durable queue: the existing Postgres `SKIP LOCKED` pattern in `profilingQueue.js` is a good template.
  - Drain jobs on shutdown.
  - Mark stale `PROCESSING` rows on startup.
  - Write the verdict first, then derive rewards idempotently from it.

### [M10] Unsafe configuration fallbacks instead of failing at startup

- **Severity:** MEDIUM
- **Confidence:** Confirmed (code). The production environment is NOT VERIFIED.
- **Category:** Configuration / reliability
- **Affected files:**
  - `src/config/jwt.js`
  - `src/app.js`
  - `src/controllers/social.controller.js`
- **Relevant line numbers:**
  - `jwt.js:5-18` (production with a missing or short secret uses a random per-process secret and only warns)
  - `app.js:21` and `51-53` (behaviour depends on `NODE_ENV`)
  - `social.controller.js:69-71` and `128` (`demo-github-client-id` and `localhost` fallbacks)
- **Description:** With `NODE_ENV=production`:
  - A missing or short `JWT_SECRET` or `OAUTH_STATE_SECRET` gives each process a random secret. Every restart then logs all users out, and instances reject each other's tokens.
  - The inspected `OAUTH_STATE_SECRET` is 30 characters, below the 32 required in production, so it would be silently replaced.

  Without `NODE_ENV=production` (it is absent from the inspected `.env`):
  - CORS allows `localhost` origins.
  - `trust proxy` is off.
- **Technical evidence:** Secret lengths were measured without printing values.
- **Reproduction scenario:** Deploy two instances without a 32-character OAuth secret; GitHub linking fails intermittently with `EXPIRED`.
- **Potential impact:**
  - Intermittent authentication failures.
  - Wrong CORS or proxy behaviour in production.
- **Recommended remediation:**
  - Validate configuration at startup with a schema and exit on missing or weak values in production.
  - Require `NODE_ENV` explicitly.
  - Remove the demo fallbacks.

### [M11] Hot paths that scale with total data, and caches bounded by entry count instead of bytes

- **Severity:** MEDIUM
- **Confidence:** Confirmed (code). Not load-tested.
- **Category:** Performance / scalability
- **Affected files:**
  - `src/utils/problemResolver.js`
  - `src/services/complexityAnalyzer.service.js`
  - `prisma/schema.prisma`
- **Relevant line numbers:**
  - `problemResolver.js:276-279` (`submission.groupBy` over the **entire** submissions table on every catalog rebuild: every 30 s per instance, and again after each first solve)
  - `problemResolver.js:14-16` (up to 300 full problems cached with all testcases)
  - `complexityAnalyzer.service.js:6-10` and `1608-1626` (up to 500 entries keyed by full source text of up to 200 KB, plus derived structures)
  - `schema.prisma` `Submission.code` (full source stored for every run, including anonymous runs, with no retention)
- **Description:** As submissions grow, the catalog query becomes a full scan on a hot path. Memory use is bounded by entry counts, not bytes. The submission cache is covered under H3.
- **Technical evidence:** The code paths cited above.
- **Reproduction scenario:** Grow `submissions` to millions of rows and observe `GET /api/problems` latency.
- **Potential impact:** Degrading latency, higher database cost, memory pressure on small instances.
- **Recommended remediation:**
  - Keep per-problem counters (`acceptedCount`, `attemptCount`) up to date incrementally.
  - Use byte-bounded LRU caches and key caches by hash, not by full source.
  - Add a retention policy for submissions.

---

## 5. Low-Severity and Informational Findings

### [L1] Account enumeration

- **Severity:** LOW
- **Confidence:** Confirmed
- **Category:** Authentication
- **Affected files:** `src/controllers/auth.controller.js`
- **Relevant line numbers:** `55-60`, `139-146`
- **Description:**
  - Registration returns `409 EMAIL_ALREADY_EXISTS` for existing emails.
  - Login skips bcrypt for unknown emails, so it responds measurably faster.
- **Technical evidence:** The code cited above.
- **Reproduction scenario:** Probe emails via register, or time login responses.
- **Potential impact:** Builds target lists for credential stuffing (amplifies M3).
- **Recommended remediation:**
  - Compare against a dummy hash when the user is not found.
  - Make the registration response generic, or verify email first.

### [L2] Missing account lifecycle controls

- **Severity:** LOW
- **Confidence:** Confirmed
- **Category:** Authentication / privacy
- **Affected files:** `src/routers/auth.router.js`, `src/routers/user.router.js`
- **Relevant line numbers:** Route tables
- **Description:** There is:
  - no email verification, so anyone can register someone else's address
  - no password reset or recovery flow
  - no self-service account deletion or data export
- **Technical evidence:** No such routes exist.
- **Reproduction scenario:** Not applicable.
- **Potential impact:**
  - Email squatting.
  - Users locked out for good when they forget a password.
  - Difficulty meeting data-subject requests.
- **Recommended remediation:** Add verified email, a rate-limited and token-based reset flow, and deletion and export endpoints.

### [L3] Token revocation fails open, propagates slowly, and refresh writes are unthrottled

- **Severity:** LOW
- **Confidence:** Confirmed
- **Category:** Authentication
- **Affected files:**
  - `src/utils/tokenBlacklist.js`
  - `src/controllers/auth.controller.js`
- **Relevant line numbers:**
  - `tokenBlacklist.js:12` (30 s "not revoked" cache)
  - `tokenBlacklist.js:33-42` (on P2021 the table is considered missing for the life of the process)
  - `tokenBlacklist.js:110-114` (a database error returns "not revoked")
  - `auth.controller.js:256-263`
- **Description:**
  - A logged-out token stays valid on other instances for up to 30 s.
  - If the revocations table is unavailable, revocation becomes in-memory only.
  - Every `/refresh` call inserts a row, with no rate limit.
- **Technical evidence:** The code cited above.
- **Reproduction scenario:** Log out on instance A and reuse the token on instance B within 30 s.
- **Potential impact:** Short windows of post-logout use; table growth driven by any user.
- **Recommended remediation:**
  - Fail closed for sensitive routes.
  - Rate-limit refresh.
  - Use the token-version approach from M1.

### [L4] No request schema validation, so malformed input yields 500 errors

- **Severity:** LOW
- **Confidence:** Confirmed
- **Category:** Input validation / error handling
- **Affected files:**
  - `src/controllers/auth.controller.js`
  - `src/controllers/ranking.controller.js`
  - `src/middlewares/error.middleware.js`
  - `src/utils/ApiError.js`
- **Relevant line numbers:**
  - `auth.controller.js:37-45` and `120-126` (`.trim()` on non-strings)
  - `ranking.controller.js:13-16` (a repeated query parameter becomes an array and fails in Prisma)
  - `error.middleware.js:35-41` (409 response names the constraint column)
  - `ApiError.js:30-31` (every 413 is labelled `CODE_TOO_LARGE`)
- **Description:** Non-string or array inputs throw `TypeError` or Prisma validation errors, which surface as 500s. Some error codes are misleading.
- **Technical evidence:** The code cited above.
- **Reproduction scenario:** `POST /api/auth/login {"email": 1, "password": 2}` → 500.
- **Potential impact:** Noisy 5xx alerts, small information leaks, harder client error handling.
- **Recommended remediation:** Validate request schemas centrally and map validation errors to 400.

### [L5] Weak security headers, and a developer console served from production

- **Severity:** LOW
- **Confidence:** Confirmed
- **Category:** Security configuration
- **Affected files:**
  - `src/app.js`
  - `src/routers/index.router.js`
  - `public/index.html`
- **Relevant line numbers:**
  - `app.js:29-37` (CSP allows `'unsafe-inline'` and any `https:` script; `frame-ancestors` allows `*.google.com`, `*.googleusercontent.com`, `*.run.app`)
  - `app.js:77`
  - `index.router.js:49-52`
  - `public/index.html:1363`
- **Description:**
  - There is no HSTS, and `X-Powered-By: Express` is not disabled.
  - The broad `frame-ancestors` list lets pages hosted on Google user-content domains frame the console (clickjacking).
  - The console keeps the JWT in `localStorage`. It mostly escapes rendered data.
- **Technical evidence:** The code cited above.
- **Reproduction scenario:** Frame `/` from a `*.googleusercontent.com` page.
- **Potential impact:** Clickjacking or token exposure through any future XSS in the console.
- **Recommended remediation:**
  - Use `helmet` defaults, HSTS, and `frame-ancestors 'none'`.
  - Disable `x-powered-by`.
  - Do not serve the console in production, or put it behind authentication.

### [L6] Study quiz answers retrievable, and progress never saved

- **Severity:** LOW
- **Confidence:** Confirmed
- **Category:** Business logic
- **Affected files:** `src/controllers/study.controller.js`
- **Relevant line numbers:** `101-142` (returns `correctIndex` for every MCQ, at `:126`; writes nothing)
- **Description:**
  - Submitting `{}` returns all correct answers.
  - The documented "save progress" behaviour does not exist.
- **Technical evidence:** The code cited above.
- **Reproduction scenario:** `POST /api/study/topics/<slug>/submit {"answers":{}}`
- **Potential impact:** Quiz scores are meaningless. This matters only if they ever count toward rewards.
- **Recommended remediation:** Return answers only after a recorded attempt, and persist attempts.

### [L7] Rating lost update under concurrent accepted submissions

- **Severity:** LOW
- **Confidence:** Likely
- **Category:** Concurrency / data integrity
- **Affected files:**
  - `src/utils/acceptedSubmissionReward.js`
  - `src/controllers/execution.controller.js`
- **Relevant line numbers:**
  - `acceptedSubmissionReward.js:47-53` (uses a prefetched user), `:90-104` (absolute `rating` write at `:101`)
  - `execution.controller.js:1675-1682` (prefetch happens before judging)
- **Description:**
  - The rating is computed from a row read before judging started, then written as an absolute value.
  - Two concurrent first solves (the in-flight limit is 2) can overwrite each other's rating change.
  - Score uses `increment` and is not affected.
- **Technical evidence:** The code cited above.
- **Reproduction scenario:** Submit two different unsolved problems at the same time.
- **Potential impact:** Small rating drift.
- **Recommended remediation:** Read the rating `FOR UPDATE` inside the transaction, or apply the change atomically in SQL.

### [L8] CodeBox VPS address present in public git history

- **Severity:** LOW
- **Confidence:** Confirmed
- **Category:** Information disclosure
- **Affected files:** History of `src/controllers/execution.controller.js` and `src/server.js`
- **Relevant line numbers:** 23 revisions reachable from `origin/main`
- **Description:**
  - Earlier revisions hard-coded the judge's public address. No token was found in those revisions.
  - Whether the GitHub repository is public was not verified.
- **Technical evidence:** History search done without printing the address.
- **Reproduction scenario:** `git log -p`
- **Potential impact:** Lets an attacker locate the judge for H3 and H4 style attacks.
- **Recommended remediation:**
  - Treat the address as known.
  - Rely on TLS, a firewall and token rotation (H4).
  - Optionally rewrite history.

### [L9] Dependency hygiene

- **Severity:** LOW
- **Confidence:** Confirmed (`npm audit`). Runtime impact assessed as low.
- **Category:** Supply chain
- **Affected files:** `package.json`, `package-lock.json`
- **Relevant line numbers:** `package.json:61-79`
- **Description:**
  - `npm audit` reports 4 high and 2 moderate advisories, all in build or development tooling: the `prisma` CLI via `@prisma/config` → `deepmerge-ts` (GHSA-ggr8-5vv4-36mx) and `effect` (GHSA-38f7-945m-qr2g, GHSA-7589-6fvf-x4pw), and `nodemon` → `minimatch` (GHSA-g3hv-75wg-m249). None is reachable from request handling.
  - `@prisma/client` 6.16.1 is paired with driver adapters 7.10.1, a major-version mismatch that needs verification.
  - `express-rate-limit` and `node-fetch` are unused, and `@aws-sdk/client-s3` is used only by the unused `lib/storage.js`.
  - `postinstall` runs `prisma generate`.
- **Technical evidence:** `npm audit --json` and `npm ls`.
- **Reproduction scenario:** Not applicable.
- **Potential impact:** Install-time risk, a larger attack surface, and adapter incompatibility on upgrade.
- **Recommended remediation:**
  - Align Prisma client and adapter versions.
  - Upgrade the Prisma CLI per the advisories.
  - Remove unused packages.
  - Run `npm ci --omit=dev` in production.

### [L10] Observability gaps

- **Severity:** LOW
- **Confidence:** Confirmed
- **Category:** Operations
- **Affected files:**
  - `src/routers/index.router.js`
  - `src/server.js`
  - `src/app.js`
- **Relevant line numbers:** `index.router.js:24-31`; `app.js:69-75`
- **Description:**
  - `/health` is liveness only: it checks neither the database nor CodeBox.
  - Logs are unstructured `console` output, with no request ids and no metrics or traces.
  - There is no `unhandledRejection` or `uncaughtException` logging.
- **Technical evidence:** The code cited above.
- **Reproduction scenario:** A database outage still reports `ok`.
- **Potential impact:** Slow incident detection and diagnosis.
- **Recommended remediation:**
  - Add a readiness endpoint and structured logs with request ids.
  - Add metrics for judge latency, error rates and queue depth, with alerting.

### [I1] JWT configuration notes

- **Severity:** INFO
- **Confidence:** Confirmed
- **Category:** Authentication
- **Affected files:** `src/utils/jwt.js`
- **Relevant line numbers:** `11-22`
- **Description:**
  - `jwt.verify` has no explicit `algorithms`. `jsonwebtoken` 9 limits string secrets to HS* and rejects `none`, so this is not exploitable today.
  - Tokens carry `email`, which is readable from base64.
  - There are no `iss` or `aud` claims.
- **Technical evidence:** The code cited above.
- **Reproduction scenario:** Not applicable.
- **Potential impact:** Low.
- **Recommended remediation:** Pin `algorithms: ['HS256']`, add `iss` and `aud`, and drop `email` from the payload.

### [I2] Password hashing parameters

- **Severity:** INFO
- **Confidence:** Confirmed
- **Category:** Cryptography
- **Affected files:** `src/utils/bcrypt.js`
- **Relevant line numbers:** `3`
- **Description:**
  - bcryptjs (pure JavaScript) at cost 10 is acceptable but at the low end.
  - Its CPU cost adds to login-flood impact.
- **Technical evidence:** The code cited above.
- **Reproduction scenario:** Not applicable.
- **Potential impact:** Low.
- **Recommended remediation:** Use cost 12 with native `bcrypt`, or argon2id.

### [I3] Hidden-testcase side channels

- **Severity:** INFO
- **Confidence:** Confirmed (design)
- **Category:** Judge integrity
- **Affected files:** `src/controllers/execution.controller.js`
- **Relevant line numbers:** `1483-1494`
- **Description:**
  - Hidden case data is correctly withheld.
  - Verdict type, failing index and timing still leak information about hidden inputs across many submissions. This is inherent to online judges.
- **Technical evidence:** The code cited above.
- **Reproduction scenario:** Not applicable.
- **Potential impact:** Low.
- **Recommended remediation:** Add per-problem submission quotas and periodically rotate hidden tests.

### [I4] Write transaction on every session check

- **Severity:** INFO
- **Confidence:** Confirmed
- **Category:** Performance
- **Affected files:**
  - `src/controllers/auth.controller.js`
  - `src/services/coinService.js`
- **Relevant line numbers:** `auth.controller.js:285-321`; `coinService.js:18-136`
- **Description:** `GET /api/auth/me`, `/verify` and `/refresh` run the daily-login reward transaction: 2–4 statements, including an `UPDATE`, on every app open.
- **Technical evidence:** The code cited above.
- **Reproduction scenario:** Not applicable.
- **Potential impact:** Unnecessary write load.
- **Recommended remediation:** Skip the write when `lastLoginISTDate` on `req.user` is already today.

---

## 6. Authentication and Authorization Audit

### Verified sound

- Passwords hashed with bcrypt.
- The password policy limits length to 8–72 bytes and rejects passwords equal to the email.
- Separate signing secrets for JWT and OAuth state; startup refuses equal secrets.
- `protect` rejects deleted accounts and never re-creates users from token claims.
- `optionalAuth` treats any invalid token as anonymous.
- Owner-only access to `GET /api/execution/submissions/:id` and `/:id/complexity`: other users get 404, with no IDOR.
- Every profile, coin, theme and onboarding write is scoped to `req.user.id`, with no id parameters to tamper with.
- Theme purchase checks ownership server-side.
- The OAuth redirect target is allow-listed.
- The GitHub access token is not stored.

### Weaknesses

- Session invalidation and indefinite refresh (M1).
- OAuth CSRF (M2).
- Limiter design (M3).
- Account enumeration (L1).
- Missing account lifecycle flows (L2).
- Revocation edge cases (L3).
- Rating self-assignment, a business-level authorization gap (M6).
- Anonymous access to execution (H3).
- There is no role or admin model. All administration happens through scripts with direct database credentials (H2).

---

## 7. Database and Data Integrity Audit

### Verified sound

- All raw SQL uses tagged templates (parameterized). The only `$executeRawUnsafe` calls are constant strings in `scripts/reset-and-upload.js`.
- Coin balance changes use atomic `increment` or `decrement` with a `coins >= price` guard.
- Daily login and daily-problem rewards are idempotent through partial unique indexes plus a composite primary key.
- Theme double purchase is prevented by `@@unique([userId, themeId])` inside a transaction.
- First-solve rewards are idempotent through `createMany(skipDuplicates)` on `UserProblemProgress`.
- The profiling queue claims jobs with `FOR UPDATE SKIP LOCKED`.
- The `DailyProblem → Problem` foreign key is `RESTRICT`.
- The Neon connection uses TLS.

### Weaknesses

- Production database used by tests and scripts (H2).
- Partial writes between rewards and verdict (M9).
- Rating lost update (L7).
- Full-table aggregation (M11).
- No retention for submissions.
- Unbounded text columns (M8).
- The schema was created with `db push`, and migration history is not applied in Neon. This makes schema drift and changes risky; additive SQL with drift checks is the current workaround.
- Connection pool size and transaction timeouts use defaults (NEEDS REVIEW under load).

---

## 8. Performance and Scalability Audit

### Verified sound

- Problem and catalog caches with in-flight de-duplication.
- Bounded caches with TTLs.
- Chunked, parallel judging with long-poll.
- Timeouts on every CodeBox and GitHub call.
- Morgan logs failures only.

### Weaknesses

- CPU-bound analysis on the event loop (H1, measured).
- All state is in-process: rate limits, in-flight counts, submission cache, analyzer cache. Horizontal scaling therefore weakens the limits and duplicates memory (M3, M11).
- No global concurrency control towards CodeBox (H3).
- Whole-table aggregation on a hot path (M11).
- Asynchronous judging is not durable (M9).
- No load testing was performed. No performance numbers beyond the analyzer measurements are claimed.

---

## 9. Infrastructure and Deployment Audit

The backend repository contains no Dockerfile, process manager configuration, reverse-proxy configuration or infrastructure as code. **The production deployment could not be verified.**

### Observed

- Plain HTTP to CodeBox (H4).
- Secrets handling (H5).
- `NODE_ENV`-dependent security behaviour and silent secret fallbacks (M10).
- `TRUST_PROXY` correctness depends on the real proxy chain (M3).
- Graceful shutdown closes HTTP and the database, but does not drain background evaluations (M9).

### CodeBox boundary

- The CodeBox worker runs `privileged: true`, which the isolate sandbox requires; it was not reviewed further.
- CodeBox Redis is limited to 256 MB with `noeviction`.
- Prometheus and Grafana use `:latest` images.

---

## 10. Dependency and Supply Chain Audit

- `npm audit`: 0 critical, 4 high and 2 moderate advisories, all in build or development tooling (the `prisma` CLI's `@prisma/config` dependencies, and `nodemon` → `minimatch`). None is reachable at runtime (L9). Each advisory is linked in L9 to its GitHub Security Advisory.
- Version conflict: `@prisma/client` 6.16.1 with `@prisma/adapter-neon` and `@prisma/adapter-pg` 7.10.1 (NEEDS REVIEW).
- Unused dependencies: `express-rate-limit`, `node-fetch`, `@aws-sdk/client-s3` (the last only via unused `lib/storage.js`).
- Git history: the committed `.env` was empty. No secret patterns were found across 170 revisions (connection strings, private keys, GitHub tokens, AWS keys, JWT or CodeBox literals). The judge's IP address appears in 23 revisions (L8).

---

## 11. Missing Tests and Coverage Gaps

Current state:
- 24 of the test files touch the database configured in `.env`, which is production (H2).
- 29 DB-free tests were run in this audit and passed: unit utilities, streak, daily-problem selection, testcase results, harness, solved count, analyzer, security middleware, CORS.
- No coverage numbers were produced, because the coverage run would execute DB-backed tests.

Scenarios with no test:

- Oversized or adversarial inputs to `/analyze-complexity`, run and submit, with event-loop latency assertions (H1).
- Anonymous access to `/api/problems/:slug/run` and `/submit`, and byte limits on `stdin`, outputs and caches (H3).
- Environment guards: tests and scripts must refuse the production database (H2).
- Old tokens rejected after a password change; refresh lifetime limits (M1).
- OAuth state bound to the initiating session, and replay rejected (M2).
- Rate limits across restarts, instances, IPv6 and proxy headers (M3).
- Comparator strictness: 64-bit integers, booleans, singleton arrays (M4).
- C/C++ harness against user constructors and forged reports (M5).
- Onboarding after the first solve must not change the rating (M6).
- Rankings response fields and authentication, and profile field length limits (M7, M8).
- Restart during asynchronous judging, and verdict-write failure after rewards (M9).
- Production config validation at boot (M10).
- Concurrency of two first solves for rating, and concurrent theme purchases. The daily rewards already have parallel tests.
- Failure paths: CodeBox 5xx, timeouts or full Redis, and database timeouts inside interactive transactions.

---

## 12. Production Readiness Checklist

| Area | Status | Basis |
|---|---|---|
| Security (overall) | FAIL | H1, H4, H5 |
| Authentication | FAIL | M1, M2, L1–L3 |
| Authorization (object-level) | PASS | Ownership checks verified; no IDOR found |
| Business-logic integrity | FAIL | M4, M5, M6 |
| Input validation | FAIL | H1 size, M8, L4 |
| Privacy / data exposure | FAIL | M7, H5 |
| Database integrity | NEEDS REVIEW | Strong constraints on coins and rewards; M9, L7 |
| Environment separation | FAIL | H2 |
| Performance | FAIL | H1, M11 |
| Reliability / resilience | FAIL | H3, M9 |
| Rate limiting / abuse control | FAIL | M3 |
| Transport security | FAIL | H4 (backend↔CodeBox); client TLS NOT VERIFIED |
| Secrets management | FAIL | H5, M10 |
| Logging | NEEDS REVIEW | No bodies or secrets logged (good); unstructured, no request ids |
| Monitoring / alerting | FAIL | Nothing in the backend; liveness-only health check (L10) |
| Deployment | NOT VERIFIED | No deployment configuration in the repository |
| Dependencies | NEEDS REVIEW | L9 |
| Backups / disaster recovery | NOT VERIFIED | Neon PITR settings not inspected; critical given H2 |
| Testing | FAIL | Tests target production; gaps in §11 |

---

## 13. Prioritized Remediation Roadmap

None of the following was implemented.

### P0: before real traffic (days)

1. **H1:** Require auth on `/analyze-complexity`. Cap analyzer input at 64 KB or lower. Move the analyzer to a worker pool with a hard timeout.
2. **H5:** Rotate the hosting password and the unidentified hex credential. Decide on rotating the database password, JWT, OAuth and CodeBox secrets. Clean `.env` and move it out of the synced folder.
3. **H2:** Create a dev/test Neon branch and a non-production CodeBox. Add production-host guards to every test and script. Make destructive scripts dry-run by default. Confirm Neon PITR.
4. **H4:** Put CodeBox behind TLS, rotate its token, and firewall it to backend IPs. Refuse insecure HTTP in production.
5. **H3:** Require authentication for all execution. Add a backend-wide judge concurrency limit or queue. Enforce byte budgets for stdin, testcases and outputs. Make the submission cache byte-bounded and keep only compact results.

### P1: before scaling or a public launch

6. **M1:** Token versioning; short access tokens with rotating refresh tokens; revoke all sessions on password change.
7. **M2:** Nonce-bound, one-time OAuth state.
8. **M3:** Shared or edge rate limiting with IPv6 /64 buckets, per-account login throttling, and a verified `trust proxy` setting.
9. **M10:** Fail-fast configuration validation; explicit `NODE_ENV`.
10. **M9:** Durable judging queue, shutdown drain, stale-row recovery, verdict-first reward derivation.
11. **M4, M5:** Strict comparator with opt-in checkers; harden the C/C++ harness.
12. **M6, M7, M8:** One-time calibration; leaderboard privacy and authentication; schema validation with length limits.

### P2: hardening

13. **M11:** Incremental counters, byte-bounded caches, submission retention.
14. **L10:** Readiness check, structured logs, metrics, alerts.
15. **L5:** helmet, HSTS, no production console.
16. **L9:** Align Prisma versions and remove unused packages.
17. The remaining LOW and INFO items.
18. Build the missing tests from §11 against an isolated database.

---

## 14. Final Verdict

**NOT PRODUCTION READY**

### Reasoning

The object-level authorization model and the money-like reward logic are better than average. They use atomic updates, unique constraints, idempotent grants and owner-only reads. However, four of the five HIGH findings can each produce a platform-wide outage or data loss without any special access:

- One anonymous request can stall the server for close to a minute (H1, measured).
- A routine `npm test` or a one-off script run can corrupt or erase production data, and already has (H2).
- One client can make the shared judge unavailable to everyone (H3).
- The judge credential travels in cleartext (H4).

H5 adds immediate credential-rotation work.

These are concentrated, well-understood fixes. After P0 and the M1–M3 and M10 items, the backend would plausibly move to **"PRODUCTION READY WITH IMPROVEMENTS RECOMMENDED"**.

### Limitations and methodology

- **Static analysis:** Every file under `src/` was read. The exceptions, reviewed only at the interface level, are:
  - `complexityAnalyzer.service.js` (1,779 lines; treated as a black box and benchmarked)
  - `src/profiling/profiler.js` and `profileHarness.js` (the feature is disabled by default)
  - the C source inside `multiCaseHarness.js` beyond its trust boundary

  Prisma schema, migrations list, scripts (scanned for destructive operations), tests (structure and database usage), package manifests and git history were also reviewed.
- **Dynamic verification (local only):**
  - analyzer timing with adversarial inputs
  - an end-to-end blocking demonstration on a local app instance with a dummy database URL and no CodeBox
  - comparator behaviour
  - 29 DB-free unit tests (all passed)
  - `npm audit`

  No request was sent to the production database, CodeBox or GitHub.
- **Not verified:**
  - the production deployment and its environment variables
  - Neon backups and PITR
  - network and TLS in front of the API
  - CodeBox internals beyond the cited limits
  - the frontend
  - `problems/*.json` and `study-material/` content
  - load behaviour
- **Working-tree state:** The audited tree includes uncommitted changes to the daily-problem subsystem: `dailyProblemService.js`, its router and controller, and the `20261123000000_daily_problem_hardening` migration, which is already applied to Neon. The deployed backend may differ from what was audited.
- **Secret handling:** No secret values are reproduced in this report. One plaintext password from `.env` passed through the audit tooling's output (see H5).

---

## 15. Remediation Status (2026-11-24)

Code fixes are in the working tree (not yet committed or deployed). The one schema change, `users.tokenVersion INTEGER NOT NULL DEFAULT 0` (migration `20261124000000_session_token_version`), **has been applied to Neon**. It is additive and compatible with the currently deployed code, and the post-apply drift check is empty.

Verification:
- DB-free tests: 80/80 passed. That is the 41 unit tests, including the new `tests/securityHardening.test.js`, plus 39 execution and judging tests.
- All 28 DB-backed integration suites passed on a throwaway local Postgres. This includes the new `tests/sessionSecurity.test.js`.
- No test was run against production.

| ID | Status | What changed / what remains |
|---|---|---|
| H1 | **Fixed** | The analyzer runs in a worker-thread pool with a hard timeout (`src/services/complexityPool.js`, 2 s default) and a bounded queue. `/analyze-complexity` requires login, takes at most 64 KB, and has its own limiter. Tested: a 64 KB adversarial input returns "unknown" in about 0.5 s, and the event loop is never stalled for more than 400 ms. |
| H2 | **Partly fixed; owner decision** | By the owner's decision (2026-11-24) `npm test` uses the real `.env` database and CodeBox (no separate test database). To limit the risk, every DB test tags the rows it creates with a per-run id (per-run far-future year for daily problems) and deletes only its own rows, so runs never touch real data or each other's data; 117/117 pass this way. Destructive scripts (`reset-and-upload`, `bulk-push`, `seedProblems --update`, `seedRanking`) refuse remote databases unless given `--confirm=<host>`. **Pending:** create a Neon dev/test branch, remove the production `DATABASE_URL` from developer `.env` files, and confirm Neon PITR. |
| H3 | **Fixed (backend); CodeBox follow-up** | All execution needs login. Backend-wide judge admission (`JUDGE_MAX_CONCURRENT`/`QUEUE`, 503 `JUDGE_BUSY`). Custom stdin is capped at 64 KB. Output and error text is clipped to 4 KB per case after comparison. The submission cache is byte-bounded and holds only public results. Harness submissions are deleted from CodeBox after they are read. **Pending (CodeBox repo):** a lower per-case output cap, deleting `/batches` results, and a Redis eviction policy or more memory for the result cache. |
| H4 | **Ops pending** | The backend logs an error at startup in production when CodeBox is plain HTTP. **Pending:** set `DOMAIN` for the CodeBox Caddy (automatic HTTPS) or use a private network, rotate `CODEBOX_TOKEN`, firewall CodeBox to the backend's egress IPs, then unset `CODEBOX_ALLOW_INSECURE_HTTP`. |
| H5 | **Ops pending (owner action)** | **Rotate the hosting-provider password and the unidentified 64-hex credential.** Remove the free-text notes from `.env`, and keep production secrets in the platform's secret store. Optionally rotate the DB password, `JWT_SECRET`, `OAUTH_STATE_SECRET` and `CODEBOX_TOKEN`. Move the working copy out of the OneDrive-synced folder. |
| M1 | **Fixed** | `tokenVersion` in every token is checked by `protect`. Password change and the new `POST /api/auth/logout-all` revoke all sessions. Refresh keeps the original `auth_time` and stops after `SESSION_MAX_AGE_DAYS` (30). Session endpoints are rate-limited. Change-password returns a new token and accepts `currentPassword`; the frontend always sent `currentPassword`, so it was previously broken. |
| M2 | **Fixed** | The OAuth callback no longer links. It returns an encrypted, 5-minute, one-time `link_code`, and `POST /api/social/:provider/complete` links it only for the user who started the flow (403 otherwise). The frontend `ConnectedAccounts` was updated. |
| M3 | **Partly fixed** | IPv6 clients are bucketed per /64. Per-account login lockout (10 failures per 15 min). Limiter maps are bounded. **Remaining:** counters are still per instance, so add edge/WAF rate limiting for multi-instance deploys, and verify `TRUST_PROXY` against the real proxy chain. |
| M4 | **Fixed** | Exact integer comparison (BigInt). `yes`/`no` are no longer booleans. The format bridges the drivers rely on, such as `[0]` vs `0`, are kept. |
| M5 | **Mitigated** | C/C++ code that could run in the harness parent is judged on the batch path instead, which has no harness. That covers preprocessor directives other than `#include` / `#pragma GCC optimize/target`, `__attribute__`, gnu attributes, `asm`, `extern "C"`, libc overrides, UCNs and line splicing. Residual: a complete fix needs the harness compiled separately from user code (a CodeBox feature). |
| M6 | **Fixed** | Calibration writes `rating`/`tier` only before the first solve. Levels are validated and normalized. |
| M7 | **Fixed** | Guests see a minimal leaderboard (no ids, dates or regional fields, and no regional scopes). Signed-in users get regional fields and an `isCurrentUser` flag. The frontend was updated. |
| M8 | **Fixed** | Name and profile fields are type-checked, cleaned and length-limited (`src/utils/validation.js`). |
| M9 | **Fixed** | The verdict is persisted before rewards. Stale `PROCESSING` rows become `ERROR` at startup and every 5 minutes. Shutdown drains background evaluations (25 s). A failed synchronous submit is marked `ERROR`. |
| M10 | **Fixed; check before deploy** | Production now **refuses to start** with a missing or short `JWT_SECRET` / `OAUTH_STATE_SECRET`. The local `OAUTH_STATE_SECRET` is 30 characters: make sure the production value is at least 32 **before deploying**, and set `NODE_ENV=production`. The GitHub demo and localhost fallbacks are removed in production. |
| M11 | **Fixed** | Acceptance stats have their own 5-minute cache, so a solve no longer triggers a full scan of `submissions`. The problem and submission caches are byte-bounded. The analyzer cache is keyed by hash. A submission retention policy is still a product decision. |
| L1 | **Fixed (timing)** | Unknown emails cost one bcrypt compare. The registration 409 is kept for UX, and email verification would be needed to remove it. |
| L2 | **Partly fixed** | Added `DELETE /api/users/me` (password plus `confirm: "DELETE"`). **Remaining:** email verification, password reset and data export need an email provider. |
| L3 | **Fixed** | Revocation lookups fail closed. The not-revoked cache is 10 s. Refresh is rate-limited. |
| L4 | **Fixed** | Type checks on auth inputs. `PAYLOAD_TOO_LARGE`, `INVALID_JSON` and Prisma validation errors map to 400. The 409 no longer names columns. |
| L5 | **Fixed** | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, HSTS in production, `x-powered-by` off, no `https:` script source. The API console is not served in production unless `SERVE_API_CONSOLE=true`. |
| L6 | **Fixed** | Correct answers are returned only for answered questions; empty sheets get 400. Persisting progress needs a schema decision. |
| L7 | **Fixed** | The rating is re-read under `SELECT … FOR UPDATE` inside the reward transaction. |
| L8 | **Accepted** | History is not rewritten. Mitigated by H4 (TLS, firewall, token rotation). |
| L9 | **Partly fixed** | Removed the unused `express-rate-limit` and `node-fetch`. **Remaining:** align `@prisma/client` 6.16 with adapters 7.10, which needs a staging test of the Neon adapter. The prisma CLI advisories are fixed by a major upgrade. `lib/storage.js` is kept for the planned R2 testcase storage. |
| L10 | **Fixed** | `/health/ready` (database and CodeBox), `X-Request-Id` on every response and in error logs, process-level crash logging, 5xx stack logging. Metrics and alerting are still to be set up on the hosting platform. |
| I1 | **Fixed** | HS256 pinned. No email in tokens. |
| I2 | **Fixed** | bcrypt cost 12, with a transparent rehash on login. |
| I3 | **Accepted** | Inherent to online judges. |
| I4 | **Fixed** | `/auth/me`, `/verify` and `/refresh` skip the daily-login write once today is recorded. |

### API changes that clients must know about

- `POST /api/problems/:slug/run|submit` and `POST /api/execution/analyze-complexity` now require a token.
- `POST /api/auth/change-password` revokes other sessions and returns `token`.
- GitHub linking now redirects back with `?link_code=…&provider=github`; the client must call `POST /api/social/github/complete`.
- `GET /api/rankings` rows have `rank` and `isCurrentUser`, and no longer have `id` or `createdAt`. Regional fields and scopes require a token.
- New endpoints: `POST /api/auth/logout-all`, `DELETE /api/users/me`, `POST /api/social/:provider/complete`, `GET /health/ready`.
- Comparator: `yes`/`no` no longer match `true`/`false`, and 64-bit integers are compared exactly.
