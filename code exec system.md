# Calibr8 — Code Execution System (Backend Side)

> **Scope.** This document covers everything the **backend repository** does to execute user code:
>
> - what the frontend sends;
> - every file, function and check the request passes through;
> - the exact HTTP requests the backend sends to the CodeBox VPS;
> - what CodeBox returns and how the backend interprets it;
> - what is judged, stored and rewarded;
> - what goes back to the frontend.
>
> CodeBox itself (its queue, sandbox and Redis) is treated as a **black box**: only its HTTP contract, as used by this backend, is described.
>
> Source of truth is the code. Rebuilt from the code on 2026-11-22. HTTP contracts of all endpoints are also in [APIdetails.md](APIdetails.md).

---

## Contents

1. [Big picture](#1-big-picture)
2. [Files involved](#2-files-involved)
3. [Configuration and constants](#3-configuration-and-constants)
4. [Entry points (routes and middleware)](#4-entry-points-routes-and-middleware)
5. [Step 1 — What the frontend sends](#5-step-1--what-the-frontend-sends)
6. [Step 2 — Request handling: validation, problem loading, code assembly](#6-step-2--request-handling-validation-problem-loading-code-assembly)
7. [Step 3 — The execution dispatcher `executeCodeBatch`](#7-step-3--the-execution-dispatcher-executecodebatch)
8. [Step 4 — What the backend sends to CodeBox and what comes back](#8-step-4--what-the-backend-sends-to-codebox-and-what-comes-back)
9. [Step 5 — Normalised result shape](#9-step-5--normalised-result-shape)
10. [Step 6 — Judging: output comparison, Run, tiered Submit](#10-step-6--judging-output-comparison-run-tiered-submit)
11. [Step 7 — After judging (Submit): persistence, rewards, complexity](#11-step-7--after-judging-submit-persistence-rewards-complexity)
12. [Step 8 — What the backend sends to the frontend](#12-step-8--what-the-backend-sends-to-the-frontend)
13. [Background empirical complexity profiling](#13-background-empirical-complexity-profiling)
14. [Status and verdict vocabulary](#14-status-and-verdict-vocabulary)
15. [Failure matrix](#15-failure-matrix)
16. [Limits, timeouts and concurrency](#16-limits-timeouts-and-concurrency)
17. [Database reads and writes](#17-database-reads-and-writes)
18. [In-memory state and multi-instance caveats](#18-in-memory-state-and-multi-instance-caveats)
19. [Worked example: Two Sum in C++](#19-worked-example-two-sum-in-c)
20. [Edge cases and known quirks](#20-edge-cases-and-known-quirks)
21. [Related scripts and tests](#21-related-scripts-and-tests)

---

## 1. Big picture

```
 Frontend (code editor)
   │  POST /api/execution/run | /submit | /submissions   or   /api/problems/:slug/run | /submit
   │  JSON { slug, language, code }   +  Authorization: Bearer <JWT>
   ▼
 app.js ── security headers · CORS · JSON body ≤ 1 MB · error handler
   ▼
 execution.router.js / problem.router.js
   │  protect | optionalAuth  →  runLimiter (10/min) | submitLimiter (6/min)  →  inFlightLimiter (2 at once)
   ▼
 execution.controller.js  (runCode / submitSolution)
   │ ① validate language + code (≤ 64 KB)
   │ ② resolveProblem(slug)              utils/problemResolver.js   (60 s cache → PostgreSQL)
   │ ③ buildFinalCode(problem, code)     utils/codeBuilder.js       (header + user code + bridge + footer/main)
   │ ④ executeCodeBatch(...)             chooses an execution path:
   │      A. C/C++ multi-case harness    utils/multiCaseHarness.js → POST /submissions?base64_encoded=true&wait=true
   │      B. CodeBox batch API                                     → POST /batches?wait=20000, GET /batches?batchId=…
   │      C. legacy per-testcase batch                             → POST /submissions/batch, GET /submissions/batch?tokens=…
   │      (all via utils/codeboxClient.js: X-Auth-Token header, timeouts, error mapping)
   │                                         │
   │                                         ▼
   │                              CodeBox VPS (Judge0-compatible API, sandboxed compile + run)
   │                                         │ raw results (stdout, status, time, memory, …)
   │ ⑤ normalise raw → { status, actual, timeMs, memoryKb, errorText, … }
   │ ⑥ compare outputs                    utils/outputComparator.js
   │ ⑦ Run: per-case verdicts │ Submit: tiers 1→2→3 with short-circuit, final verdict
   │ ⑧ Submit only: save verdict, rewards, daily problem, solved count, profiling job
   │ ⑨ static complexity                  services/complexityAnalyzer.service.js
   ▼
 JSON response → Frontend      (Submit async: 202 + poll GET /api/execution/submissions/:id)
```

| | **Run** | **Submit** |
|---|---|---|
| Testcases executed | visible (sample) testcases only | **all** testcases, in 3 tiers, stopping at the first failing tier |
| Custom stdin | yes (`/api/execution/run` without a problem) | no |
| Database writes | none | `submissions`, plus rewards tables on accept |
| Rewards | none | score, rating, tier, daily-problem coins and streak, solved count |
| Response | 200 with full per-case details | sync: 200 with verdict (hidden cases redacted); async: 202, then poll |
| Static complexity | yes | yes |
| Empirical profiling | no | queued for accepted submissions when enabled |

---

## 2. Files involved

| File | Role in code execution | Key exports / functions |
|---|---|---|
| [src/app.js](src/app.js) | Express app: CORS, `express.json({ limit: "1mb" })`, error handler. Morgan never logs request bodies, so code is not logged. | – |
| [src/server.js](src/server.js) | Boot: CodeBox health check (`GET ${CODEBOX_URL}/health`), starts the profiling worker | `checkCodeboxEngine` |
| [src/routers/index.router.js](src/routers/index.router.js) | Mounts the execution router at `/api/execution` **and** `/api/execute` | – |
| [src/routers/execution.router.js](src/routers/execution.router.js) | Execution routes and their middleware | – |
| [src/routers/problem.router.js](src/routers/problem.router.js) | Problem-scoped `/:slug/run` and `/:slug/submit` | – |
| [src/middlewares/auth.middleware.js](src/middlewares/auth.middleware.js) | Sets `req.user` (protect / optionalAuth) | `protect`, `optionalAuth` |
| [src/middlewares/rateLimit.middleware.js](src/middlewares/rateLimit.middleware.js) | Run/submit limits; in-flight cap and slot hold for async jobs | `runLimiter`, `submitLimiter`, `inFlightLimiter` (`req.holdInFlightSlot`) |
| [src/middlewares/error.middleware.js](src/middlewares/error.middleware.js) | Converts thrown `ApiError` into JSON | `errorHandler` |
| [src/controllers/execution.controller.js](src/controllers/execution.controller.js) | **The core**: endpoints, dispatcher, the 3 CodeBox paths, normalisers, tiered judging, submission cache | `getLanguages`, `runCode`, `submitSolution`, `getSubmissionStatus`, `getSubmissionComplexity`, `getComplexityAnalysis`, `executeCodeBatch`, `evaluateAllTestcases`, `verdictForFailure`, `compactComplexitySummary` |
| [src/utils/codeboxClient.js](src/utils/codeboxClient.js) | HTTP client for CodeBox: URL validation, auth header, timeout, error mapping | `getCodeboxUrl`, `fetchCodeboxJson` |
| [src/utils/codeBuilder.js](src/utils/codeBuilder.js) | Language normalisation, Judge0 language ids, starter templates, **final program assembly** | `LANGUAGE_IDS`, `SUPPORTED_LANGUAGES`, `normalizeLanguage`, `getUserTemplate`, `buildFinalCode` |
| [src/utils/multiCaseHarness.js](src/utils/multiCaseHarness.js) | C harness appended to C/C++ programs (compile once, fork per testcase), stdin framing, report parser | `supportsMultiCase`, `wrapWithHarness`, `buildHarnessStdin`, `parseHarnessOutput`, `normalizeHarnessCase` |
| [src/utils/outputComparator.js](src/utils/outputComparator.js) | Tolerant comparison of actual and expected output | `normalizeOutput`, `areOutputsEqual` |
| [src/utils/problemResolver.js](src/utils/problemResolver.js) | Loads the problem with testcases and templates (cached) | `resolveProblem`, `updateCachedProblemSolvedCount` |
| [src/utils/testcaseResults.js](src/utils/testcaseResults.js) | Redacts hidden testcases in submit/poll responses | `publicTestResults` |
| [src/utils/acceptedSubmissionReward.js](src/utils/acceptedSubmissionReward.js) | Points, score, Elo rating and tier on a first solve | `applyAcceptedSubmissionReward`, `REWARD_USER_SELECT` |
| [src/utils/problemSolvedCount.js](src/utils/problemSolvedCount.js) | Recomputes `problems.solvedCount` | `syncProblemSolvedCount` |
| [src/utils/userHeaderStats.js](src/utils/userHeaderStats.js) | `stats` object inside rewards | `getUserHeaderStats` |
| [src/utils/ApiError.js](src/utils/ApiError.js) | Error class with status, code, details | `ApiError` |
| [src/services/coinService.js](src/services/coinService.js) | Daily-problem reward entry point | `grantDailyProblemReward` |
| [src/services/dailyProblemService.js](src/services/dailyProblemService.js) | "Is this today's daily problem?", +2 coins, streak | `completeDailyProblemSubmission` |
| [src/services/streakService.js](src/services/streakService.js) | IST dates and streak arithmetic | `getISTDateString`, `computeDailyProblemStreak` |
| [src/services/complexityAnalyzer.service.js](src/services/complexityAnalyzer.service.js) | **Static** time/space analysis of the user's code (no execution) | `analyzeComplexity` |
| [src/profiling/profilingQueue.js](src/profiling/profilingQueue.js) | Background job queue (DB table as the queue), judging priority | `profilingEligibility`, `enqueueComplexityProfile`, `markJudgingStart`/`End`, `startProfilingWorker` |
| [src/profiling/profiler.js](src/profiling/profiler.js) | Builds the profiling program, sends it to CodeBox, analyses measurements | `runComplexityProfile`, `getProfilingConfig` |
| [src/profiling/profileHarness.js](src/profiling/profileHarness.js) | C harness for profiling (fork per measurement) | `wrapWithProfileHarness`, `buildProfileStdin`, `parseProfileOutput` |
| [src/profiling/complexityFit.js](src/profiling/complexityFit.js) | Curve fitting of measurements to O(·) classes | `classifyGrowth`, `classifyTimeWithReference` |
| [src/profiling/registry.js](src/profiling/registry.js) | Which problems can be profiled (currently `add-two-numbers`, C++) | `getProfileDefinition`, `isProfilingSupported` |
| [src/profiling/problems/addTwoNumbers.js](src/profiling/problems/addTwoNumbers.js) | Input generator, validator and C++ profiling driver for Add Two Numbers | `addTwoNumbersProfile` |
| [src/profiling/problems/cppDriverCommon.js](src/profiling/problems/cppDriverCommon.js) | C++ allocation counter and timing helpers for drivers | `CPP_ALLOC_COUNTER`, `CPP_TIMING_HELPERS` |
| [src/profiling/problems/selfTestArray.js](src/profiling/problems/selfTestArray.js) | Test-only profiling definition (never offered to users) | – |
| [prisma/schema.prisma](prisma/schema.prisma) | `Problem`, `Testcase`, `CodeTemplate`, `Submission`, `UserProblemProgress`, `ComplexityProfile`, … | – |
| [problems/*.json](problems/) + [scripts/upload-problem.js](scripts/upload-problem.js), [scripts/bulk-push.js](scripts/bulk-push.js), [scripts/reset-and-upload.js](scripts/reset-and-upload.js), [scripts/seedProblems.js](scripts/seedProblems.js) | Source of testcases and templates loaded into the database | – |

---

## 3. Configuration and constants

### 3.1 Environment variables (execution-related)

| Variable | Default | Effect |
|---|---|---|
| `CODEBOX_URL` | – | Base URL of the CodeBox VPS. **Required**: without it every Run/Submit returns 503 `EXECUTION_UNAVAILABLE`. |
| `CODEBOX_TOKEN` | – | Sent as the `X-Auth-Token` header on every CodeBox request. **Required.** |
| `CODEBOX_ALLOW_INSECURE_HTTP` | `false` | Without `true`, an `http://` URL is rejected (503). HTTPS is always accepted. |
| `CODEBOX_MULTICASE_ENABLED` | `true` | Path A (C/C++ harness). `false` or `0` disables it. |
| `CODEBOX_MULTICASE_MAX_CASES` | 500 | Maximum testcases per harness request (chunk size) |
| `CODEBOX_BATCH_EXECUTION_ENABLED` | `auto` (in code); `.env.example` ships `false` | Path B (`/batches`): `true`/`1` always on, `false`/`0` off, `auto` on until a 404, then off for 10 minutes |
| `CODEBOX_BATCH_WAIT_MS` | 20000 | `?wait=` long-poll window for `/batches` |
| `CODEBOX_BATCH_MAX_CASES` | 200 | Maximum testcases for the "all tiers in ONE batch" submit fast path |
| `CODEBOX_MAX_CONCURRENT_BATCHES` | 2 | Parallel chunks per execution (paths A, B and C) |
| `CODEBOX_MAX_CPU_TIME_LIMIT` | 15 (s) | Sandbox CPU limit for a harness run (path A) |
| `CODEBOX_MAX_WALL_TIME_LIMIT` | 20 (s) | Sandbox wall limit for a harness run (path A) |
| `PROBLEM_CACHE_TTL_MS` | 60000 | Cache of loaded problems with testcases (0 disables) |
| `COMPLEXITY_PROFILING_*` | see [§13](#13-background-empirical-complexity-profiling) | Background profiling |

### 3.2 Constants in code ([execution.controller.js](src/controllers/execution.controller.js) unless noted)

| Constant | Value | Meaning |
|---|---|---|
| Max code size | 64 KB (UTF-8 bytes) | 413 `CODE_TOO_LARGE` |
| JSON body limit | 1 MB ([app.js](src/app.js)) | 413 from the body parser |
| `MAX_CASES_PER_BATCH` | 20 | chunk size for paths B and C |
| `BATCH_POLL_INITIAL_INTERVAL_MS` / `MAX` | 150 / 800 ms (×1.35 per poll) | polling backoff for paths B and C |
| `BATCH_TIMEOUT_MS` | 60 s | polling deadline (path B adds `cases × wall limit`) |
| `BATCH_UNSUPPORTED_RETRY_MS` | 10 min | path B disabled after a 404 in `auto` mode |
| `MULTICASE_POLL_INITIAL_INTERVAL_MS` | 120 ms (×1.25, maximum 800) | path A polling backoff |
| `MULTICASE_MAX_STDIN_BYTES` | 3 MB | stdin bytes per harness chunk (keeps requests under CodeBox's 5 MB body limit after base64) |
| `MULTICASE_MAX_ROUNDS` | 6 | re-runs for cases the harness did not report |
| `WATCHDOG_GRACE_MS` ([multiCaseHarness.js](src/utils/multiCaseHarness.js)) | 1000 ms | parent-side kill delay after the per-case time limit |
| Submission cache | 30 min, 2,000 entries | per-test results for polling |
| `fetchCodeboxJson` default timeout | 15 s | per HTTP call unless overridden |

### 3.3 Language table ([codeBuilder.js](src/utils/codeBuilder.js))

| Canonical key | Accepted input (case-insensitive) | CodeBox `language_id` | Version (as advertised) | Execution paths |
|---|---|---|---|---|
| `cpp` | `cpp`, `c++` | **54** | GCC 13 (C++20) | A → B → C |
| `c` | `c` | **50** | GCC 13 | A → B → C |
| `java` | `java` | **62** | OpenJDK 17 | B → C |
| `python` | `python`, `py`, `python3` | **71** | Python 3.10 | B → C |
| `javascript` | `javascript`, `js`, `node`, `nodejs` | **63** | Node.js 22 | B → C |

---

## 4. Entry points (routes and middleware)

| Route | Auth | Middleware chain | Handler | Mode |
|---|---|---|---|---|
| `GET /api/execution/languages` | Public | – | `getLanguages` | – |
| `POST /api/execution/run` · `/runs` | Protected | `protect` → `runLimiter` → `inFlightLimiter` | `runCode` | sync |
| `POST /api/problems/:slug/run` | Optional | `optionalAuth` → `runLimiter` → `inFlightLimiter` | `runCode` | sync |
| `POST /api/execution/submit` | Protected | `protect` → `submitLimiter` → `inFlightLimiter` | `submitSolution` | **sync** (`req.path === "/submit"`) |
| `POST /api/execution/submissions` | Protected | same | `submitSolution` | **async 202** |
| `POST /api/problems/:slug/submit` | Optional | `optionalAuth` → `submitLimiter` → `inFlightLimiter` | `submitSolution` | **async 202** |
| `GET /api/execution/submissions/:id` | Protected (owner) | `protect` | `getSubmissionStatus` | – |
| `GET /api/execution/submissions/:id/complexity` | Protected (owner) | `protect` | `getSubmissionComplexity` | – |
| `POST /api/execution/analyze-complexity` | Optional | `optionalAuth` → `runLimiter` | `getComplexityAnalysis` | – |

Every `/api/execution/*` route also exists as `/api/execute/*`. On those routes `req.originalUrl` contains `/execute/submit`, so **`POST /api/execute/submit` and `POST /api/execute/submissions` are both synchronous**.

**Sync/async decision** in `submitSolution`. A submission is synchronous if **any** of these holds:

```js
req.originalUrl.includes("/execute/submit")   // /api/execute/submit, /api/execute/submissions
|| req.body.wait === true                     // boolean true only
|| req.query.wait === "true"
|| req.path === "/submit"                     // /api/execution/submit
```

**Middleware effects**

- `runLimiter`: 10 per 60 s, keyed `run:<userId or ip>`. It is shared by every run route **and** analyze-complexity.
- `submitLimiter`: 6 per 60 s, keyed `submit:<userId or ip>`.
- `inFlightLimiter`: at most **2 concurrent execution jobs** per user (or IP when anonymous), across run and submit together. The slot is released when the response finishes or closes. For async submits, the controller calls `req.holdInFlightSlot()` and releases the slot only when background judging settles.

Rejections are 429 `RATE_LIMITED` (see [APIdetails §5](APIdetails.md#5-rate-limiting-and-execution-concurrency)).

---

## 5. Step 1 — What the frontend sends

### 5.1 Headers

```
Content-Type: application/json
Authorization: Bearer <JWT>        (required on /api/execution/*; optional on /api/problems/:slug/*)
```

### 5.2 Body fields (Run and Submit)

| Field (aliases, in precedence order) | Type | Required | Notes |
|---|---|---|---|
| Problem: URL `:slug` → `slug` → `problemSlug` → `problemId` | string | yes (Run custom-input mode excepted) | slug (`two-sum`), problem number (`1`), slug with numeric suffix (`two-sum-2` → `two-sum`) or problem id |
| Language: `language` → `lang` → `?language=` | string | no, default `"cpp"` | see [§3.3](#33-language-table-codebuilderjs) |
| Code: `userCode` → `code` → `source_code` → `sourceCode` | string | **yes** | **only the function/class** shown in the starter template, never `main()`; ≤ 64 KB |
| `stdin` | string | Run only | custom-input mode, used only when no problem identifier is present |
| `wait` | boolean | Submit only | `true` forces a synchronous submit |

### 5.3 Typical payloads

```http
POST /api/execution/run
{ "slug": "two-sum", "language": "cpp",
  "code": "class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        unordered_map<int,int> seen;\n        for (int i = 0; i < (int)nums.size(); i++) {\n            auto it = seen.find(target - nums[i]);\n            if (it != seen.end()) return {it->second, i};\n            seen[nums[i]] = i;\n        }\n        return {};\n    }\n};" }
```

```http
POST /api/execution/submissions          (async; poll afterwards)
{ "problemSlug": "two-sum", "lang": "python", "userCode": "class Solution:\n    def twoSum(self, nums, target):\n        ..." }
```

```http
POST /api/execution/run                  (custom input, no problem)
{ "language": "python", "code": "class Solution:\n    def square(self, n):\n        return n * n", "stdin": "5" }
```

---

## 6. Step 2 — Request handling: validation, problem loading, code assembly

### 6.1 Validation order

Both `runCode` and `submitSolution` check in this order:

1. **Problem identifier** is resolved from params or body (see 5.2).
2. **Language**: `normalizeLanguage(raw)`. `null` gives **422 `UNSUPPORTED_LANGUAGE`** "Unsupported language: 'x'. Supported languages: cpp, c, java, python, javascript."
3. **Code present**: missing or whitespace-only gives **400 `MISSING_CODE`** "Code is required."
4. **Code size**: more than 65,536 UTF-8 bytes gives **413 `CODE_TOO_LARGE`** "Code exceeds maximum allowable size (64 KB)."
5. **Run custom-input mode**: if `stdin !== undefined` and there is no problem identifier, it jumps to `runSingleTestCase` (see 6.5).
6. **Problem**: `resolveProblem(slug)`. Not found gives **404 `NOT_FOUND`** "Problem '<slug>' not found."
7. **Testcases exist**: zero testcases give **422 `NO_TESTCASES`** "This problem has no testcases and cannot be accepted."
8. **Build program**: `buildFinalCode(problem, code, lang)`. A `main` gives **400 `FUNCTION_ONLY_REQUIRED`**.
9. **Run only**: there must be visible testcases, otherwise **400 `NO_TESTCASES`** "No sample test cases configured for this problem."

### 6.2 Problem loading: `resolveProblem` ([problemResolver.js](src/utils/problemResolver.js))

- **Cache**: key is the lowercased identifier; TTL `PROBLEM_CACHE_TTL_MS` (60 s); at most 300 entries; concurrent loads of the same key are de-duplicated. Only hits are cached.
- **Lookup order**:
  1. All digits: `problems.problemNumber`.
  2. Otherwise: `problems.slug`.
  3. Fallback: `findFirst` where the slug equals the input, or the slug with a trailing `-<digits>` removed, or the `id` equals the input.
- **Included relations**: `examples` (by `order`), **`testcases` ordered by `testIndex` ascending**, and `templates`.
- **`templatesMap`**: for each `code_templates` row, keyed by language:
  - if `code` is a JSON string containing `userTemplate`, `header` or `footer`, it is parsed into `{ userTemplate, header, footer }`;
  - otherwise the raw `code` string is kept.

**Testcase fields used by execution**

| Column | Used as |
|---|---|
| `stdinSmall` | the program's **stdin** (sent to CodeBox as-is) |
| `expectedSmall` | the **expected stdout** (compared by the backend, never sent to CodeBox) |
| `isVisible` | visible (sample, used by Run, shown in full) or hidden (Submit only, redacted) |
| `testIndex` | order and identifier |
| `sizeBytes`, `r2Key` | **not used** at runtime. Every input comes from `stdinSmall`. |

**Where the data comes from**: `problems/<slug>.json` is loaded by [scripts/upload-problem.js](scripts/upload-problem.js) (and the bulk scripts):

- `testcases[].input` → `stdinSmall`, `output` → `expectedSmall`;
- `isVisible` defaults to `true` if missing;
- `templates.<lang>` objects are stored as JSON strings `{ userTemplate, header, footer }`.

### 6.3 Code assembly: `buildFinalCode(problem, userCode, language)` ([codeBuilder.js](src/utils/codeBuilder.js))

Users write **only the solution function or class**. The backend wraps it into a complete program whose own `main()` reads stdin, calls the user's function and prints the answer.

**(a) Function-only rule.** Problems are function problems unless `problem.submissionModel` is `stdio`/`stdin`/`standard`, and no problem in the schema has that field. For function problems, the code is rejected with **400 `FUNCTION_ONLY_REQUIRED`** "Do not write main(), only write the required function solution." when it matches any of:

```
/\bmain\s*\(/    /\bint\s+main\b/    /\bvoid\s+main\b/    /\bdef\s+main\b/
```

The check is purely textual, so a comment like `// called from main()` is also rejected.

**(b) Template lookup.** It uses `problem.templatesMap[lang]`, falls back to a `problem.templates` row whose `language` normalises to `lang`, and parses JSON strings.

**(c) Structured template** (`{ header, footer }`, the normal case for every uploaded problem):

1. `header`: includes, imports and type definitions. If the header defines `struct ListNode {…}` **and** the user code defines `struct ListNode {` or `class ListNode {`, the header's definition is removed to avoid a duplicate.
2. `userCode` is inserted verbatim (trimmed).
3. `bridge` (glue code, language-specific):
   - **Python**: if a `Solution` class exists, every public method is also exposed as a global function bound to one `Solution()` instance. If not, a `Solution` class is created with the user's global functions as static methods. So footers can call either style.
   - **JavaScript**: same idea. Methods of `new Solution()` are bound onto `globalThis` when no global of that name exists.
   - **C++**: only for Add Two Numbers. If the code has `class Solution` with `addTwoNumbers` but no free `ListNode* addTwoNumbers(...)`, it adds a free function that calls `Solution().addTwoNumbers`.
   - **C / Java**: no bridge.
4. `footer`: the judge driver. It holds `main()` in C/C++, `public class Main { main(...) }` in Java, and `def main()` / `function main()` plus their calls in Python/JS. It parses stdin, calls the user's function and prints the result.

The final string is:

```js
`${header.trim()}\n\n${userCode.trim()}\n\n${bridge.trim()}\n\n${footer.trim()}\n`
```

**(d) Synthesised wrapper** (no structured template, or `problem === null` in custom-input mode). `getSynthesizedWrapper` provides:

| Language | Header | Footer |
|---|---|---|
| C++ | `#include <bits/stdc++.h>` plus common includes and `using namespace std;`. If the slug looks like a linked-list problem, also a `ListNode` struct, or a `Node` struct when the code uses `Node*`. | only a comment, **no `main`**, so linking fails |
| C | `stdio.h`, `stdlib.h`, `stdbool.h`, `string.h`, plus an optional `ListNode` and `createListNode` | comment only, **no `main`** |
| Java | `import java.util.*; import java.io.*;` plus an optional `ListNode` | empty, **no `main`** |
| Python | `from typing import List, Optional` and `import sys, json`, plus an optional `ListNode` | **generic driver**: reads stdin lines, parses each as JSON, a whitespace-separated int list or an int; picks the first public method of `Solution`, or the last global function; drops a leading length line when the argument count is one more than the parameter count; prints the result (`bool` → `true`/`false`, `list` → space-joined) |
| JavaScript | optional `ListNode` class | **generic driver**: same idea, using `Solution`'s first method, or `solve` / `solution`; arrays are printed space-joined; on exception it writes to stderr and exits 1 |

### 6.4 Example: assembled C++ program (Two Sum)

```cpp
#include <bits/stdc++.h>
using namespace std;

class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        unordered_map<int,int> seen;
        for (int i = 0; i < (int)nums.size(); i++) {
            auto it = seen.find(target - nums[i]);
            if (it != seen.end()) return {it->second, i};
            seen[nums[i]] = i;
        }
        return {};
    }
};



int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    int n, target;
    if (!(cin >> n >> target)) return 0;
    vector<int> nums(n);
    for (int i = 0; i < n; i++) cin >> nums[i];
    Solution sol;
    vector<int> res = sol.twoSum(nums, target);
    if (res.size() >= 2) {
        cout << res[0] << " " << res[1] << "\n";
    }
    return 0;
}
```

The empty lines in the middle are the empty `bridge` slot.

### 6.5 Run custom-input mode: `runSingleTestCase`

This mode is used by `/api/execution/run` when `stdin` is present and no problem identifier is.

1. `buildFinalCode(null, code, lang)` builds a synthesised wrapper (6.3 d). **Build errors do not become HTTP errors here.** They are returned as one result with `status: "Compilation Error"` and the message in `errorText`.
2. `executeCodeBatch({ testcases: [{ stdin }], timeLimit: 3000, memoryLimit: 256 })`.
3. The result is returned with `status` mapped `OK` → `Accepted`. There is no expected output and nothing is compared.

---

## 7. Step 3 — The execution dispatcher `executeCodeBatch`

```ts
executeCodeBatch({
  language,        // canonical key
  fullCode,        // assembled program (6.3)
  testcases,       // [{ stdin }]   (or stdinSmall / input)
  timeLimit,       // ms per testcase   (problem.timeLimit || 2000)
  memoryLimit,     // MB                (problem.memoryLimit || 256)
  allowMultiCase,  // default true
  stopOnTimeout,   // default false; Submit tiers pass true
}) → Promise<NormalizedResult[]>   // same order as `testcases`
```

It is wrapped in `markJudgingStart()` / `markJudgingEnd()` so background profiling jobs wait while judging is in progress ([§13](#13-background-empirical-complexity-profiling)).

### 7.1 Path selection and fallback

```
executeCodeBatch
 │
 ├─ language ∈ {cpp, c}  AND  CODEBOX_MULTICASE_ENABLED  AND  allowMultiCase ?
 │     └─► Path A: executeMultiCaseRounds  ───────────────► results  ✔
 │            on HARNESS_COMPILE_FAILED  ──► continue below (the plain source gives the real compiler error)
 │            on infrastructure error    ──► log "Multi-case path unavailable, falling back", continue below
 │            on any other error         ──► throw
 │
 ├─ isCodeboxBatchExecutionEnabled() ?   ("true" | "auto" and no 404 in the last 10 min)
 │     └─► Path B: chunks of 20 → executeCodeboxBatchOnce (2 in parallel) ──► results ✔
 │            on infrastructure error (not a batch timeout)  ──► continue below
 │            on anything else (incl. batch timeout)          ──► throw
 │
 └─► Path C: legacy /submissions/batch, chunks of 20, 2 in parallel ──► results ✔  (errors are thrown)
```

**What counts as an "infrastructure error"** (`isInfrastructureError`): an `ApiError` with code `EXECUTION_UNAVAILABLE` **that is not** a `/batches` polling timeout (`isBatchTimeout`). Examples:

- CodeBox unreachable or a network error;
- any non-2xx except 401/403;
- an invalid or unparseable response;
- missing tokens or batchId;
- Judge0 status 13 (internal error);
- a missing harness report;
- a harness poll timeout;
- `CODEBOX_URL`/`TOKEN` not configured.

**Never a reason to fall back**: any verdict about the user's code (WA/RE/TLE/MLE/CE), **401/403 from CodeBox** (`EXECUTION_AUTH_FAILED`, 500), and the `/batches` polling timeout. A slow batch API means retrying would only double the wait.

### 7.2 Which path each request uses

| Request | C / C++ (multi-case on) | Java / Python / JS |
|---|---|---|
| Run (visible cases) | A, one request for all visible cases | B in chunks of 20 if enabled, else C |
| Run custom stdin | A, 1 case | B or C, 1 case |
| Submit | **A, one request per tier** (`stopOnTimeout`), at most 3 requests | **B fast path**: all tiers in ONE `/batches` request with `group` and `stop_on_failure` (if B is enabled and the total is ≤ 200). Otherwise per tier: B chunks or C. |

When C/C++ multi-case is disabled, C/C++ follow the Java/Python/JS column.

---

## 8. Step 4 — What the backend sends to CodeBox and what comes back

### 8.0 Shared HTTP client ([codeboxClient.js](src/utils/codeboxClient.js))

**`getCodeboxUrl(required = true)`**:

- requires both `CODEBOX_URL` and `CODEBOX_TOKEN`;
- the URL must parse;
- the protocol must be `https:`, or `http:` with `CODEBOX_ALLOW_INSECURE_HTTP=true`.

Anything else gives `ApiError(503, "Code execution service is unavailable.", "EXECUTION_UNAVAILABLE")`.

**`fetchCodeboxJson(url, options)`**:

- Adds the header **`X-Auth-Token: <CODEBOX_TOKEN>`** (plus the caller's headers; JSON requests add `Content-Type: application/json`).
- Uses `redirect: "error"`, so redirects are never followed (the token is never forwarded elsewhere).
- Applies a timeout via `AbortController`, `options.timeoutMs` (default **15 s**). An external `options.signal` (profiling deadline) also aborts.
- Response mapping:

| CodeBox response | Thrown |
|---|---|
| 401 / 403 | `ApiError(500, "Code execution service authentication failed.", "EXECUTION_AUTH_FAILED")` |
| other non-2xx | `ApiError(503, "Code execution service returned an error status.", "EXECUTION_UNAVAILABLE")` with `httpStatus` set |
| network error, timeout or abort, invalid JSON | `ApiError(503, "Code execution service is unavailable.", "EXECUTION_UNAVAILABLE")` |
| 2xx | parsed JSON body |

**Unit conversions** (the backend stores the time limit in ms and memory in MB):

| | Path A (harness) | Path B (`/batches`) | Path C (legacy) |
|---|---|---|---|
| Per-case time | enforced **inside the harness**: CPU > `timeLimit` ms is a TLE | `cpu_time_limit = max(1, ceil(tl/1000))` **seconds** | `cpu_time_limit = max(1, ceil(tl/1000))` s |
| Wall time | sandbox `wall_time_limit = 20` s for the whole run; per case ≈ `tl + 300` ms (child timer) | `wall_time_limit = max(2, ceil(tl/1000) × 2)` s | `wall_time_limit = cpu × 2 + 1` s |
| Sandbox CPU | `cpu_time_limit = 15` s for the whole run | per case (above) | per case |
| Memory | `memory_limit = MB × 1024` (KB); per-case MLE when `ru_maxrss > MB × 1024` | `memory_limit = MB × 1024` KB | `memory_limit = MB × 1024` KB |
| Processes | `max_processes_and_or_threads = 60` | `60` | not sent |

Example with Two Sum (1000 ms, 256 MB): path B sends `cpu 1 s, wall 2 s, memory 262144`; path C sends `cpu 1 s, wall 3 s, memory 262144`.

### 8.1 Path A — C/C++ multi-case harness

**Goal**: compile once and run every testcase in **one** sandbox, instead of compiling or starting a sandbox per testcase.

#### 8.1.1 Source transformation: `wrapWithHarness(fullCode, language)`

- C sources are prefixed with `#define _GNU_SOURCE 1`, because strict C hides the POSIX declarations the harness needs. C++ is not prefixed: g++ already defines it, and adding it would break the precompiled header.
- The **harness C code** (`HARNESS_C`, about 290 lines in [multiCaseHarness.js](src/utils/multiCaseHarness.js)) is appended after the user's complete program.

How the harness works (this is backend-owned code compiled into the user program):

1. It is an `__attribute__((constructor(101)))` function, so it **runs before `main()`**.
2. It reads the framed stdin header byte by byte, then copies every testcase input into an **unmapped memfd**.
3. It marks itself non-dumpable (`PR_SET_DUMPABLE 0`) and becomes a child-subreaper.
4. It snapshots the entries of `.` and `/tmp`.
5. For each case:
   1. It checks the time budget: it stops starting new cases when `elapsed + timeLimit + 400 ms > budget`.
   2. It copies the case's input into a fresh memfd and zeroes its buffer.
   3. It `fork()`s.
   4. **Child**: new process group; stdin, stdout and stderr redirected to memfds; every other fd closed (including the input memfd holding all other cases); dumpable again; `RLIMIT_CPU = ceil(tl/1000) + 1` s; a real-time itimer of `tl + 300` ms. It then **returns from the constructor and runs the program's real `main()`** unchanged.
   5. **Parent**: a watchdog itimer of `tl + 1000` ms. It waits with `wait4` (which provides CPU time and max RSS), SIGKILLs the case's process group on watchdog expiry and afterwards, reaps leftovers, deletes files created during the case in `.` and `/tmp`, and writes one framed result record.
   6. With flag `STOP_ON_TIMEOUT`, it stops after the first timed-out case.
6. It prints the end marker and calls `_exit(0)`, so the user's `main()` never runs in the parent.

Per-case isolation therefore gives:

- fresh globals and heap for each case;
- no access to other cases' inputs;
- no files carried over between cases;
- per-case memory not inflated by earlier cases;
- time enforced both inside the child and by the parent.

Captured output is limited to **8 MB of stdout** and **4,096 bytes of stderr** per case.

#### 8.1.2 Stdin framing: `buildHarnessStdin(stdins, timeLimitMs, budgetMs, { stopOnTimeout })`

```
C8MC2 <timeLimitMs> <caseCount> <budgetMs> <flags> <payloadBytes>\n
<len0>\n<bytes of case 0>
<len1>\n<bytes of case 1>
…
```

- `timeLimitMs = max(100, problem.timeLimit || 2000)`.
- `budgetMs = min(CODEBOX_MAX_CPU_TIME_LIMIT, CODEBOX_MAX_WALL_TIME_LIMIT) × 1000 − 1500`, which is 13,500 by default.
- `flags` is `1` when `stopOnTimeout` (Submit tiers), else `0`.
- `<len>` is the UTF-8 byte length of the case input. No separator follows the bytes.

#### 8.1.3 HTTP request

```http
POST {CODEBOX_URL}/submissions?base64_encoded=true&wait=true
X-Auth-Token: <CODEBOX_TOKEN>
Content-Type: application/json

{
  "source_code": "<base64( fullCode + HARNESS_C )>",
  "language_id": 54,                         // 50 for C
  "stdin": "<base64( framed stdin )>",
  "cpu_time_limit": 15,                      // CODEBOX_MAX_CPU_TIME_LIMIT
  "wall_time_limit": 20,                     // CODEBOX_MAX_WALL_TIME_LIMIT
  "memory_limit": 262144,                    // problem.memoryLimit (MB) × 1024 → KB
  "max_processes_and_or_threads": 60
}
```

- The request timeout is **40 s**.
- `wait=true` asks CodeBox to hold the request until the run finishes, within its synchronous window, so usually no polling is needed.

#### 8.1.4 Response and polling

The response is a Judge0-style submission object. **Fields the backend reads**: `token`, `status.id`, `stdout`, `compile_output`, `message` (base64).

- Pending means `status.id` is missing, `1` (In Queue) or `2` (Processing). A pending response **without** a `token` gives `EXECUTION_UNAVAILABLE` ("invalid response").
- While pending, the backend sleeps 120 ms (×1.25 each time, maximum 800 ms), then calls `GET {CODEBOX_URL}/submissions/{token}?base64_encoded=true` (15 s timeout each). After a **60 s** deadline: `EXECUTION_UNAVAILABLE` "Code execution service timed out."

Once finished:

| Condition | Backend action |
|---|---|
| `status.id === 6` (Compilation Error), or `compile_output` without `stdout` | Throws `HARNESS_COMPILE_FAILED`. **Never reported as the user's CE directly.** The dispatcher re-judges with the plain source through path B or C, which returns the genuine compiler error. |
| `status.id === 13` (Internal Error) | `EXECUTION_UNAVAILABLE` (falls back) |
| `stdout` does not start with `C8MC1 ` | `EXECUTION_UNAVAILABLE` "Multi-case harness unavailable." (falls back) |
| otherwise | parse the report |

#### 8.1.5 Report format (decoded `stdout`) and `parseHarnessOutput`

```
C8MC1 <caseCount>\n
#C8 <index> <exitCode> <signal> <cpuMs> <wallMs> <maxRssKb> <stdoutLen> <stderrLen>\n<stdout bytes><stderr bytes>
… one record per executed case …
#C8END\n            (or  "#C8END TLE\n"  when it stopped after a definitive TLE)
```

- `exitCode` is `128 + signal` when the case was killed by a signal.
- Parsing stops at the end marker or at the first malformed or truncated record.
- Unreported indices stay `undefined`. They were not run because the budget ran out or the sandbox was killed, and they are **re-run**, never guessed.

#### 8.1.6 Per-case normalisation: `normalizeHarnessCase`

The checks run in this order:

| Check | Result |
|---|---|
| signal SIGXCPU (24) or SIGALRM (14), **or** SIGKILL with `cpuMs ≥ tl` or `wallMs ≥ tl + 1000`, **or** `cpuMs > tl` | `Time Limit Exceeded` |
| `memKb > memoryLimitMb × 1024` | `Memory Limit Exceeded` |
| any signal or `exitCode ≠ 0` | `Runtime Error`. `errorText` is stderr, or "Segmentation fault" for SIGSEGV (11), "Process terminated by signal N", or "Process exited with code N". |
| otherwise | `OK` |

Output fields: `actual = stdout.trim()`, `timeMs = cpuTimeMs = cpuMs`, `wallTimeMs = wallMs`, `memoryKb = maxRssKb`, `memorySource: "max-rss"`, `exitCode`, `inputBytes`.

#### 8.1.7 Chunking, parallelism and rounds

- **Chunks** (`chunkForHarness`): a new chunk starts after 500 cases (`CODEBOX_MULTICASE_MAX_CASES`) or when the stdin would exceed 3 MB (counting 16 bytes overhead per case). Usually everything fits in one chunk.
- **Parallelism**: up to `CODEBOX_MAX_CONCURRENT_BATCHES` (2) chunks at once.
- **Rounds** (`executeMultiCaseRounds`): up to **6 rounds**. Each round sends only the still-unreported cases, compiled again; CodeBox may serve the build from its cache.
  - A round that reports nothing ends the loop.
  - Cases still unreported after the rounds go through `executeCodeBatch(..., allowMultiCase: false)`, which means path B or C.
- **`stopOnTimeout`** (Submit): after a definitive TLE, no further chunks start, and every case after the first TLE is marked `Skipped`.

### 8.2 Path B — CodeBox batch API (`/batches`)

**Enabled when** `CODEBOX_BATCH_EXECUTION_ENABLED` is `true`/`1`, or `auto` (the code default) and no 404 has been seen in the last 10 minutes. A **404** on `POST /batches` sets `batchUnsupportedUntil = now + 10 min`.

#### 8.2.1 Create request (`executeCodeboxBatchOnce`)

```http
POST {CODEBOX_URL}/batches?wait=20000
X-Auth-Token: <CODEBOX_TOKEN>
Content-Type: application/json

{
  "language_id": 71,
  "source_code": "<assembled program, plain text>",
  "testcases": [
    { "stdin": "4 9\n2 7 11 15", "group": 0 },
    { "stdin": "3 6\n3 2 4",     "group": 1 }
  ],
  "stop_on_failure": true,
  "limits": {
    "cpu_time_limit": 1,
    "wall_time_limit": 2,
    "memory_limit": 262144,
    "max_processes_and_or_threads": 60
  }
}
```

- `group` and `stop_on_failure` are sent **only** by the Submit fast path `runAllTiersInOneBatch`. `group` is the tier index 0/1/2.
- `wait` is `CODEBOX_BATCH_WAIT_MS`, a long-poll in which CodeBox holds the request until the batch finishes. The request timeout is `wait + 10 s` (30 s).
- **Response**: `{ batchId | id | batch_id, status, results?, message?, error?, compileError? }`. Without any batch id: `EXECUTION_UNAVAILABLE` "invalid batch response".

#### 8.2.2 Polling

```http
GET {CODEBOX_URL}/batches?batchId=<id>&wait=20000      (timeout 30 s)
```

- The backend repeats until `status` is terminal: `completed`, `compile_failed`, `compile-failed`, `failed`, `timeout`, `cancelled` or `canceled`.
- If CodeBox answered in under 1 s (no long-poll support), it sleeps 150 ms (×1.35, maximum 800 ms) between polls.
- **Deadline**: `60 s + caseCount × wall_time_limit s`. On expiry it throws `EXECUTION_UNAVAILABLE` "Code execution service timed out." with `isBatchTimeout = true`. That error is **not** a fallback reason, so the client gets 503.

#### 8.2.3 Result handling

- `status === "failed"` with **no** results means a CodeBox-internal failure, which is infrastructure: `EXECUTION_UNAVAILABLE`, falls back to path C.
- Results are matched to testcases by `result.index`, else by position. A missing result becomes a fallback record: `Compilation Error` with `compileError`/`error` text for a `compile_failed` batch, otherwise `Runtime Error` with the batch `message`.
- `compile_failed` (any case): **every** case becomes `Compilation Error`, with `errorText` = the case's stderr/compile_output, else the batch message/error, else "Compilation failed."; times and memory are 0.

**Per-result fields read** (several spellings are accepted):

| Field | Accepted names |
|---|---|
| status | `status` / `state` |
| exit code | `exitCode` / `exit_code` |
| output | `stdout`, `stderr`, `compile_output` |
| CPU time (ms) | `timeMs` / `time` / `elapsedMs` |
| wall time (ms) | `wallTimeMs` / `wall_time` |
| memory (KB) | `memory` / `memoryKb` / `memory_kb` |
| signal | `exitSignal` / `exit_signal` |
| other | `memory_source`, `message`, `index` |

**Status mapping** (`normalizeBatchStatus`, case-insensitive):

| CodeBox result status | Normalised |
|---|---|
| `completed`, `done`, `success` | `OK` |
| `skipped` | `Skipped` |
| `compile_failed`, `compile-failed`, `compilation_error`, `compilation-error`, `compile-error`, `ce` | `Compilation Error` |
| `timeout`, `time_limit_exceeded`, `time-limit-exceeded`, `tle` | `Time Limit Exceeded` |
| `memory_limit_exceeded`, `memory-limit-exceeded`, `memory-limit` | `Memory Limit Exceeded` |
| `output_limit_exceeded`, `output-limit-exceeded`, `output-limit` | `Output Limit Exceeded` |
| `cancelled`, `canceled`, `cancelled_by_user`, `cancelled-by-user` | `Cancelled` |
| `failed`, `error`, `runtime_error`, `runtime-error`, anything else | `Runtime Error` |

**Sticky-MLE correction** (`correctStickyMemoryLimit`). CodeBox reuses one cgroup per batch lane, and its "OOM killed" flag is cumulative. After one memory kill, later cases can wrongly report `memory_limit_exceeded`. For a result reported as MLE, the backend therefore checks the following:

| Case | Result |
|---|---|
| The process was **not** SIGKILLed (signal ≠ 9 and exit code ≠ 137) | `OK` if exit 0 and no signal, else `Runtime Error` |
| SIGKILLed, memory not near the limit (< 95 %), and `timeMs ≥ cpu limit` | `Time Limit Exceeded` |
| otherwise | stays `Memory Limit Exceeded` |

**Normalised output**: `{ status, studentStdout: "", actual: stdout.trim(), errorText: stderr || compile_output || message || null, timeMs, cpuTimeMs: timeMs, wallTimeMs, memoryKb, memorySource, exitCode, index, inputBytes }`.

#### 8.2.4 Chunking

- Testcases are sent in chunks of **20**, up to **2** chunks in parallel. After the first chunk compiles, the others hit CodeBox's build cache.
- With `stopOnTimeout`, no new chunk starts after a chunk containing a TLE.
- `finishAfterTimeout` then marks unstarted chunks, and every case after the first TLE, as `Skipped`, so the result does not depend on which parallel chunk finished first.

### 8.3 Path C — Legacy per-testcase batch (`/submissions/batch`)

This is the last resort and always available on a Judge0-compatible server. Each testcase is its own Judge0 submission.

```http
POST {CODEBOX_URL}/submissions/batch?base64_encoded=false          (timeout 15 s)
{
  "submissions": [
    { "source_code": "<program>", "language_id": 62, "stdin": "4 9\n2 7 11 15",
      "cpu_time_limit": 1, "wall_time_limit": 3, "memory_limit": 262144 },
    … up to 20 per request …
  ]
}
```

- **Response**: an array or `{ submissions: [...] }` with a `token` per submission. The count must match and every entry must have a token, otherwise `EXECUTION_UNAVAILABLE`.
- **Polling**: `GET {CODEBOX_URL}/submissions/batch?tokens=<t1,t2,…>&base64_encoded=false` (15 s timeout). The first poll is immediate, then the backend sleeps 150 ms (×1.35, maximum 800 ms) between polls. A missing token in the reply gives `EXECUTION_UNAVAILABLE`. Polling ends when no submission has `status.id` 1 or 2. **Deadline 60 s**, then `EXECUTION_UNAVAILABLE` "Code execution service timed out."
- **Fields read** per submission: `status.id`, `stdout`, `stderr`, `compile_output`, `message`, `time` (seconds, string), `wall_time` (seconds), `memory` (KB), `exit_code`, `memory_source`.

**Status mapping** (`normalizeRunnerResult`):

| Judge0 `status.id` | Meaning | Normalised |
|---|---|---|
| 5 | Time Limit Exceeded | `Time Limit Exceeded` |
| 6, or any `compile_output` present | Compilation Error | `Compilation Error` |
| 7–12 | Runtime errors (SIGSEGV, SIGXFSZ, SIGFPE, SIGABRT, NZEC, other) | `Runtime Error` |
| ≥ 13 | Internal error / exec format error | `Runtime Error` |
| 3 (and anything else) | Accepted | `OK` |

- The backend never sends `expected_output`, so CodeBox never judges correctness. Status 4 (Wrong Answer) cannot occur, and output comparison is always done by the backend.
- This path has no dedicated MLE detection.
- Times: `timeMs = round(time × 1000)` and `wallTimeMs = round(wall_time × 1000)`. `exitCode` falls back to 0 for OK, else 1.

### 8.4 Boot-time health check

[src/server.js](src/server.js) `checkCodeboxEngine()`: `GET {CODEBOX_URL}/health` with a 3 s timeout and **no token**, called once after the server starts listening.

- On success it logs `✅ Successfully connected to Codebox exec engine (<status>)`.
- On failure it logs `❌ Codebox OFF …`.

It never blocks startup or changes behaviour.

---

## 9. Step 5 — Normalised result shape

Every path produces this per-case object for the judging code (the "NormalizedResult"):

```ts
interface NormalizedResult {
  status: "OK" | "Time Limit Exceeded" | "Memory Limit Exceeded" | "Runtime Error"
        | "Compilation Error" | "Output Limit Exceeded" | "Cancelled" | "Skipped";
  actual: string;            // program stdout, trimmed
  studentStdout: "";         // reserved, always empty
  errorText: string | null;  // stderr / compiler output / sandbox message
  timeMs: number;            // CPU ms
  cpuTimeMs: number;         // CPU ms
  wallTimeMs: number;        // wall ms
  memoryKb: number;          // peak RSS KB
  memorySource: string;      // "max-rss" (or CodeBox-provided)
  exitCode: number | null;
  inputBytes: number;        // UTF-8 bytes of the stdin
  index?: number;            // path B only
}
```

`Skipped` means the case was intentionally not run, after a definitive TLE with `stopOnTimeout`, or because CodeBox's `stop_on_failure` skipped it.

---

## 10. Step 6 — Judging: output comparison, Run, tiered Submit

### 10.1 Output comparison: `areOutputsEqual(actual, expected)` ([outputComparator.js](src/utils/outputComparator.js))

The comparison is only applied when the execution status is `OK`.

`normalizeOutput(v)` works on the trimmed string:

1. If it parses as JSON: arrays and objects become `JSON.stringify` of the parsed value, booleans become `"true"`/`"false"`, numbers become `String(n)`.
2. Else `true`/`yes` (case-insensitive) becomes `"true"`, and `false`/`no` becomes `"false"`.
3. Else, if there is more than one whitespace-separated token and all are numeric: a JSON number array.
4. Else, if there is more than one comma-separated token and all are numeric: a JSON number array.
5. Else the trimmed string.

`areOutputsEqual` returns true if **any** of these hold:

- the normalised forms are equal;
- the whitespace-collapsed strings are equal (so `"1\n2"` equals `"1 2"`);
- both normalised forms parse as JSON and are deeply equal;
- a one-element array equals the other scalar;
- the trimmed raw strings are equal.

| actual | expected | equal? |
|---|---|---|
| `0 1` | `[0, 1]` | ✔ |
| `0, 1` | `0 1` | ✔ |
| `Yes` | `true` | ✔ |
| `1.0` | `1` | ✔ (numeric) |
| `[5]` | `5` | ✔ |
| `1 0` | `0 1` | ✘ (order matters) |
| `Hello` | `hello` | ✘ (case-sensitive, except true/false/yes/no) |

### 10.2 Run (`runCode`)

1. Executes the **visible** testcases (problem order) in one `executeCodeBatch` call, with `timeLimit = problem.timeLimit || 2000` and `memoryLimit = problem.memoryLimit || 256`. `stopOnTimeout` is false, so every case runs.
2. For each case:
   - if the status is `OK`, it compares the output: a match gives `Accepted`, otherwise `Wrong Answer`;
   - any other status (TLE, RE, CE, …) is kept as is and the case fails.
3. Overall `verdict` is `Accepted` if all cases pass, else **the first failing case's status**.
4. Static complexity: `analyzeComplexity({ code, language, executionResult: { timeMs: max, memoryKb: max }, include: ["time","space"] })`, compacted. Errors are swallowed and give `null`.

### 10.3 Submit (`evaluateAllTestcases`)

**Tier split** over **all** testcases in `testIndex` order (`n` = number of testcases):

```
tier1Count = max(1, floor(n × 0.35))
tier2End   = max(tier1Count + 1, floor(n × 0.70))
Tier 1 = cases[0 .. tier1Count)     Tier 2 = cases[tier1Count .. tier2End)     Tier 3 = cases[tier2End .. n)
```

| n | Tier 1 | Tier 2 | Tier 3 | Best possible `tierReached` |
|---|---|---|---|---|
| 1 | [0] | – | – | Tier 1 (Brute Force) |
| 2 | [0] | [1] | – | Tier 2 (Better) |
| 3 | [0] | [1] | [2] | Tier 3 (Optimal) |
| 5 | [0] | [1–2] | [3–4] | Tier 3 |
| 10 | [0–2] | [3–6] | [7–9] | Tier 3 |
| 20 | [0–6] | [7–13] | [14–19] | Tier 3 |
| 100 | [0–34] | [35–69] | [70–99] | Tier 3 |

Visible and hidden cases are mixed in that order; uploaded problems usually put visible cases first.

**Execution strategy**

- **Java / Python / JS, or C/C++ with multi-case disabled**: the fast path `runAllTiersInOneBatch` is tried first. It requires path B to be enabled and `n ≤ 200`. It makes one `/batches` request with every case, `group = tierIndex` and `stop_on_failure: true`, so CodeBox skips later groups once a case **crashes or times out**.
  - CodeBox does not know expected outputs, so a **Wrong Answer** does not stop CodeBox, but the backend still short-circuits and ignores later tiers.
  - The result is split back per tier.
  - If the fast path returns `null` (B disabled, `n > 200`, or an infrastructure error), each tier is executed separately.
- **C / C++ with multi-case enabled**: no fast path. **Each tier is one `executeCodeBatch` call with `stopOnTimeout: true`**, so at most 3 CodeBox requests are made, and a failing tier prevents the later requests.

**Per-tier loop**

```
for tier in [Tier 1, Tier 2, Tier 3]:
    skip if the tier is empty or an earlier tier failed
    results = precomputed[tier]
    if results are missing, the wrong length, or any is "Skipped":
        results = executeCodeBatch(tier cases, stopOnTimeout = true)
    for each case:
        if status == "Skipped": continue            # not run, not counted, not in results
        maxTimeMs   = max(maxTimeMs, timeMs)
        maxMemoryKb = max(maxMemoryKb, memoryKb)
        passed = status == "OK" and areOutputsEqual(actual, expected)
        failureType = status, or "Wrong Answer" when OK but the output differs
        push a case result
        if not passed:
            mark the tier failed
            on the first failure: finalStatus = verdictForFailure(failureType); build firstFailure
    if the tier failed: tierReached = tier.rankIfFailed; stop
    else:               tierReached = tier.rankIfPassed
```

| Tier | `rankIfPassed` | `rankIfFailed` |
|---|---|---|
| 1 | Tier 1 (Brute Force) | Tier 0 (Failed) |
| 2 | Tier 2 (Better) | Tier 1 (Brute Force) |
| 3 | Tier 3 (Optimal) | Tier 2 (Better) |

Within a failing tier, **every** case is still evaluated and reported, except cases `Skipped` after a TLE.

**Verdict mapping** (`verdictForFailure(firstFailureType)`):

| First failure | Submission `status` |
|---|---|
| none | `ACCEPTED` |
| Time Limit Exceeded | `TIME_LIMIT_EXCEEDED` |
| Memory Limit Exceeded | `MEMORY_LIMIT_EXCEEDED` |
| Compilation Error | `COMPILATION_ERROR` |
| Runtime Error, Output Limit Exceeded | `RUNTIME_ERROR` |
| Wrong Answer, Cancelled, anything else | `WRONG_ANSWER` |

**`firstFailure`**

- Visible case: `{ testIndex, status, errorText, input, expected, actual, message: "Failed sample test <k>: expected '<e>', got '<a>'" }`.
- Hidden case: `{ testIndex, status, errorText: null, message: "Failed on hidden evaluation test case #<k>." }`, with no input, expected or actual. `k` is the 1-based position in `results`, not the `testIndex`.

**Return value**: `{ status, tierReached, passedCount, totalCount: n, maxTimeMs, maxMemoryKb, firstFailure, results }`.

---

## 11. Step 7 — After judging (Submit): persistence, rewards, complexity

### 11.1 Timeline of `submitSolution`

```
validate → resolveProblem → buildFinalCode
   │
   ├── createSubmissionRow()  INSERT submissions(status=PROCESSING, totalCount=n)
   │       sync  mode: started in parallel with execution, awaited before the verdict update
   │       async mode: awaited BEFORE replying 202 (the id is needed for pollUrl)
   │       failure: logged-in → 503 SUBMISSION_STORAGE_UNAVAILABLE; anonymous → continue with "sub_<ts>_<rand>"
   │       then submissionCache.set(id, {...PROCESSING})
   │
   ├── priorSolvePromise        SELECT user_problem_progress(userId, problemId) + user stats   (logged-in only)
   ├── rewardPrefetchPromise    if not solved before: SELECT user (REWARD_USER_SELECT) + COUNT(user_problem_progress)
   │       (both run while the code executes; errors give null)
   │
   └── runEvaluation()
          evaluation = evaluateAllTestcases(...)                ← CodeBox calls happen here
          await submissionSaved (sync mode)
          isAccepted = status == ACCEPTED && totalCount > 0 && passedCount == totalCount
          in parallel:
            ├─ rewardsChain()     (only logged-in && accepted)
            ├─ verdictChain()
            └─ complexityTask     analyzeComplexity(include time+space), errors → null
          if accepted && verdict persisted && profiling eligible → enqueueComplexityProfile (background)
          submissionCache.set(id, full result)
```

### 11.2 `verdictChain`

1. `UPDATE submissions SET status, passedCount, totalCount, time = "<maxTimeMs>ms", memory = <maxMemoryKb>`.
2. If logged-in, accepted, and **not solved before**: `syncProblemSolvedCount`. It runs `COUNT(DISTINCT userId)` over fully passed ACCEPTED submissions, falling back to a JS count, then `UPDATE problems.solvedCount`. `updateCachedProblemSolvedCount` patches the cached problem and drops the catalogue cache. Errors here are logged and ignored.

### 11.3 `rewardsChain` (logged-in and accepted only)

1. **Solve reward**:
   - Already solved (`priorSolve`): `reward = { awarded: false, points: 0, scoreDelta: 0, coinsEarned: 0, stats }`, with no writes.
   - First solve: one transaction `applyAcceptedSubmissionReward`:
     - `INSERT user_problem_progress (points, scoreAwarded = points × 10, coinsAwarded = 0)` with `skipDuplicates`. If 0 rows are inserted (a race), it returns awarded false.
     - Computes the Elo rating: K = 60 while the user has ≤ 10 solves, else 32. The problem rating is 800, 1200 or 1600 for easy, medium or hard.
     - `UPDATE users SET score += points × 10, rating, tier`.
     - Points are 10, 25 or 50 for easy, medium or hard (see [APIdetails §20](APIdetails.md#20-gamification-rules)).
   - Errors give `rewardError = true`; the verdict is unaffected.
2. **Daily problem**: `grantDailyProblemReward(userId, problemId, submissionId)` calls `completeDailyProblemSubmission`:
   1. It reads today's daily problem from a 60 s cache (creating it if missing). If this problem is not today's: `granted: false`.
   2. In one transaction:
      - existing completion or `DAILY_PROBLEM` coin transaction today: `ALREADY_COMPLETED`;
      - compute the streak;
      - `INSERT daily_problem_completions`;
      - `UPDATE users coins += 2, streak, longestStreak, lastStreakDate`;
      - `INSERT coin_transactions(+2, DAILY_PROBLEM, referenceId = submissionId)`.
   3. If granted: `dailyProblemReward = { granted: true, coins: 2 }`, `reward.coinsEarned += 2`, and `reward.stats.coins` = the new balance.

If either chain throws, logged-in callers get **503 `SUBMISSION_STORAGE_UNAVAILABLE`** "Unable to save the submission verdict. Please try again." In async mode this becomes status `ERROR`. For anonymous callers it is ignored (`verdictPersisted = false`).

### 11.4 Static complexity (Run and Submit)

`analyzeComplexity` ([complexityAnalyzer.service.js](src/services/complexityAnalyzer.service.js)) parses the **user's code only**: Babel AST for JS, an indentation scanner for Python, a brace scanner for C/C++/Java.

- It estimates time and auxiliary/output space from loops, recursion, library calls and allocations.
- It never executes anything.
- Results are cached by `sha256(code :: language :: version)`.

The controller compacts the result to `{ time: { bestEstimate, confidence }, space: { bestEstimate, confidence }, summary }`.

### 11.5 Submission cache

`submissionCache` is an in-memory `Map` with a 30-minute TTL and at most 2,000 entries (the oldest is evicted), swept every 5 minutes. It holds what the database does not store: `results`, `firstFailure`, `tierReached`, `reward`, `rewardError`, `dailyProblemReward`, `complexity`, `complexityProfile`.

### 11.6 Async background failure

`runEvaluation().catch()` logs `[Submission Background Error]`, caches `{ status: "ERROR" }` and runs `UPDATE submissions SET status = 'ERROR'`. The `finally` block releases the held in-flight slot.

---

## 12. Step 8 — What the backend sends to the frontend

### 12.1 Run → 200

```json
{
  "success": true,
  "verdict": "Accepted",
  "status": "Accepted",
  "passedCount": 2,
  "totalCount": 2,
  "results": [
    { "index": 0, "testIndex": 0, "isVisible": true,
      "input": "4 9\n2 7 11 15", "expected": "0 1", "actual": "0 1", "studentStdout": "",
      "status": "Accepted", "passed": true,
      "timeMs": 2, "cpuTimeMs": 2, "wallTimeMs": 3, "memoryKb": 3520, "inputBytes": 13, "errorText": null }
  ],
  "complexity": { "time": { "bestEstimate": "O(n)", "confidence": "high" },
                  "space": { "bestEstimate": "O(n)", "confidence": "medium" },
                  "summary": "Time: O(n), Space: O(n) auxiliary, O(1) output (O(n) total)" }
}
```

- On a compile error every case has `status: "Compilation Error"` and `errorText` holds the compiler output.
- Custom-input mode returns a single result with no `isVisible`, no `cpuTimeMs`/`wallTimeMs`/`inputBytes`, and no `complexity`.

### 12.2 Submit (sync) → 200

```json
{
  "success": true, "submissionId": "cm…", "verdict": "ACCEPTED", "status": "ACCEPTED",
  "tierReached": "Tier 3 (Optimal)", "passedCount": 5, "totalCount": 5,
  "time": "3ms", "memory": 3540,
  "results": [ /* publicTestResults(...) */ ],
  "firstFailure": null,
  "complexity": { /* compact */ },
  "complexityProfile": null,
  "reward": { "awarded": true, "points": 10, "scoreDelta": 100, "coinsEarned": 0, "stats": { /* UserHeaderStats */ } },
  "rewardError": false,
  "dailyProblemReward": { "granted": false, "coins": 0 },
  "problem": { "slug": "two-sum", "title": "Two Sum" }
}
```

**`publicTestResults`** ([testcaseResults.js](src/utils/testcaseResults.js)):

- Visible cases are returned in full: `testIndex, input, expected, actual, passed, isVisible, time, timeMs, cpuTimeMs, wallTimeMs, memory, memoryKb, inputBytes, status, errorText`.
- **Hidden cases are reduced to** `{ testIndex, isVisible: false, passed, status, time, memory }`, with no input, expected output, actual output or error text. Hidden testcase data never leaves the backend.

### 12.3 Submit (async) → 202, then poll

```json
{ "success": true, "submissionId": "cm…", "verdict": "QUEUED", "status": "QUEUED",
  "pollUrl": "/api/execution/submissions/cm…", "message": "Submission received and queued for execution.",
  "problem": { "slug": "two-sum", "title": "Two Sum" } }
```

The frontend polls `GET /api/execution/submissions/:id` (with the same token) while `submission.status === "PROCESSING"`.

How `getSubmissionStatus` builds the reply:

1. It reads the database row (id, problemId, userId, language, status, counts, time, memory, createdAt, problem slug/title).
2. 404 `SUBMISSION_NOT_FOUND` if the row is missing or the caller is not the owner.
3. It merges cached `results`, `complexity`, `firstFailure`, `tierReached`, `reward` and `dailyProblemReward`.
4. For ACCEPTED submissions it reads `complexity_profiles` (status, time/space complexity, confidence).
5. If `tierReached` is not cached, it derives it from the counts: ACCEPTED → Tier 3; ≥ 70 % → Tier 2; ≥ 35 % → Tier 1; else Tier 0.
6. It returns `{ success, submission: { … same fields as the sync response … } }`, with hidden cases redacted again.

### 12.4 Complexity endpoints

- `GET /api/execution/submissions/:id/complexity`: the empirical profile ([§13](#13-background-empirical-complexity-profiling); full shape in [APIdetails §13.5](APIdetails.md#135-get-apiexecutionsubmissionsidcomplexity--owner)).
- `POST /api/execution/analyze-complexity`: static analysis only, no CodeBox call ([APIdetails §13.6](APIdetails.md#136-post-apiexecutionanalyze-complexity--optional--run-limiter)).

---

## 13. Background empirical complexity profiling

An optional system that **measures** an accepted solution's time and space growth by running it on increasingly large generated inputs on CodeBox. **It never affects a verdict.** It is off unless `COMPLEXITY_PROFILING_ENABLED=true`, and is currently available only for `add-two-numbers` in `cpp` ([registry.js](src/profiling/registry.js)).

### 13.1 Configuration (`getProfilingConfig`)

| Variable | Default | Meaning |
|---|---|---|
| `COMPLEXITY_PROFILING_ENABLED` | false | master switch |
| `_CONCURRENCY` | 1 | jobs at once per backend |
| `_MAX_INPUT_SIZE` | 16000 | largest generated `n`. Sizes double from 250, so the default gives 7 sizes. |
| `_REPETITIONS` | 3 (1–10) | timed repetitions per size |
| `_TIMEOUT_MS` | 90000 | hard job deadline; aborts CodeBox requests |
| `_MAX_PENDING` | 50 | backlog (PENDING + RUNNING) limit; beyond it new profiles are stored as FAILED "queue is full" |
| `_MAX_ATTEMPTS` | 3 | retries for infrastructure errors |
| `_CPU_LIMIT_SEC` / `_WALL_LIMIT_SEC` / `_MEMORY_LIMIT_MB` | 15 / 20 / 512 | sandbox limits for the profiling run |
| `_PER_RUN_LIMIT_MS` / `_STOP_ABOVE_MS` | 3000 / 1200 | per-invocation limit / CPU above which larger sizes are skipped |

### 13.2 Flow

1. **Eligibility** (`profilingEligibility`, no DB access): enabled, and the registry has a driver for (slug, language). The submit response then includes `complexityProfile: { status: "PENDING", url }`.
2. **Enqueue** (`enqueueComplexityProfile`, never throws):
   - counts the backlog;
   - inserts `complexity_profiles { submissionId (unique), language, problemSlug, status: PENDING }`, or `FAILED` when the queue is full;
   - a duplicate (`P2002`) returns the existing status;
   - calls `kick()`.
3. **Worker** (`kick`, event-driven, no idle polling): while `running < concurrency`, it atomically claims the oldest due job:

   ```sql
   UPDATE complexity_profiles SET status='RUNNING', startedAt=NOW(), attempts=attempts+1, updatedAt=NOW()
   WHERE id = (SELECT id FROM complexity_profiles WHERE status='PENDING' AND nextAttemptAt <= NOW()
               ORDER BY createdAt LIMIT 1 FOR UPDATE SKIP LOCKED)
   RETURNING id, submissionId, attempts, language, problemSlug
   ```

   When nothing is due, it schedules a timer for the next `nextAttemptAt`. On a DB error it retries in 30 s.
4. **Judging priority** (`yieldToJudging`): the job waits, up to 15 s, while any `executeCodeBatch` is in progress (`markJudgingStart`/`End` counters).
5. **Job** (`processJob`):
   - loads the submission's code, language, status and problem templates; FAILED if the submission is missing or not ACCEPTED;
   - starts an abort timer (`_TIMEOUT_MS`);
   - calls `runComplexityProfile`.
6. **`runComplexityProfile`** ([profiler.js](src/profiling/profiler.js)):
   1. Generates inputs for each size ≤ `MAX_INPUT_SIZE` with the definition's deterministic generator. For Add Two Numbers the pattern is `max-carry`: all 9s, the worst case. Each input is validated. The largest sizes are dropped while the total stdin exceeds 1 MB.
   2. Plans runs: per size, a **baseline** run (1 repetition, a no-op function, to measure overhead) and a **user** run (`REPETITIONS`, reusing the same input).
   3. Builds the program: the problem's **header** + the user code + the problem's **profiling driver**, which **replaces the judge footer/main**. The driver times the solution against a reference O(n) implementation, counts heap allocations through `operator new`, and verifies the output. Then `wrapWithProfileHarness` appends the profiling harness.
   4. Frames the stdin (`buildProfileStdin`):

      ```
      C8PF1 <runCount> <perRunTimeLimitMs> <budgetMs> <stopAboveCpuMs> <payloadBytes>\n
      per run: "<repetitions> <tag>\n<inputLength>\n<inputBytes>"   (inputLength -1 = reuse previous input)
      ```

      Here `budgetMs = min(cpu, wall) × 1000 − 1500`.
   5. Sends it to CodeBox:

      ```http
      POST {CODEBOX_URL}/submissions?base64_encoded=true&wait=true        (timeout 40 s, abortable)
      { "source_code": "<base64>", "language_id": 54, "stdin": "<base64>",
        "cpu_time_limit": 15, "wall_time_limit": 20,
        "memory_limit": 512000,                 // min(MB × 1024, 512000): CodeBox's maximum
        "max_processes_and_or_threads": 60 }
      ```

      While pending it polls `GET /submissions/{token}?base64_encoded=true` **every 2 s** (gentle, to share CodeBox's per-client rate limit), for up to 60 s. It then sends **`DELETE /submissions/{token}`** (best effort, 5 s) to free CodeBox's Redis payload storage immediately.
   6. Handles the response:
      - status 6 gives `PROFILE_COMPILE_FAILED`, not retryable;
      - status 13 gives a retryable `EXECUTION_UNAVAILABLE`;
      - no `C8PF1` report gives `PROFILE_NO_REPORT`, which becomes INCONCLUSIVE.

      The report format is:

      ```
      C8PF1 <runCount>\n
      #P <run> <rep> <exitCode> <signal> <cpuMs> <wallMs> <maxRssKb> <outLen> <errLen>\n<out><err>
      #PEND <done|failed|slow|budget>\n
      ```

      Each invocation's stdout carries a driver line `C8M v=1 ok=… median_ns=… heap_peak=… ref_median_ns=… …`.
   7. Analyses the measurements ([complexityFit.js](src/profiling/complexityFit.js)):
      - **time**: the per-size median call time minus timer overhead (best repetition), fitted to O(1) … O(n!) by weighted least squares; for Add Two Numbers it is normalised against the reference implementation;
      - **space**: auxiliary bytes = peak heap minus output nodes, plus stack;
      - it produces confidence values (High / Medium / Low / Inconclusive) and notes.
7. **Stores** the result in `complexity_profiles`: status `COMPLETED` or `INCONCLUSIVE`, the time/space complexity and confidence, `inputSizes`, `measurements`, `baseline`, `analysis`, `durationMs`, `failureReason`.
   - Retryable errors go back to `PENDING` with `nextAttemptAt = now + 30 s × attempts`, while `attempts < MAX_ATTEMPTS`.
   - Other errors give `FAILED`, or `INCONCLUSIVE` for `PROFILE_NO_REPORT`.
8. **Restart recovery** (`startProfilingWorker`): `RUNNING` rows older than `timeout + 60 s` go back to `PENDING` (or to `FAILED` when attempts are exhausted), at startup and once more after `timeout + 61 s`.

---

## 14. Status and verdict vocabulary

| Layer | Values |
|---|---|
| CodeBox raw (path A) | Judge0 `status.id` for the whole harness run, plus per-case `exitCode`/`signal`/`cpuMs`/`memKb` in the report |
| CodeBox raw (path B) | per-result `status` strings (table in 8.2.3) |
| CodeBox raw (path C) | Judge0 `status.id` per testcase (table in 8.3) |
| Normalised (`NormalizedResult.status`) | `OK`, `Time Limit Exceeded`, `Memory Limit Exceeded`, `Runtime Error`, `Compilation Error`, `Output Limit Exceeded`, `Cancelled`, `Skipped` |
| Case status sent to the frontend | `Accepted` (OK and the output matches), `Wrong Answer` (OK but it does not), or the normalised status. `Skipped` never appears: in Submit those cases are dropped, and Run never skips. |
| Run `verdict` | `Accepted` or the first failing case status |
| Submission `status` / `verdict` | `PROCESSING` → `ACCEPTED` / `WRONG_ANSWER` / `TIME_LIMIT_EXCEEDED` / `MEMORY_LIMIT_EXCEEDED` / `RUNTIME_ERROR` / `COMPILATION_ERROR`, or `ERROR`; `QUEUED` appears only in the 202 response |
| `tierReached` | `Tier 0 (Failed)`, `Tier 1 (Brute Force)`, `Tier 2 (Better)`, `Tier 3 (Optimal)` |
| Profile `status` | `PENDING`, `RUNNING`, `COMPLETED`, `INCONCLUSIVE`, `FAILED` (or `UNAVAILABLE` when no row exists) |

---

## 15. Failure matrix

| Situation | What the backend does | What the frontend gets |
|---|---|---|
| `CODEBOX_URL` or `CODEBOX_TOKEN` missing, or an `http://` URL without `CODEBOX_ALLOW_INSECURE_HTTP` | `getCodeboxUrl` throws on every path | **503 `EXECUTION_UNAVAILABLE`** "Code execution service is unavailable." |
| CodeBox down, network error, timeout, 5xx/429, bad JSON | path A falls back to B, which falls back to C; C throws | **503 `EXECUTION_UNAVAILABLE`** |
| CodeBox rejects the token (401/403) | thrown immediately (no fallback) | **500 `EXECUTION_AUTH_FAILED`** "Code execution service authentication failed." |
| `/batches` returns 404 (old CodeBox) | path B disabled for 10 minutes in `auto` mode; falls back to C | a normal verdict |
| `/batches` still running at its deadline | not a fallback reason | **503 `EXECUTION_UNAVAILABLE`** "Code execution service timed out." |
| `/batches` returns `failed` with no results | infrastructure error; falls back to C | a normal verdict |
| Harness program does not compile (usually the user's compile error) | re-judged with the plain program on B or C | `Compilation Error` with the real compiler output |
| Harness produced no report / status 13 / poll timeout | falls back to B or C | a normal verdict |
| Harness ran out of budget before all cases | up to 6 rounds, then B or C for the remainder | a normal verdict, never guessed |
| User code: infinite loop | harness: child timer `tl + 300` ms / RLIMIT_CPU / watchdog `tl + 1000` ms; B and C: sandbox limits | `Time Limit Exceeded` / `TIME_LIMIT_EXCEEDED`; later cases of the tier `Skipped` (dropped) |
| User code: crash (segfault, exception, non-zero exit) | | `Runtime Error` / `RUNTIME_ERROR`, with `errorText` for visible cases |
| User code: too much memory | harness: `ru_maxrss > limit`; B: CodeBox status (with sticky-MLE correction); C: usually Runtime Error | `Memory Limit Exceeded` / `MEMORY_LIMIT_EXCEEDED` (or Runtime Error on path C) |
| User code: huge output | B: `output_limit_exceeded`; harness: stdout captured up to 8 MB | Run: `Output Limit Exceeded`; Submit: `RUNTIME_ERROR` |
| User code contains `main` | rejected before any CodeBox call | **400 `FUNCTION_ONLY_REQUIRED`** (custom-input mode: `Compilation Error` result) |
| DB insert of the submission fails | logged-in: abort; anonymous: continue with an in-memory id | **503 `SUBMISSION_STORAGE_UNAVAILABLE`** / normal verdict |
| DB update of the verdict fails (logged-in) | | sync: **503 `SUBMISSION_STORAGE_UNAVAILABLE`**; async: row and cache become `ERROR` |
| Reward or daily-problem write fails | logged, verdict kept | `rewardError: true` (sync) |
| CodeBox fails during a **sync** submit | error propagates | 503 / 500; the DB row stays `PROCESSING` |
| CodeBox fails during an **async** submit | `.catch` | poll returns `status: "ERROR"` |

---

## 16. Limits, timeouts and concurrency

| What | Value |
|---|---|
| Code size | 64 KB (UTF-8) |
| Request body | 1 MB |
| Run rate | 10 per minute per user/IP (shared with analyze-complexity) |
| Submit rate | 6 per minute per user/IP |
| Concurrent execution jobs | 2 per user/IP (run + submit; async jobs hold their slot until finished) |
| Per-testcase time limit | `problem.timeLimit` ms (DB default 1000; the controller uses 2000 if unset); custom stdin uses 3000 |
| Per-testcase memory | `problem.memoryLimit` MB (default 256) |
| Harness sandbox | 15 s CPU / 20 s wall per request; budget 13.5 s; ≤ 500 cases and ≤ 3 MB stdin per request |
| Harness per case | CPU > limit is a TLE; child real-time timer `tl + 300` ms; parent watchdog `tl + 1000` ms; RLIMIT_CPU `ceil(tl/1000) + 1` s |
| Batch / legacy chunk size | 20 testcases |
| Parallel chunks | 2 (`CODEBOX_MAX_CONCURRENT_BATCHES`) |
| HTTP timeouts | harness create 40 s · `/batches` create/poll `wait + 10 s` = 30 s · other calls 15 s · health 3 s |
| Polling deadlines | harness 60 s · `/batches` 60 s + `cases × wall` · legacy 60 s |
| Poll intervals | harness 120 ms ×1.25 → 800 ms · batch/legacy 150 ms ×1.35 → 800 ms · profiling 2 s |
| Submit fast path | ≤ 200 testcases in one `/batches` request |
| Submission cache | 30 min / 2,000 entries |
| Problem cache | 60 s / 300 entries |

---

## 17. Database reads and writes

| Table | Run | Submit |
|---|---|---|
| `problems`, `testcases`, `code_templates`, `examples` | read (cached 60 s) | read (cached); `problems.solvedCount` **updated** on a first solve |
| `users` | read by auth middleware | read (auth, prefetch); **updated** on a first solve (score, rating, tier) and on the daily problem (coins, streak, longestStreak, lastStreakDate) |
| `submissions` | – | **insert** (PROCESSING), **update** (verdict), or update to `ERROR` |
| `user_problem_progress` | – | read (prior solve, count); **insert** on a first solve |
| `daily_problems` | – | read (cached 60 s; created if missing) |
| `daily_problem_completions` | – | **insert** on the first daily-problem accept of the day |
| `coin_transactions` | – | **insert** `DAILY_PROBLEM` +2 |
| `complexity_profiles` | – | **insert** (enqueue); updated by the worker; read on poll |
| `revoked_tokens` | read by auth | read by auth |

**What is not stored**:

- per-testcase results;
- `firstFailure` and `tierReached`;
- the static complexity summary;
- reward details.

These live only in the in-memory submission cache for 30 minutes.

`submissions.code` stores the user's code only, not the assembled program.

---

## 18. In-memory state and multi-instance caveats

| State | Where | Consequence with several instances or a restart |
|---|---|---|
| `submissionCache` | execution.controller.js | Polling on another instance, or after a restart, returns DB fields only: no per-test results and a derived `tierReached` |
| Rate-limit and in-flight counters | rateLimit.middleware.js | Limits are per instance |
| `batchUnsupportedUntil` | execution.controller.js | Each instance probes `/batches` independently |
| Problem cache | problemResolver.js | Testcase or template edits take up to 60 s to be judged |
| Daily-problem lookup cache | dailyProblemService.js | 60 s |
| Static complexity caches | complexityAnalyzer.service.js | – |
| Profiling `state` (`running`, `activeJudging`) | profilingQueue.js | The job claim itself is DB-safe across instances (`SKIP LOCKED`) |
| Async submissions | the event loop of the instance that received them | A crash or restart mid-judging leaves the row `PROCESSING`. There is no external queue or recovery for submissions. |

---

## 19. Worked example: Two Sum in C++

**Problem data** (from `problems/two-sum.json`, stored in the database): `timeLimit 1000 ms`, `memoryLimit 256 MB`, and 5 testcases:

| testIndex | visible | stdin | expected |
|---|---|---|---|
| 0 | ✔ | `4 9\n2 7 11 15` | `0 1` |
| 1 | ✔ | `3 6\n3 2 4` | `1 2` |
| 2 | ✘ | `2 6\n3 3` | `0 1` |
| 3 | ✘ | `4 10\n1 4 6 8` | `1 2` |
| 4 | ✘ | `5 13\n-1 2 5 11 15` | `1 3` |

### 19.1 Run

1. The frontend sends `POST /api/execution/run { "slug": "two-sum", "language": "cpp", "code": "class Solution { … }" }` with a Bearer token.
2. The backend runs `protect`, the run limiter (1/10) and the in-flight limiter (1/2), then validation. `resolveProblem("two-sum")` hits the cache or the DB. `buildFinalCode` produces the program in [§6.4](#64-example-assembled-c-program-two-sum).
3. The visible cases are 0 and 1. The language is C++ and multi-case is on, so path A is used.
4. The backend sends to CodeBox:

   ```http
   POST {CODEBOX_URL}/submissions?base64_encoded=true&wait=true
   X-Auth-Token: <CODEBOX_TOKEN>
   { "source_code": base64(program + HARNESS_C), "language_id": 54,
     "stdin": base64(stdin below), "cpu_time_limit": 15, "wall_time_limit": 20,
     "memory_limit": 262144, "max_processes_and_or_threads": 60 }
   ```

   The decoded stdin is:

   ```
   C8MC2 1000 2 13500 0 27
   13
   4 9
   2 7 11 159
   3 6
   3 2 4
   ```

   That is: the header, then `13\n` + the 13 bytes `4 9\n2 7 11 15`, then `9\n` + the 9 bytes `3 6\n3 2 4`. There are no separators after the bytes, so `15` and `9` appear on one line above.
5. CodeBox returns `{ "token": "…", "status": { "id": 3, … }, "stdout": base64(report), … }`. The decoded report is:

   ```
   C8MC1 2
   #C8 0 0 0 2 3 3520 4 0
   0 1
   #C8 1 0 0 2 3 3500 4 0
   1 2
   #C8END
   ```

6. Normalising: both cases are `OK` (exit 0, no signal, 2 ms < 1000 ms, 3,520 KB < 262,144 KB), with `actual` `0 1` and `1 2`.
7. Judging: `areOutputsEqual("0 1", "0 1")` and `areOutputsEqual("1 2", "1 2")` both hold, so both cases are `Accepted` and the verdict is `Accepted`, 2/2. Static complexity: O(n).
8. The backend responds **200** in the shape of [§12.1](#121-run--200). Nothing is written to the database.

### 19.2 Submit (synchronous, `POST /api/execution/submit`, logged-in first solve)

1. After validation and build, `INSERT submissions (PROCESSING, totalCount 5)` starts in parallel. `priorSolve` finds nothing, so the reward prefetch reads the user and their solve count.
2. Tier split for n = 5: Tier 1 = [0], Tier 2 = [1, 2], Tier 3 = [3, 4]. C++ means one harness request per tier with flag `1` (stop on timeout):

   | Tier | Decoded stdin header | Payload |
   |---|---|---|
   | 1 | `C8MC2 1000 1 13500 1 16` | `13\n4 9\n2 7 11 15` |
   | 2 | `C8MC2 1000 2 13500 1 20` | `9\n3 6\n3 2 4` + `7\n2 6\n3 3` |
   | 3 | `C8MC2 1000 2 13500 1 35` | `12\n4 10\n1 4 6 8` + `17\n5 13\n-1 2 5 11 15` |

3. Every tier passes, so the result is `ACCEPTED`, `Tier 3 (Optimal)`, 5/5, `time: "<max cpu>ms"`, `memory: <max KB>`.
4. In parallel:
   - `UPDATE submissions`, then `syncProblemSolvedCount`;
   - the reward transaction: `user_problem_progress` +10 points, `score += 100`, rating 800 → 830, tier "Pulse II";
   - `grantDailyProblemReward`: granted only if Two Sum is today's daily problem;
   - static complexity.
5. Profiling eligibility is false: two-sum has no profiling definition.
6. `submissionCache.set(id, …)`. The backend responds **200** in the shape of [§12.2](#122-submit-sync--200). Visible cases 0 and 1 are returned in full; hidden cases 2, 3 and 4 as `{ testIndex, isVisible: false, passed: true, status: "Accepted", time, memory }`.

**Python variant**: no harness. If path B is enabled, a single `POST /batches` carries all 5 cases with `group` 0/1/1/2/2, `stop_on_failure: true` and `limits { cpu 1, wall 2, memory 262144, processes 60 }`. Otherwise path C sends three legacy submissions, one per tier (1, 2 and 2 cases).

**Failure variant**: suppose the solution returns `1 0` for case 2. Tier 1 passes. In tier 2, case 1 passes and case 2 is `Wrong Answer`. The verdict is `WRONG_ANSWER` and `tierReached` is `Tier 1 (Brute Force)`. Tier 3 never runs, `passedCount` is 2/5, and `firstFailure` is `{ testIndex: 2, status: "Wrong Answer", errorText: null, message: "Failed on hidden evaluation test case #3." }`. There is no reward.

---

## 20. Edge cases and known quirks

1. **`main` detection is textual.** Comments or strings containing `main(` are rejected.
2. **Anonymous async submits cannot be polled.** `/api/problems/:slug/submit` without a token returns 202, but the poll route requires the owner's token. Use `wait: true`.
3. **`/api/execute/submissions` is synchronous**, because of the `/execute/submit` substring match.
4. **A sync submit interrupted by a CodeBox failure** leaves its `submissions` row in `PROCESSING`.
5. **A server restart during async judging** leaves rows in `PROCESSING`. There is no recovery or requeue for submissions.
6. **A Wrong Answer does not stop CodeBox's batch** (`stop_on_failure` reacts only to crashes and timeouts). Later tiers may execute on CodeBox even though the backend ignores their results.
7. **Path C cannot detect MLE**; memory blow-ups usually surface as Runtime Error.
8. **Custom-input Run for C, C++ and Java** has no generic driver, so code without `main` fails to link or compile, and code with `main` is rejected. Only Python and JavaScript are really usable there.
9. **`rewardError` is not restored** in poll responses (always `false`).
10. **`Output Limit Exceeded`** is reported as `RUNTIME_ERROR` on Submit (Judge0 semantics), but shown as `Output Limit Exceeded` on Run.
11. **`testcases.r2Key` and `sizeBytes`** are not used; large testcases must fit in `stdinSmall`.
12. **`studentStdout`** is always empty. Students cannot print debug output separately from the judged stdout; anything they print is part of `actual`.
13. **Tier boundaries depend only on the testcase count**, not on difficulty or input size. With 1 or 2 testcases, `Tier 3 (Optimal)` is unreachable.
14. **Time reported** (`time`, `timeMs`) is CPU time. Wall time is in `wallTimeMs` (visible cases only on Submit).

---

## 21. Related scripts and tests

| File | Purpose |
|---|---|
| [scripts/benchmarkExecution.js](scripts/benchmarkExecution.js) | Benchmarks `executeCodeBatch` / `evaluateAllTestcases` against CodeBox (`--url`, `--token`, `--langs`, `--cases`) |
| [scripts/test-isolated.mjs](scripts/test-isolated.mjs) | Runs the test suite against an isolated `_test` database. Unmocked CodeBox calls go to an unreachable host and profiling is disabled. **Use this instead of `npm test`, which uses `DATABASE_URL` (production).** |
| [scripts/complexity-accuracy.mjs](scripts/complexity-accuracy.mjs) | Measures the static analyzer against `tests/fixtures/complexityCorpus.js` |
| [scripts/upload-problem.js](scripts/upload-problem.js), [scripts/bulk-push.js](scripts/bulk-push.js), [scripts/seedProblems.js](scripts/seedProblems.js) | Load `problems/*.json` (testcases and templates) into the database |
| [scripts/reset-and-upload.js](scripts/reset-and-upload.js) | ⚠ `TRUNCATE`s `problems`, `examples`, `testcases`, `code_templates` **and `submissions`** (CASCADE), then re-uploads every problem |
| [tests/multiCaseHarness.test.js](tests/multiCaseHarness.test.js), [tests/multiCaseExecution.test.js](tests/multiCaseExecution.test.js) | Harness framing, parsing, normalisation; path A behaviour and fallbacks (mocked CodeBox) |
| [tests/codeboxBatchExecution.test.js](tests/codeboxBatchExecution.test.js) | Path B (`/batches`) requests, long-poll and results |
| [tests/executionBatch.test.js](tests/executionBatch.test.js) | Path C chunking (50 cases → 3 legacy batch requests) |
| [tests/executionOptimization.test.js](tests/executionOptimization.test.js) | Static complexity caching; Run response schema and visible-only execution |
| [tests/executionVerdicts.test.js](tests/executionVerdicts.test.js) | Languages endpoint, validation errors, custom stdin, Run verdicts (Accepted / WA / TLE / CE) |
| [tests/judgingVerdicts.test.js](tests/judgingVerdicts.test.js) | Submit verdict mapping, tiers, whole-tier judging, MLE vs WA |
| [tests/problemsecurity.test.js](tests/problemsecurity.test.js) | Function-only (`main`) rejection, unsupported language (422), compiler diagnostics |
| [tests/executionLanguages.test.js](tests/executionLanguages.test.js), [tests/problemEndpoints.test.js](tests/problemEndpoints.test.js) | Language normalisation; problem endpoints and templates with run/submit |
| [tests/testcaseResults.test.js](tests/testcaseResults.test.js), [tests/acceptedSubmissionReward.test.js](tests/acceptedSubmissionReward.test.js), [tests/problemSolvedCount.test.js](tests/problemSolvedCount.test.js) | Redaction, reward maths, solved count |
| [tests/complexityProfiler.test.js](tests/complexityProfiler.test.js), [tests/complexityAnalyzer.test.js](tests/complexityAnalyzer.test.js) | Profiling pipeline and static analyzer |
| [tests/codeboxComparison.e2e.js](tests/codeboxComparison.e2e.js) | End-to-end comparison against a real CodeBox (`npm run test:codebox-compare`) |
