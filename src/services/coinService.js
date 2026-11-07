// src/services/coinService.js - FIXED
// Only file allowed to write User.coins.
// Fixes: 1) streak was object {newStreak,isNewDay} passed to Prisma -> now uses .newStreak number
//        2) longestStreak NaN -> now Number() guarded
//        3) destructure null -> now null checks
//        4) Invalid time value -> getISTDateString never throws, and we never call it with null daily

import prisma from "../config/db.js";
import { getISTDateString, calcLoginReward, toISTDateString } from "./streakService.js";

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function grantDailyLoginReward(userId) {
  const todayIST = getISTDateString(new Date());
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) {
        console.error(`[CoinService] User not found: ${userId}`);
        return { coinsEarnedToday: 0, loginCoins: 0, bonusCoins: 0, bonusType: null, type: null, streak: 0, longestStreak: 0, isNewDay: false, rewardPending: true };
      }

      const calc = calcLoginReward({
        lastStreakDate: user.lastStreakDate ?? null,
        currentStreak: safeNumber(user.streak, 0),
        todayISTDate: todayIST,
      });

      if (!calc.isNewDay) {
        return {
          coinsEarnedToday: 0, loginCoins: 0, bonusCoins: 0, bonusType: null, type: null,
          streak: safeNumber(user.streak, 0),
          longestStreak: safeNumber(user.longestStreak, 0),
          isNewDay: false,
        };
      }

      // Idempotency: concurrent logins same day
      const existing = await tx.coinTransaction.findFirst({
        where: { userId, type: "DAILY_LOGIN", istDate: todayIST },
      });
      if (existing) {
        return {
          coinsEarnedToday: 0, loginCoins: 0, bonusCoins: 0, bonusType: null, type: null,
          streak: safeNumber(user.streak, 0),
          longestStreak: safeNumber(user.longestStreak, 0),
          isNewDay: false,
        };
      }

      const newStreak = safeNumber(calc.newStreak, 1);
      const newLongest = Math.max(safeNumber(user.longestStreak, 0), newStreak);
      const coinsToAdd = safeNumber(calc.coinsEarnedToday, 1);
      const currentCoins = safeNumber(user.coins, 0);
      const newBalance = currentCoins + coinsToAdd;

      // Build update data - only include lastLoginISTDate if your schema has it.
      // If your User model does NOT have lastLoginISTDate, remove that line.
      const updateData = {
        coins: newBalance,
        streak: newStreak,
        longestStreak: newLongest,
        lastStreakDate: new Date(),
      };
      // Try to include lastLoginISTDate, but if Prisma rejects it, retry without it
      try {
        await tx.user.update({ where: { id: userId }, data: { ...updateData, lastLoginISTDate: todayIST } });
      } catch (e) {
        if (String(e.message || "").includes("lastLoginISTDate")) {
          await tx.user.update({ where: { id: userId }, data: updateData });
        } else throw e;
      }

      await tx.coinTransaction.create({
        data: {
          userId,
          amount: 1,
          type: "DAILY_LOGIN",
          referenceId: todayIST,
          istDate: todayIST,
          balanceAfter: currentCoins + 1,
        },
      });

      if (safeNumber(calc.bonusCoins, 0) > 0) {
        await tx.coinTransaction.create({
          data: {
            userId,
            amount: safeNumber(calc.bonusCoins, 0),
            type: calc.bonusType || calc.type || "STREAK_7_BONUS",
            referenceId: todayIST,
            istDate: todayIST,
            balanceAfter: newBalance,
          },
        });
      }

      return {
        coinsEarnedToday: coinsToAdd,
        loginCoins: 1,
        bonusCoins: safeNumber(calc.bonusCoins, 0),
        bonusType: calc.bonusType || calc.type || null,
        type: calc.type || calc.bonusType || null,
        streak: newStreak,
        longestStreak: newLongest,
        isNewDay: true,
      };
    });
  } catch (err) {
    console.error(`[CoinService] Daily login reward error for user ${userId}:`, err.message || err);
    return { coinsEarnedToday: 0, loginCoins: 0, bonusCoins: 0, bonusType: null, type: null, streak: 0, longestStreak: 0, isNewDay: false, rewardPending: true };
  }
}

export async function grantDailyProblemReward(userId, problemId, submissionId) {
  const todayIST = getISTDateString(new Date());
  try {
    if (!userId || !problemId) return { granted: false, reason: "MISSING_ARGS" };
    return await prisma.$transaction(async (tx) => {
      const daily = await tx.dailyProblem.findUnique({ where: { istDate: todayIST } });
      if (!daily) return { granted: false, reason: "NO_DAILY_PROBLEM_TODAY", istDate: todayIST };
      if (daily.problemId !== problemId) return { granted: false, reason: "NOT_TODAYS_PROBLEM" };

      const existing = await tx.coinTransaction.findFirst({
        where: { userId, type: "DAILY_PROBLEM", istDate: todayIST, referenceId: problemId },
      });
      if (existing) return { granted: false, reason: "ALREADY_CLAIMED" };

      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) return { granted: false, reason: "USER_NOT_FOUND" };
      const currentCoins = safeNumber(user.coins, 0);
      const newBalance = currentCoins + 2;

      await tx.user.update({ where: { id: userId }, data: { coins: newBalance } });
      await tx.coinTransaction.create({
        data: { userId, amount: 2, type: "DAILY_PROBLEM", referenceId: problemId, istDate: todayIST, balanceAfter: newBalance },
      });
      return { granted: true, coins: 2, balance: newBalance };
    });
  } catch (err) {
    console.error(`[CoinService] Daily problem reward error for user ${userId}:`, err.message || err);
    return { granted: false, reason: "ERROR", error: String(err.message || err) };
  }
}
