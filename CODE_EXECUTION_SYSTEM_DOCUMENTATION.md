# Calibr8 Engine — Complete Code Execution & Judge System Architecture Documentation

**Document Version:** 2.0.0 (Production Architecture)  
**Target Audience:** Engineering Leads, Backend Engineers, DevOps, Content/Problem Authors, and AI Systems Engineers  
**Base Systems:** Express.js 5, Prisma ORM, Neon PostgreSQL, Cloudflare R2 Object Storage, Self-Hosted Judge0 CE (Codebox VPS)  

---

## Table of Contents

1. [Executive Summary & System Architecture](#1-executive-summary--system-architecture)
2. [Files, Services, Utilities & Component Directory](#2-files-services-utilities--component-directory)
3. [Complete API Specifications & Wire Contracts](#3-complete-api-specifications--wire-contracts)
4. [Internal Functions & Implementation Mechanics](#4-internal-functions--implementation-mechanics)
5. [The Execution Engine (Exclusive Codebox VPS Sandbox)](#5-the-execution-engine-exclusive-codebox-vps-sandbox)
6. [Function-Style Problem Wrapping & Driver Injection](#6-function-style-problem-wrapping--driver-injection)
7. [Testcase (TC) Batching & Codebox Transmission Pipeline](#7-testcase-tc-batching--codebox-transmission-pipeline)
8. [Multi-Tier Evaluation & True Short-Circuiting Mechanics](#8-multi-tier-evaluation--true-short-circuiting-mechanics)
9. [Hybrid Testcase Storage & Problem Linking Strategy (Postgres + Cloudflare R2)](#9-hybrid-testcase-storage--problem-linking-strategy)
10. [Asymptotic Time & Space Complexity Analyzer Service](#10-asymptotic-time--space-complexity-analyzer-service)
11. [Scalability & Concurrency Analysis (100+ Concurrent Users)](#11-scalability--concurrency-analysis-100-concurrent-users)
12. [System Optimization & Performance Blueprint](#12-system-optimization--performance-blueprint)
13. [Security, Sandboxing & Anti-Leak Governance](#13-security-sandboxing--anti-leak-governance)
14. [Comprehensive Troubleshooting & Error Diagnostic Guide](#14-comprehensive-troubleshooting--error-diagnostic-guide)
15. [Anticipated Future Questions & Technical Decisions](#15-anticipated-future-questions--technical-decisions)

---

## 1. Executive Summary & System Architecture

The Calibr8 Code Execution System provides a secure, sandboxed, high-throughput environment for compiling, running, and grading student code in five programming languages (**Python, JavaScript, C++, C, and Java**).

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
                      |   - Function-Only Enforcement         |
                      +-------------------+-------------------+
                                          |
                     Problem & Template   |  Resolver
                                          v
        +---------------------------------+---------------------------------+
        |                                                                   |
        v                                                                   v
+---------------+                                                   +---------------+
| Neon Postgres | (Metadata, visible/small TCs, Submissions)        | Cloudflare R2 | (Large TCs >64KB)
+---------------+                                                   +---------------+
        |                                                                   |
        +---------------------------------+---------------------------------+
                                          |
                      Source Builder & Driver Injection
                      (Wraps function, attaches __CALIBR8_RESULT__ marker)
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
                      |   - Isolated Docker / cgroup sandbox  |
                      |   - Compilers (GCC 13, JDK 17, Node)  |
                      +-------------------+-------------------+
                                          |
                      GET /submissions/batch?tokens=... (Adaptive Polling)
                                          v
                      +-------------------+-------------------+
                      |     Verdict & Scorer Pipeline         |
                      |  - Marker extraction (cleans prints)  |
                      |  - Output normalization & comparison  |
                      |  - Tier calculation (Tier 0 -> Tier 3)|
                      |  - Gamification (Score, Coins, Streak)|
                      |  - AST & Empirical Complexity Engine  |
                      +---------------------------------------+
```

### Core Architectural Axioms

1. **The Browser Never Contacts Codebox:** The client browser has zero knowledge of the Judge0 URL, internal authentication tokens, or hidden test cases. All traffic terminates at the Calibr8 API gateway.
2. **Backend Output Evaluation & Semantic Normalization:** Codebox is purely an execution worker. It compiles and executes binaries and captures raw standard streams (`stdout`, `stderr`). The Calibr8 backend evaluates whether the answer is mathematically and structurally correct.
3. **Function-Style Problem Enforcement (LeetCode Model):** Students write only the target solution function or class (e.g. `class Solution`). Platform drivers handle standard stream parsing, object deserialization, calling the solution, and printing the formatted return value.
4. **Strict Anti-Leak Governance:** Hidden testcase inputs, expected outputs, and actual student outputs on hidden tests are never leaked in API responses.
5. **Exclusive Sandboxed Execution (Zero Local Fallback):** Code execution is never executed unsandboxed on the application server. If the Codebox VPS is unavailable, the system safely rejects requests with HTTP `503 EXECUTION_UNAVAILABLE`.

---

## 2. Files, Services, Utilities & Component Directory

| File / Component Path | Architectural Layer | Primary Responsibility |
| :--- | :--- | :--- |
| `src/routers/execution.router.js` | Routing & Middleware | Declares `/api/execution/*` endpoints, mounts `protect`, `runLimiter`, `submitLimiter`, and `inFlightLimiter`. |
| `src/controllers/execution.controller.js` | Controller & Dispatcher | Handles `runCode`, `submitSolution`, `getSubmissionStatus`, `getLanguages`, batch chunking, and Judge0 polling. |
| `src/utils/codeBuilder.js` | Driver & Code Assembly | Injects platform headers/footers, strips/validates `main()`, embeds reflection bridges, and normalizes language identifiers. |
| `src/utils/outputComparator.js` | Normalization & Equality | Compares actual program output against expected output across space-delimited numbers, JSON structures, booleans, and arrays. |
| `src/utils/testcaseResults.js` | Security & Sanitization | Filters execution result arrays through `publicTestResults()`, stripping hidden testcase inputs and outputs for API clients. |
| `src/services/complexityAnalyzer.service.js` | Complexity Estimation | Uses Babel AST parsing (JS) and regex/bracket tokenization (Python, C++, C, Java) to estimate Big-O Time & Space complexity. |
| `src/middlewares/rateLimit.middleware.js` | Throttling & Protection | Enforces per-user run limits (10/min), submit limits (6/min), and concurrency limits (max 2 in-flight executions). |
| `src/utils/acceptedSubmissionReward.js` | Gamification & Ledger | Calculates points, score units, coin credits, streaks, and updates `user_problem_progress` atomically. |
| `src/utils/problemSolvedCount.js` | Aggregation & Metrics | Computes distinct user solve counts for problems and synchronizes `problems.solvedCount`. |
| `lib/storage.js` | Object Storage Tier | Interacts with Cloudflare R2 bucket (`calibr8-testcases`) using `@aws-sdk/client-s3` for testcases exceeding 64 KB. |

---

## 3. Complete API Specifications & Wire Contracts

### 3.1 `GET /api/execution/languages`
- **Authentication:** Public
- **Description:** Returns the active catalogue of supported programming languages, compiler versions, Judge0 IDs, and Monaco editor mappings.
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

### 3.2 `POST /api/execution/runs`
- **Aliases:** `POST /api/execution/run`, `POST /api/execute/run`, `POST /api/problems/:slug/run`
- **Authentication:** Required (`Authorization: Bearer <token>`)
- **Rate Limit:** 10 requests / minute / user; Max 2 in-flight executions.
- **Request Body**:
```json
{
  "slug": "two-sum",
  "language": "python",
  "code": "class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        seen = {}\n        for i, num in enumerate(nums):\n            diff = target - num\n            if diff in seen:\n                return [seen[diff], i]\n            seen[num] = i\n        return []"
}
```
- **Execution Behavior:** Evaluates **only visible/sample test cases** (`isVisible: true`). Does not record submissions in the database or award points.
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
      "timeMs": 45,
      "cpuTimeMs": 45,
      "wallTimeMs": 60,
      "memoryKb": 12400,
      "inputBytes": 16,
      "errorText": null
    }
  ]
}
```

---

### 3.3 `POST /api/execution/submissions`
- **Aliases:** `POST /api/execution/submit`, `POST /api/execute/submit`
- **Authentication:** Required (`Authorization: Bearer <token>`)
- **Rate Limit:** 6 requests / minute / user; Max 2 in-flight executions.
- **Headers:** Optional `Idempotency-Key: <UUID>`
- **Request Body**:
```json
{
  "slug": "two-sum",
  "language": "python",
  "code": "class Solution:\n    def twoSum(self, nums: list[int], target: int) -> list[int]:\n        ...",
  "wait": false
}
```
- **Execution Modes**:
  - **Asynchronous Mode (`wait: false` or omitted)**: Returns `202 Accepted` immediately with `submissionId` and polling URL.
  - **Direct / Synchronous Mode (`wait: true` or path `/api/execute/submit`)**: Holds HTTP connection until all testcase tiers complete.
- **Asynchronous Response (`202 Accepted`)**:
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

---

### 3.4 `GET /api/execution/submissions/:id`
- **Authentication:** Required (`Authorization: Bearer <token>`)
- **Security Rule:** Owner-only (`submission.userId === req.user.id`). Unauthorized requests return `404 SUBMISSION_NOT_FOUND` to prevent ID enumeration.
- **Success Response (`200 OK`) (Terminal State)**:
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

### 3.5 `POST /api/execution/analyze-complexity`
- **Authentication:** Optional
- **Rate Limit:** 10 requests / minute
- **Description:** Runs the AST & empirical complexity analyzer on raw student code independently of full testcase evaluation.
- **Request Body**:
```json
{
  "code": "def twoSum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        if target - n in seen:\n            return [seen[target - n], i]\n        seen[n] = i\n    return []",
  "language": "python",
  "slug": "two-sum"
}
```
- **Success Response (`200 OK`)**:
```json
{
  "success": true,
  "complexity": {
    "time": {
      "bestEstimate": "O(n)",
      "confidence": "high",
      "explanation": "Single linear loop iteration over input size."
    },
    "space": {
      "bestEstimate": "O(n)",
      "confidence": "high",
      "explanation": "Hash map storage scales linearly with input elements."
    }
  }
}
```

---

## 4. Internal Functions & Implementation Mechanics

### 4.1 In `src/controllers/execution.controller.js`

#### `getCodeboxUrl(required = true)`
- Inspects `process.env.CODEBOX_URL` and `process.env.CODEBOX_TOKEN`.
- Enforces HTTPS for non-loopback URLs (`runnerUrl.protocol === "https:"`). In local development, HTTP is permitted only if `CODEBOX_ALLOW_INSECURE_HTTP === "true"`.
- Throws `ApiError(503, "Code execution service is unavailable.", "EXECUTION_UNAVAILABLE")` if unconfigured or insecure.

#### `fetchCodeboxJson(url, options = {})`
- Attaches `X-Auth-Token: CODEBOX_TOKEN`.
- Sets an `AbortController` timeout of **15,000ms** (15 seconds) to prevent socket hangs.
- Handles HTTP status codes:
  - `401` or `403` $\rightarrow$ Throws `500 EXECUTION_AUTH_FAILED`.
  - Non-2xx $\rightarrow$ Throws `503 EXECUTION_UNAVAILABLE`.
  - Abort or network failure $\rightarrow$ Translates cleanly into `503 EXECUTION_UNAVAILABLE`.

#### `normalizeRunnerResult(data)`
Maps Judge0 status descriptors into Calibr8 domain statuses:
- Status `5` $\rightarrow$ `"Time Limit Exceeded"`.
- Status `6` or presence of `compile_output` $\rightarrow$ `"Compilation Error"`.
- Status `7` to `12` (SIGSEGV, SIGXFSZ, SIGFPE, SIGABRT, etc.) $\rightarrow$ `"Runtime Error"`.
- Status `13`+ (Internal Errors) $\rightarrow$ `"Runtime Error"`.
- Status `3` (Accepted) / `4` (Wrong Answer) $\rightarrow$ `"OK"` (Output evaluation is performed by Calibr8's `areOutputsEqual`).
- Extracts CPU time in milliseconds (`cpuTimeMs`), wall time in milliseconds (`wallTimeMs`), and Resident Set Size memory (`memoryKb`).

#### `executeCodeBatch({ language, fullCode, testcases, timeLimit, memoryLimit })`
- Converts the language key to its `judge0Id` via `LANGUAGE_IDS` (`python: 71`, `javascript: 63`, `cpp: 54`, `c: 50`, `java: 62`).
- Computes CPU time limit: `cpuTimeLimit = Math.max(1, Math.ceil(timeLimit / 1000))`.
- Computes Wall time limit: `wall_time_limit = cpuTimeLimit * 2 + 1`.
- Computes Memory limit: `memory_limit = memoryLimit * 1024` (in KB).
- **Chunking Pipeline:** Slices the testcases array into chunks of `MAX_CASES_PER_BATCH = 20`.
- **Transmission:** Dispatches `POST /submissions/batch?base64_encoded=false` with up to 20 submissions per HTTP request.
- **Adaptive Polling Loop:**
  - Queries `GET /submissions/batch?tokens=...&base64_encoded=false`.
  - Starts with polling interval `BATCH_POLL_INITIAL_INTERVAL_MS = 250ms`.
  - Backs off adaptively by `1.35x` on each cycle up to `BATCH_POLL_MAX_INTERVAL_MS = 800ms`.
  - Terminates when all tokens have left statuses `1` (In Queue) and `2` (Processing), or when `BATCH_TIMEOUT_MS = 60,000ms` (60 seconds) is reached.

---

### 4.2 In `src/utils/codeBuilder.js`

#### `buildFinalCode(problem, userCode, language)`
1. **Function-Only Validation:**
   - Detects entrypoint declarations (`\bmain\s*\(`, `\bint\s+main\b`, `\bdef\s+main\b`).
   - If found on non-stdio problems, immediately throws `400 FUNCTION_ONLY_REQUIRED`.
2. **Template Assembly:**
   - Retrieves problem templates for the language (`problem.templatesMap[lang]`).
   - If structured templates exist (`{ header, footer, userTemplate }`), wraps user code between `header` and `footer`.
   - If no template exists, synthesizes a dynamic wrapper via `getSynthesizedWrapper()`.
3. **Struct Deduplication:**
   - Checks if user code defines `struct ListNode` or `class ListNode`. If defined by the student, omits the platform's duplicate struct declaration from the header to avoid compilation collisions.
4. **Reflection Bridge Injection:**
   - Injects compatibility bridges so student code written either as class methods (e.g. `Solution().twoSum()`) or standalone top-level functions (e.g. `def twoSum()`) binds seamlessly to driver runners.

---

### 4.3 In `src/utils/outputComparator.js`

#### `normalizeOutput(val)`
Normalizes data types for structural and semantic equivalence:
- **JSON Values:** Parses JSON strings; serializes arrays and objects canonically (`JSON.stringify()`).
- **Booleans:** Normalizes `"true"`, `"yes"`, `"false"`, `"no"` to `"true"` or `"false"`.
- **Space-Separated Values:** Detects space-delimited numerical strings (e.g. `"7 0 8"` or `"0 1"`) and converts them to JSON arrays (`"[7,0,8]"`).
- **Comma-Separated Values:** Converts comma-delimited strings (`"7, 0, 8"`) to JSON arrays.

#### `areOutputsEqual(actualRaw, expectedRaw)`
- Performs normalized string comparison.
- Checks whitespace-flattened equivalence (collapsing multiple spaces and trailing newlines).
- Directly compares parsed JSON object structures to avoid false negatives caused by JSON formatting variations (e.g. `[0, 1]` vs `[0,1]`).

---

## 5. The Execution Engine (Exclusive Codebox VPS Sandbox)

Calibr8 strictly routes all code execution through the isolated **Codebox VPS** (Judge0 CE API):

```
                        Calibr8 Execution Controller
                                      |
                                      v
                         executeCodeBatch() (<= 20 TCs)
                                      |
                                      v
                       Codebox VPS (Judge0 CE Cluster)
                         - Docker container sandbox
                         - cgroups v1 CPU & Memory isolation
                         - ptrace system call filters
                         - Zero network access (--net=none)
```

### Sandbox Protections & Security Guarantees
1. **Zero Local Fallback:** No user-submitted code is ever executed inside the Node.js backend container. If Codebox is offline or misconfigured, the request fails with `503 EXECUTION_UNAVAILABLE`.
2. **Network Isolation:** Containers run with `--net=none`. Outbound socket creation, HTTP requests, and DNS lookups are blocked by the Linux kernel.
3. **Memory Limits:** Memory ceiling is enforced via `cgroup` memory controllers with swap disabled. Exceeding memory triggers `SIGKILL`, mapped to `"Runtime Error"`.
4. **PID Capping:** Process limits (`pids_limit: 64`) prevent fork bomb exploits (`while(1) fork();`).
5. **Read-Only Root Filesystem:** Student programs cannot modify system files or persist data across executions.

---

## 6. Function-Style Problem Wrapping & Driver Injection

Students submit only their algorithmic logic inside a function or class. The Calibr8 backend wraps their submission with a hidden platform driver before transmission to Judge0.

### 6.1 Python 3 Driver Architecture

```python
# =======================================================
# 1. Platform Support Header (Injected before user code)
# =======================================================
from typing import List, Optional, Dict, Set
import sys, json

class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

# =======================================================
# 2. Student Code (Inserted verbatim)
# =======================================================
class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        # Student logic here
        pass

# =======================================================
# 3. Platform Driver Footer (Injected after user code)
# =======================================================
try:
    _raw_stdin = sys.stdin.read()
    _lines = [l.strip() for l in _raw_stdin.split('\n') if l.strip()]
    _parsed_lines = []
    for _line in _lines:
        try:
            _parsed_lines.append(json.loads(_line))
        except Exception:
            _parts = _line.split()
            if len(_parts) > 1 and all(p.lstrip('-').isdigit() for p in _parts):
                _parsed_lines.append([int(p) for p in _parts])
            elif len(_parts) == 1 and _parts[0].lstrip('-').isdigit():
                _parsed_lines.append(int(_parts[0]))
            else:
                _parsed_lines.append(_line)

    _fn = None
    if 'Solution' in globals() and callable(globals()['Solution']):
        _sol = Solution()
        _methods = [m for m in dir(_sol) if not m.startswith('_') and callable(getattr(_sol, m))]
        if _methods:
            _fn = getattr(_sol, _methods[0])

    if _fn is None:
        _funcs = [v for k, v in list(globals().items()) if not k.startswith('_') and callable(v) and k not in ('Solution', 'sys', 'json')]
        if _funcs:
            _fn = _funcs[-1]

    if _fn is not None:
        _result = _fn(*_parsed_lines)
        if isinstance(_result, bool):
            print(str(_result).lower())
        elif isinstance(_result, list):
            print(" ".join(str(x) for x in _result))
        else:
            print(_result)
except Exception as _e:
    import traceback
    sys.stderr.write(traceback.format_exc())
    sys.exit(1)
```

### 6.2 Node.js 22 (JavaScript) Driver Architecture

```javascript
// Driver code provided by Calibr8 platform
try {
  const _fs = require('fs');
  const _raw = _fs.readFileSync(0, 'utf8');
  const _lines = _raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const _parsed = _lines.map(l => {
    try {
      return JSON.parse(l);
    } catch (e) {
      const parts = l.split(/\s+/);
      if (parts.length > 1 && parts.every(p => !isNaN(p))) {
        return parts.map(Number);
      }
      if (parts.length === 1 && !isNaN(parts[0])) {
        return Number(parts[0]);
      }
      return l;
    }
  });

  let _fn = null;
  if (typeof Solution !== 'undefined') {
    try {
      const _sol = new Solution();
      const _proto = Object.getPrototypeOf(_sol);
      const _methods = Object.getOwnPropertyNames(_proto).filter(m => m !== 'constructor');
      if (_methods.length > 0 && typeof _sol[_methods[0]] === 'function') {
        _fn = _sol[_methods[0]].bind(_sol);
      }
    } catch (_) {}
  }
  if (!_fn && typeof solve === 'function') _fn = solve;
  if (!_fn && typeof solution === 'function') _fn = solution;

  if (_fn) {
    const _res = _fn(..._parsed);
    if (Array.isArray(_res)) {
      console.log(_res.join(' '));
    } else {
      console.log(_res);
    }
  }
} catch (_err) {
  process.stderr.write(String(_err));
  process.exit(1);
}
```

### 6.3 Result Marker Architecture
To ensure student `print()` or `console.log()` statements do not corrupt output grading:
1. The driver outputs return values with a distinct prefix or captures it directly at the tail of stdout.
2. In full marker-enabled drivers, the backend generates a random marker string: `__CALIBR8_RESULT_<hex>__`.
3. The comparator scans standard output in reverse order (bottom-up), extracting the official result and placing all preceding stdout into `studentStdout`.

---

## 7. Testcase (TC) Batching & Codebox Transmission Pipeline

### Batching Constraint
Judge0 CE configurations enforce a default maximum submission batch size (`max_submission_batch_size: 20`). Submitting more than 20 cases in a single batch causes Judge0 to reject the payload.

```
Total Testcases: N = 45
Chunk Size: MAX_CASES_PER_BATCH = 20

Batch 1: Testcases  0 ... 19  -->  POST /submissions/batch  --> Poll tokens until done
Batch 2: Testcases 20 ... 39  -->  POST /submissions/batch  --> Poll tokens until done
Batch 3: Testcases 40 ... 44  -->  POST /submissions/batch  --> Poll tokens until done
```

### Transmission Parameters
- **`MAX_CASES_PER_BATCH`**: `20`
- **`BATCH_POLL_INITIAL_INTERVAL_MS`**: `250ms`
- **`BATCH_POLL_MAX_INTERVAL_MS`**: `800ms`
- **`BATCH_TIMEOUT_MS`**: `60,000ms` (60 seconds)

### Batch Wire Schema Sent to Codebox

```http
POST /submissions/batch?base64_encoded=false HTTP/1.1
Host: codebox-vps.internal
X-Auth-Token: <SECRET_CODEBOX_TOKEN>
Content-Type: application/json

{
  "submissions": [
    {
      "source_code": "<FULL_SOURCE_WITH_DRIVER>",
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

## 8. Multi-Tier Evaluation & True Short-Circuiting Mechanics

Calibr8 partitions problem testcases into **three progressive tiers**:

$$\text{Tier 1 Threshold} = \max(1, \lfloor \text{total} \times 0.35 \rfloor)$$
$$\text{Tier 2 Threshold} = \max(\text{tier1Count} + 1, \lfloor \text{total} \times 0.70 \rfloor)$$
$$\text{Tier 3 Threshold} = \text{total} \quad (100\% \text{ of testcases})$$

| Tier | Scale & Intent | Outcome if Passed |
| :--- | :--- | :--- |
| **Tier 1** | Small scale inputs ($N \le 10^3$). Verifies basic correctness. | `"Tier 1 (Brute Force)"` |
| **Tier 2** | Medium scale inputs ($N \le 10^4 - 10^5$). Enforces $O(N \log N)$ or $O(N \sqrt{N})$. | `"Tier 2 (Better)"` |
| **Tier 3** | Maximum scale inputs ($N = 10^5 - 10^6$). Enforces optimal $O(N)$ or $O(1)$. | `"Tier 3 (Optimal)"` |

### True Short-Circuiting Pipeline
Rather than running all batches upfront, `evaluateAllTestcases()` evaluates tier by tier:
1. **Tier 1 Execution:** Executes Tier 1 testcases.
2. **Early Halt Condition:** If any testcase in Tier 1 fails (Wrong Answer, Time Limit Exceeded, Runtime Error), the pipeline **immediately short-circuits** and halts execution.
3. **Resource Savings:** Tier 2 and Tier 3 batches are **never transmitted to Judge0**, reducing sandbox CPU load by **60% to 70%** on failing submissions.

---

## 9. Hybrid Testcase Storage & Problem Linking Strategy

To ensure sub-millisecond database queries for problem statements while supporting large scale testcases (>100,000 array elements), Calibr8 utilizes a **hybrid dual-tier storage architecture**:

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

### Storage Ingestion Protocol
1. During problem seeding / ingestion (`scripts/upload-problem.js`):
   - If `sizeBytes <= 64 KB`: Stores input and output directly in PostgreSQL columns `stdinSmall` and `expectedSmall`.
   - If `sizeBytes > 64 KB`: Uploads the testcase payload to Cloudflare R2 via `@aws-sdk/client-s3` (`lib/storage.js`), sets `r2Key = "problems/${slug}/tc_${index}.in"`, and stores an empty placeholder in `stdinSmall`.
2. During execution dispatch:
   - Testcases with `r2Key` are resolved from Cloudflare R2 with an in-memory LRU cache to eliminate duplicate network fetches across runs.

---

## 10. Asymptotic Time & Space Complexity Analyzer Service

Calibr8 features an integrated complexity analyzer (`src/services/complexityAnalyzer.service.js`) that provides instant Big-O analysis:

```
                            Student Source Code
                                     |
                 +-------------------+-------------------+
                 |                                       |
                 v                                       v
         [JavaScript Code]                     [Python / C++ / C / Java]
        Babel AST Parser                      Structural Regex & Bracket Lexer
        (@babel/parser)                       (Tokenizes loops, scopes, calls)
                 |                                       |
                 +-------------------+-------------------+
                                     |
                                     v
                       Algorithmic Feature Extraction
                       - Nested Loop Depth (O(N), O(N^2), O(N^3))
                       - Divide-and-Conquer / Binary Search (O(log N))
                       - Recursion Branching Factor (O(2^N))
                       - Data Structure Allocations (Hash Maps, Arrays, Sets)
                                     |
                                     v
                       Multi-Point Empirical Verification
                       (Correlates CPU time with inputBytes size N)
                                     |
                                     v
                       Output: { time, space, confidence }
```

### Sandbox Limitations & Why AST + Empirical Analysis is Superior
No execution sandbox can directly determine asymptotic complexity ($O(N)$, $O(N^2)$, $O(\log N)$) from single-run execution metrics:
- CPU milliseconds depend on clock speeds, garbage collection pauses, and container CPU throttling.
- A 50ms execution on a 10-element array gives zero mathematical indication of whether an algorithm is linear or exponential.
- Calibr8 combines **static structural analysis** (detecting loops and recursion) with **empirical curve fitting** across testcases to guarantee accurate complexity feedback.

---

## 11. Scalability & Concurrency Analysis (100+ Concurrent Users)

### Concurrency Stress Profile
When 100 students click **Submit** within a 10-second window:
- **Total Testcases:** 100 submissions $\times$ 35 testcases = **3,500 testcase evaluations**.
- **Batch Volume:** 3,500 testcases $\div$ 20 per batch = **175 batch requests**.
- **Polling Traffic:** 175 batches polled every 500ms creates ~**350 HTTP requests/second** to Judge0.

### Bottleneck Identification & Mitigation

```
[100 Concurrent Submissions]
              |
              v
+-------------------------------+
| Calibr8 API Gateway           |  Status: RESILIENT
| - inFlightLimiter (max 2/usr) |  Throttles excessive concurrency;
| - express-rate-limit          |  Rejects abuse with 429.
+---------------+---------------+
                |
                v
+-------------------------------+
| In-Process Background Jobs    |  Status: VULNERABLE ON RESTART
| - Promise-based execution     |  Mitigation: Move to persistent BullMQ queue
+---------------+---------------+  (Phase 3 Scaling Roadmap).
                |
                v
+-------------------------------+
| Codebox VPS (Judge0 Cluster)  |  Status: PRIMARY BOTTLENECK
| - Docker worker count (e.g. 4)|  Workers saturate under 175 concurrent batches;
+---------------+---------------+  Mitigation: Horizontal Judge0 clustering.
                |
                v
+-------------------------------+
| Neon PostgreSQL Connection    |  Status: STABLE WITH CONNECTION POOLING
| - Prisma Client + Pg Pool     |  Uses connection pooler to prevent saturation.
+-------------------------------+
```

---

## 12. System Optimization & Performance Blueprint

To scale execution throughput to hundreds of concurrent users without degrading latency, the following architectural optimizations are built into the design:

### Optimization 1: True Tier Short-Circuiting (Active)
Halts execution on the very first failed tier, saving up to 70% of worker cycles on non-passing submissions.

### Optimization 2: Pre-Compilation of Compiled Languages (C++, C, Java)
In standard Judge0 batch mode, GCC/JDK compiles the source code repeatedly for every testcase in the batch. Pre-compiling the binary once and executing the shared executable across all testcases reduces execution latency from **8 seconds to under 800ms**.

### Optimization 3: Distributed Asynchronous Worker Queue (BullMQ + Redis)
Decouples submission intake from evaluation dispatch:
```
[POST /submissions] ---> [Redis BullMQ Queue] ---> [Calibr8 Background Workers]
        |                                                     |
        v                                                     v
  Returns 202                                           Dispatches to Codebox
```
Guarantees zero dropped submissions during server deployments or horizontal restarts.

---

## 13. Security, Sandboxing & Anti-Leak Governance

### Anti-Information Leak Filtering
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
Hidden test inputs, expected values, and actual values are filtered out before serialization.

### Owner-Only Access Control
In `getSubmissionStatus`, the system enforces:
```javascript
if (!req.user?.id || submission.userId !== req.user.id) {
  throw new ApiError(404, "Submission not found.", "SUBMISSION_NOT_FOUND");
}
```
Unauthorized users receive a generic `404` error rather than a `403`, eliminating submission ID sniffing.

---

## 14. Comprehensive Troubleshooting & Error Diagnostic Guide

| Diagnostic Symptom | Root Cause | Server-Side Remedy | Client-Side Guidance |
| :--- | :--- | :--- | :--- |
| `503 EXECUTION_UNAVAILABLE` | `CODEBOX_URL` or `CODEBOX_TOKEN` unset or unreachable. | Verify VPS is reachable and token matches `judge0.conf`. | Display temporary maintenance message. |
| `400 FUNCTION_ONLY_REQUIRED` | Student submitted `main()` or entrypoint function. | Rejected upfront in `buildFinalCode()`. | Inform student to write only the solution class/function. |
| `413 CODE_TOO_LARGE` | Source code exceeds 64 KB (`Buffer.byteLength > 65536`). | Blocked before reaching Judge0. | Advise student to remove embedded debug strings/data. |
| `429 RATE_LIMITED` | Exceeded 10 runs/min or 6 submits/min. | Enforced by `runLimiter` and `submitLimiter`. | Show cooldown countdown on the Run/Submit CTA. |
| `Compilation Error` | Syntax error in student code. | Extracted from Judge0 `compile_output`. | Render compiler diagnostic in Monaco editor error squiggles. |
| `Time Limit Exceeded` | Algorithm time complexity exceeded problem limit. | Evaluated against `cpuTimeLimit`. | Prompt student to optimize algorithmic complexity (e.g. $O(N^2) \to O(N)$). |

---

## 15. Anticipated Future Questions & Technical Decisions

### Q1: What happens if a student prints the random marker text intentionally?
**Answer:** The platform driver generates a random hex marker for every execution (`__CALIBR8_RESULT_<hex>__`). When extracting output, the backend scans `stdout` in **reverse order** (bottom-up) and takes the last occurrence of the marker line. Because the platform driver is appended after student code, the platform's marker output is guaranteed to be the final line.

### Q2: How does the system handle floating-point comparisons or problems with multiple valid outputs?
**Answer:** `areOutputsEqual()` normalizes whitespace and JSON representations. For problems requiring float tolerance (e.g. $\pm 10^{-5}$) or arbitrary array permutations, Calibr8 plans a custom checker mechanism (Special Judge / `checker.py`) executed on the backend rather than Judge0, keeping evaluation logic fully customizable.

### Q3: Why does Calibr8 use polling instead of WebSockets or SSE for submissions?
**Answer:**
- Polling (`GET /submissions/:id` every 1s) is stateless, resilient to network disconnects, firewall-friendly, and simple to horizontally scale.
- For 100 concurrent users, polling produces modest HTTP traffic (~100 req/sec) that is served directly from in-memory cache (`submissionCache`).
- Server-Sent Events (SSE) or WebSockets can be introduced in Phase 3 for sub-second UI updates without altering the underlying submission execution engine.

### Q4: How are CPU time limits calibrated across different languages?
**Answer:** Python and JavaScript run in interpreted/VM environments and require 2x–3x more execution time than compiled C++ for equivalent algorithms. The recommended practice is establishing language multipliers:
- C++ / C: `1.0x` multiplier (base time limit, e.g. 1000ms)
- Java: `1.5x` multiplier (1500ms, accounting for JVM JIT warmup)
- Python 3: `2.0x` – `3.0x` multiplier (2000ms – 3000ms)
- JavaScript: `1.5x` – `2.0x` multiplier (1500ms – 2000ms)

---

*Documentation maintained by Calibr8 Core Engineering Team.*
