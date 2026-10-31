# Calibr8 — Complete Frontend Developer & AI Agent API Documentation

> **Target Audience**: Frontend Engineers & AI Coding Agents building web/mobile clients (React, Next.js, Vue, React Native, Flutter, Swift, Kotlin).  
> **Backend Base URL**: `http://localhost:3000` (Dev server binds to `0.0.0.0:3000`).  
> **Global API Prefix**: `/api`  
> **Default Content-Type**: `application/json`  
> **Default Auth Scheme**: `Authorization: Bearer <jwt-token>`  
> **All Time Formats**: ISO 8601 UTC strings (e.g., `2026-10-24T12:00:00.000Z`).

---

## Table of Contents

1. [Global API Protocols & Contracts](#1-global-api-protocols--contracts)
2. [TypeScript Type Definitions](#2-typescript-type-definitions)
3. [Frontend Client Implementation Guide (Fetch / Axios Interceptors)](#3-frontend-client-implementation-guide)
4. [System & Health APIs](#4-system--health-apis)
5. [Authentication APIs (`/api/auth`)](#5-authentication-apis-apiauth)
6. [User Profile & Academic APIs (`/api/users`)](#6-user-profile--academic-apis-apiusers)
7. [Topics & Categories APIs (`/api/topics`)](#7-topics--categories-apis-apitopics)
8. [Onboarding & Calibration APIs (`/api/onboarding`)](#8-onboarding--calibration-apis-apionboarding)
9. [Problems Catalogue APIs (`/api/problems`)](#9-problems-catalogue-apis-apiproblems)
10. [Code Execution Sandbox APIs (`/api/execution`)](#10-code-execution-sandbox-apis-apiexecution)
11. [Social & GitHub OAuth APIs (`/api/social`)](#11-social--github-oauth-apis-apisocial)
12. [CS Curriculum & Study Material APIs (`/api/study`)](#12-cs-curriculum--study-material-apis-apistudy)
13. [Themes & Personalization APIs (`/api/themes`)](#13-themes--personalization-apis-apithemes)
14. [Rankings & Leaderboard APIs (`/api/rankings`)](#14-rankings--leaderboard-apis-apirankings)
15. [Rate Limits & Security Policy](#15-rate-limits--security-policy)
16. [Zero-Config Resilience & In-Memory Database Architecture](#16-zero-config-resilience--in-memory-database-architecture)

---

## 1. Global API Protocols & Contracts

### 1.1 Success Response Shapes

Endpoints returning single entities or operations return `{ success: true, ... }` or directly the requested resource. Endpoints returning collections include an explicit `count` and `data` array or the array directly:

```json
{
  "success": true,
  "count": 25,
  "data": [ ... ]
}
```

### 1.2 Unified Error Response Contract

Every error emitted by the backend (4xx and 5xx) strictly adheres to this structure:

```json
{
  "success": false,
  "code": "ERROR_CODE_STRING",
  "message": "Human-friendly explanation of error.",
  "details": {}
}
```

#### Master Error Codes Reference

| HTTP Status               | Error Code              | Description / Trigger Condition                                                 |
| :------------------------ | :---------------------- | :------------------------------------------------------------------------------ |
| `400 Bad Request`         | `VALIDATION_ERROR`      | Missing required body fields or invalid data types                              |
| `400 Bad Request`         | `INVALID_EMAIL`         | Email fails standard regex format validation                                    |
| `400 Bad Request`         | `WEAK_PASSWORD`         | Password has fewer than 8 characters                                            |
| `400 Bad Request`         | `PASSWORD_TOO_LONG`     | Password exceeds bcrypt 72-byte limit                                           |
| `400 Bad Request`         | `PASSWORD_EQUALS_EMAIL` | Password matches the user's email address                                       |
| `400 Bad Request`         | `INSUFFICIENT_COINS`    | User coin balance is lower than theme price                                     |
| `400 Bad Request`         | `ALREADY_OWNED`         | User already owns the requested theme                                           |
| `400 Bad Request`         | `MISSING_CODE`          | Code string missing in execution payload                                        |
| `401 Unauthorized`        | `UNAUTHORIZED`          | Missing or invalid `Authorization: Bearer <token>`                              |
| `401 Unauthorized`        | `INVALID_CREDENTIALS`   | Incorrect email or password during login                                        |
| `401 Unauthorized`        | `TOKEN_REVOKED`         | Token was invalidated via `POST /api/auth/logout`                               |
| `401 Unauthorized`        | `TOKEN_EXPIRED`         | JWT has passed its `exp` claim                                                  |
| `403 Forbidden`           | `FORBIDDEN`             | Access denied (e.g., trying to apply an unowned theme)                          |
| `404 Not Found`           | `NOT_FOUND`             | Problem, study topic, chapter, subject, or theme not found                      |
| `404 Not Found`           | `SUBMISSION_NOT_FOUND`  | Submission ID does not exist or belongs to another user (anti-leak protection)  |
| `409 Conflict`            | `EMAIL_ALREADY_EXISTS`  | Registration email is already associated with an account                        |
| `413 Payload Too Large`   | `CODE_TOO_LARGE`        | Submitted code string exceeds 64 KB limit                                       |
| `422 Unprocessable`       | `UNSUPPORTED_LANGUAGE`  | Programming language not in `[cpp, c, java, python, javascript]`                |
| `429 Too Many Requests`   | `RATE_LIMITED`          | Run, submit, or in-flight execution limit exceeded                              |
| `429 Too Many Requests`   | `AUTH_RATE_LIMITED`     | Registration or login rate limit exceeded                                       |
| `503 Service Unavailable` | `EXECUTION_UNAVAILABLE` | Code execution service is missing, unreachable, or returned an invalid response |
| `503 Service Unavailable` | `DATABASE_UNAVAILABLE`  | Database service is unavailable                                                 |
| `500 Server Error`        | `INTERNAL_ERROR`        | Unhandled server error; response does not expose internal details               |

---

## 2. TypeScript Type Definitions

Copy these types directly into your frontend codebase (e.g. `src/types/api.ts`):

```typescript
// --- Core User & Auth ---
export type SupportedLanguage = "cpp" | "c" | "java" | "python" | "javascript";
export type UserDifficulty = "easy" | "medium" | "hard";
export type UserTier =
  | "Prism I"
  | "Prism II"
  | "Aurora I"
  | "Aurora II"
  | "Aurora III"
  | "Eclipse I"
  | "Eclipse II"
  | "Eclipse III"
  | "Zenith I"
  | "Zenith II";

export interface User {
  id: string;
  email: string;
  name: string;
  difficulty: UserDifficulty | null;
  rating: number;
  score: number;
  streak: number;
  strictPercent: number;
  tier: UserTier;
  college: string | null;
  branch: string | null;
  batch: string | null;
  state: string | null;
  country: string;
  coins: number;
  onboarded: boolean;
  preferredLanguage: SupportedLanguage;
  createdAt: string;
  updatedAt: string;
  socialAccounts?: SocialAccount[];
  topics?: UserTopicAssociation[];
}

export interface UserTopicAssociation {
  id: string;
  userId: string;
  topicId: string;
  level: "easy" | "medium" | "hard";
  topic?: Topic;
}

export interface AuthResponse {
  success: boolean;
  message: string;
  token: string;
  user: User;
}

// --- Topics ---
export interface Topic {
  id: string;
  slug: string;
  name: string;
  category: "DSA" | "CORE";
}

export interface DsaCategory {
  id: string;
  slug: string;
  name: string;
  order: number;
  totalProblems: number;
}

// --- Problems Catalogue ---
export interface ProblemListItem {
  id: string;
  problemNumber: number;
  slug: string;
  title: string;
  difficulty: "Easy" | "Medium" | "Hard";
  timeLimit: number;
  memoryLimit: number;
  _count: {
    testcases: number;
    templates: number;
  };
}

export interface TestCase {
  testIndex: number;
  isVisible: boolean;
  input: string;
  output: string;
  stdinSmall?: string;
  expectedSmall?: string;
}

export interface ProblemDetail {
  id: string;
  problemNumber: number;
  slug: string;
  title: string;
  description: string;
  difficulty: "Easy" | "Medium" | "Hard";
  timeLimit: number;
  memoryLimit: number;
  testcases: TestCase[]; // Strictly visible sample cases only
  templates: Record<SupportedLanguage, string>;
}

// --- Code Execution ---
export type ExecutionStatus =
  | "Accepted"
  | "Wrong Answer"
  | "Runtime Error"
  | "Time Limit Exceeded";

export interface RunCaseResult {
  index: number;
  input: string;
  expected: string;
  actual: string;
  studentStdout: string;
  status: ExecutionStatus;
  timeMs: number;
  memoryKb: number;
  errorText?: string;
}

export interface RunResponse {
  success: boolean;
  status: ExecutionStatus;
  passedCount: number;
  totalCount: number;
  cases: RunCaseResult[];
}

export interface SubmissionQueuedResponse {
  success: boolean;
  submissionId: string;
  status: "QUEUED";
  pollUrl: string;
  message: string;
}

export interface SubmissionDetail {
  id: string;
  problemId: string;
  language: SupportedLanguage;
  status:
    | "QUEUED"
    | "PROCESSING"
    | "ACCEPTED"
    | "WRONG_ANSWER"
    | "RUNTIME_ERROR"
    | "TIME_LIMIT_EXCEEDED";
  passedCount: number;
  totalCount: number;
  time: string | null;
  memory: number | null;
  createdAt: string;
  problem: {
    slug: string;
    title: string;
  };
}

// --- Study Curriculum ---
export interface StudySubject {
  id: string;
  slug: "cn" | "dbms" | "oops" | "os" | "system-design";
  name: string;
  description: string | null;
  icon: string | null;
  order: number;
  _count: {
    chapters: number;
  };
}

export interface StudyChapter {
  id: string;
  slug: string;
  name: string;
  subjectId: string;
  order: number;
  _count?: {
    topics: number;
  };
}

export interface StudyMCQ {
  id: string;
  question: string;
  options: string[];
  difficulty: string;
  order: number;
}

export interface StudyTopicDetail {
  id: string;
  slug: string;
  name: string;
  order: number;
  content: string; // Markdown document with mathematical notation and deep dives
  isPublished: boolean;
  chapter: {
    id: string;
    slug: string;
    name: string;
    subject: {
      slug: string;
      name: string;
    };
  };
  mcqs: StudyMCQ[]; // correctIndex and explanation are hidden prior to submission
}

export interface MCQEvaluationResult {
  mcqId: string;
  correct: boolean;
  userAnswer: number;
  correctIndex: number;
  explanation: string;
}

export interface StudyQuizSubmitResponse {
  success: boolean;
  totalQuestions: number;
  score: number;
  percentage: number;
  results: MCQEvaluationResult[];
}

// --- Themes ---
export interface Theme {
  id: string;
  slug: string;
  name: string;
  price: number;
  previewColor: string | null;
  isDefault: boolean;
  owned: boolean;
  applied: boolean;
  canAfford: boolean;
}

export interface ThemeStatusResponse {
  success: boolean;
  coins: number;
  activeTheme: string;
  ownedThemes: string[];
}

// --- Rankings ---
export interface RankedUser {
  id: string;
  name: string;
  score: number;
  rating: number;
  streak: number;
  strictPercent: number;
  tier: UserTier;
  college: string | null;
  branch: string | null;
  batch: string | null;
  state: string | null;
  country: string;
  createdAt: string;
}
```

---

## 3. Frontend Client Implementation Guide

### 3.1 Fetch API Interceptor with Automatic Bearer Header

```typescript
const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

export async function apiClient<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const token =
    typeof window !== "undefined"
      ? localStorage.getItem("calibr8_token")
      : null;

  const headers = new Headers(options.headers || {});
  if (!headers.has("Content-Type") && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      localStorage.removeItem("calibr8_token");
      // Optional: window.location.href = '/login';
    }
    throw data; // Rejects with standard { success: false, code, message }
  }

  return data as T;
}
```

---

## 4. System & Health APIs

### 4.1 Root API Spec & Architecture

- **Method & Path**: `GET /`
- **Protected**: No
- **Headers**: `Accept: application/json` (returns API manifest) or `Accept: text/html` (returns Developer Console).
- **Success Response (200 OK)**:

```json
{
  "service": "Calibr8 Backend API",
  "status": "online",
  "version": "1.2.0",
  "architecture": {
    "pattern": "Router-Controller-Model",
    "namingConvention": "*.router.js, *.controller.js"
  },
  "apiGroups": {
    "auth": "/api/auth",
    "users": "/api/users",
    "topics": "/api/topics",
    "onboarding": "/api/onboarding",
    "problems": "/api/problems",
    "execution": "/api/execution",
    "social": "/api/social",
    "study": "/api/study",
    "themes": "/api/themes",
    "rankings": "/api/rankings"
  }
}
```

### 4.2 Health Check

- **Method & Path**: `GET /health` or `GET /api/health`
- **Protected**: No
- **Success Response (200 OK)**:

```json
{
  "status": "ok",
  "service": "Calibr8 Backend",
  "timestamp": "2026-10-24T12:00:00.000Z"
}
```

### 4.3 Ping Check

- **Method & Path**: `GET /ping` or `GET /api/ping`
- **Protected**: No
- **Success Response (200 OK)**: Returns plain text `pong`.

---

## 5. Authentication APIs (`/api/auth`)

### 5.1 Register Account

- **Method & Path**: `POST /api/auth/register`
- **Protected**: No
- **Rate Limit**: 30 requests / 15 min / IP
- **Headers**: `Content-Type: application/json`
- **Request Body**:

```json
{
  "email": "student@example.com",
  "password": "StrongPassword123",
  "name": "Alex Mercer"
}
```

_Validation Rules_:

- `email`: Required, valid email string. Normalized to lowercase.
- `password`: Required, 8–72 characters, must not match email (case-insensitive).
- `name`: Required, non-empty string.
- **Success Response (201 Created)**:

```json
{
  "success": true,
  "message": "User registered successfully.",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "isNewUser": true,
  "user": {
    "id": "u-45a8-bc91-2309",
    "email": "student@example.com",
    "name": "Alex Mercer",
    "difficulty": null,
    "rating": 800,
    "score": 0,
    "coins": 100,
    "onboarded": false,
    "preferredLanguage": "cpp"
  }
}
```

- **Error Responses**:
  - `400 Bad Request`: `{"success": false, "code": "WEAK_PASSWORD", "message": "Password must be at least 8 characters long."}`
  - `400 Bad Request`: `{"success": false, "code": "PASSWORD_EQUALS_EMAIL", "message": "Password must differ from the email address."}`
  - `400 Bad Request`: `{"success": false, "code": "PASSWORD_TOO_LONG", "message": "Password cannot exceed 72 bytes."}`
  - `409 Conflict`: `{"success": false, "code": "EMAIL_ALREADY_EXISTS", "message": "An account with this email already exists."}`

---

### 5.2 User Login

- **Method & Path**: `POST /api/auth/login`
- **Protected**: No
- **Rate Limit**: 30 requests / 15 min / IP
- **Headers**: `Content-Type: application/json`
- **Request Body**:

```json
{
  "email": "student@example.com",
  "password": "StrongPassword123"
}
```

- **Success Response (200 OK)**:

```json
{
  "success": true,
  "message": "Login successful.",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "isNewUser": false,
  "user": {
    "id": "u-45a8-bc91-2309",
    "email": "student@example.com",
    "name": "Alex Mercer",
    "difficulty": "medium",
    "rating": 1200,
    "score": 450,
    "coins": 100,
    "onboarded": true,
    "preferredLanguage": "python"
  }
}
```

- **Error Responses**:
  - `400 Bad Request`: `{"success": false, "code": "VALIDATION_ERROR", "message": "email and password are required."}`
  - `401 Unauthorized`: `{"success": false, "code": "INVALID_CREDENTIALS", "message": "Invalid email or password."}`

---

### 5.3 Verify Auth Session (`/api/auth/me` or `/api/auth/verify`)

- **Method & Path**: `GET /api/auth/me` (alias: `GET /api/auth/verify`)
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Description**: Verifies the authenticated session and returns the user plus the compact header summary. The summary is part of this existing request, so the frontend does not need a separate stats call.
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "user": {
    "id": "u-45a8-bc91-2309",
    "email": "student@example.com",
    "name": "Alex Mercer",
    "difficulty": "medium",
    "rating": 1200,
    "coins": 100,
    "onboarded": true,
    "preferredLanguage": "python",
    "socialAccounts": [],
    "topics": []
  },
  "stats": {
    "rating": 1200,
    "tier": "Prism II",
    "score": 0,
    "scoreUnits": 0,
    "coins": 100,
    "streak": 0,
    "longestStreak": 0
  }
}
```

---

### 5.4 Refresh JWT Token

- **Method & Path**: `POST /api/auth/refresh`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "message": "Token refreshed successfully.",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

### 5.5 Change Password

- **Method & Path**: `POST /api/auth/change-password`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Request Body**:

```json
{
  "currentPassword": "OldPassword123",
  "newPassword": "NewStrongPassword456"
}
```

- **Success Response (200 OK)**:

```json
{
  "success": true,
  "message": "Password changed successfully."
}
```

- **Error Responses**:
  - `401 Unauthorized`: `{"success": false, "code": "INVALID_CURRENT_PASSWORD", "message": "Current password is incorrect."}`
  - `400 Bad Request`: `{"success": false, "code": "WEAK_PASSWORD", "message": "Password must be at least 8 characters long."}`

---

### 5.6 Logout & Token Revocation

- **Method & Path**: `POST /api/auth/logout`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Behavior**: Extracts the unique JWT `jti` and permanently blacklists it until token expiration. Subsequent requests using this token receive `401 TOKEN_REVOKED`.
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "message": "Logged out successfully. Token has been revoked."
}
```

---

## 6. User Profile & Academic APIs (`/api/users`)

### 6.1 Get Profile Details

- **Method & Path**: `GET /api/users/me` (alias: `GET /api/users/`)
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "user": {
    "id": "u-45a8-bc91-2309",
    "email": "student@example.com",
    "name": "Alex Mercer",
    "difficulty": "medium",
    "rating": 1200,
    "score": 3400,
    "streak": 14,
    "strictPercent": 92,
    "tier": "Prism II",
    "college": "AKGEC",
    "branch": "CSE",
    "batch": "2026",
    "state": "UP",
    "country": "India",
    "coins": 120,
    "onboarded": true,
    "preferredLanguage": "cpp",
    "createdAt": "2026-09-10T08:00:00.000Z",
    "updatedAt": "2026-10-24T06:00:00.000Z",
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

### 6.2 Update Name

- **Method & Path**: `PUT /api/users/me` (alias: `PUT /api/users/`)
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Request Body**:

```json
{
  "name": "Alexander Mercer"
}
```

- **Success Response (200 OK)**:

```json
{
  "success": true,
  "user": {
    "id": "u-45a8-bc91-2309",
    "email": "student@example.com",
    "name": "Alexander Mercer",
    "difficulty": "medium",
    "rating": 1200
  }
}
```

---

### 6.3 Update Preferred Programming Language

- **Method & Path**: `PATCH /api/users/me/language` (alias: `PATCH /api/users/language`)
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Request Body**:

```json
{
  "language": "python"
}
```

_Valid values_: `cpp`, `c`, `java`, `python`, `javascript`.

- **Success Response (200 OK)**:

```json
{
  "success": true,
  "language": "python"
}
```

---

### 6.4 Update Academic Profile

- **Method & Path**: `PATCH /api/users/me/academic` (alias: `PATCH /api/users/academic`)
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Request Body** (all fields optional, at least one required):

```json
{
  "college": "AKGEC",
  "branch": "Computer Science",
  "batch": "2026",
  "state": "UP",
  "country": "India"
}
```

- **Success Response (200 OK)**:

```json
{
  "success": true,
  "message": "Academic profile saved",
  "user": {
    "id": "u-45a8-bc91-2309",
    "name": "Alexander Mercer",
    "email": "student@example.com",
    "college": "AKGEC",
    "branch": "Computer Science",
    "batch": "2026",
    "state": "UP",
    "country": "India",
    "updatedAt": "2026-10-24T06:50:00.000Z"
  }
}
```

---

### 6.5 Get Problem Solve Status for User

- **Method & Path**: `GET /api/users/all`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "message": "Problems fetched successfully",
  "data": [
    {
      "name": "Two Sum",
      "slug": "two-sum-001",
      "number": 1,
      "topic": "Arrays & Hashing",
      "topicSlug": "arrays-and-hashing",
      "level": "easy",
      "levelDisplay": "easy",
      "solvedPercentage": 74,
      "isSolved": true
    }
  ]
}
```

---

### 6.6 Get Successful Submission Activity

- **Method & Path**: `GET /api/users/me/activity`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Description**: Returns daily counts of submissions that passed every test case in the past 371 days. Runs, partial submissions, failed submissions, and anonymous submissions are not included.
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "activity": {
    "2026-10-28": 2,
    "2026-10-29": 1
  },
  "total": 3,
  "activeDays": 2
}
```

### Profile Page Combined Endpoints

The profile page uses the following combined endpoints to reduce network requests.

#### Get Profile Overview

- **Method & Path**: `GET /api/users/me/overview`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Description**: Returns the authenticated user's profile and daily successful submission activity from the past 371 days.
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "user": {
    "id": "u-45a8-bc91-2309",
    "email": "student@example.com",
    "name": "Alex Mercer",
    "college": "AKGEC",
    "branch": "CSE",
    "batch": "2026",
    "state": "UP",
    "country": "India",
    "socialAccounts": [],
    "topics": []
  },
  "activity": {
    "2026-10-28": 2,
    "2026-10-29": 1
  },
  "total": 3,
  "activeDays": 2
}
```

#### Save Profile

- **Method & Path**: `PATCH /api/users/me`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Description**: Updates profile name and academic fields together. Send at least one field. Name, when provided, must not be empty.
- **Request Body**:

```json
{
  "name": "Alex Mercer",
  "college": "AKGEC",
  "branch": "CSE",
  "batch": "2026",
  "state": "UP",
  "country": "India"
}
```

- **Success Response (200 OK)**: `{ "success": true, "user": { ... } }`, with the updated user profile.

---

## 7. Topics & Categories APIs (`/api/topics`)

### 7.1 List All Calibration Topics

- **Method & Path**: `GET /api/topics`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Query Parameters**:
  - `category` (optional): Filter to `'dsa'` or `'core'`.
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "count": 9,
  "topics": [
    {
      "id": "t-1",
      "slug": "dsa-arrays",
      "name": "DSA - Arrays",
      "category": "DSA"
    },
    { "id": "t-6", "slug": "dbms", "name": "DBMS", "category": "CORE" }
  ],
  "dsaTopics": [
    {
      "id": "t-1",
      "slug": "dsa-arrays",
      "name": "DSA - Arrays",
      "category": "DSA"
    }
  ],
  "coreTopics": [
    { "id": "t-6", "slug": "dbms", "name": "DBMS", "category": "CORE" }
  ]
}
```

---

### 7.2 List DSA Calibration Topics Specifically

- **Method & Path**: `GET /api/topics/dsa`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "count": 5,
  "topics": [
    {
      "id": "t-1",
      "slug": "dsa-arrays",
      "name": "DSA - Arrays",
      "category": "DSA"
    },
    {
      "id": "t-2",
      "slug": "dsa-graphs-dp",
      "name": "DSA - Graphs & DP",
      "category": "DSA"
    },
    {
      "id": "t-3",
      "slug": "dsa-linked-list",
      "name": "DSA - Linked List",
      "category": "DSA"
    },
    {
      "id": "t-4",
      "slug": "dsa-stack-queue",
      "name": "DSA - Stack & Queue",
      "category": "DSA"
    },
    {
      "id": "t-5",
      "slug": "dsa-trees",
      "name": "DSA - Trees",
      "category": "DSA"
    }
  ]
}
```

---

### 7.3 List Structured DSA Categories

- **Method & Path**: `GET /api/topics/dsa/categories`
- **Public alias**: `GET /api/topics/categories` does not require authentication and is used by the Tracks page.
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (200 OK)**:

```json
[
  {
    "id": "cat-1",
    "slug": "arrays-and-hashing",
    "name": "Arrays & Hashing",
    "order": 1,
    "totalProblems": 24
  },
  {
    "id": "cat-2",
    "slug": "two-pointers",
    "name": "Two Pointers",
    "order": 2,
    "totalProblems": 14
  }
]
```

---

### 7.4 Get Problems in a DSA Category

- **Method & Path**: `GET /api/topics/dsa/:slug/problems`
- **Protected**: No
- **Path Parameter**: `:slug` (DSA category slug, e.g., `arrays-and-hashing`)
- **Query Parameters**:
  - `difficulty` (optional): `'Easy'`, `'Medium'`, or `'Hard'`.
  - `search` (optional): String keyword search on title or slug.
- **Success Response (200 OK)**:

```json
{
  "topic": {
    "id": "cat-1",
    "slug": "arrays-and-hashing",
    "name": "Arrays & Hashing"
  },
  "count": 12,
  "problems": [
    {
      "id": "p-1",
      "problemNumber": 1,
      "slug": "two-sum-001",
      "title": "Two Sum",
      "difficulty": "Easy",
      "tags": ["Array", "Hash Table"]
    }
  ]
}
```

---

### 7.5 Get Topic by Identifier (ID or Slug)

- **Method & Path**: `GET /api/topics/:identifier`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Path Parameter**: `:identifier` (Topic ID e.g. `t-1` or slug e.g. `dsa-arrays`)
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "topic": {
    "id": "t-1",
    "slug": "dsa-arrays",
    "name": "DSA - Arrays",
    "category": "DSA"
  }
}
```

---

## 8. Onboarding & Calibration APIs (`/api/onboarding`)

The Onboarding and Calibration subsystem is responsible for calibrating a student's baseline skill level across Data Structures and Algorithms (DSA) topics upon initial sign-up or profile re-evaluation. It dynamically calculates an initial Elo-style skill rating, sets topic-specific difficulty levels in the database, marks `user.onboarded = true`, and unlocks personalized problem recommendations.

```
+--------------------------------------------------------------------------------------------------+
|                                    ONBOARDING CALIBRATION FLOW                                   |
+--------------------------------------------------------------------------------------------------+
|                                                                                                  |
|   Student Signs Up / Logs In                                                                     |
|               |                                                                                  |
|               v                                                                                  |
|   GET /api/topics/dsa  -------------->  Receives active DSA topics (Arrays, Trees, Graphs, ...)   |
|               |                                                                                  |
|               v                                                                                  |
|   Selects Topic Difficulty Levels                                                                |
|     - Option A: Per-Topic Slider (Easy / Mid / Hard)                                             |
|     - Option B: Global Preset (e.g. All Medium)                                                  |
|     - Option C: 1-Click Beginner Preset (All Easy -> 800 Rating)                                 |
|               |                                                                                  |
|               v                                                                                  |
|   POST /api/onboarding (Bearer JWT)                                                              |
|               |                                                                                  |
|               +---> 1. Token Signature Verification (HMAC-SHA256)                                |
|               +---> 2. Session Auto-Healing (Restores user if DB restarted or unseeded)           |
|               +---> 3. Topic Identifier Resolution (Maps IDs or Slugs to validated topic records)|
|               +---> 4. Rating Calculation:                                                       |
|               |        Total = SUM(Topic Ratings), Avg = Round(Total / N)                        |
|               |        Easy = 800 | Medium = 1200 | Hard = 1600                                  |
|               +---> 5. Atomic DB Transaction:                                                    |
|               |        - UPDATE User: { difficulty, rating, onboarded: true }                    |
|               |        - DELETE existing UserTopic associations for userId                       |
|               |        - INSERT fresh UserTopic rows with assigned levels                        |
|               v                                                                                  |
|   200 OK Response: Updated User Profile with Calibrated Topics & Rating                          |
+--------------------------------------------------------------------------------------------------+
```

---

### 8.1 Submit Skill Calibration

- **Method & Route**: `POST /api/onboarding`
- **Route Alias**: `PUT /api/onboarding/levels`
- **Authentication**: Required (`Authorization: Bearer <jwt-token>`)
- **Content-Type**: `application/json`
- **Rate Limit**: 20 requests per minute per authenticated user

#### Request Body Schemas (3 Supported Modes)

The endpoint is polymorphic and intelligently processes three distinct payload paradigms:

#### Mode 1: Granular Per-Topic Selection (Recommended for Full UIs)

Allows setting individual skill levels per DSA topic:

```json
{
  "topicSelections": [
    { "topicId": "top-1", "difficulty": "easy" },
    { "topicId": "top-2", "difficulty": "medium" },
    { "topicId": "top-3", "difficulty": "medium" },
    { "topicId": "top-4", "difficulty": "hard" },
    { "topicId": "top-5", "difficulty": "easy" },
    { "topicId": "top-6", "difficulty": "hard" },
    { "topicId": "top-7", "difficulty": "medium" },
    { "topicId": "top-8", "difficulty": "easy" },
    { "topicId": "top-9", "difficulty": "medium" },
    { "topicId": "top-10", "difficulty": "easy" }
  ]
}
```

_Alternative Alias for Mode 1_: Also accepts `topicLevels: [{ topicId, level }]` or string array `topicSelections: ["top-1", "top-2"]` (defaults to easy).

#### Mode 2: Global Preset across All Topics

Applies a single target difficulty to all active DSA topics in the database:

```json
{
  "difficulty": "medium",
  "topicIds": "all"
}
```

#### Mode 3: 1-Click Beginner Preset (Fast Track)

Instantly calibrates all DSA topics to `easy` and assigns a beginner baseline rating of 800:

```json
{
  "beginner": true
}
```

---

#### Field Specifications & Constraints

| Field                          | Type                 | Required                | Allowed Values                                                           | Description                                                                      |
| :----------------------------- | :------------------- | :---------------------- | :----------------------------------------------------------------------- | :------------------------------------------------------------------------------- |
| `topicSelections`              | `Array<Object>`      | Optional (Mode 1)       | Array of `{ topicId: string, difficulty: string }`                       | Detailed calibration per topic. `topicId` can be the topic ID or topic slug.     |
| `topicSelections[].topicId`    | `string`             | Required if item is obj | Valid topic ID (`top-1`, `top-2`, etc.) or slug (`dsa-arrays`, `dsa-dp`) | Must reference an existing topic in the database.                                |
| `topicSelections[].difficulty` | `string`             | Optional                | `easy`, `beginner`, `medium`, `mid`, `intermediate`, `hard`, `advanced`  | Skill level for this topic. Normalized case-insensitively.                       |
| `topicIds`                     | `string \| string[]` | Optional (Mode 2)       | `"all"` or `["top-1", "top-2"]`                                          | Calibrates specified topics or all topics if `"all"`.                            |
| `difficulty`                   | `string`             | Optional (Mode 2)       | `easy`, `medium`, `hard`                                                 | Global difficulty to apply when `topicIds` is `"all"`.                           |
| `beginner`                     | `boolean`            | Optional (Mode 3)       | `true` or `false`                                                        | When `true`, automatically assigns `difficulty = "easy"` and `topicIds = "all"`. |
| `topicLevels`                  | `Array<Object>`      | Optional                | Array of `{ topicId, level }`                                            | Alias supported for backward compatibility with frontend clients.                |

---

#### Calibration Scoring & Rating Mathematics

1. **Difficulty Normalization**:
   - `easy`, `beginner` $\rightarrow$ normalized to `"easy"` (Score = 800)
   - `medium`, `mid`, `intermediate` $\rightarrow$ normalized to `"medium"` (Score = 1200)
   - `hard`, `advanced` $\rightarrow$ normalized to `"hard"` (Score = 1600)

2. **Composite Rating Formula**:
   $$\text{Rating} = \text{round}\left( \frac{\sum_{i=1}^{N} \text{Score}(\text{topic}_i)}{N} \right)$$
   Where $N$ is the number of calibrated topics (must be $\ge 1$).

3. **Overall Profile Difficulty Tier**:
   - $\text{Rating} \ge 1400 \implies \text{User Difficulty} = \text{"hard"}$
   - $1000 \le \text{Rating} < 1400 \implies \text{User Difficulty} = \text{"medium"}$
   - $\text{Rating} < 1000 \implies \text{User Difficulty} = \text{"easy"}$

---

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "user": {
    "id": "usr-1740001234",
    "email": "student@example.com",
    "name": "Demo Student",
    "difficulty": "medium",
    "rating": 1160,
    "onboarded": true,
    "preferredLanguage": "cpp",
    "createdAt": "2026-10-24T12:00:00.000Z",
    "updatedAt": "2026-10-24T12:05:00.000Z",
    "topics": [
      {
        "id": "ut-1740001235",
        "userId": "usr-1740001234",
        "topicId": "top-1",
        "level": "medium",
        "topic": {
          "id": "top-1",
          "slug": "dsa-arrays",
          "name": "DSA - Arrays",
          "category": "DSA"
        }
      },
      {
        "id": "ut-1740001236",
        "userId": "usr-1740001234",
        "topicId": "top-2",
        "level": "hard",
        "topic": {
          "id": "top-2",
          "slug": "dsa-strings",
          "name": "DSA - Strings",
          "category": "DSA"
        }
      }
    ]
  }
}
```

---

#### Error Responses & Resolution

| HTTP Status        | Error Code         | Cause                                                                         | Resolution                                                                             |
| :----------------- | :----------------- | :---------------------------------------------------------------------------- | :------------------------------------------------------------------------------------- |
| `400 Bad Request`  | `VALIDATION_ERROR` | Empty topic list or no topics selected (`"Please select at least 1 topic."`). | Send at least one topic in `topicSelections` or pass `beginner: true`.                 |
| `400 Bad Request`  | `VALIDATION_ERROR` | Topic ID or slug does not exist (`"One or more topic IDs are invalid."`).     | Query `GET /api/topics/dsa` first to obtain valid active IDs and slugs.                |
| `400 Bad Request`  | `VALIDATION_ERROR` | Invalid difficulty string provided.                                           | Use `easy`, `medium`, or `hard`.                                                       |
| `401 Unauthorized` | `UNAUTHORIZED`     | Missing `Authorization: Bearer <token>` header.                               | Authenticate via `POST /api/auth/login` or `POST /api/auth/register` and attach token. |
| `401 Unauthorized` | `TOKEN_EXPIRED`    | JWT token has passed its expiration time.                                     | Call `POST /api/auth/refresh` or re-authenticate.                                      |
| `401 Unauthorized` | `TOKEN_REVOKED`    | Token was explicitly revoked via `POST /api/auth/logout`.                     | Re-authenticate to receive a new active token.                                         |

---

#### Client Implementation Example (cURL & TypeScript)

**cURL Request**:

```bash
curl -X POST http://localhost:3000/api/onboarding \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "topicSelections": [
      { "topicId": "dsa-arrays", "difficulty": "easy" },
      { "topicId": "dsa-dp", "difficulty": "medium" },
      { "topicId": "dsa-trees", "difficulty": "hard" }
    ]
  }'
```

**TypeScript / React Integration Hook**:

```typescript
interface TopicSelection {
  topicId: string;
  difficulty: "easy" | "medium" | "hard";
}

export async function submitCalibration(
  selections: TopicSelection[],
  token: string,
) {
  const response = await fetch("/api/onboarding", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ topicSelections: selections }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.message || `Calibration failed with status ${response.status}`,
    );
  }

  const result = await response.json();
  return result.user;
}
```

---

### 8.2 Get Onboarding Status

Checks whether the current authenticated user has completed initial onboarding calibration and retrieves their assigned topic levels.

- **Method & Route**: `GET /api/onboarding/status`
- **Authentication**: Required (`Authorization: Bearer <jwt-token>`)
- **Success Response (`200 OK`)**:

```json
{
  "success": true,
  "user": {
    "id": "usr-1740001234",
    "email": "student@example.com",
    "name": "Demo Student",
    "difficulty": "medium",
    "rating": 1200,
    "onboarded": true,
    "preferredLanguage": "cpp",
    "topics": [
      {
        "id": "ut-1",
        "userId": "usr-1740001234",
        "topicId": "top-1",
        "level": "medium",
        "topic": {
          "id": "top-1",
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

### 8.3 Update Onboarding Language Preference

Allows setting or changing the student's preferred programming language during onboarding or afterwards.

- **Method & Route**: `PATCH /api/onboarding/language`
- **Authentication**: Required (`Authorization: Bearer <jwt-token>`)
- **Content-Type**: `application/json`
- **Request Body**:

```json
{
  "language": "cpp"
}
```

_Allowed Language Keys_:

- `cpp` (C++ / GCC 13)
- `c` (C / GCC 13)
- `java` (Java / OpenJDK 17)
- `python` (Python 3.10)
- `javascript` (JavaScript / Node.js 22)

- **Success Response (`200 OK`)**:

```json
{
  "success": true,
  "language": "cpp"
}
```

- **Error Response (`400 Bad Request`)**:

```json
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "message": "Invalid language. Allowed options: cpp, c, java, python, javascript"
}
```

---

## 9. Problems Catalogue APIs (`/api/problems`)

### 9.1 List All Problems

- **Method & Path**: `GET /api/problems`
- **Protected**: No
- **Query Parameters**:
  - `difficulty` (optional): `'Easy'`, `'Medium'`, or `'Hard'`.
  - `search` (optional): String matching problem number, title, or slug.
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "count": 161,
  "data": [
    {
      "id": "prob-1",
      "problemNumber": 1,
      "slug": "two-sum-001",
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

### 9.2 Get Problem Details & Starter Templates

- **Method & Path**: `GET /api/problems/:slug`
- **Protected**: No
- **Path Parameter**: `:slug` (e.g. `'two-sum-001'` or problem number integer `'1'`).
- **Security Constraint**: Returns **visible / sample test cases ONLY**. Hidden verification cases are never exposed.
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "data": {
    "id": "prob-1",
    "problemNumber": 1,
    "slug": "two-sum-001",
    "title": "Two Sum",
    "description": "Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.",
    "difficulty": "Easy",
    "timeLimit": 1000,
    "memoryLimit": 256,
    "testcases": [
      {
        "testIndex": 0,
        "isVisible": true,
        "input": "4\n2 7 11 15\n9",
        "output": "0 1",
        "stdinSmall": "4\n2 7 11 15\n9",
        "expectedSmall": "0 1"
      }
    ],
    "templates": {
      "cpp": "class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n    }\n};",
      "java": "class Solution {\n    public int[] twoSum(int[] nums, int target) {\n    }\n}",
      "python": "class Solution:\n    def twoSum(self, nums, target):\n        pass",
      "javascript": "class Solution {\n    twoSum(nums, target) {\n    }\n}"
    }
  }
}
```

---

## 10. Code Execution Sandbox APIs (`/api/execution`)

### 10.1 List Supported Languages

- **Method & Path**: `GET /api/execution/languages`
- **Protected**: No (`Authorization: Bearer <token>`)
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "languages": [
    {
      "key": "python",
      "label": "Python",
      "version": "Python 3.10",
      "starterAvailable": true
    },
    {
      "key": "javascript",
      "label": "JavaScript",
      "version": "Node.js 22",
      "starterAvailable": true
    },
    {
      "key": "cpp",
      "label": "C++",
      "version": "GCC 13",
      "starterAvailable": true
    },
    {
      "key": "c",
      "label": "C",
      "version": "GCC 13",
      "starterAvailable": true
    },
    {
      "key": "java",
      "label": "Java",
      "version": "OpenJDK 17",
      "starterAvailable": true
    }
  ]
}
```

---

### 10.2 Synchronous Run (Sample Testcases)

- **Method & Path**: `POST /api/execution/runs`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Rate Limit**: 10 requests / min / user
- **Headers**:
  - `Authorization: Bearer <token>`
  - `Content-Type: application/json`
- **Request Body**:

```json
{
  "slug": "two-sum-001",
  "language": "python",
  "code": "class Solution:\n    def twoSum(self, nums, target):\n        print('debugging:', target)\n        lookup = {}\n        for i, n in enumerate(nums):\n            diff = target - n\n            if diff in lookup:\n                return [lookup[diff], i]\n            lookup[n] = i\n"
}
```

_Note_: Also accepts `problemId` in place of `slug`. Maximum code size is 64 KB.

- **Success Response (200 OK)**:

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
      "input": "4\n2 7 11 15\n9",
      "expected": "0 1",
      "actual": "0 1",
      "studentStdout": "debugging: 9\n",
      "passed": true,
      "status": "Accepted",
      "timeMs": 42,
      "memoryKb": 12800
    }
  ]
}
```

---

### 10.3 Asynchronous Submit (Full Multi-Tier Judging)

- **Method & Path**: `POST /api/execution/submissions`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Rate Limit**: 6 requests / min / user
- **Headers**:
  - `Authorization: Bearer <token>`
  - `Content-Type: application/json`
  - `Idempotency-Key`: Optional UUID string to deduplicate requests.
- **Request Body**:

```json
{
  "slug": "two-sum-001",
  "language": "python",
  "code": "class Solution:\n    def twoSum(self, nums, target):\n        lookup = {}\n        for i, n in enumerate(nums):\n            diff = target - n\n            if diff in lookup:\n                return [lookup[diff], i]\n            lookup[n] = i\n"
}
```

- **Success Response (202 Accepted)**:

```json
{
  "success": true,
  "submissionId": "sub-91bc-2234-5678",
  "status": "QUEUED",
  "pollUrl": "/api/execution/submissions/sub-91bc-2234-5678",
  "message": "Submission received and queued for execution."
}
```

The submission is evaluated against all visible and hidden testcases. Poll the returned URL until the status is terminal. A completed response includes per-testcase `results`; visible testcase details include input and outputs, while hidden testcase details include only the testcase index, pass status, verdict, and resource usage.

For an authenticated user, a fully accepted submission also returns `reward` with the server-calculated points, score and coin awards, and updated header stats. Rewards are granted once per user/problem. Points are 10/25/50 for Easy/Medium/Hard; score units are points × 10; coins are points × 2 + 10. Streaks update at most once per UTC day for any fully accepted submission, including repeat solves that do not earn another reward. Client-submitted mode, hints, and points do not affect rewards. If the verdict is accepted but reward persistence fails, `rewardError` is `true`; refresh the user session before displaying updated stats.

---

### 10.4 Poll Submission Status

- **Method & Path**: `GET /api/execution/submissions/:id`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Path Parameter**: `:id` (submissionId string from 10.3)
- **Security Rule**: Owner-only. Non-owners receive `404 SUBMISSION_NOT_FOUND`.
- **Success Response (200 OK - Finished)**:

```json
{
  "success": true,
  "submission": {
    "id": "sub-91bc-2234-5678",
    "problemId": "prob-1",
    "language": "python",
    "status": "ACCEPTED",
    "verdict": "ACCEPTED",
    "tierReached": "Tier 3 (Optimal)",
    "reward": {
      "awarded": true,
      "points": 10,
      "scoreDelta": 100,
      "coinsEarned": 30,
      "stats": {
        "rating": 830,
        "tier": "Pulse II",
        "score": 10,
        "scoreUnits": 100,
        "coins": 130,
        "streak": 1,
        "longestStreak": 1
      }
    },
    "rewardError": false,
    "passedCount": 15,
    "totalCount": 15,
    "results": [
      {
        "testIndex": 0,
        "isVisible": true,
        "passed": true,
        "status": "Accepted",
        "input": "4\n2 7 11 15\n9",
        "expected": "0 1",
        "actual": "0 1"
      },
      {
        "testIndex": 1,
        "isVisible": false,
        "passed": true,
        "status": "Accepted",
        "time": 58,
        "memory": 14200
      }
    ],
    "time": "58ms",
    "memory": 14200,
    "createdAt": "2026-10-24T06:55:00.000Z",
    "problem": {
      "slug": "two-sum-001",
      "title": "Two Sum"
    }
  }
}
```

---

## 11. Social & GitHub OAuth APIs (`/api/social`)

### 11.1 Get GitHub Link URL

- **Method & Path**: `GET /api/social/:provider/link-url`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Path Parameter**: `:provider` (`'github'`)
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "url": "https://github.com/login/oauth/authorize?client_id=...&scope=read:user%20user:email&state=..."
}
```

---

### 11.2 OAuth Callback

- **Method & Path**: `GET /api/social/:provider/callback`
- **Protected**: No (Invoked by GitHub OAuth redirect)
- **Path Parameter**: `:provider` (`'github'`)
- **Query Parameters**:
  - `code`: Temporary OAuth code from GitHub
  - `state`: Cryptographically signed CSRF state token
- **Response**: Issues a `302 Found` redirect to `${FRONTEND_URL}/profile?linked=github` on success, or `${FRONTEND_URL}/profile?error=oauth_error` on failure.

---

### 11.3 Unlink Social Account

- **Method & Path**: `DELETE /api/social/:provider`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Path Parameter**: `:provider` (`'github'`)
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "message": "Successfully unlinked github account."
}
```

---

## 12. CS Curriculum & Study Material APIs (`/api/study`)

Study subjects, chapters, lesson content, and MCQs are loaded from `backend/study-material`. Populate or refresh the database using `npm run study:sync` from the backend directory.

### 12.1 List All Subjects

- **Method & Path**: `GET /api/study/subjects`
- **Protected**: No (Public)
- **Success Response (200 OK)**:

```json
[
  {
    "id": "subj-cn",
    "slug": "cn",
    "name": "Computer Networks",
    "description": "Comprehensive networking syllabus",
    "icon": null,
    "order": 1,
    "_count": { "chapters": 13 }
  },
  {
    "id": "subj-dbms",
    "slug": "dbms",
    "name": "Database Management Systems",
    "description": "Relational algebra, SQL, ACID, internals",
    "icon": null,
    "order": 2,
    "_count": { "chapters": 16 }
  },
  {
    "id": "subj-oops",
    "slug": "oops",
    "name": "Object-Oriented Programming",
    "description": "OOP principles, SOLID, GoF design patterns",
    "icon": null,
    "order": 3,
    "_count": { "chapters": 14 }
  },
  {
    "id": "subj-os",
    "slug": "os",
    "name": "Operating Systems",
    "description": "Processes, memory, scheduling, file systems",
    "icon": null,
    "order": 4,
    "_count": { "chapters": 16 }
  },
  {
    "id": "subj-system-design",
    "slug": "system-design",
    "name": "System Design",
    "description": "Scalability, caching, distributed transactions",
    "icon": null,
    "order": 5,
    "_count": { "chapters": 16 }
  }
]
```

---

### 12.2 Get Subject Details & Chapters

- **Method & Path**: `GET /api/study/subjects/:subjectSlug` (alias: `/api/study/subjects/:subjectSlug/chapters`)
- **Protected**: No (Public)
- **Path Parameter**: `:subjectSlug` (`'cn'`, `'dbms'`, `'oops'`, `'os'`, `'system-design'`)
- **Success Response (200 OK)**:

```json
{
  "id": "subj-dbms",
  "slug": "dbms",
  "name": "Database Management Systems",
  "order": 2,
  "chapters": [
    {
      "id": "chap-dbms-1",
      "slug": "dbms-fundamentals",
      "name": "DBMS Fundamentals & Architecture",
      "order": 1,
      "_count": { "topics": 2 }
    }
  ]
}
```

---

### 12.3 Get Topics in a Chapter

- **Method & Path**: `GET /api/study/chapters/:chapterId/topics`
- **Protected**: No (Public)
- **Path Parameter**: `:chapterId` (e.g. `'chap-dbms-1'`)
- **Success Response (200 OK)**:

```json
[
  {
    "id": "top-dbms-1",
    "slug": "dbms-foundations-and-architecture",
    "name": "DBMS Foundations, Architecture, and Schemas",
    "order": 1
  }
]
```

---

### 12.4 Get Study Topic Lesson & MCQs

- **Method & Path**: `GET /api/study/topics/:topicSlug`
- **Protected**: No (Public)
- **Path Parameter**: `:topicSlug` (e.g. `'dbms-foundations-and-architecture'`)
- **Answer Handling**: `correctIndex` is omitted from this response. The explanation is included with each MCQ.
- **Success Response (200 OK)**:

```json
{
  "id": "top-dbms-1",
  "slug": "dbms-foundations-and-architecture",
  "name": "DBMS Foundations, Architecture, and Schemas",
  "content": "# DBMS Foundations\n\n## 1. Introduction...",
  "order": 1,
  "isPublished": true,
  "chapter": {
    "slug": "dbms-fundamentals",
    "name": "DBMS Fundamentals",
    "subject": { "slug": "dbms", "name": "DBMS" }
  },
  "mcqs": [
    {
      "id": "mcq-1",
      "question": "Which layer of the 3-Schema Architecture hides physical storage details from users?",
      "options": [
        "Internal Level",
        "Conceptual Level",
        "External Level",
        "Physical Level"
      ],
      "difficulty": "Easy",
      "order": 1
    }
  ]
}
```

---

### 12.5 Submit MCQ Answers

- **Method & Path**: `POST /api/study/topics/:topicSlug/submit`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Path Parameter**: `:topicSlug`
- **Request Body**:

```json
{
  "answers": {
    "mcq-1": 1,
    "mcq-2": 0
  }
}
```

_Note_: Keys are MCQ IDs, values are the 0-indexed option selected.

- **Success Response (200 OK)**:

```json
{
  "success": true,
  "userId": "u-45a8-bc91-2309",
  "topicSlug": "dbms-foundations-and-architecture",
  "score": 2,
  "total": 2,
  "result": [
    {
      "mcqId": "mcq-1",
      "isCorrect": true,
      "correctIndex": 1,
      "explanation": "The conceptual schema describes the structure of the whole database for a community of users while hiding storage."
    }
  ]
}
```

---

## 13. Themes & Personalization APIs (`/api/themes`)

### 13.1 List All Themes

- **Method & Path**: `GET /api/themes`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "coins": 120,
  "themes": [
    {
      "id": "thm-default",
      "slug": "default",
      "name": "Default",
      "price": 0,
      "previewColor": "#3b82f6",
      "isDefault": true,
      "owned": true,
      "applied": true,
      "canAfford": true
    },
    {
      "id": "thm-orbit",
      "slug": "orbit",
      "name": "Orbit",
      "price": 450,
      "previewColor": "#35E6FF",
      "isDefault": false,
      "owned": false,
      "applied": false,
      "canAfford": true
    }
  ]
}
```

---

### 13.2 Get User Theme State

- **Method & Path**: `GET /api/themes/me`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "coins": 120,
  "activeTheme": "default",
  "ownedThemes": ["default"]
}
```

---

### 13.3 Apply an Owned Theme

- **Method & Path**: `PUT /api/themes/apply`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Request Body**:

```json
{
  "slug": "orbit"
}
```

- **Success Response (200 OK)**:

```json
{
  "success": true,
  "activeTheme": "orbit",
  "message": "Orbit applied"
}
```

- **Error Responses**:
  - `400 Bad Request`: `{"success": false, "code": "BAD_REQUEST", "message": "slug required"}`
  - `403 Forbidden`: `{"success": false, "code": "FORBIDDEN", "message": "You don't own this theme, buy first"}`
  - `404 Not Found`: `{"success": false, "code": "NOT_FOUND", "message": "Theme not found"}`

---

### 13.4 Purchase Theme with Coins

- **Method & Path**: `POST /api/themes/:slug/buy`
- **Protected**: Yes (`Authorization: Bearer <token>`)
- **Path Parameter**: `:slug` (one of `orbit`, `frost`, `editorial`, `mono`, `pearl`, `arcade`, `racer`, `anime`, `comic`, or `storybook`)
- **Atomic Operations**:
  - Validates user has `>= theme.price` coins.
  - Decrements coins, links theme to `user_themes`, auto-applies theme.
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "message": "Bought Orbit",
  "theme": {
    "slug": "orbit",
    "applied": true,
    "owned": true
  },
  "coins": 550,
  "stats": {
    "rating": 800,
    "tier": "Pulse II",
    "score": 0,
    "scoreUnits": 0,
    "coins": 550,
    "streak": 0,
    "longestStreak": 0
  }
}
```

Purchases are committed atomically to `users.coins`, `users.activeThemeId`, and `user_themes`. The theme catalog is installed by the `20261030140001_sync_store_themes` migration (or synchronized by `npm run db:seed`).

- **Error Responses**:
  - `400 Bad Request`: `{"success": false, "code": "ALREADY_OWNED", "message": "Already owned"}`
  - `400 Bad Request`: `{"success": false, "code": "INSUFFICIENT_COINS", "message": "Not enough coins", "details": {"required": 100, "have": 40}}`
  - `404 Not Found`: `{"success": false, "code": "NOT_FOUND", "message": "Theme not found"}`

---

## 14. Rankings & Leaderboard APIs (`/api/rankings`)

### 14.1 Get Public Rankings

- **Method & Path**: `GET /api/rankings`
- **Protected**: No (Public)
- **Query Parameters**:
  - `scope` (optional): Filter scope (`'college'`, `'batch'`, `'state'`, or `'country'`).
  - `college` (optional): Exact college name (e.g. `'AKGEC'`, `'IIT Delhi'`).
  - `batch` (optional): Graduation batch (e.g. `'2026'`).
  - `state` (optional): State / Province (e.g. `'UP'`, `'Delhi'`).
  - `country` (optional): Country (e.g. `'India'`).
  - `limit` (optional): Integer (1 to 100, default `50`).
- **Security Policy**: Sensitive data (password hashes, tokens, emails) is strictly omitted.
- **Success Response (200 OK)**:

```json
{
  "success": true,
  "count": 10,
  "data": [
    {
      "id": "u-rank-1",
      "name": "Riya Verma",
      "score": 48210,
      "rating": 1790,
      "streak": 132,
      "strictPercent": 88,
      "tier": "Zenith II",
      "college": "AKGEC",
      "branch": "CSE",
      "batch": "2026",
      "state": "UP",
      "country": "India",
      "createdAt": "2026-08-15T10:00:00.000Z"
    },
    {
      "id": "u-rank-2",
      "name": "Kabir Singh",
      "score": 46950,
      "rating": 1690,
      "streak": 97,
      "strictPercent": 74,
      "tier": "Eclipse III",
      "college": "AKGEC",
      "branch": "CSE",
      "batch": "2026",
      "state": "UP",
      "country": "India",
      "createdAt": "2026-08-20T10:00:00.000Z"
    }
  ]
}
```

---

## 15. Rate Limits & Security Policy

### 15.1 Rate Limiting Windows

The backend applies standard in-memory rate limiting to protect code evaluation resources and prevent brute-force attacks:

- **Authentication endpoints** (`/api/auth/register`, `/api/auth/login`): **10 requests per minute per IP**.
- **Code Run** (`/api/execution/runs`): **10 runs per minute per user**.
- **Code Submission** (`/api/execution/submissions`): **6 submissions per minute per user**.
- **Concurrent In-Flight Executions**: Maximum **2 active runs/submissions per user** simultaneously. If exceeded, returns `429 TOO_MANY_REQUESTS` with message `"Another execution is already running. Please wait."`.

### 15.2 Security Headers

Every response includes security headers configured for modern web apps:

- `Content-Security-Policy`: Restricts scripts, styles, fonts, and sets frame ancestors.
- `X-Content-Type-Options`: `nosniff`
- `X-Frame-Options`: `SAMEORIGIN`
- `Referrer-Policy`: `strict-origin-when-cross-origin`

---

## 16. Zero-Config Resilience & In-Memory Database Architecture

Calibr8 features a resilient dual-tier database layer engineered to run seamlessly across all environments—from instant zero-dependency local development and container preview sandboxes to production PostgreSQL/Neon deployments.

### 16.1 Architecture Overview

```
                      +-----------------------------+
                      | Incoming API / HTTP Request |
                      +-----------------------------+
                                     |
                                     v
                        +-------------------------+
                        |  Auth Middleware        |
                        |  (JWT Token Validation) |
                        +-------------------------+
                                     |
                                     v
                       +---------------------------+
                       |    Is DATABASE_URL set?   |
                       +---------------------------+
                               /           \
                       YES    /             \    NO
                             v               v
                +---------------------+   +---------------------------+
                | PrismaClient Engine |   | Transparent Model Proxy   |
                | (PostgreSQL / Neon) |   | (InMemoryStore Fallback)  |
                +---------------------+   +---------------------------+
                             |                           |
                  (On Connection Error)                  |
                             +---------------------------+
                                           |
                                           v
                       +---------------------------------------+
                       | InMemoryStore Features:               |
                       | - 14 Calibrated Topics (DSA & Core)   |
                       | - 6 Personalization Themes            |
                       | - Pre-seeded Demo Student Account:    |
                       |   student@example.com                 |
                       |   PW: StrongPassword123 (100 coins)   |
                       | - Full CS Curriculum (5 Subjects,     |
                       |   75+ Chapters, 150+ Topics & MCQs)   |
                       | - Multi-tier Code Evaluation Sandbox  |
                       +---------------------------------------+
```

### 16.2 Session Auto-Healing & Token Resilience

When running in ephemeral containers or development sandboxes where memory is refreshed on server restarts:

1. **Cryptographic Integrity**: When a client presents an `Authorization: Bearer <jwt-token>`, `protect` verifies the HMAC-SHA256 signature against `JWT_SECRET`.
2. **Auto-Restoration**: If the database was restarted or wiped and the user record is not found in memory or PostgreSQL, the middleware **automatically provisions and restores the user record** via `prisma.user.upsert`.
3. **No Dead Sessions**: Clients and test suites never get blocked with `USER_NOT_FOUND` or `"User belonging to this token no longer exists"`. Session continuity is preserved indefinitely.

### 16.3 Pre-Seeded Demo Credentials

For immediate exploration and manual endpoint testing, the backend is pre-seeded with:

- **Email**: `student@example.com`
- **Password**: `StrongPassword123`
- **Pre-Configured State**:
  - Rating: `800` (Prism I Tier)
  - Coins: `100` (Enough to buy themes)
  - Role: `user`
  - Active Theme: `default` (Calibr8 Dark)
- **1-Click Authentication**: Available directly on the Interactive Dashboard (`/`) via the `⚡ 1-Click Demo Login` button.
