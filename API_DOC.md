# CALIBR8 — API DOCUMENTATION

Comprehensive API contract for Calibr8 Backend, with full specifications for Coin Rewards, Daily Problems, Streak Milestones, and Code Execution.

---

## 1. Core Business Rules

- **Default Balance**: Every new user account is provisioned with `100 coins`, `streak: 0`, and `longestStreak: 0`.
- **IST Day Boundary**: All daily milestones, daily login rewards, and daily problem resets operate on **Asia/Kolkata (IST = UTC+5:30)** date string `YYYY-MM-DD`. Days start strictly at `00:00 IST`. UTC or local client system dates are never used for day boundaries.
- **Never-Block Rule**: Coin transactions and reward computations must **never** fail or crash user login, registration, or code submissions. Errors are caught, logged server-side, and return safe default payloads (`granted: false`, `coins: 0`), preserving HTTP 200 responses.
- **Single Authority**: Only `src/services/coinService.js` is permitted to write or increment `User.coins`. All coin modifications write an immutable audit row to `CoinTransaction` with the updated `balanceAfter`.

---

## 2. Coin Transaction Types

| Type | Amount | Trigger Condition |
| :--- | :--- | :--- |
| `DAILY_LOGIN` | `+1` | Granted on the first successful `POST /api/auth/login` of a new IST day. Subsequent logins or `/auth/refresh` on the same day grant 0. |
| `STREAK_7_BONUS` | `+5` | Granted on reaching 7-day streak milestones (Day 7, 14, 21, 28, 35...) that are not divisible by 30. |
| `STREAK_30_BONUS` | `+25` | Granted on reaching 30-day streak milestones (Day 30, 60, 90...). Stacks with login (+1 + 25 = +26 total; no +5 bonus on day 30). |
| `DAILY_PROBLEM` | `+2` | Granted upon first `ACCEPTED` submission for that day's assigned `DailyProblem`. Once per user per IST day. |
| `THEME_PURCHASE` | `-price` | Deducted when buying a theme from the Calibr8 Theme Store. |

---

## 3. Authentication & Rewards Endpoints

### 3.1 `POST /api/auth/login`
Authenticates user and grants daily login reward if first login of the IST day.

- **Request**:
```json
{
  "email": "student@calibr8.test",
  "password": "StrongPassword123"
}
```

- **Response (200 OK)**:
```json
{
  "success": true,
  "user": {
    "id": "usr-123",
    "email": "student@calibr8.test",
    "name": "Student",
    "coins": 101,
    "streak": 1,
    "longestStreak": 1,
    "lastLoginISTDate": "2026-11-07"
  },
  "stats": {
    "coins": 101,
    "streak": 1,
    "longestStreak": 1,
    "rating": 800,
    "tier": "Prism I"
  },
  "token": "eyJhbGciOiJIUzI1Ni...",
  "rewards": {
    "coinsEarnedToday": 1,
    "loginCoins": 1,
    "bonusCoins": 0,
    "bonusType": null,
    "streak": 1,
    "longestStreak": 1,
    "isNewDay": true
  }
}
```

- **Error Codes**:
  - `401 Unauthorized` (`INVALID_CREDENTIALS`): Email or password incorrect. No coins granted.

---

### 3.2 `GET /api/auth/me`
Retrieves authenticated user profile and header statistics.

- **Headers**: `Authorization: Bearer <token>`
- **Response (200 OK)**:
```json
{
  "success": true,
  "user": {
    "id": "usr-123",
    "email": "student@calibr8.test",
    "name": "Student",
    "coins": 101,
    "streak": 1,
    "longestStreak": 1,
    "todayISTDate": "2026-11-07",
    "coinsEarnedToday": 1
  },
  "stats": {
    "coins": 101,
    "streak": 1,
    "longestStreak": 1,
    "rating": 800
  }
}
```

---

## 4. Coin & Daily Problem Endpoints

### 4.1 `GET /api/coins/balance`
Retrieves current coin balance and streak metrics.

- **Headers**: `Authorization: Bearer <token>` (Required)
- **Response (200 OK)**:
```json
{
  "success": true,
  "coins": 101,
  "streak": 1,
  "longestStreak": 1,
  "lastLoginISTDate": "2026-11-07"
}
```
- **Error Codes**: `401 Unauthorized` if Bearer token is missing or invalid.

---

### 4.2 `GET /api/coins/history`
Returns paginated audit trail of user's coin transactions, newest first.

- **Headers**: `Authorization: Bearer <token>` (Required)
- **Query Parameters**:
  - `limit`: Integer (Default: 20, Min: 1, Max: 50)
  - `offset`: Integer (Default: 0)
- **Response (200 OK)**:
```json
{
  "success": true,
  "transactions": [
    {
      "id": "ctx_1794063068065_abc123",
      "amount": 1,
      "type": "DAILY_LOGIN",
      "referenceId": "2026-11-07",
      "istDate": "2026-11-07",
      "balanceAfter": 101,
      "createdAt": "2026-11-07T06:51:06.000Z"
    }
  ]
}
```
- **Error Codes**: `401 Unauthorized` if Bearer token is missing.

---

### 4.3 `GET /api/daily-problem`
Retrieves today's assigned Daily Problem metadata and user's completion status.

- **Headers**: `Authorization: Bearer <token>` (Optional)
- **Response (200 OK)**:
```json
{
  "success": true,
  "istDate": "2026-11-07",
  "problem": {
    "id": "prob_two-sum",
    "slug": "two-sum",
    "title": "Two Sum",
    "difficulty": "Easy"
  },
  "solvedToday": false,
  "rewardClaimed": false
}
```
- **Response (404 Not Found)**:
```json
{
  "message": "Daily problem not found — run seedDailyProblems.js"
}
```

---

## 5. Submission & Daily Problem Reward

### 5.1 `POST /api/execution/submissions` / `POST /api/execute/submit`
Submits code for evaluation. When an authenticated user's submission receives an `ACCEPTED` verdict:
1. `grantDailyProblemReward(userId, problemId, submissionId)` is called.
2. If `problemId` matches today's `DailyProblem` and has not yet been claimed today:
   - User `coins` is incremented by `+2`.
   - A `CoinTransaction` row is created (`type: DAILY_PROBLEM`, `amount: 2`, `referenceId: submissionId`, `istDate: todayIST`, `balanceAfter`).
   - Response contains `dailyProblemReward: { granted: true, coins: 2 }`.
3. If not today's problem, already claimed, or submission not accepted:
   - Response contains `dailyProblemReward: { granted: false, coins: 0 }`.

- **Response (200 OK)**:
```json
{
  "success": true,
  "verdict": "ACCEPTED",
  "passed": 15,
  "total": 15,
  "dailyProblemReward": {
    "granted": true,
    "coins": 2
  }
}
```
