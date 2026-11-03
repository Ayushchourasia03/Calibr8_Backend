# Calibr8 Engine — Complete Code Execution & Judge System Architecture Documentation

**Document Version:** 1.0.0  
**Target Audience:** Engineering Leads, Backend Engineers, DevOps, Content/Problem Authors  
**Base Systems:** Express.js 4, Prisma ORM, Neon PostgreSQL, Cloudflare R2, Self-Hosted Judge0 CE (Codebox VPS)  

---

## Table of Contents

1. [Executive Summary & System Architecture](#1-executive-summary--system-architecture)
2. [Files, Services, Utilities & Component Directory](#2-files-services-utilities--component-directory)
3. [API Specifications & Contracts](#3-api-specifications--contracts)
4. [Internal Functions & Implementation Mechanics](#4-internal-functions--implementation-mechanics)
5. [The Dual Execution Engine (Codebox VPS vs. Local Worker)](#5-the-dual-execution-engine-codebox-vps-vs-local-worker)
6. [Function-Style Problem Wrapping & Driver Injection](#6-function-style-problem-wrapping--driver-injection)
7. [Testcase (TC) Batching & Codebox Transmission Pipeline](#7-testcase-tc-batching--codebox-transmission-pipeline)
8. [Current vs. Ideal Testcase Topology](#8-current-vs-ideal-testcase-topology)
9. [Testcase Storage & Problem Linking Strategy](#9-testcase-storage--problem-linking-strategy)
10. [Determining Time & Space Complexity via Codebox](#10-determining-time--space-complexity-via-codebox)
11. [Scalability & Concurrency Analysis (100+ Concurrent Users)](#11-scalability--concurrency-analysis-100-concurrent-users)
12. [System Optimization & Performance Blueprint](#12-system-optimization--performance-blueprint)
13. [Security, Sandboxing & Anti-Cheat Governance](#13-security-sandboxing--anti-cheat-governance)
14. [Anticipated Future Questions & Technical Decisions](#14-anticipated-future-questions--technical-decisions)

---

## 1. Executive Summary & System Architecture

The Calibr8 Code Execution System provides a secure, sandboxed, high-throughput environment for running and grading student code in five programming languages (**Python, JavaScript, C++, C, and Java**).

### High-Level Architectural Flow

```
                      +---------------------------------------+
                      |           Student Browser             |
                      |   Monaco Editor (Run / Submit CTA)    |
                      +-------------------+-------------------+
                                          |
                      HTTPS REST Payload  |  (Bearer JWT + Code)
                                          v
                      +-------------------+-------------------+
                      |         Calibr8 Express API           |
                      |   - Auth & Rate Limit Validation      |
                      |   - In-Flight Execution Limiter (<=2) |
                      +-------------------+-------------------+
                                          |
                     Problem & Template   |  Resolver
                                          v
       +----------------------------------+----------------------------------+
       |                                                                     |
       v                                                                     v
+--------------+                                                      +--------------+
| Neon Postgres| (Metadata, visible/small TCs, Submissions)           |Cloudflare R2 | (Large TCs >64KB)
+--------------+                                                      +--------------+
       |                                                                     |
       +----------------------------------+----------------------------------+
                                          |
                      Source Builder & Driver Injection
                      (Hides stdin/stdout, attaches marker)
                                          |
                                          v
                      +-------------------+-------------------+
                      |      executeCodeBatch Dispatcher      |
                      |  - Slices testcases into batches <=20 |
                      |  - Dispatches to Codebox VPS (Judge0) |
                      +-------------------+-------------------+
                                          |
                      POST /submissions/batch?base64_encoded=false
                                          v
                      +-------------------+-------------------+
                      |        Codebox VPS (Judge0)           |
                      |   - Redis Submission Queue            |
                      |   - Isolated Docker / cgroup v1 box   |
                      |   - Compilers (GCC 13, JDK 17, Node)  |
                      +-------------------+-------------------+
                                          |
                      GET /submissions/batch?tokens=... (Poll 500ms)
                                          v
                      +-------------------+-------------------+
                      |     Verdict & Scorer Pipeline         |
                      |  - Marker extraction (cleans prints)  |
                      |  - Output normalization & comparison  |
                      |  - Tier calculation (Tier 0 -> Tier 3)|
                      |  - Gamification (Score, Coins, Streak)|
                      +---------------------------------------+
```

### Architectural Axioms

1. **The Browser Never Contacts Codebox:** The frontend has zero knowledge of the Judge0 URL, internal tokens, or hidden test cases.
2. **Backend Output Comparison:** Codebox runs the code and captures `stdout`/`stderr`. The Calibr8 backend evaluates whether the answer is mathematically/structurally correct.
3. **Function-Style Enforcement:** Students only submit the function/class (e.g. `class Solution`). Platform drivers handle I/O parsing, object deserialization, invocation, and serializing return values.
4. **Information Security & Anti-Leak:** Hidden test inputs and outputs are never leaked in API responses.

---

## 2. Files, Services, Utilities & Component Directory

| File / Component Path | Architectural Layer | Primary Responsibility |
| :--- | :--- | :--- |
| `src/routers/execution.router.js` | Routing Layer | Registers execution endpoints (`/languages`, `/runs`, `/run`, `/submissions`, `/submit`, `/submissions/:id`), attaching auth and rate limiters. |
| `src/controllers/execution.controller.js` | Controller / Business Logic | Coordinates run/submit flows, Codebox batch dispatch, polling loop, tier calculation, gamification rewards, and response shaping. |
| `src/utils/codeBuilder.js` | Code Synthesis Engine | Normalizes language keys, maps Judge0 language IDs, validates function-only constraints (forbids `main`), injects language drivers, bridges, and headers/footers. |
| `src/utils/outputComparator.js` | Output Comparison Engine | Implements normalized output comparison (`areOutputsEqual`, `normalizeOutput`) with line-ending and whitespace tolerance. |
| `src/services/complexityAnalyzer.service.js` | Algorithmic Complexity Analyzer | Multi-language static source-code analyzer computing time and auxiliary/output/total space complexity. |
| `src/utils/problemResolver.js` | Data Ingestion & Caching | Resolves problem metadata, templates, and test cases from PostgreSQL or fallback `/problems/*.json` with in-memory TTL caching. |
| `src/utils/testcaseResults.js` | Data Sanitization | Sanitizes test results before returning to client (`publicTestResults`), stripping inputs/outputs from hidden test cases. |
| `src/middlewares/rateLimit.middleware.js` | Traffic Shaping & Security | Enforces per-user rate limits (10 runs/min, 6 submits/min) and concurrent in-flight job caps (max 2 per user). |
| `src/middlewares/auth.middleware.js` | Security | Verifies JWT bearer tokens, checks token blacklist, and binds `req.user`. |
| `lib/storage.js` | Cloud Storage Client | Configures AWS S3-compatible client for Cloudflare R2 for storing test cases larger than 64 KB. |
| `prisma/schema.prisma` | Persistence Schema | Defines models: `Problem`, `Testcase`, `CodeTemplate`, `Submission`, `UserProblemProgress`, `User`. |
| `problems/*.json` | File Seed Catalog | Contains JSON problem seeds with testcases, difficulty, limits, and multi-language starter templates. |
| `scripts/upload-problem.js` | Catalog Ingestion Tool | Idempotent CLI script to ingest individual or folder-based JSON problems into the database. |
| `scripts/reset-and-upload.js` | Database Maintenance | Wipes and resets problems, testcases, templates, and re-imports `./problems/`. |

---

## 3. API Specifications & Contracts

### 3.1 `GET /api/execution/languages`
- **Auth Required:** No
- **Purpose:** Returns list of supported languages, versions, Judge0 IDs, and editor modes.
- **Response `200 OK`:**
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

### 3.2 `POST /api/execution/runs` (Alias: `POST /api/execution/run`)
- **Auth Required:** Yes (`Bearer <JWT>`)
- **Rate Limit:** 10 requests / minute / user; Max 2 in-flight jobs.
- **Request Body:**
```json
{
  "slug": "two-sum",
  "language": "python",
  "code": "class Solution:\n    def twoSum(self, nums: list[int], target: int) -> list[int]:\n        seen = {}\n        for i, n in enumerate(nums):\n            diff = target - n\n            if diff in seen:\n                return [seen[diff], i]\n            seen[n] = i\n        return []"
}
```
- **Execution Mode:** Synchronous (HTTP connection held until sample tests finish, typically 1–3s).
- **Behavior:** Executes **only visible/sample test cases** (`isVisible: true`). No points or database submissions are recorded.
- **Response `200 OK`:**
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
      "timeMs": 45,
      "memoryKb": 12400,
      "errorText": null
    }
  ]
}
```

### 3.3 `POST /api/execution/submissions` (Alias: `POST /api/execution/submit`)
- **Auth Required:** Yes (`Bearer <JWT>`)
- **Rate Limit:** 6 requests / minute / user; Max 2 in-flight jobs.
- **Headers:** Optional `Idempotency-Key: <UUID>`
- **Request Body:**
```json
{
  "slug": "two-sum",
  "language": "python",
  "code": "class Solution:\n    def twoSum(self, nums: list[int], target: int) -> list[int]:\n        ...",
  "wait": false
}
```
- **Execution Mode:**
  - Standard mode (`wait: false`): Asynchronous. Returns `202 Accepted` immediately with `submissionId` and polling URL.
  - Direct execution mode (`wait: true` or path `/api/execute/submit`): Synchronous. Holds connection until all testcases complete.
- **Response `202 Accepted`:**
```json
{
  "success": true,
  "submissionId": "sub_1740001234_abc89f",
  "status": "QUEUED",
  "pollUrl": "/api/execution/submissions/sub_1740001234_abc89f",
  "message": "Submission received and queued for execution.",
  "problem": { "slug": "two-sum", "title": "Two Sum" }
}
```

### 3.4 `GET /api/execution/submissions/:id`
- **Auth Required:** Yes (`Bearer <JWT>`)
- **Security Rule:** Owner-only access (`submission.userId === req.user.id`). Unauthorized users receive `404 SUBMISSION_NOT_FOUND`.
- **Response `200 OK` (Terminal State):**
```json
{
  "success": true,
  "submission": {
    "id": "sub_1740001234_abc89f",
    "problemId": "prob-two-sum",
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
      "stats": { "rating": 810, "tier": "Prism I", "score": 10, "coins": 130, "streak": 1, "longestStreak": 1 }
    },
    "rewardError": false,
    "firstFailure": null,
    "results": [
      { "testIndex": 0, "isVisible": true, "passed": true, "status": "Accepted", "input": "4 9\n2 7 11 15", "expected": "0 1", "actual": "0 1" },
      { "testIndex": 2, "isVisible": false, "passed": true, "status": "Accepted", "time": 48, "memory": 13400 }
    ],
    "problem": { "slug": "two-sum", "title": "Two Sum" }
  }
}
```

---

## 4. Internal Functions & Implementation Mechanics

### 4.1 In `src/controllers/execution.controller.js`

#### `getCodeboxUrl()`
- Validates that `CODEBOX_URL` and `CODEBOX_TOKEN` are present in environment variables.
- Enforces HTTPS for non-localhost endpoints (`runnerUrl.protocol === "https:"`). In non-production, loopback addresses (`127.0.0.1`, `localhost`, `::1`) are permitted over HTTP.
- Throws `ApiError(503, "Code execution service is unavailable.", "EXECUTION_UNAVAILABLE")` if unconfigured or insecure.

#### `fetchCodeboxJson(url, options)`
- Performs authenticated HTTP fetch with `X-Auth-Token: CODEBOX_TOKEN`.
- Wraps call in an `AbortController` with a strict **10-second request timeout**.
- Guarantees clean network failure handling, translating socket hangs or Codebox downtimes into `503 EXECUTION_UNAVAILABLE`.

#### `normalizeRunnerResult(data)`
Maps raw Judge0 status IDs into Calibr8 domain statuses:
- Status `5` $\rightarrow$ `"Time Limit Exceeded"`
- Status `6` or presence of `compile_output` $\rightarrow$ `"Compilation Error"`
- Status `7` to `12` (SIGSEGV, SIGXFSZ, SIGFPE, SIGABRT, etc.) $\rightarrow$ `"Runtime Error"`
- Status `13`+ (Internal Errors) $\rightarrow$ `"Runtime Error"`
- Status `3` (Accepted) / `4` (Wrong Answer) $\rightarrow$ `"OK"` (Output evaluation is handled by Calibr8 backend).

#### `executeCodeBatch({ language, fullCode, testcases, timeLimit, memoryLimit })`
- Converts the requested language to its `judge0Id` via `LANGUAGE_IDS` (e.g. `python: 71`, `javascript: 63`, `cpp: 54`, `c: 50`, `java: 62`).
- Computes CPU time limit: `cpuTimeLimit = Math.max(1, Math.ceil(timeLimit / 1000))` (minimum 1 second).
- Computes Wall time limit: `wall_time_limit = cpuTimeLimit * 2 + 1` (prevents hung processes from blocking workers).
- Computes Memory limit: `memory_limit = memoryLimit * 1024` (in KB).
- **Chunking Loop:** Slices the testcase array into batches of size `MAX_CASES_PER_BATCH = 20`.
- **Submission:** Submits each batch to `POST /submissions/batch?base64_encoded=false`.
- **Polling Loop:** Polls `GET /submissions/batch?tokens=...&base64_encoded=false` every `500ms` until all statuses are outside `[1, 2]` (In Queue / Processing), or until `BATCH_TIMEOUT_MS` (60 seconds) is reached.
- Returns normalized array of testcase execution results.

#### `evaluateAllTestcases(problem, language, code, providedFullCode)`
- Evaluates code against every testcase associated with the problem.
- Calculates dynamic tier thresholds:
  - $\text{Tier 1 Threshold} = \max(1, \lfloor \text{total} \times 0.35 \rfloor)$
  - $\text{Tier 2 Threshold} = \max(\text{tier1Count} + 1, \lfloor \text{total} \times 0.70 \rfloor)$
  - $\text{Tier 3 Threshold} = \text{total}$ (100% of testcases passed)
- Iterates over execution results, comparing student output against expected output via `areOutputsEqual`.
- Identifies the `firstFailure` details (attaching input/output only if the failed case is marked `isVisible`).
- Computes `maxTimeMs` and `maxMemoryKb`.
- Returns `{ status, tierReached, passedCount, totalCount, maxTimeMs, maxMemoryKb, firstFailure, results }`.

---

### 4.2 In `src/utils/codeBuilder.js`

#### `buildFinalCode(problem, userCode, language)`
- **Function-Only Validation:** Inspects `userCode` for standard entrypoints (`main()`, `int main`, `def main`). If detected on standard problems, immediately throws `400 FUNCTION_ONLY_REQUIRED`.
- **Template Assembly:** Merges problem headers, student code, platform bridge, and driver footers.
- **Language Bridging:** Injects reflection bridges (such as dynamic `Solution` binding in Python and Node.js) so student code written either as class methods or standalone functions executes seamlessly against driver footers.

#### Language IDs Mapping
```javascript
export const LANGUAGE_IDS = {
  python: 71,      // Python 3.10
  javascript: 63,  // Node.js 22
  js: 63,
  cpp: 54,         // GCC 13 (C++20)
  c: 50,           // GCC 13
  java: 62,        // OpenJDK 17
};
```

---

### 4.3 In `src/utils/codeRunner.js`

#### `normalizeOutput(val)`
Handles multi-format equality normalization:
- Parsed JSON structures (arrays, objects, numbers, booleans).
- Space-separated numerical strings (e.g., `"7 0 8"` $\rightarrow$ `"[7,0,8]"`).
- Comma-separated numerical strings (e.g., `"7, 0, 8"` $\rightarrow$ `"[7,0,8]"`).
- Case-insensitive boolean string representations (`"true"`, `"yes"`, `"false"`, `"no"`).

#### `areOutputsEqual(actualRaw, expectedRaw)`
- Performs strict normalized string comparison.
- Evaluates whitespace-flattened equivalence (handling trailing newlines and multi-space formatting).
- Compares parsed JSON structures directly to prevent formatting false-negatives (e.g., `"[0, 1]"` vs `"[0,1]"`).

---

## 5. The Execution Engine (Exclusive Codebox VPS)

The codebase routes all code execution exclusively through the Codebox VPS (Judge0 CE API):

```
                              Calibr8 Execution Controller
                                           |
                                           v
                              executeCodeBatch() (Batching <= 20)
                                           |
                                           v
                              Codebox VPS (Judge0 CE REST API)
                                (cgroup containerized sandbox)
```

1. **Codebox VPS (`executeCodeBatch` in `execution.controller.js`):**
   - Sole execution engine. Dispatches batches to the remote Judge0 VPS instance via HTTP REST APIs.
   - Slices requests into batches of at most 20 testcases, polling status with adaptive backoff.
   - Completely sandboxed with Linux `cgroup` resource isolation, ptrace limits, and disabled network access.
   - If CodeBox is unreachable or unconfigured, the execution controller fails securely with a controlled 503 (`EXECUTION_UNAVAILABLE`) error without executing code locally.

---

## 6. Function-Style Problem Wrapping & Driver Injection

Calibr8 operates on a **LeetCode-style function model**. Students are never asked to handle stdin parsing or stdout printing.

### How Driver Injection Operates:

1. **Student Code:**
   ```python
   class Solution:
       def twoSum(self, nums: List[int], target: int) -> List[int]:
           # Student solution
   ```

2. **Backend Driver (Appended to source):**
   ```python
   # --- CALIBR8 DRIVER ---
   import sys, json
   _MARK = '__CALIBR8_RESULT_d8f2a1__'
   _lines = [l.strip() for l in sys.stdin.read().split('\n') if l.strip()]
   _args = [json.loads(l) for l in _lines]
   _result = Solution().twoSum(*_args)
   print(_MARK + json.dumps(_result))
   ```

3. **Marker Extraction Pipeline:**
   - The backend generates a random cryptographic marker string per run: `__CALIBR8_RESULT_<hex>__`.
   - If the student includes debug prints (e.g. `print("debug array:", nums)`), those lines appear in `stdout`.
   - The backend splits `stdout` by line, scans for the marker prefix, extracts the payload after the marker as the official `actual` return value, and places all preceding lines into `studentStdout`.
   - If the student maliciously prints the marker text, the backend selects the **last occurrence** of the marker line.

---

## 7. Testcase (TC) Batching & Codebox Transmission Pipeline

### Batching Mechanics

```
Total Testcases: N (e.g. 45 testcases)
Chunk Size: MAX_CASES_PER_BATCH = 20

Batch 1: Cases  0 to 19  -->  POST /submissions/batch  --> Poll tokens until done
Batch 2: Cases 20 to 39  -->  POST /submissions/batch  --> Poll tokens until done
Batch 3: Cases 40 to 44  -->  POST /submissions/batch  --> Poll tokens until done
```

### Transmission Parameters
- **`MAX_CASES_PER_BATCH`**: Set to `20`. This aligns with standard Judge0 CE default configurations (`max_submission_batch_size: 20` in `judge0.conf`).
- **`BATCH_POLL_INTERVAL_MS`**: `500ms`. Polling interval for querying token status.
- **`BATCH_TIMEOUT_MS`**: `60,000ms` (60 seconds). Maximum allowable duration before marking the batch as timed out.

### Payload Structure Sent to Codebox

```http
POST /submissions/batch?base64_encoded=false HTTP/1.1
Host: codebox-vps.calibr8.internal
X-Auth-Token: <SECRET_CODEBOX_TOKEN>
Content-Type: application/json

{
  "submissions": [
    {
      "source_code": "<FULL_CODE_WITH_DRIVER>",
      "language_id": 71,
      "stdin": "4 9\n2 7 11 15",
      "cpu_time_limit": 2,
      "wall_time_limit": 5,
      "memory_limit": 262144
    },
    ... (up to 20 submissions)
  ]
}
```

---

## 8. Current vs. Ideal Testcase Topology

### Current State in Codebase
- **Total Testcases per Problem:** Currently **5 test cases** per problem.
- **Distribution:**
  - **Visible (Sample Tests):** 2 cases (`isVisible: true`)
  - **Hidden (Evaluation Tests):** 3 cases (`isVisible: false`)

### Why 5 Testcases Are Insufficient for Production
With only 5 test cases:
1. Sub-optimal algorithms (e.g. $O(N^2)$ brute force) can easily pass problems intended to require $O(N \log N)$ or $O(N)$ solutions.
2. Edge cases (empty inputs, single-element collections, overflow values, negative numbers) are inadequately covered.
3. Memory and time limit bounds cannot be reliably stressed.

### Recommended Testcase Matrix (Per Problem)

| Tier / Category | Quantity | Purpose & Characteristics | Visibility |
| :--- | :--- | :--- | :--- |
| **Sample Cases** | 2 – 4 | Basic validation of functional behavior; displayed in statement. | `isVisible: true` |
| **Edge Cases** | 5 – 8 | Empty inputs, $N=1$, negative numbers, duplicate elements, zero targets. | `isVisible: false` |
| **Tier 1 (Brute Force)** | 6 – 10 | Small scale inputs ($N \le 10^3$). Verifies basic logic and recursion. | `isVisible: false` |
| **Tier 2 (Better)** | 10 – 15 | Medium scale inputs ($N \le 10^4 - 10^5$). Enforces $O(N \log N)$ or $O(N \sqrt{N})$. | `isVisible: false` |
| **Tier 3 (Optimal)** | 10 – 20 | Maximum scale inputs ($N = 10^5 - 10^6$). Guarantees TLE for sub-optimal code. | `isVisible: false` |
| **Total Recommended** | **35 – 50** | **Comprehensive grading and precise tier assessment.** | — |

---

## 9. Testcase Storage & Problem Linking Strategy

### Dual Storage Architecture

To prevent database bloat while maintaining sub-millisecond query performance for standard metadata, Calibr8 employs a **hybrid storage tier**:

```
                              Testcase Storage Model
                                         |
                   +---------------------+---------------------+
                   |                                           |
                   v                                           v
      [Small Testcases: <= 64 KB]                  [Large Testcases: > 64 KB]
         Neon PostgreSQL Table                        Cloudflare R2 Bucket
          `testcases` table                          Bucket: `calibr8-testcases`
       Columns: stdinSmall, expectedSmall             Key: `problems/{slug}/tc_{index}.in`
```

### 1. Database Schema (`prisma/schema.prisma`)

```prisma
model Problem {
  id            String         @id @default(cuid())
  problemNumber Int            @unique @default(autoincrement())
  slug          String         @unique
  title         String
  description   String
  difficulty    String         @default("Easy")
  timeLimit     Int            @default(1000)
  memoryLimit   Int            @default(256)
  testcases     Testcase[]
  templates     CodeTemplate[]
  submissions   Submission[]
}

model Testcase {
  id            String   @id @default(cuid())
  problemId     String
  testIndex     Int
  isVisible     Boolean  @default(false)
  stdinSmall    String   @db.Text
  expectedSmall String   @db.Text
  sizeBytes     Int      @default(0)
  r2Key         String?  // References Cloudflare R2 object when sizeBytes > 65536
  problem       Problem  @relation(fields: [problemId], references: [id], onDelete: Cascade)

  @@unique([problemId, testIndex])
  @@map("testcases")
}
```

### 2. Linking & Ingestion Workflow
- When `uploadProblem()` runs, it iterates through `data.testcases`:
  - If `sizeBytes <= 64 KB`: Ingests `stdinSmall` and `expectedSmall` directly into PostgreSQL.
  - If `sizeBytes > 64 KB`: Uploads the testcase payload to Cloudflare R2 using `@aws-sdk/client-s3` (via `lib/storage.js`), sets `r2Key = "problems/${slug}/tc_${index}.in"`, and stores an empty or truncated placeholder in `stdinSmall`.
- During execution, the backend loads database testcases; if an `r2Key` is present, it retrieves the payload from R2 (with an in-memory LRU cache to avoid repeated network fetches).

---

## 10. Determining Time & Space Complexity via Codebox

A common engineering question is:  
**"Can Codebox / Judge0 directly determine the Time and Space Complexity (Big-O) of student code?"**

### The Fundamental Limitation
**No execution sandbox can directly determine asymptotic complexity ($O(N)$, $O(N^2)$, $O(\log N)$) from a single run.**

*Why?*  
- Big-O is an **asymptotic mathematical property** of an algorithm as $N \to \infty$.
- Codebox measures **physical metrics**: CPU time in milliseconds and peak Resident Set Size (RSS) memory in kilobytes.
- A single measurement of 45ms does not indicate whether an algorithm is $O(1)$, $O(N)$, or $O(N^3)$ running on a small input.
- Hardware noise, CPU clock frequency scaling, garbage collection cycles (in Java/JavaScript), and container virtualization introduce variable timing deltas.

### How Platforms Solve Complexity Verification

Platforms implement complexity evaluation using four complementary techniques:

```
+----------------------------------------------------------------------------------------------------+
|                                    COMPLEXITY EVALUATION SPECTRUM                                  |
+----------------------------------------------------------------------------------------------------+
|                                                                                                    |
| 1. Empirical Tiered Input Sizing (CURRENT CALIBR8 METHOD)                                          |
|    - Calibrate inputs across orders of magnitude:                                                  |
|      * N = 10^3  --> Runs in < 50ms for O(N^2), passes Tier 1                                     |
|      * N = 10^5  --> Takes ~10s for O(N^2) (TLE), but passes in 120ms for O(N log N) (Tier 2)     |
|      * N = 10^6  --> TLE for O(N log N), only passes for O(N) (Tier 3)                             |
|                                                                                                    |
| 2. Multi-Point Empirical Curve Fitting                                                             |
|    - Execute solution on 3 specific testcase sizes: N1 = 1,000, N2 = 10,000, N3 = 100,000.        |
|    - Calculate the ratio of measured times: T(N2) / T(N1) and T(N3) / T(N2).                       |
|    - If ratio ~ 10  --> Linear growth O(N)                                                         |
|    - If ratio ~ 100 --> Quadratic growth O(N^2)                                                    |
|                                                                                                    |
| 3. Static AST (Abstract Syntax Tree) Analysis                                                      |
|    - Parse student code via Babel / Tree-sitter before execution.                                  |
|    - Detect nested loop nesting depth, recursive branches, and data structure allocations.         |
|                                                                                                    |
| 4. Post-Submission AI / LLM Complexity Evaluation                                                  |
|    - In Calibr8, students take a complexity quiz after solving (`POST /attempts/:id/complexity-quiz`) |
|    - An LLM evaluates student code alongside execution metrics to verify Big-O assertions.        |
+----------------------------------------------------------------------------------------------------+
```

---

## 11. Scalability & Concurrency Analysis (100+ Concurrent Users)

When user traffic scales to 100 concurrent users running and submitting code, the execution architecture experiences specific loads across its layers.

### Scenario: 100 Active Users Concurrently Submitting Code
- **Incoming Load:** 100 requests arriving within a 10–30 second window.
- **Job Multiplier:** If each submission involves 20–35 test cases chunked into 2 batches, 100 submissions create **200 batch requests** representing **3,000 individual testcase executions**.

### Bottleneck Identification & Behavioral Analysis

```
[100 Concurrent Users]
         |
         v
+-------------------------------+
| Calibr8 Express API Server    |  Status: STABLE
| (Memory & Event Loop)         |  In-flight limiter caps max concurrent jobs to 200.
+---------------+---------------+
                |
                v
+-------------------------------+
| In-Process Background Jobs    |  Status: VULNERABLE
| (Unbounded Promise execution) |  Risk: If server crashes or restarts, all active submissions
+---------------+---------------+        are lost from memory.
                |
                v
+-------------------------------+
| Codebox VPS (Judge0 Cluster)  |  Status: PRIMARY BOTTLENECK
| (Docker workers & CPU cores)  |  Default Judge0 instances run 2 to 4 workers.
+---------------+---------------+  Result: Queue backlog grows; jobs take 30-60s;
                |                          polling timeouts occur.
                v
+-------------------------------+
| Neon PostgreSQL Connection    |  Status: VULNERABLE TO CONNECTION EXHAUSTION
| Pool (Prisma Client)          |  Risk: Concurrent status updates spike pool connections.
+-------------------------------+
```

### Failure Modes Under 100+ Concurrent Users

1. **Codebox Worker Exhaustion:**
   - Judge0 executes each testcase inside a separate sandboxed container.
   - If the VPS has 4 vCPUs and 4 Judge0 workers, running 200 batches sequentially will saturate CPU queues.
   - Polling requests may exceed `BATCH_TIMEOUT_MS` (60 seconds), returning `503 EXECUTION_UNAVAILABLE`.
2. **Express In-Process Job Drops:**
   - Submissions currently run via `runEvaluation().catch(...)` inside the Node.js process memory.
   - If the container restarts or scales horizontally, active jobs in `submissionCache` disappear.
3. **Database Connection Saturation:**
   - Each submission triggers Prisma transactions for creation, verdict updates, reward calculation, and problem solved count synchronization.
   - 100 concurrent transactions can exhaust connection limits on standard database tiers.

---

## 12. System Optimization & Performance Blueprint

To scale the execution system reliably to 100+ concurrent users and reduce execution latency, the following optimizations should be applied:

### Optimization 1: True Tier Short-Circuiting
- **Current Behavior:** `evaluateAllTestcases` executes all batches across all testcases regardless of failures.
- **Optimized Behavior:** Evaluate tier by tier. If any testcase in Tier 1 fails (Wrong Answer, TLE, Runtime Error), **halt execution immediately**.
- **Impact:** Saves **60% to 70%** of Judge0 CPU cycles on failing submissions.

### Optimization 2: Persistent Distributed Message Queue (BullMQ + Redis)
- Migrate background execution out of the Express process memory into a dedicated worker queue:

```
[POST /submissions] ---> [Redis BullMQ Queue] ---> [Calibr8 Background Workers]
        |                                                     |
        v                                                     v
  Returns 202                                           Dispatches to Codebox
```

- **Benefits:** Prevents server crashes from losing jobs; provides automatic retries, job prioritization, and horizontal scaling.

### Optimization 3: Single-Compilation for Compiled Languages
- **Problem:** For C++, C, and Java, Judge0 compiles the source code repeatedly for every testcase in a batch.
- **Solution:** Compile the binary once in an isolated step, and execute the precompiled binary across all testcase inputs.
- **Impact:** Reduces C++ batch execution time from **8 seconds to under 800ms**.

### Optimization 4: Horizontal Scaling of Codebox VPS Instances
- Deploy 2 or more Judge0 VPS instances behind a round-robin load balancer:

```
Calibr8 API  --->  HAProxy / NGINX Load Balancer
                         |
           +-------------+-------------+
           |                           |
           v                           v
     Judge0 VPS #1               Judge0 VPS #2
    (8 Workers / 4 Core)       (8 Workers / 4 Core)
```

---

## 13. Security, Sandboxing & Anti-Cheat Governance

### Sandboxing Protections (Codebox / Judge0 Level)
1. **Network Isolation:** Submissions are executed inside containers with networking completely disabled (`--net=none`). Network calls (`curl`, socket connections, DNS requests) fail immediately.
2. **Process / Fork Bomb Defense:** Max processes are capped via `pids_limit` (typically 32 to 64). Malicious fork bombs (`while(1) fork();`) are terminated without host impact.
3. **Memory Limits:** Hard memory limits are enforced via Linux `cgroup` (memory limit + swap disabled). Memory allocation beyond the ceiling triggers `SIGKILL`, mapped to `"Runtime Error"`.
4. **Filesystem Isolation:** Code executes in a read-only container root with a temporary, size-restricted `/tmp` scratchpad that is wiped immediately upon termination.

### Application-Level Governance
1. **Source Code Size Ceiling:** Maximum allowable source code size is strictly **64 KB** (`Buffer.byteLength > 64 * 1024` returns `413 CODE_TOO_LARGE`).
2. **Anti-Leak Result Sanitization:**
   - In `runCode` (sample runs), inputs and outputs are visible.
   - In `submitSolution`, all results pass through `publicTestResults()`:
     ```javascript
     export function publicTestResults(results) {
       return results.map((testcase) => {
         if (testcase.isVisible) return testcase;
         return {
           testIndex: testcase.testIndex,
           isVisible: false,
           passed: testcase.passed,
           status: testcase.status,
           time: testcase.time,
           memory: testcase.memory,
         };
       });
     }
     ```
   - Hidden inputs, expected outputs, and actual student outputs for hidden tests are stripped before response serialization.
3. **Owner-Only Submission Access:** Polling `GET /submissions/:id` verifies `submission.userId === req.user.id`. Any mismatch returns `404 SUBMISSION_NOT_FOUND`.

---

## 14. Anticipated Future Questions & Technical Decisions

### Q1: What happens if a student prints the random marker text intentionally?
**Answer:** The platform driver generates a random hex marker for every execution (`__CALIBR8_RESULT_<randomHex>__`). When extracting output, the backend scans `stdout` in **reverse order** (from bottom to top) and takes the last occurrence of the marker line. Because the platform driver is appended after student code, the platform's marker output is always the final line.

### Q2: How does the system handle floating-point comparisons or problems with multiple valid outputs?
**Answer:** Currently, `areOutputsEqual()` normalizes whitespace and JSON representations. For problems requiring float tolerance (e.g. $\pm 10^{-5}$) or arbitrary array permutations, Calibr8 plans a custom checker mechanism (Special Judge / `checker.py`) executed on the backend rather than Judge0, keeping evaluation logic fully customizable.

### Q3: Why does Calibr8 use polling instead of WebSockets or SSE for submissions?
**Answer:** 
- Polling (`GET /submissions/:id` every 1s) is stateless, resilient to network disconnects, firewall-friendly, and simple to horizontally scale.
- For 100 concurrent users, polling produces modest HTTP traffic (~100 req/sec) that can be served directly from in-memory cache (`submissionCache`).
- Server-Sent Events (SSE) or WebSockets can be introduced in Phase 3 for sub-second UI updates without altering the underlying submission execution engine.

### Q4: How should we calibrate CPU time limits across different languages?
**Answer:** Python and JavaScript run in interpreted/VM environments and require 2x–3x more execution time than compiled C++ for equivalent algorithms. The recommended practice is establishing language multipliers:
- C++ / C: `1.0x` multiplier (base time limit, e.g. 1000ms)
- Java: `1.5x` multiplier (1500ms, accounting for JVM JIT warmup)
- Python 3: `2.0x` – `3.0x` multiplier (2000ms – 3000ms)
- JavaScript: `1.5x` – `2.0x` multiplier (1500ms – 2000ms)

---

*Documentation maintained by Calibr8 Core Engineering Team.*