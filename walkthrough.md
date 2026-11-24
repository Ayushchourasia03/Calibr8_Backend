# Security Summary

**Reviewed Files**: 31
**Issues Resolved**: 21

### Issues Resolved
| Area | File | Line | What Was Happening | Impact | Status | How It Was Fixed |
|---|---|---|---|---|---|---|
| Hidden Testcase Harness Isolation | `src/utils/multiCaseHarness.js` | 174, 500 | The multi-case parent harness became non-dumpable only after reading all stdin, and static safety checks allowed non-standard `#include` directives, `operator new`, comment/raw-string tricks, and qualified `libc` hooks that could access parent memory or intercept parent I/O. | Critical | Fixed | Moved `prctl(PR_SET_DUMPABLE, 0, ...)` before reading stdin and hardened `isHarnessSafeUserCode` to strip comments/literals, enforce strict header allowlists, block `operator new`/`delete`, and detect `libc` function redefinitions. |
| Complexity Profiling Harness Isolation | `src/profiling/profileHarness.js` | 110, 204 | The profiling parent process remained dumpable with open parent file descriptors accessible from forked child code, and the profiler compiled user C++ without checking safety hooks. | Critical | Fixed | Added `PR_SET_DUMPABLE` protection before reading profiling stdin, closed inherited descriptors in forked children, and gated `src/profiling/profiler.js` (line 310) + `src/profiling/profilingQueue.js` through `isHarnessSafeUserCode`. |
| Hardcoded Dev JWT & OAuth Fallbacks | `src/config/jwt.js` | 14 | Non-production runs fell back to fixed static strings checked into source control if `JWT_SECRET` or `OAUTH_STATE_SECRET` was missing or short. | High | Fixed | Replaced static fallback strings with ephemeral runtime `crypto.randomBytes(32)` secrets in non-production while enforcing minimum 32-char secrets in production. |
| OAuth Link Code Replay & Token Derivation | `src/controllers/social.controller.js` | 81, 302 | One-time OAuth link codes had an in-memory-only nonce cache (vulnerable across multi-instance deployments or restarts), derived encryption keys via plain SHA-256 over a single secret, trusted arbitrary `http://` avatar/profile URLs, and exposed unthrottled OAuth link/unlink endpoints. | High | Fixed | Switched key derivation to HKDF-SHA256, reduced link code TTL to 2 minutes, persisted nonces atomically in PostgreSQL inside a transaction, enforced `https:` profile URLs, added `no-referrer`/`no-store` headers, and added `sessionLimiter` in `src/routers/social.router.js`. |
| Immediate Token Revocation | `src/utils/tokenBlacklist.js` | 7 | A 10-second negative revocation cache delayed cross-instance logouts/password-change invalidations, and a missing-table (`P2021`) error permanently disabled DB checks for the process lifetime. | High | Fixed | Removed the negative lookup cache so revocations check PostgreSQL immediately, and replaced the permanent disable flag with a bounded 60-second retry cooldown. |
| Plaintext CodeBox Transport in Production | `src/utils/codeboxClient.js` | 40 | Setting `CODEBOX_ALLOW_INSECURE_HTTP=true` permitted unencrypted `http://` traffic carrying source code, testcases, and tokens to remote hosts even when `NODE_ENV=production`. | High | Fixed | Restricted `CODEBOX_ALLOW_INSECURE_HTTP` in production to loopback addresses only (`127.0.0.1`, `localhost`, `::1`). |
| Study Material Draft & Answer Leakage | `src/controllers/study.controller.js` | 100 | Unpublished chapters/topics (`isPublished: false`) were readable directly, `GET /topics/:topicSlug` exposed answer explanations alongside questions, MCQ submissions accepted out-of-range option indexes, and `POST /topics/:topicSlug/submit` had no rate limit. | High | Fixed | Filtered topic reads and submissions to `isPublished: true`, stripped `explanation` from question reads, validated integer bounds against `options.length`, and added `submitLimiter` in `src/routers/study.router.js`. |
| Submission History Persistence & Truncation Handling | `src/controllers/execution.controller.js` | 140, 290 | Extended submission results (`tierReached`, `firstFailure`, `results`, `complexity`, `reward`) lived only in bounded RAM cache and disappeared on eviction/restart, truncated CodeBox batches could fail silently, and language inputs in `/complexity` were unnormalized. | High | Fixed | Added persistent nullable columns in `prisma/schema.prisma` (plus additive migration `20261125000000_persist_submission_details`), threw `503 EXECUTION_UNAVAILABLE` on unexplained truncated batches, avoided redundant tier re-runs, and normalized language inputs. |
| Missing `iss`/`aud` JWT Validation | `src/utils/jwt.js` | 20 | Session tokens were verified without explicit issuer/audience claims, increasing cross-service token confusion risk. | Medium | Fixed | Added `issuer: "calibr8"` and `audience: "calibr8-api"` to both `signSessionToken` and `verifyToken`. |
| Remote Account Login Lockout (DoS) | `src/middlewares/rateLimit.middleware.js` | 109 | Failed login lockouts were keyed only by `email`, allowing an attacker to lock out any victim's account from a remote IP. | Medium | Fixed | Scoped failed-login throttling to `${email}|${clientIpKey(req)}` across `rateLimit.middleware.js` and `src/controllers/auth.controller.js`. |
| Weak Password Validation | `src/controllers/auth.controller.js` | 35 | Password policy allowed common leaked passwords (`Password123`, `12345678`), single-character repeats, or the account holder's name. | Medium | Fixed | Rejected common leaked passwords, single repeated characters, and passwords matching the user's name. |
| Problem Header/Footer Solution Leakage | `src/controllers/problem.controller.js` | 95 | `GET /api/problems/:slug` returned raw `{ header, footer }` template objects from database entries, potentially exposing driver harness internals. | Medium | Fixed | Sanitized `templates` array entries in `getProblemBySlug` to return `{ language, code }` via `getUserTemplate` only. |
| API Console & CORS Production Exposure | `src/app.js` | 41 | Localhost CORS origins and CSP `frame-ancestors *` applied too broadly, and the interactive API console could render unnecessarily when unconfigured. | Medium | Fixed | Restricted default localhost CORS origins and automatic console serving to `development`/`test` (unless `SERVE_API_CONSOLE=true`) and tightened CSP directives (`frame-ancestors 'none'` / `'self'`, minimal source directives). |
| Public Telemetry Disclosure | `src/routers/index.router.js` | 25 | Public `/health/ready` and `/api/health/ready` endpoints leaked internal judge queue concurrency and depth metrics (`judgeAdmissionStats()`). | Medium | Fixed | Removed `judgeAdmissionStats()` from public readiness payloads, returning only service status. |
| Console XSS, Credential Storage & Hardcoded Passwords | `public/index.html` | 810, 1363 | The browser API console stored bearer tokens and `calibr8_api` base URL overrides in `localStorage`, pre-filled hardcoded passwords in forms and demo auto-login code, built HTML with unescaped `onclick="..."` attribute strings, passed unvalidated palette colors into styles, and used `alert()`. | Medium | Fixed | Kept auth tokens strictly in page memory, pinned `API_BASE` to `/api`, removed hardcoded credentials and auto-login requests, replaced inline `onclick` interpolation and `toast.innerHTML` with event listeners and `textContent`, validated palette hex colors, and replaced all `alert()` dialogs with `showToast()`. |
| Free/Default Theme Purchase Bypass & Rate Limits | `src/controllers/theme.controller.js` | 74 | Callers could invoke `POST /:slug/buy` on free/default themes and spam buy/apply endpoints without per-user throttling. | Low | Fixed | Rejected purchases when `theme.isDefault` or `theme.price <= 0`, and added `sessionLimiter` to `src/routers/theme.router.js`. |
| Unvalidated Topic Path Parameters | `src/controllers/topic.controller.js` | 5 | Malformed or oversized `:identifier` / `:slug` values were passed directly into Prisma lookups and string transformations. | Low | Fixed | Enforced `/^[A-Za-z0-9_-]{1,100}$/` validation on `identifier` and `slug` parameters, returning HTTP 400 `INVALID_PARAMETER`. |
| Comment Bypass in Driver & Bridge Builders | `src/utils/codeBuilder.js` | 114 | Commented-out `main()` or `class ListNode` text triggered false rejections or suppressed `ListNode` definitions, and Python driver locals polluted module globals. | Low | Fixed | Stripped comments and string literals before syntax checks across C/C++/Java/Python/JS and scoped Python driver execution inside `_c8_run()`. |
| Scheduler Toggle & Graceful Process Shutdown | `src/server.js` | 65 | `uncaughtException` exited immediately (`process.exit(1)`) without draining HTTP/DB connections or stopping profiling workers, and `dailyProblemService.js` had no flag to disable cron tasks when running horizontal replicas. | Low | Fixed | Routed fatal errors through bounded graceful shutdown (`stopProfilingWorker()`, DB disconnect, 5s force exit), exited non-zero on production DB startup failure, and added `ENABLE_CRON_JOBS=false` support in `src/services/dailyProblemService.js`. |
| Missing Environment Variable Documentation | `.env.example` | 1 | Deployment toggles (`APP_PORT`, `CODEBOX_ALLOW_INSECURE_HTTP`, `ENABLE_CRON_JOBS`, `NODE_ENV`, `SESSION_MAX_AGE_DAYS`) were undocumented. | Low | Fixed | Documented safe placeholder keys and non-secret defaults in `.env.example`. |
| Placeholder Lint Script | `package.json` | 11 | `npm run lint` always printed success without checking JavaScript files. | Low | Fixed | Updated `npm run lint` to run `node --check` recursively across all `.js` and `.mjs` files in `src/` and `tests/`. |

