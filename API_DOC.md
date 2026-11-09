# CALIBR8 — API DOCUMENTATION & CONTRACT SPECIFICATION

> **Version**: 2.1.0 (Production Release)  
> **Global Prefix**: `/api` (with root convenience routes `/health`, `/ping`, and interactive console at `/`)  
> **Base URL**: `http://localhost:3000`  
> **Authentication**: Bearer JWT token (`Authorization: Bearer <token>`)  
> **Timezone**: Indian Standard Time (`Asia/Kolkata`, UTC+5:30) for all gamification and daily milestones

---

## 1. Core Architectural & Business Rules

1. **Default Account Balance**: Every registered user starts with `100 coins`, `streak: 0`, `longestStreak: 0`, and `rating: 800` (Pulse II tier).
2. **Strict IST Day Boundary**: All daily milestones, daily login rewards, and daily problem resets operate on `Asia/Kolkata` date string `YYYY-MM-DD`. Days start strictly at `00:00:00 IST`. UTC or local client system dates are never used for day boundaries.
3. **Never-Block Rule**: Coin transactions and reward computations never fail or crash user login, registration, or code submissions. In case of storage errors, safe default payloads (`granted: false`, `coins: 0`) are returned while preserving HTTP 200 responses.
4. **Single Authority for Coins**: Only `src/services/coinService.js` and `src/services/dailyProblemService.js` may modify `User.coins`. All coin modifications write an immutable audit row to `CoinTransaction` with the updated `balanceAfter`.
5. **Anti-Information Leak**: Hidden evaluation testcases (`isVisible: false`) never leak inputs or expected outputs in API responses.
6. **Function-Only Submissions**: User code submissions must provide function or class solutions only. Submissions defining `main()` are rejected with `400 FUNCTION_ONLY_REQUIRED`.

---

## 2. Master Error Taxonomy & Standard Error Format

All errors emitted by the API adhere strictly to this schema:
```json
{
  "success": false,
  "code": "ERROR_CODE_STRING",
  "message": "Human-readable explanation of error.",
  "details": {}
}
```

| HTTP Status | Standard Code | Meaning |
|---|---|---|
| `400` | `BAD_REQUEST` | Validation failed, required field missing, or illegal state |
| `400` | `FUNCTION_ONLY_REQUIRED` | Submitted code contains `main()`; function-only required |
| `401` | `UNAUTHORIZED` | Bearer token missing, invalid, or expired |
| `401` | `TOKEN_REVOKED` | Token was explicitly revoked via logout |
| `403` | `FORBIDDEN` | Access denied or attempting to apply unowned theme |
| `404` | `NOT_FOUND` | Resource (problem, topic, user, subject) not found |
| `409` | `CONFLICT` | Email or unique field already exists |
| `413` | `CODE_TOO_LARGE` | Source code exceeds 64 KB limit |
| `422` | `UNSUPPORTED_LANGUAGE` | Programming language not supported |
| `429` | `RATE_LIMITED` | Too many requests within rate limit window |
| `503` | `EXECUTION_UNAVAILABLE` | CodeBox execution runner is unreachable |

---

## 3. System & Health Endpoints

### 3.1 `GET /health` & `GET /api/health`
Returns system status, service name, and ISO timestamp.
- **Access**: Public
- **Response (`200 OK`)**:
```json
{
  "status": "ok",
  "service": "Calibr8 Backend",
  "timestamp": "2026-11-09T08:50:00.000Z"
}
```

### 3.2 `GET /ping` & `GET /api/ping`
Simple ping endpoint returning plain text `"pong"`.
- **Access**: Public
- **Response (`200 OK`)**: `pong`

### 3.3 `GET /` (Content Negotiated)
Interactive developer dashboard or JSON API specification:
- When requested with `Accept: text/html` (e.g. browser), returns the interactive UI dashboard (`public/index.html`).
- When requested with `Accept: application/json` or by API clients, returns the full service directory and endpoint metadata catalog.

---

## 4. Authentication & Session Lifecycle (`/api/auth`)

### 4.1 `POST /api/auth/register`
Creates a new user account.
- **Access**: Public
- **Validation**:
  - `email`: Valid email format (case-insensitive).
  - `password`: Minimum 8 characters, maximum 72 bytes, must not equal email.
- **Request**:
```json
{
  "email": "student@calibr8.dev",
  "password": "StrongPassword123",
  "name": "Jane Developer"
}
```
- **Response (`201 Created`)**:
```json
{
  "success": true,
  "message": "User registered successfully.",
  "user": {
    "id": "usr-12345",
    "email": "student@calibr8.dev",
    "name": "Jane Developer",
    "coins": 100,
    "streak": 0,
    "rating": 800
  },
  "token": "eyJhbGciOiJIUzI1Ni..."
}
```

