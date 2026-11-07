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

## 3. Locked Business Rules
- New user starts with **100 coins** by default.
- Day = **Asia/Kolkata IST date (YYYY-MM-DD)**, day starts 00:00 IST. Never use UTC or client device date.
- **Daily login**: +1 only on first `POST /api/auth/login` on a new IST day. Refresh, /me, or re-login same day = 0.
- **Daily problem**: +2 only for solving that day's assigned DailyProblem with an ACCEPTED submission, once per user per day.
- **Bonus stacking**: Day 7 = +1 +5 = +6 total. Day 30 = +1 +25 = +26 total, NO extra +5 on day 30. Bonus repeats every 7 / 30 days.
  - Milestone 30 (30, 60, 90...): +25, type `STREAK_30_BONUS`
  - Milestone 7 (7, 14, 21, 28, 35... not divisible by 30): +5, type `STREAK_7_BONUS`
- **Missed day**: streak resets to 1 on next login, coins kept, longestStreak preserved.
- Only `coinService.js` may write `User.coins`.
- Every coin change must write an audit row to `CoinTransaction` with `balanceAfter`.
- Coin failures must NEVER block login or submission. Catch, log, return rewards 0 / granted false, still return 200.

---

## 4. Data Model Specifications
In model `User`:
```prisma
  coins            Int               @default(100)
  streak           Int               @default(0)
  lastStreakDate   DateTime?
  longestStreak    Int               @default(0)
  lastLoginISTDate String?           @map("lastLoginISTDate")
  coinTransactions CoinTransaction[]
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
  id        String   @id @default(cuid())
  istDate   String   @unique @map("istDate")
  problemId String   @map("problemId")
  problem   Problem  @relation(fields: [problemId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())

  @@index([istDate])
  @@map("daily_problems")
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