### Safeguards Verified
| Area | File | How It's Protected |
|---|---|---|
| Password Storage | `src/utils/bcrypt.js` | Hashes user passwords with cost factor 12 bcrypt, verifies string inputs safely, and detects older cost hashes for rehash on login. |
| Parameterized Database Access | `src/controllers/problem.controller.js` | All database queries use Prisma ORM parameterized builders with validated, bounded inputs. |
| Judge Admission Control | `src/utils/judgeAdmission.js` | Caps concurrent CodeBox evaluations and queue wait depth with bounded timeouts, rejecting excess load with HTTP 503. |
| Complexity Worker Isolation | `src/services/complexityPool.js` | Runs untrusted-AST parsing inside worker threads with hard size caps (`64 KB`) and wall-clock termination (`COMPLEXITY_TIMEOUT_MS`). |
| OAuth State Integrity | `src/controllers/social.controller.js` | Signs OAuth state payloads using `OAUTH_STATE_SECRET` (enforced distinct from `JWT_SECRET`) with HMAC-SHA256 and timing-safe verification. |

## PoC Verification

### Multi-Case Harness Escape & Parent Memory Disclosure
#### Summary
| Field | Value |
|---|---|
| Issue Type | Sandbox / Process Isolation Bypass |
| Impact | Critical |
| Affected File | `src/utils/multiCaseHarness.js:174,500` |
| Test Scenario | Submitting C++ code with `#include </etc/passwd>`, `operator new`, or qualified `long read(int fd, void* b, unsigned long n) noexcept { return 0; }` |

