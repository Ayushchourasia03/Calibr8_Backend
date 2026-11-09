// src/services/coinService.js
// Sole authority for updating User.coins and recording CoinTransactions.

import prisma from "../config/db.js";
import { getISTDateString, toISTDateString } from "./streakService.js";
import {
  ensureDailyProblem,
  completeDailyProblemSubmission,
  getDailyProblemWithUserStatus,
} from "./dailyProblemService.js";

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Grants daily login reward (+1 coin) for first login of an IST calendar day (FR-05).
 * Idempotent per user per IST day.
 * Does NOT alter streak (streak is strictly earned via Daily Problem).
 */
export async function grantDailyLoginReward(userId) {
  if (!userId) {
    return {
      coinsEarnedToday: 0,
      loginCoins: 0,
      streak: 0,
      longestStreak: 0,
      isNewDay: false,
      granted: false,
      coins: 0,
    };
  }

  const todayIST = getISTDateString(new Date());

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) {
        console.error(`[CoinService] User not found: ${userId}`);
        return {
          coinsEarnedToday: 0,
          loginCoins: 0,
          streak: 0,
          longestStreak: 0,
          isNewDay: false,
          granted: false,
          coins: 0,
        };
      }

      // Check if user already claimed DAILY_LOGIN for today's IST date
      const alreadyClaimedByDate = user.lastLoginISTDate === todayIST;
      const existingTx = await tx.coinTransaction.findFirst({
        where: { userId, type: "DAILY_LOGIN", istDate: todayIST },
      });

      if (alreadyClaimedByDate || existingTx) {
        return {
          coinsEarnedToday: 0,
          loginCoins: 0,
          streak: safeNumber(user.streak, 0),
          longestStreak: safeNumber(user.longestStreak, 0),
          isNewDay: false,
          granted: false,
          balanceAfter: safeNumber(user.coins, 100),
          user,
        };
      }

      const currentCoins = safeNumber(user.coins, 100);
      const newBalance = currentCoins + 1;

      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          coins: newBalance,
          lastLoginISTDate: todayIST,
        },
      });

      await tx.coinTransaction.create({
        data: {
          userId,
          amount: 1,
          type: "DAILY_LOGIN",
          referenceId: todayIST,
          istDate: todayIST,
          balanceAfter: newBalance,
        },
      });

      return {
        coinsEarnedToday: 1,
        loginCoins: 1,
        streak: safeNumber(user.streak, 0),
        longestStreak: safeNumber(user.longestStreak, 0),
        isNewDay: true,
        granted: true,
        balanceAfter: newBalance,
        user: updatedUser,
      };
    });
  } catch (err) {
    console.error(
      `[CoinService] Daily login reward error for user ${userId}:`,
      err.message || err,
    );
    return {
      coinsEarnedToday: 0,
      loginCoins: 0,
      streak: 0,
      longestStreak: 0,
      isNewDay: false,
      granted: false,
      coins: 0,
    };
  }
}

/**
 * Grants daily problem reward (+2 coins, +1 streak) by delegating to
 * the authoritative completeDailyProblemSubmission transaction (FR-03, FR-04, FR-06).
 */
export async function grantDailyProblemReward(
  userId,
  problemId,
  submissionIdOrDate = null,
) {
  let todayIST = getISTDateString(new Date());
  let submissionId = null;

  if (
    submissionIdOrDate instanceof Date ||
    (typeof submissionIdOrDate === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(submissionIdOrDate))
  ) {
    todayIST = getISTDateString(submissionIdOrDate);
  } else if (typeof submissionIdOrDate === "string") {
    submissionId = submissionIdOrDate;
  }

  return await completeDailyProblemSubmission({
    userId,
    problemId,
    submissionId,
    isAccepted: true,
    targetISTDate: todayIST,
  });
}

/**
 * Returns coin balance and streak details for user.
 */
export async function getBalance(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      coins: true,
      streak: true,
      longestStreak: true,
      lastLoginISTDate: true,
      lastStreakDate: true,
    },
  });

  if (!user) {
    return { coins: 100, streak: 0, longestStreak: 0, lastLoginISTDate: null };
  }

  return {
    coins: safeNumber(user.coins, 100),
    streak: safeNumber(user.streak, 0),
    longestStreak: safeNumber(user.longestStreak, 0),
    lastLoginISTDate:
      user.lastLoginISTDate ||
      (user.lastStreakDate ? toISTDateString(user.lastStreakDate) : null),
  };
}

/**
 * Returns audit log of coin transactions for user.
 */
export async function getCoinHistory(userId, { limit = 20, offset = 0 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const skip = Math.max(Number(offset) || 0, 0);

  const transactions = await prisma.coinTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take,
    skip,
    select: {
      id: true,
      amount: true,
      type: true,
      referenceId: true,
      istDate: true,
      balanceAfter: true,
      createdAt: true,
    },
  });

  return { transactions };
}

/**
 * Returns today's active DailyProblem, problem metadata, and user's claim status.
 */
export async function getDailyProblem(
  istDate = getISTDateString(),
  userId = null,
) {
  return await getDailyProblemWithUserStatus(istDate, userId);
}

/**
 * Returns total coins earned by user today in IST.
 */
export async function getCoinsEarnedToday(
  userId,
  istDate = getISTDateString(),
) {
  try {
    const txs = await prisma.coinTransaction.findMany({
      where: { userId, istDate },
    });
    return txs.reduce((sum, t) => sum + (t.amount || 0), 0);
  } catch {
    return 0;
  }
}

/**
 * Records an audit transaction for theme purchase.
 */
export async function debitThemePurchase(tx, { userId, themeId, price }) {
  const debit = await tx.user.updateMany({
    where: { id: userId, coins: { gte: price } },
    data: { coins: { decrement: price }, activeThemeId: themeId },
  });
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      rating: true,
      score: true,
      coins: true,
      streak: true,
      longestStreak: true,
    },
  });
  if (!user) return { success: false, user: null };
  if (debit.count === 0) return { success: false, user };

  await tx.coinTransaction.create({
    data: {
      userId,
      amount: -Math.abs(Number(price) || 0),
      type: "THEME_PURCHASE",
      referenceId: themeId,
      istDate: getISTDateString(new Date()),
      balanceAfter: user.coins,
    },
  });
  return { success: true, user };
}