### 4.2 `POST /api/auth/login`
Authenticates user, issues JWT, and awards daily login coin (+1 on first login of IST day).
- **Access**: Public
- **Request**:
```json
{
  "email": "student@calibr8.dev",
  "password": "StrongPassword123"
}
```
- **Response (`200 OK`)**:
```json
{
  "success": true,
  "user": {
    "id": "usr-12345",
    "email": "student@calibr8.dev",
    "name": "Jane Developer",
    "coins": 101,
    "streak": 0,
    "rating": 800
  },
  "token": "eyJhbGciOiJIUzI1Ni...",
  "rewards": {
    "coinsEarnedToday": 1,
    "loginCoins": 1,
    "isNewDay": true
  }
}
```

### 4.3 `POST /api/auth/logout`
Revokes active token persistently.
- **Access**: Protected (`Bearer`)
- **Response (`200 OK`)**:
```json
{
  "success": true,
  "message": "Logged out successfully. Token has been revoked."
}
```

### 4.4 `POST /api/auth/refresh`
Refreshes active token and issues an updated JWT.
- **Access**: Protected (`Bearer`)
- **Response (`200 OK`)**: Returns updated token and user claims.

### 4.5 `GET /api/auth/me` & `GET /api/auth/verify`
Returns authenticated user claims and header statistics.
- **Access**: Protected (`Bearer`)
- **Response (`200 OK`)**:
```json
{
  "success": true,
  "user": {
    "id": "usr-12345",
    "email": "student@calibr8.dev",
    "name": "Jane Developer",
    "coins": 101,
    "streak": 0,
    "rating": 800,
    "tier": "Pulse II"
  }
}
```

### 4.6 `POST /api/auth/change-password`
Updates password after verifying the old password.
- **Access**: Protected (`Bearer`)
- **Request**: `{ "currentPassword": "OldPassword123", "newPassword": "NewStrongPassword456" }`
- **Response (`200 OK`)**: `{ "success": true, "message": "Password changed successfully." }`

---

## 5. User Profile & Academic Management (`/api/users`)

### 5.1 `GET /api/users/me`
Retrieves full user profile including calibrated topics and preferred language.
- **Access**: Protected

### 5.2 `GET /api/users/me/overview`
Retrieves profile overview, streak stats, and daily fully accepted submission activity map.
- **Access**: Protected
- **Response (`200 OK`)**:
```json
{
  "success": true,
  "user": {
    "id": "usr-12345",
    "name": "Jane Developer",
    "coins": 101,
    "streak": 3,
    "longestStreak": 5,
    "rating": 850,
    "tier": "Pulse III",
    "activity": {
      "2026-11-08": 2,
      "2026-11-09": 1
    }
  }
}
```

### 5.3 `GET /api/users/me/activity`
Returns the user's daily accepted submission activity map `{ [YYYY-MM-DD]: count }`.
- **Access**: Protected

### 5.4 `PUT /api/users/me` & `PATCH /api/users/me`
Updates profile name and academic background fields.
- **Access**: Protected
- **Request**:
```json
{
  "name": "Jane Developer",
  "college": "IIT Delhi",
  "batch": "2026",
  "branch": "Computer Science",
  "state": "Delhi",
  "country": "India"
}
```

### 5.5 `PATCH /api/users/me/language`
Updates preferred coding language (`cpp`, `c`, `java`, `python`, `javascript`).
- **Access**: Protected

### 5.6 `GET /api/users/all`
Returns all problems annotated with the user's individual solve status (`solved: true/false`).
- **Access**: Protected

---

## 6. DSA Topics & Skill Calibration (`/api/topics` & `/api/onboarding`)

### 6.1 `GET /api/topics`
Lists all calibration topics. Optional query `?category=dsa` or `?category=core`.
- **Access**: Public

### 6.2 `GET /api/topics/dsa`
Lists DSA-specific calibration topics.
- **Access**: Public

### 6.3 `GET /api/topics/dsa/categories` & `GET /api/topics/categories`
Returns structured DSA category groups (Arrays, Two Pointers, Trees, Graphs, DP) with problem counts.
- **Access**: Public / Protected

### 6.4 `GET /api/topics/dsa/:slug/problems`
Returns all problems mapped to a specific DSA topic slug.
- **Access**: Public

