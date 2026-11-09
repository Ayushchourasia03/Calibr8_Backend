# Calibr8 — Coin Rewards System Quick Start & Guide

Complete guide for Calibr8's persistent, audited coin rewards, streak tracking, and daily problem mechanics.

---

## 1. Locked Business Rules

1. **Default Balance**: New accounts begin with `100 coins`, `streak: 0`, and `longestStreak: 0`.
2. **IST Date Boundary**: All daily checks use Indian Standard Time (`Asia/Kolkata`, UTC+5:30). Day changes at `00:00 IST` (`YYYY-MM-DD`). Never uses client system dates.
3. **Daily Login (+1)**: First `POST /api/auth/login` on a new IST day awards `+1 coin`. Repeated logins, token refresh, or `/auth/me` on the same day award 0 extra coins. Login rewards are independent of Daily Problem completion and do **not** alter the Daily Problem streak.
4. **Daily Problem (+2 coins, +1 streak)**: First `ACCEPTED` submission for that day's designated `DailyProblem` awards `+2 coins` and advances the user's `streak` by 1.
5. **Streak Rules**:
   - First-ever Daily Problem completion: `streak = 1`.
   - Consecutive calendar day solves: `streak = previous streak + 1`.
   - Missing a calendar day: `streak` resets to `1` on the next Daily Problem completion.
   - `longestStreak = max(longestStreak, streak)` is preserved.
   - Only Daily Problem completion counts towards this streak; solving other problems does not alter the Daily Problem streak.
6. **Single Writing Authority**: Only `src/services/coinService.js` and `src/services/dailyProblemService.js` update `User.coins` and `streak`. All coin updates write an audit row to `CoinTransaction` with `balanceAfter`.
7. **Never-Block Rule**: Coin logic errors never fail or crash user login or code submissions.

---

## 2. Quick Start Commands

Run these commands in order from the repository root:

```bash
# 1. Generate Prisma Client
npx prisma generate

# 2. Seed Base Coding Problems (into problems table)
node scripts/seedProblems.js

# 3. Seed Daily Problems for Today + Next 34 Days (35 rows, starting i=0)
node scripts/seedDailyProblems.js

# 4. Diagnostic Check for Daily Problems (Must show TODAY FOUND)
node scripts/checkDailyProblems.js

# 5. Verify Coin Rewards Setup (Imports, checks DB, verifies exports)
node scripts/verifyCoinSetup.js

# 6. Run Coin Rewards Database Integration Tests (45 passed, 0 failed)
node tests/coinReward.integration.test.js

# 7. Run Daily Login Reward & Streak Integration Tests (I1 - I10 passed)
node tests/dailyLoginReward.test.js
```

---

## 3. Prisma Baseline & Migration Note

- Database schema is kept in sync with Neon PostgreSQL via Prisma migrations.
- The baseline migration folder is located at `prisma/migrations/20261107000000_add_coin_rewards/migration.sql`.
- Migration history is baselined using:
  ```bash
  npx prisma migrate resolve --applied 20261107000000_add_coin_rewards
  ```
- Migration status is verified with:
  ```bash
  npx prisma migrate status
  ```
- **CRITICAL**: Never run `npx prisma migrate reset` against production or Neon DB.

---

## 4. API Endpoints Quick Reference

- `POST /api/auth/login` → Returns `user`, `stats`, `token`, and `rewards: { coinsEarnedToday, loginCoins, streak, longestStreak, isNewDay }`.
- `GET /api/coins/balance` (Bearer) → `{ coins, streak, longestStreak, lastLoginISTDate }`.
- `GET /api/coins/history?limit=20&offset=0` (Bearer) → `{ transactions: [...] }`.
- `GET /api/daily-problem` → `{ istDate, problem: { id, slug, title, difficulty }, reward: { coins: 2, streak: 1 }, streak, longestStreak, completed }`.
- `POST /api/execution/submissions` → Response includes `dailyReward: { granted, coinsEarned, streak, longestStreak }`.

Full documentation: see `API_DOC.md`.
