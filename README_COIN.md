# Calibr8 — Coin Rewards System Quick Start & Guide

Complete guide for Calibr8's persistent, audited coin rewards, streak tracking, and daily problem mechanics.

---

## 1. Locked Business Rules

1. **Default Balance**: New accounts begin with `100 coins`, `streak: 0`.
2. **IST Date Boundary**: All daily checks use Indian Standard Time (`Asia/Kolkata`, UTC+5:30). Day changes at `00:00 IST`. Never uses client system dates.
3. **Daily Login (+1)**: First `POST /api/auth/login` on a new IST day awards `+1 coin`. Repeated logins, token refresh, or `/auth/me` on the same day award 0 extra coins.
4. **Milestone Bonuses**:
   - **7-day streak milestone** (Day 7, 14, 21, 28, 35...): `+5 coins` (`STREAK_7_BONUS`), granting `+6 total` on Day 7.
   - **30-day streak milestone** (Day 30, 60, 90...): `+25 coins` (`STREAK_30_BONUS`), granting `+26 total` on Day 30. No +5 stacking on day 30.
5. **Missed Day Reset**: Skipping a day resets `streak` to 1 on next login. `coins` are kept, and `longestStreak` is preserved.
6. **Daily Problem (+2)**: First `ACCEPTED` submission for that day's designated `DailyProblem` awards `+2 coins`. Duplicate claims or wrong problems award 0 coins.
7. **Single Writing Authority**: Only `src/services/coinService.js` is permitted to update `User.coins`. All updates write an audit row to `CoinTransaction` with `balanceAfter`.
8. **Never-Block Rule**: Coin logic errors never fail or crash user login or code submissions.

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

- `POST /api/auth/login` → Returns `user`, `stats`, `token`, and `rewards: { coinsEarnedToday, loginCoins, bonusCoins, bonusType, streak, longestStreak, isNewDay }`.
- `GET /api/coins/balance` (Bearer) → `{ coins, streak, longestStreak, lastLoginISTDate }`.
- `GET /api/coins/history?limit=20&offset=0` (Bearer) → `{ transactions: [...] }`.
- `GET /api/daily-problem` → `{ istDate, problem: { id, slug, title, difficulty } }`.
- `POST /api/execution/submissions` → Response includes `dailyProblemReward: { granted, coins }`.

Full documentation: see `API_DOC.md`.