### 6.5 `GET /api/topics/:identifier`
Retrieves topic details by ID or unique slug.
- **Access**: Protected

### 6.6 `POST /api/onboarding` & `PUT /api/onboarding/levels`
Saves user's topic calibrations or sets the 1-click beginner preset (`beginner: true`).
- **Access**: Protected
- **Request**:
```json
{
  "beginner": true
}
```
Or custom calibrations:
```json
{
  "difficulty": "medium",
  "topicIds": ["arrays", "two-pointers"]
}
```

---

## 7. Problems & Starter Code Catalog (`/api/problems`)

### 7.1 `GET /api/problems`
Lists problems with optional filtering and pagination.
- **Query Parameters**:
  - `difficulty`: `Easy`, `Medium`, `Hard`
  - `topic`: Topic slug
  - `search`: Keyword matching in title or description
  - `status`: `solved`, `unsolved` (when authenticated)
  - `page`: Page number (default: 1)
  - `limit`: Problems per page (default: 20)
- **Access**: Public (Optional Auth)

### 7.2 `GET /api/problems/:slug`
Retrieves problem statement, constraints, visible testcases, and templates. Hidden testcases are redacted.
- **Access**: Public

### 7.3 `GET /api/problems/:slug/starter` & `/template`
Retrieves clean starter function signature for student editor.
- **Query Parameters**: `?language=python` (or `cpp`, `c`, `java`, `javascript`)
- **Access**: Public

### 7.4 `POST /api/problems/:slug/run`
Executes user code against visible sample testcases for the problem.
- **Access**: Protected

### 7.5 `POST /api/problems/:slug/submit`
Submits solution for multi-tier judging against all testcases for the problem.
- **Access**: Protected

---

## 8. Code Execution Sandbox & Judging (`/api/execution`)

### 8.1 `GET /api/execution/languages`
Lists supported languages, versions, and Judge0 IDs.
- **Access**: Public
- **Response (`200 OK`)**:
```json
{
  "success": true,
  "languages": [
    { "key": "python", "label": "Python 3", "version": "Python 3.10", "judge0Id": 71 },
    { "key": "javascript", "label": "JavaScript", "version": "Node.js 22", "judge0Id": 63 },
    { "key": "cpp", "label": "C++ (GCC)", "version": "GCC 13 (C++20)", "judge0Id": 54 },
    { "key": "c", "label": "C (GCC)", "version": "GCC 13", "judge0Id": 50 },
    { "key": "java", "label": "Java (OpenJDK)", "version": "OpenJDK 17", "judge0Id": 62 }
  ]
}
```

### 8.2 `POST /api/execution/run` / `POST /api/execution/runs`
Executes code against sample (visible) testcases only. Supports custom `stdin` without a problem slug.
- **Access**: Protected
- **Request**:
```json
{
  "slug": "two-sum",
  "language": "python",
  "code": "class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]"
}
```
- **Response (`200 OK`)**:
```json
{
  "success": true,
  "verdict": "Accepted",
  "passedCount": 2,
  "totalCount": 2,
  "results": [
    {
      "index": 0,
      "input": "4 9\n2 7 11 15",
      "expected": "0 1",
      "actual": "0 1",
      "passed": true,
      "status": "Accepted",
      "timeMs": 15,
      "memoryKb": 1024
    }
  ]
}
```

### 8.3 `POST /api/execution/submit` / `POST /api/execution/submissions`
Full multi-tier judging across sample and hidden testcases.
- **Access**: Protected
- **Short-Circuiting**: If Tier 1 fails, execution halts immediately; Tier 2 and Tier 3 batches are not evaluated.
- **Response (`200 OK`)**:
```json
{
  "success": true,
  "submissionId": "sub_1794215000_abc123",
  "verdict": "ACCEPTED",
  "tierReached": "Tier 3 (Optimal)",
  "passedCount": 5,
  "totalCount": 5,
  "reward": { "coinsEarned": 10, "pointsEarned": 15 }
}
```

### 8.4 `GET /api/execution/submissions/:id`
Polls status and results of a submission. Strictly restricted to submission owner.
- **Access**: Protected (Owner Only)

### 8.5 `POST /api/execution/analyze-complexity`
Performs static AST and lexical complexity analysis.
- **Access**: Optional Auth
- **Response (`200 OK`)**:
```json
{
  "success": true,
  "complexity": {
    "time": { "bestEstimate": "O(n)", "confidence": "high" },
    "space": { "bestEstimate": "O(n)", "confidence": "high" },
    "summary": "Single traversal using hash table lookup."
  }
}
```