#### How It Was Fixed
`prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)` now runs immediately at startup before reading stdin so child processes cannot inspect parent memory or descriptors containing unrun testcases, and `isHarnessSafeUserCode` strips comments/string literals and enforces a strict `#include` allowlist alongside balanced `libc` signature scanning.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Code enters `shouldUseMultiCaseHarness` during batch submission in `src/utils/multiCaseHarness.js` | Calls `isHarnessSafeUserCode(userCode)` |
| 2 | `isHarnessSafeUserCode` checks `#include </etc/passwd>`, `operator new`, and qualified `read(...) noexcept {` at `src/utils/multiCaseHarness.js:500` | Returns `false` |
| 3 | Execution falls back to isolated single-case judging without sharing a parent harness process; meanwhile, safe user code compiled with the harness locks parent `PR_SET_DUMPABLE` to `0` at `src/utils/multiCaseHarness.js:174` | **Handled Safely** |

#### Conclusion
**Fix Verified** - Unsafe C/C++ hooks are rejected before harness compilation and parent test data remains non-dumpable across child processes.

---

### Complexity Profiler Unsafe C++ Execution
#### Summary
| Field | Value |
|---|---|
| Issue Type | Missing Pre-Compile Code Safety Gate |
| Impact | Critical |
| Affected File | `src/profiling/profiler.js:310` |
| Test Scenario | Calling `runComplexityProfile` with `__attribute__((constructor)) void pwn(){}` in C++ |

