# CALIBR8 — COIN REWARDS: CHECK, TEST, FIX & COMPLETE — AI CODING AGENT PRD v2

## 1. Role & Goal
Audit the Calibr8 coin-rewards implementation, check it, test it, implement whatever is missing, fix all scripts + Prisma, run everything, and update API doc + index.html + other docs. Preserve all existing auth, problems, submissions, themes, store, and progress logic.

---

## 2. Project Architecture & Context
- **Backend**: Node.js (ES Modules) + Express + Prisma Client + PostgreSQL (Neon) + JWT auth
- **Frontend**: Single-page interactive developer hub in `public/index.html`
- **DB client**: `src/config/db.js` (exports default `prisma`)
- **Controllers**: `src/controllers/auth.controller.js`, `execution.controller.js`, `problem.controller.js`, `coin.controller.js`
- **Services**: `src/services/coinService.js`, `streakService.js`
- **Scripts**: `scripts/seedProblems.js`, `seedDailyProblems.js`, `checkDailyProblems.js`, `verifyCoinSetup.js`
- **Tests**: `tests/dailyLoginReward.test.js`, `tests/coinReward.integration.test.js`

### Import Rule (CRITICAL)
- From `src/services/` or `src/controllers/`: import from `"../config/db.js"`
- From `scripts/` or `tests/`: import from `"../src/config/db.js"`

---

## 3. Locked Business Rules (FR-01 through FR-07)
- New user starts with **100 coins**, `streak: 0`, and `longestStreak: 0` by default.
- Day = **Asia/Kolkata IST date (YYYY-MM-DD)**, day starts 00:00 IST. Never use UTC or client device date.
- **Daily login (FR-05)**: +1 coin only on first `POST /api/auth/login` on a new IST day (`lastLoginISTDate`). Re-login same day = 0 coins. Login rewards do **not** increment or alter the Daily Problem streak.
- **Daily problem selection (FR-01, FR-02)**: Selected randomly from the existing `problems` table, avoiding yesterday's problem when at least 2 problems exist. No cycle field or duplicate problem bank.
- **Daily problem completion (FR-03, FR-04, FR-06)**:
  - User receives **+2 coins** and **+1 streak** only for an ACCEPTED submission for today's assigned Daily Problem.
  - Consecutive day solve: `streak = previous streak + 1`.
  - Missed day: `streak` resets to `1` on the next solve.
  - `longestStreak = max(longestStreak, streak)` is preserved.
  - Multiple solves on the same day grant no additional coins or streak (`DailyProblemCompletion` composite key `@@id([userId, dailyProblemId])`).
- Every coin change writes an audit row to `CoinTransaction` with `balanceAfter`.
- Coin failures must NEVER block login or submission. Catch, log, return rewards 0 / granted false, still return 200.

---

## 4. Data Model Specifications
In model `User`:
```prisma
  coins                  Int                      @default(100)
  streak                 Int                      @default(0)
  lastStreakDate         DateTime?
  longestStreak          Int                      @default(0)
  lastLoginISTDate       String?                  @map("lastLoginISTDate")
  coinTransactions       CoinTransaction[]
  dailyProblemCompletions DailyProblemCompletion[]
```

In model `Problem`:
```prisma
  dailyProblems    DailyProblem[]
```

Models:
```prisma
model CoinTransaction {
  id           String   @id @default(cuid())
  userId       String   @map("userId")
  amount       Int
  type         String
  referenceId  String?  @map("referenceId")
  istDate      String   @map("istDate")
  balanceAfter Int      @map("balanceAfter")
  createdAt    DateTime @default(now())
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt])
  @@index([userId, type, istDate])
  @@map("coin_transactions")
}

model DailyProblem {
  id          String                   @id @default(cuid())
  istDate     String                   @unique @map("istDate")
  problemId   String                   @map("problemId")
  problem     Problem                  @relation(fields: [problemId], references: [id], onDelete: Cascade)
  createdAt   DateTime                 @default(now())
  completions DailyProblemCompletion[]

  @@map("daily_problems")
}

model DailyProblemCompletion {
  userId         String       @map("userId")
  dailyProblemId String       @map("dailyProblemId")
  completedAt    DateTime     @default(now()) @map("completedAt")
  dailyProblem   DailyProblem @relation(fields: [dailyProblemId], references: [id], onDelete: Cascade)
  user           User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([userId, dailyProblemId])
  @@index([dailyProblemId])
  @@map("daily_problem_completions")
}
```

---

## 5. Verification Checklist & Results

| Checkpoint | Status | Notes |
| :--- | :--- | :--- |
| `prisma validate` | PASS | Valid schema loaded and formatted |
| `prisma format` | PASS | Clean schema formatting applied |
| `seedDailyProblems.js` | PASS | Seeds 35 days (i=0 to 34), logs `TODAY FOUND` |
| `checkDailyProblems.js` | PASS | Diagnostic prints total rows, first/last, `TODAY FOUND` |
| `verifyCoinSetup.js` | PASS | Checks today daily problem, counts txs, verifies service exports |
| `coinReward.integration.test.js` | PASS | **45 passed, 0 failed** against isolated test user |
| `dailyLoginReward.test.js` | PASS | **I1 - I10 passed** (idempotency, streaks, bonuses, audits) |
| `POST /api/auth/login` | PASS | Returns `rewards` object with `coinsEarnedToday`, `streak`, etc. |
| `POST /api/execution/submissions` | PASS | Returns `dailyProblemReward: { granted, coins }` on ACCEPTED |
| `GET /api/coins/balance` | PASS | Returns `{ coins, streak, longestStreak, lastLoginISTDate }` |
| `GET /api/coins/history` | PASS | Returns `{ transactions: [...] }` with limit/offset |
| `GET /api/daily-problem` | PASS | Returns today's problem metadata or 404 |
| `public/index.html` | PASS | Header pills (`coinsPill`, `streakPill`, `dailyPill`), `dailyCard`, `historyList`, how coins work, and toast |
| Docs (`API_DOC.md`, `README_COIN.md`) | PASS | Fully updated and documented |