---

## 9. Automated Daily Problem & Streaks (`/api/daily-problem`)

### 9.1 `GET /api/daily-problem`
Retrieves today's assigned Daily Problem and completion status.
- **Access**: Optional Auth
- **Response (`200 OK`)**:
```json
{
  "success": true,
  "istDate": "2026-11-09",
  "problem": {
    "id": "two-sum",
    "slug": "two-sum",
    "title": "Two Sum",
    "difficulty": "Easy"
  },
  "completed": false,
  "reward": { "coins": 2, "streak": 1 },
  "nextRefreshTime": "12:00 AM IST"
}
```

### 9.2 `GET /api/daily-problem/history`
Retrieves paginated history of past daily problems and completion records.
- **Query Parameters**: `?page=1&limit=20`
- **Access**: Optional Auth

---

## 10. Coin Rewards & Store (`/api/coins` & `/api/themes`)

### 10.1 `GET /api/coins/balance`
Returns coin balance, current streak, longest streak, and last login date.
- **Access**: Protected

### 10.2 `GET /api/coins/history`
Returns paginated audit log of coin transactions.
- **Query Parameters**: `?limit=20&offset=0`
- **Access**: Protected

### 10.3 `GET /api/themes`
Lists all available IDE themes, ownership status, and coin prices.
- **Access**: Protected

### 10.4 `GET /api/themes/me`
Returns user's currently active theme and balance.
- **Access**: Protected

### 10.5 `POST /api/themes/:slug/buy`
Purchases a theme using coins. Deducts price and records audit log.
- **Access**: Protected

### 10.6 `PUT /api/themes/apply`
Applies an owned or default theme to the user profile.
- **Access**: Protected

---

## 11. Global Rankings & Leaderboard (`/api/rankings`)

### 11.1 `GET /api/rankings`
Retrieves leaderboard ranked by score descending. Sensitive fields (`passwordHash`) are excluded.
- **Query Parameters**:
  - `scope`: `global`, `college`, `batch`, `state`, `country`
  - `college`: Filter by college name
  - `batch`: Filter by graduation batch year
  - `state`: Filter by state
  - `country`: Filter by country
  - `limit`: Number of users (1 to 100, default: 50)
  - `skip`: Pagination offset (default: 0)
- **Access**: Public
- **Response (`200 OK`)**:
```json
{
  "success": true,
  "count": 10,
  "total": 1250,
  "rankings": [
    {
      "rank": 1,
      "id": "usr-1",
      "name": "Alex Coder",
      "rating": 1820,
      "tier": "Zenith I",
      "score": 182,
      "streak": 14,
      "college": "IIT Delhi",
      "batch": "2026"
    }
  ]
}
```

---

## 12. Computer Science Curriculum & MCQs (`/api/study`)

### 12.1 `GET /api/study/subjects`
Lists CS subjects (Computer Networks, DBMS, Operating Systems, etc.) with chapter counts.
- **Access**: Public

### 12.2 `GET /api/study/subjects/:subjectSlug`
Retrieves subject chapters and curriculum structure.
- **Access**: Public

### 12.3 `GET /api/study/chapters/:chapterId/topics`
Lists topics within a chapter.
- **Access**: Public

### 12.4 `GET /api/study/topics/:topicSlug`
Retrieves topic reading material and MCQ quiz question bank.
- **Access**: Public

### 12.5 `POST /api/study/topics/:topicSlug/submit`
Submits answers to MCQ quiz. Grades answers and returns item-level explanations.
- **Access**: Protected
- **Request**: `{ "answers": { "mcq-1": 1, "mcq-2": 0 } }`
- **Response (`200 OK`)**:
```json
{
  "success": true,
  "score": 100,
  "total": 2,
  "passed": 2,
  "feedback": [
    { "mcqId": "mcq-1", "correct": true, "explanation": "The Data Link Layer is responsible for framing." }
  ]
}
```

---

## 13. Social Account Linking & OAuth (`/api/social`)

### 13.1 `GET /api/social/:provider/link-url`
Generates a signed OAuth link URL with HMAC-SHA256 state protection.
- **Access**: Protected

### 13.2 `GET /api/social/:provider/callback`
Handles OAuth provider callback with error redirect codes (`CANCELLED`, `EXPIRED`, `UNKNOWN_PROVIDER`) and open-redirect defenses.
- **Access**: Public

### 13.3 `DELETE /api/social/:provider`
Unlinks a connected social provider from the user profile.
- **Access**: Protected