#### How It Was Fixed
`profiler.js` now validates C/C++ submissions with `isHarnessSafeUserCode` before sending source code to CodeBox, throwing a non-retryable `UNSAFE_FOR_PROFILING` error handled cleanly as `INCONCLUSIVE` in `src/profiling/profilingQueue.js`, while `src/profiling/profileHarness.js` sets `PR_SET_DUMPABLE = 0` and closes inherited file descriptors in forked children.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Accepted C++ submission is passed to `runComplexityProfile` in `src/profiling/profiler.js` | Reaches pre-compile safety gate |
| 2 | `src/profiling/profiler.js:310` calls `isHarnessSafeUserCode(userCode)` | Returns `false` |
| 3 | Throws `ProfilingError(..., { code: "UNSAFE_FOR_PROFILING", retryable: false })` | **Handled Safely** |

#### Conclusion
**Fix Verified** - Solutions containing constructor attributes or `libc` hooks are blocked from compiling inside the multi-run profiling binary.

---

### One-Time OAuth Link Code Replay
#### Summary
| Field | Value |
|---|---|
| Issue Type | Multi-Instance Replay Risk in OAuth Linking |
| Impact | High |
| Affected File | `src/controllers/social.controller.js:302` |
| Test Scenario | Replaying the same short-lived OAuth link code concurrently across two `POST /api/social/complete-link` calls |

#### How It Was Fixed
Link codes are encrypted with an HKDF-SHA256 derived key and verified inside a database transaction that atomically inserts `oauth-nonce:<nonce>` into `revoked_tokens`. A duplicate replay hits unique key violation `P2002` and is rejected immediately.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Link code arrives at `completeLink` in `src/controllers/social.controller.js` | Decrypted and TTL checked (2 min) |
| 2 | Transaction attempts `tx.revokedToken.create({ data: { jti: "oauth-nonce:" + payload.nonce, ... } })` at `src/controllers/social.controller.js:302` | First request commits nonce; second hits `P2002` |
| 3 | Duplicate request throws `400 LINK_CODE_USED` | **Handled Safely** |

#### Conclusion
**Fix Verified** - Replay of an already-used link code is rejected atomically at the database layer across all backend instances.

---

### Plaintext CodeBox URL Misconfiguration in Production
#### Summary
| Field | Value |
|---|---|
| Issue Type | Insecure Transport Configuration |
| Impact | High |
| Affected File | `src/utils/codeboxClient.js:40` |
| Test Scenario | Configuring `NODE_ENV=production`, `CODEBOX_ALLOW_INSECURE_HTTP=true`, and `CODEBOX_URL=http://codebox.internal:2358` |

#### How It Was Fixed
`getCodeboxUrl` only honors `CODEBOX_ALLOW_INSECURE_HTTP=true` in production when the hostname resolves to loopback (`127.0.0.1`, `localhost`, or `::1`), refusing remote plaintext URLs with `503 EXECUTION_UNAVAILABLE`.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Code execution calls `getCodeboxUrl(true)` in `src/utils/codeboxClient.js` | Parses URL protocol and host |
| 2 | Evaluates `httpPermitted` at `src/utils/codeboxClient.js:40` with `isProduction=true` and non-loopback `codebox.internal` | Evaluates to `false` |
| 3 | Throws `ApiError(503, ..., "EXECUTION_UNAVAILABLE")` without transmitting tokens or code | **Handled Safely** |

#### Conclusion
**Fix Verified** - Remote unencrypted HTTP CodeBox connections are blocked in production even if `CODEBOX_ALLOW_INSECURE_HTTP=true`.

---

### Browser Console Stored Credentials & DOM Event Injection
#### Summary
| Field | Value |
|---|---|
| Issue Type | Client Token Storage & Inline Event Attribute Injection |
| Impact | Medium |
| Affected File | `public/index.html:1363,1800,3369` |
| Test Scenario | Rendering an API item or theme card whose slug contains quotes, or inspecting `localStorage` after sign-in |

#### How It Was Fixed
Bearer tokens are kept strictly in in-memory JavaScript state (`authToken`) instead of `localStorage`, `API_BASE` is fixed to `/api`, hardcoded credential values and auto-login calls were removed, toast notifications use `textContent`, theme palette colors are checked against `#hex`, and dynamic cards bind DOM event listeners instead of inline `onclick="..."` strings.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | User logs in or loads themes/API cards in `public/index.html` | Token saved only in `let authToken` |
| 2 | Theme colors validated by `safeHexColor` and buttons rendered with `data-theme-action` / `addEventListener` | Special characters stay inert data attributes |
| 3 | No tokens written to `localStorage` and no inline script strings executed | **Handled Safely** |

#### Conclusion
**Fix Verified** - Credentials are never persisted in browser storage or HTML inputs, and rendered controls cannot break out into JavaScript execution.
