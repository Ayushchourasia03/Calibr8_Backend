# Calibr8 Backend API Documentation

**Base URL**: `http://localhost:3000` by default (`PORT` can override it; dev runs on `0.0.0.0:3000`)  
**Standard API Prefix**: `/api`  
**Authentication Header**: `Authorization: Bearer <jwt-token>` (for all protected endpoints)  
**Content-Type**: `application/json` (for all endpoints accepting JSON bodies)

**Configuration**: Set `DATABASE_URL` in `.env` to connect to PostgreSQL (Neon serverless or standard PostgreSQL). Set `JWT_SECRET` for production token signing (falls back to a development secret if omitted). Set `OAUTH_STATE_SECRET` (or `JWT_SECRET`) for OAuth state verification. JWT tokens expire after 7 days by default (`JWT_EXPIRES_IN`).

---

## Table of Contents

1. [Architecture & Design Principles](#1-architecture--design-principles)
2. [Health & System Endpoints](#2-health--system-endpoints)
3. [Authentication API (`/api/auth`)](#3-authentication-api-apiauth)
4. [User Profile API (`/api/users`)](#4-user-profile-api-apiusers)
5. [Topics API (`/api/topics`)](#5-topics-api-apitopics)
6. [Onboarding & Skill Calibration API (`/api/onboarding`)](#6-onboarding--skill-calibration-api-apionboarding)
7. [Problems Catalogue API (`/api/problems`)](#7-problems-catalogue-api-apiproblems)
8. [Code Execution API (`/api/execution`)](#8-code-execution-api-apiexecution)
9. [Social & OAuth API (`/api/social`)](#9-social--oauth-api-apisocial)
10. [CS Curriculum & Study Material API (`/api/study`)](#10-cs-curriculum--study-material-api-apistudy)
11. [Utility Scripts & Database Management](#11-utility-scripts--database-management)
12. [Error Handling & Status Codes](#12-error-handling--status-codes)

---

## 1. Architecture & Design Principles

- **Controller-First Architecture**: All route handlers and business logic reside directly inside the respective controller file in `src/controllers/`. There is no separate `services/` layer, keeping the codebase straightforward and easy to trace for all developers.
- **Clean Routing**: Express routers in `src/routers/` are cleanly mounted in `src/routers/index.router.js` under the `/api` prefix.
- **Real Database Access**: Database operations use the official `@prisma/client` connecting via `@prisma/adapter-neon` (for Neon WebSocket connections) or `@prisma/adapter-pg` (for standard PostgreSQL pools).
- **Security & Password Hashing**: Passwords are cryptographically hashed using `bcryptjs` with 10 salt rounds. Stateless authentication uses standard JWTs with bearer token authorization and a memory-based revocation blacklist for user logout.

---

## 2. Health & System Endpoints

### `GET /`

Serves the interactive Developer Dashboard (HTML) when HTML is accepted (`Accept: text/html`), or returns backend service metadata JSON when JSON is accepted (`Accept: application/json`).

- **Auth**: None
- **Headers**: `Accept: application/json`
- **Response (200 OK - JSON mode)**:

```json
{
  "service": "Calibr8 Backend API",
  "status": "online",
  "version": "1.2.0",
  "architecture": {
    "pattern": "Router-Controller-Model",
    "namingConvention": "*.router.js, *.controller.js"
  },
  "features": [
    "User Registration, Login, Logout & Token Revocation",
    "DSA Topic Level Calibration (Easy, Mid, Hard)",
    "Beginner 1-Click Preset (Auto-sets all DSA topics to Easy, rating 800)",
    "Composite Rating Calculation & Difficulty Mapping",
    "Profile Management & Language Preferences",
    "Problem Catalogue (161 coding problems with testcases & multi-language starter templates)",
    "Code Execution Sandbox Runner & Submissions",
    "GitHub OAuth Account Linking"
  ],
  "apiGroups": {
    "auth": "/api/auth",
    "users": "/api/users",
    "topics": "/api/topics",
    "onboarding": "/api/onboarding",
    "problems": "/api/problems",
    "execution": "/api/execution",
    "social": "/api/social",
    "study": "/api/study"
  }
}
```

---

### `GET /health` or `GET /api/health`

Health check endpoint reporting backend service status and timestamp.

- **Auth**: None
- **Response (200 OK)**:

```json
{
  "status": "ok",
  "service": "Calibr8 Backend",
  "timestamp": "2026-10-23T14:00:00.000Z"
}
```

---

### `GET /ping` or `GET /api/ping`

Lightweight latency probe.

- **Auth**: None
- **Response (200 OK)**: `pong` (plain text)

---

## 3. Authentication API (`/api/auth`)

Mounted from `src/routers/auth.router.js` -> `src/controllers/auth.controller.js`.

### `POST /api/auth/register`

Registers a new user account, hashes their password, and immediately issues a signed JWT token.

- **Auth**: None
- **Request Body**:

```json
{
  "email": "developer@example.com",
  "password": "strongPassword123",
  "name": "Alex Developer"
}
```

- **Validation Rules**:
  - `email`: Required, trimmed, converted to lowercase.
  - `password`: Required string.
  - `name`: Required string, trimmed.
  - Returns `409 Conflict` if an account with this email already exists.
- **Response (201 Created)**:

```json
{
  "success": true,
  "user": {
    "id": "c1f7b7f2-1234-4567-89ab-cdef01234567",
    "email": "developer@example.com",
    "name": "Alex Developer",
    "difficulty": null,
    "rating": 800,
    "onboarded": false,
    "preferredLanguage": "cpp",
    "createdAt": "2026-10-23T14:00:00.000Z",
    "updatedAt": "2026-10-23T14:00:00.000Z",
    "socialAccounts": [],
    "topics": []
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

### `POST /api/auth/login`

Authenticates an existing user and returns their profile plus a fresh JWT.

- **Auth**: None
- **Request Body**:

```json
{
  "email": "developer@example.com",
  "password": "strongPassword123"
}
```

- **Response (200 OK)**:

```json
{
  "success": true,
  "user": {
    "id": "c1f7b7f2-1234-4567-89ab-cdef01234567",
    "email": "developer@example.com",
    "name": "Alex Developer",
    "difficulty": "easy",
    "rating": 800,
    "onboarded": true,
    "preferredLanguage": "python",
    "socialAccounts": [],
    "topics": []
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

- **Error Responses**:
  - `400 Bad Request`: `{ "success": false, "message": "email and password are required." }`
  - `401 Unauthorized`: `{ "success": false, "message": "Invalid email or password." }`

---

### `POST /api/auth/logout`

Revokes the active bearer token by registering it in the server-side revocation blacklist.

- **Auth**: Required (`Authorization: Bearer <token>`)
- **Response (200 OK)**:

```json
{
  "success": true,
  "message": "Logged out successfully."
}
```

---

### `GET /api/auth/me` or `GET /api/auth/verify`

Verifies the active token and returns the authenticated user's current record.

- **Auth**: Required (`Authorization: Bearer <token>`)
- **Response (200 OK)**:

```json
{
  "success": true,
  "user": {
    "id": "c1f7b7f2-1234-4567-89ab-cdef01234567",
    "email": "developer@example.com",
    "name": "Alex Developer",
    "difficulty": "easy",
    "rating": 800,
    "onboarded": true,
    "preferredLanguage": "cpp",
    "socialAccounts": [],
    "topics": []
  }
}
```

---

### `POST /api/auth/change-password`

Updates the authenticated user's password after verifying the old password.

- **Auth**: Required (`Authorization: Bearer <token>`)
- **Request Body**:

```json
{
  "oldPassword": "currentPassword123",
  "newPassword": "brandNewSecurePassword456"
}
```

- **Validation Rules**:
  - `newPassword` must be at least 6 characters.
  - Returns `400 Bad Request` if `oldPassword` is incorrect or `newPassword` is too short.
- **Response (200 OK)**:

```json
{
  "success": true,
  "message": "Password updated successfully."
}
```

---

## 4. User Profile API (`/api/users`)

Mounted from `src/routers/user.router.js` -> `src/controllers/user.controller.js`.

### `GET /api/users/me`

Retrieves the authenticated user's full profile, selected calibration topics, and preferences.

- **Auth**: Required
- **Response (200 OK)**:

```json
{
  "success": true,
  "user": {
    "id": "user-uuid",
    "email": "alex@example.com",
    "name": "Alex Developer",
    "difficulty": "medium",
    "rating": 1200,
    "onboarded": true,
    "preferredLanguage": "cpp",
    "createdAt": "2026-10-23T14:00:00.000Z",
    "updatedAt": "2026-10-23T14:00:00.000Z",
    "socialAccounts": [],
    "topics": [
      {
        "id": "ut-1",
        "topicId": "t-1",
        "level": "medium",
        "topic": {
          "id": "t-1",
          "slug": "dsa-arrays",
          "name": "DSA - Arrays",
          "category": "DSA"
        }
      }
    ]
  }
}
```

---

### `PUT /api/users/me`

Updates the user's display name.

- **Auth**: Required
- **Request Body**:

```json
{
  "name": "Alex Updated"
}
```

- **Response (200 OK)**: Returns updated user profile.

---

### `PATCH /api/users/me/language`

Updates the preferred programming language.

- **Auth**: Required
- **Request Body**:

```json
{
  "language": "python"
}
```

- **Allowed Options**: `cpp`, `c`, `java`, `python`, `javascript`
- **Response (200 OK)**:

```json
{
  "success": true,
  "language": "python"
}
```

---

## 5. Topics API (`/api/topics`)

Mounted from `src/routers/topic.router.js` -> `src/controllers/topic.controller.js`.

### `GET /api/topics`

Returns all calibration topics, with category separation (`dsaTopics` and `coreTopics`) and optional query filtering (`?category=dsa` or `?category=core`).

- **Auth**: None
- **Response (200 OK)**:

```json
{
  "success": true,
  "count": 9,
  "topics": [
    { "id": "t-1", "slug": "dsa-arrays", "name": "DSA - Arrays", "category": "DSA" },
    { "id": "t-2", "slug": "dsa-linked-list", "name": "DSA - Linked List", "category": "DSA" },
    { "id": "t-3", "slug": "dbms", "name": "DBMS", "category": "CORE" }
  ],
  "dsaTopics": [
    { "id": "t-1", "slug": "dsa-arrays", "name": "DSA - Arrays", "category": "DSA" }
  ],
  "coreTopics": [
    { "id": "t-3", "slug": "dbms", "name": "DBMS", "category": "CORE" }
  ]
}
```

---

### `GET /api/topics/dsa`

Returns only DSA calibration topics.

- **Auth**: None
- **Response (200 OK)**: Returns `{ success: true, count: 5, topics: [...], dsaTopics: [...] }`.

---

### `GET /api/topics/dsa/categories` or `GET /api/topics/categories`

Returns all structured DSA problem categories with total problem counts.

- **Auth**: None
- **Response (200 OK)**:

```json
[
  {
    "id": "dsa-cat-1",
    "slug": "arrays-and-hashing",
    "name": "Arrays & Hashing",
    "order": 1,
    "totalProblems": 24
  }
]
```

---

### `GET /api/topics/dsa/:slug/problems`

Returns problems grouped under a specific structured DSA category.

- **Auth**: None
- **Query Parameters**: `?difficulty=Easy` (optional), `?search=two+sum` (optional)
- **Response (200 OK)**:

```json
{
  "topic": {
    "id": "dsa-cat-1",
    "slug": "arrays-and-hashing",
    "name": "Arrays & Hashing"
  },
  "count": 1,
  "problems": [
    {
      "id": "prob-1",
      "problemNumber": 1,
      "slug": "two-sum",
      "title": "Two Sum",
      "difficulty": "Easy",
      "tags": ["Array", "Hash Table"]
    }
  ]
}
```

---

### `GET /api/topics/:identifier`

Returns a single topic by ID or unique slug.

- **Auth**: None
- **Parameters**: `identifier` (topic ID or slug)
- **Response (200 OK)**: `{ "success": true, "topic": { ... } }`

---

## 6. Onboarding & Skill Calibration API (`/api/onboarding`)

Mounted from `src/routers/onboarding.router.js` -> `src/controllers/onboarding.controller.js`.

### `POST /api/onboarding` or `PUT /api/onboarding/levels`

Completes skill calibration for the authenticated user and calculates composite rating.

- **Auth**: Required
- **Request Payloads**:

#### Option A: Interactive Multi-Topic Calibration
```json
{
  "topicLevels": [
    { "topicId": "topic-uuid-1", "level": "easy" },
    { "topicId": "topic-uuid-2", "level": "hard" }
  ]
}
```

#### Option B: 1-Click Beginner Preset
```json
{
  "beginner": true
}
```
*(Automatically sets all topics to Easy and rating to 800)*

#### Rating Calculation Formula:
- `easy` / `beginner`: 800
- `medium` / `mid`: 1200
- `hard` / `advanced`: 1600
- Composite rating = rounded average of calibrated topics.
- Difficulty mapping: `>= 1400` -> `hard`, `>= 1000` -> `medium`, otherwise `easy`.

- **Response (200 OK)**:

```json
{
  "success": true,
  "user": {
    "id": "user-uuid",
    "email": "alex@example.com",
    "name": "Alex Developer",
    "difficulty": "medium",
    "rating": 1200,
    "onboarded": true,
    "topics": [...]
  }
}
```

---

### `GET /api/onboarding/status`

Retrieves onboarding status and current calibrations.

- **Auth**: Required
- **Response (200 OK)**: Returns `{ success: true, user: { ... } }`.

---

### `PATCH /api/onboarding/language`

Updates preferred programming language during onboarding.

- **Auth**: Required
- **Request Body**: `{ "language": "python" }`
- **Response (200 OK)**: `{ "success": true, "language": "python" }`

---

## 7. Problems Catalogue API (`/api/problems`)

Mounted from `src/routers/problem.router.js` -> `src/controllers/problem.controller.js`.

### `GET /api/problems`

Lists all coding problems with counts of testcases and templates.

- **Auth**: None
- **Query Parameters**:
  - `difficulty`: `Easy`, `Medium`, or `Hard`
  - `search`: Case-insensitive search on title, slug, or problem number
- **Response (200 OK)**:

```json
{
  "success": true,
  "count": 161,
  "data": [
    {
      "id": "prob-uuid-1",
      "problemNumber": 1,
      "slug": "two-sum",
      "title": "Two Sum",
      "difficulty": "Easy",
      "timeLimit": 1000,
      "memoryLimit": 256,
      "_count": {
        "testcases": 6,
        "templates": 4
      }
    }
  ]
}
```

---

### `GET /api/problems/:slug`

Fetches detailed problem statement, sample testcases, and language starter templates.

- **Auth**: None
- **Parameters**: `slug` (slug string or numeric problem number)
- **Response (200 OK)**:

```json
{
  "success": true,
  "data": {
    "id": "prob-uuid-1",
    "problemNumber": 1,
    "slug": "two-sum",
    "title": "Two Sum",
    "description": "Given an array of integers nums and an integer target...",
    "difficulty": "Easy",
    "timeLimit": 1000,
    "memoryLimit": 256,
    "testcases": [
      {
        "testIndex": 0,
        "isVisible": true,
        "input": "4\n2 7 11 15\n9",
        "output": "0 1"
      }
    ],
    "templates": {
      "cpp": "class Solution {\npublic:\n    vector<int> twoSum(...) {\n    }\n};",
      "python": "class Solution:\n    def twoSum(self, nums, target):\n        pass",
      "javascript": "class Solution {\n    twoSum(nums, target) {\n    }\n}",
      "java": "class Solution {\n    public int[] twoSum(...) {\n    }\n}"
    }
  }
}
```

---

### `POST /api/problems`

Creates a new problem with testcases and templates.

- **Auth**: None (or Admin)
- **Request Body**: Accepts `slug`, `title`, `description`, `difficulty`, `timeLimit`, `memoryLimit`, `testcases`, and `templates`.
- **Response (201 Created)**: Returns the newly created problem record.

---

## 8. Code Execution API (`/api/execution`)

Mounted from `src/routers/execution.router.js` -> `src/controllers/execution.controller.js`.

### `GET /api/execution/languages`

Returns supported programming languages and versions.

- **Auth**: None
- **Response (200 OK)**:

```json
{
  "success": true,
  "languages": [
    { "key": "python", "label": "Python", "version": "Python 3.10", "starterAvailable": true },
    { "key": "javascript", "label": "JavaScript", "version": "Node.js 22", "starterAvailable": true },
    { "key": "cpp", "label": "C++", "version": "GCC 13", "starterAvailable": true },
    { "key": "java", "label": "Java", "version": "OpenJDK 17", "starterAvailable": true }
  ]
}
```

---

### `POST /api/execution/runs`

Executes user code against visible/sample testcases (Synchronous Run).

- **Auth**: None (Optional Bearer token)
- **Request Body**:

```json
{
  "slug": "two-sum",
  "language": "python",
  "code": "class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]"
}
```

- **Response (200 OK)**:

```json
{
  "success": true,
  "status": "Accepted",
  "passedCount": 6,
  "totalCount": 6,
  "cases": [
    {
      "index": 0,
      "input": "4\n2 7 11 15\n9",
      "expected": "0 1",
      "actual": "0 1",
      "studentStdout": "Program executed successfully.",
      "status": "Accepted",
      "timeMs": 12,
      "memoryKb": 12500
    }
  ]
}
```

---

### `POST /api/execution/submissions`

Submits code for evaluation against all testcases and records submission.

- **Auth**: Optional (Associates with `req.user.id` if logged in)
- **Request Body**:

```json
{
  "slug": "two-sum",
  "language": "python",
  "code": "class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]"
}
```

- **Response (200 OK)**:

```json
{
  "success": true,
  "submissionId": "sub-uuid-1234",
  "status": "done",
  "verdict": "Accepted",
  "passedCount": 6,
  "totalCount": 6,
  "scoreUnitsAwarded": 100,
  "maxTimeMs": 24,
  "maxMemoryKb": 14200
}
```

---

### `GET /api/execution/submissions/:id`

Retrieves submission evaluation details by submission ID.

- **Auth**: None
- **Response (200 OK)**: `{ "success": true, "submission": { ... } }`

---

## 9. Social & OAuth API (`/api/social`)

Mounted from `src/routers/social.router.js` -> `src/controllers/social.controller.js`.

### `GET /api/social/:provider/link-url`

Generates an OAuth authorization link with signed state for account linking.

- **Auth**: Required (`Authorization: Bearer <token>`)
- **Parameters**: `provider` (e.g., `github`)
- **Response (200 OK)**:

```json
{
  "url": "https://github.com/login/oauth/authorize?client_id=...&redirect_uri=...&scope=read%3Auser+user%3Aemail&state=..."
}
```

---

### `GET /api/social/:provider/callback`

OAuth redirect callback handler that exchanges the authorization code for a profile and upserts the linked social account.

- **Auth**: None (via signed `state` query parameter)
- **Redirects**: To `${FRONTEND_URL}/?linked=github` on success, or `${FRONTEND_URL}/?link_error=...` on failure.

---

### `DELETE /api/social/:provider`

Unlinks the given social provider from the authenticated user.

- **Auth**: Required
- **Parameters**: `provider` (e.g., `github`)
- **Response (200 OK)**: `{ "success": true, "count": 1 }`

---

## 10. CS Curriculum & Study Material API (`/api/study`)

Mounted from `src/routers/study.routes.js` -> `src/controllers/study.controller.js`.

### `GET /api/study/subjects`

Returns all subjects (Computer Networks, DBMS, OOPs, Operating Systems, System Design) with chapter counts.

- **Auth**: None
- **Response (200 OK)**:

```json
[
  {
    "id": "subj-1",
    "slug": "oops",
    "name": "OOPs",
    "order": 1,
    "_count": { "chapters": 5 }
  }
]
```

---

### `GET /api/study/subjects/:subjectSlug` or `/api/study/subjects/:subjectSlug/chapters`

Returns subject details with its chapters and topic counts.

- **Auth**: None
- **Response (200 OK)**: Returns subject record with nested `chapters` array.

---

### `GET /api/study/chapters/:chapterId/topics`

Returns topics under a specific chapter.

- **Auth**: None
- **Response (200 OK)**: Returns topic headers (`id`, `slug`, `name`, `order`).

---

### `GET /api/study/topics/:topicSlug`

Returns comprehensive study markdown lesson and multiple-choice questions (MCQs).

- **Auth**: None
- **Response (200 OK)**: Returns lesson content and MCQs without revealing `correctIndex`.

---

### `POST /api/study/topics/:topicSlug/submit`

Evaluates submitted answers and returns score breakdown with explanations.

- **Auth**: None
- **Request Body**:

```json
{
  "answers": {
    "topic-mcq-1": 1,
    "topic-mcq-2": 0
  }
}
```

- **Response (200 OK)**:

```json
{
  "score": 2,
  "total": 2,
  "result": [
    {
      "mcqId": "topic-mcq-1",
      "isCorrect": true,
      "correctIndex": 1,
      "explanation": "Detailed explanation..."
    }
  ]
}
```

---

## 11. Utility Scripts & Database Management

Scripts located under `./scripts/` and `./prisma/`:

1. **`npm run seed` / `npm run db:seed` (`prisma/seed.js`)**: Seeds initial topic categories (5 DSA + 4 Core).
2. **`npm run problems:seed` (`scripts/seedProblems.js`)**: Seeds 161 problem definitions from `./problems/` into PostgreSQL.
3. **`node scripts/upload-study.js`**: Reads subject/chapter/topic JSON files from `./study-material/` into the database.
4. **`node scripts/upload-problem.js <path>`**: Ingests an individual problem JSON file into the database.
5. **`npx prisma db push`**: Synchronizes Prisma schema definitions directly to PostgreSQL.

---

## 12. Error Handling & Status Codes

All API errors return consistent JSON shapes:

```json
{
  "success": false,
  "message": "Detailed error explanation."
}
```

## 13. Themes & Personalization API (`/api/themes`)

Mounted from `src/routers/themeRoutes.js` -> `src/controllers/themeController.js`.

Allows users to view, purchase, and apply IDE themes. Premium themes require coins. All endpoints are protected.

---

### `GET /api/themes`

Returns all available themes with ownership, applied status, and affordability for the authenticated user. Powers the screenshot gallery page.

- **Auth**: Required (`Authorization: Bearer <token>`)
- **Response (200 OK)**:

```json
{
  "success": true,
  "coins": 80,
  "themes": [
    {
      "id": "e447113c-a354-4737-80d1-697cd80b7bb9",
      "slug": "default",
      "name": "Default",
      "price": 0,
      "previewColor": "#0A0F2C",
      "isDefault": true,
      "owned": true,
      "applied": false,
      "canAfford": true
    },
    {
      "id": "a683f5e1-4d2c-4078-8d31-4c27e4a84ddb",
      "slug": "arcade",
      "name": "Arcade",
      "price": 120,
      "previewColor": "#FF1493",
      "isDefault": false,
      "owned": true,
      "applied": true,
      "canAfford": false
    },
    {
      "id": "80cf347c-b6d5-4229-8bec-e90eab652a15",
      "slug": "racer",
      "name": "Racer",
      "price": 150,
      "previewColor": "#FF0000",
      "isDefault": false,
      "owned": false,
      "applied": false,
      "canAfford": false
    }
  ]
}
```

---

### `GET /api/themes/me`

Returns minimal state for the current user: active theme, owned theme slugs, and coin balance. Optimized for the `/me` sidebar/header.

- **Auth**: Required
- **Response (200 OK)**:

```json
{
  "coins": 200,
  "activeTheme": "pearl",
  "ownedThemes": [
    "default",
    "orbit",
    "frost",
    "editorial",
    "monochrome",
    "pearl"
  ]
}
```

---

### `PUT /api/themes/apply`

Applies an owned theme to the authenticated user, giving an instant visual shift.

- **Auth**: Required
- **Request Body**:

```json
{
  "slug": "frost"
}
```

- **Validation Rules**:
  - `slug`: Required, must exist in the `themes` table.
  - User must own the theme (free themes are auto-owned; premium themes must be purchased). Returns `403 Forbidden` if not owned.
- **Response (200 OK)**:

```json
{
  "success": true,
  "activeTheme": "frost",
  "message": "Frost applied"
}
```

- **Error Responses**:
  - `400 Bad Request`: `{ "error": "slug required" }`
  - `404 Not Found`: `{ "error": "Theme not found" }`
  - `403 Forbidden`: `{ "error": "You don't own this theme, buy first" }`

---

### `POST /api/themes/:slug/buy`

Purchases a premium theme using coins, deducts the balance, and auto-applies the theme.

- **Auth**: Required
- **Parameters**: `slug` (e.g., `arcade`, `racer`)
- **Request Body**: None
- **Logic**:
  1. Check that the theme exists, else `404`.
  2. Check whether it is already owned, else `400 Already owned`.
  3. Check `user.coins >= theme.price`, else `400 Not enough coins`.
  4. Run an atomic transaction: `coins -= price` + `user_themes.create()` + `activeTheme.connect()`.
- **Response (200 OK)**:

```json
{
  "success": true,
  "message": "Bought Arcade",
  "theme": {
    "slug": "arcade",
    "applied": true,
    "owned": true
  },
  "coins": 80
}
```

- **Error Responses**:
  - `404 Not Found`: `{ "error": "Theme not found" }`
  - `400 Bad Request`: `{ "error": "Already owned", "owned": true }`
  - `400 Bad Request`: `{ "error": "Not enough coins", "required": 120, "have": 80 }`

---

### Theme Catalogue (Seeded)

| Slug | Name | Price | Type |
|---|---|---|---|
| `default` | Default | 0 | Free |
| `orbit` | Orbit | 0 | Free |
| `frost` | Frost | 0 | Free |
| `editorial` | Editorial | 0 | Free |
| `monochrome` | Monochrome | 0 | Free |
| `pearl` | Pearl | 0 | Free |
| `arcade` | Arcade | 120 | Premium |
| `racer` | Racer | 150 | Premium |

---

### HTTP Status Code Reference

| Status Code | Meaning | Typical Scenario |
|---|---|---|
| `200 OK` | Succeeded | Successful GET, PUT, PATCH |
| `201 Created` | Resource created | Successful registration or problem addition |
| `400 Bad Request` | Validation failure | Missing required fields, invalid language, short password, already owned, not enough coins |
| `401 Unauthorized` | Auth required / invalid | Missing, revoked, or expired Bearer token; wrong credentials |
| `403 Forbidden` | Not allowed | Applying a theme the user doesn't own |
| `404 Not Found` | Not found | Invalid topic ID, problem slug, subject, or theme |
| `409 Conflict` | Conflict | Account with this email already exists |
| `500 Server Error` | Server error | Unhandled runtime exception |
| `503 Unavailable` | Service error | Database URL missing or unreachable |