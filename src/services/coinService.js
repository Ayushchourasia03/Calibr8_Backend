// src/services/coinService.js
// Sole authority for updating User.coins and recording CoinTransactions.

import prisma from "../config/db.js";
import { getISTDateString, calcLoginReward, toISTDateString } from "./streakService.js";
import { ensureDailyProblem } from "./dailyProblemService.js";

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Grants daily login reward and milestone streak bonuses.
 * Idempotent per user per IST day.
 * Never throws to caller.
 */
export async function grantDailyLoginReward(userId) {
  if (!userId) {
    return {
      coinsEarnedToday: 0,
      loginCoins: 0,
      bonusCoins: 0,
      bonusType: null,
      type: null,
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
          bonusCoins: 0,
          bonusType: null,
          type: null,
          streak: 0,
          longestStreak: 0,
          isNewDay: false,
          granted: false,
          coins: 0,
        };
      }

      // Check if user already claimed DAILY_LOGIN for today's IST date
      const existing = await tx.coinTransaction.findFirst({
        where: { userId, type: "DAILY_LOGIN", istDate: todayIST },
      });
      if (existing) {
        return {
          coinsEarnedToday: 0,
          loginCoins: 0,
          bonusCoins: 0,
          bonusType: null,
          type: null,
          streak: safeNumber(user.streak, 0),
          longestStreak: safeNumber(user.longestStreak, 0),
          isNewDay: false,
          balanceAfter: safeNumber(user.coins, 100),
          user,
        };
      }

      const calc = calcLoginReward({
        lastStreakDate: user.lastStreakDate ?? null,
        currentStreak: safeNumber(user.streak, 0),
        todayISTDate: todayIST,
      });

      if (!calc.isNewDay) {
        return {
          coinsEarnedToday: 0,
          loginCoins: 0,
          bonusCoins: 0,
          bonusType: null,
          type: null,
          streak: safeNumber(user.streak, 0),
          longestStreak: safeNumber(user.longestStreak, 0),
          isNewDay: false,
          balanceAfter: safeNumber(user.coins, 100),
          user,
        };
      }

      const newStreak = safeNumber(calc.newStreak, 1);
      const newLongest = Math.max(safeNumber(user.longestStreak, 0), newStreak);
      const coinsToAdd = safeNumber(calc.coinsEarnedToday, 1);
      const currentCoins = safeNumber(user.coins, 100);
      const newBalance = currentCoins + coinsToAdd;

      const updateData = {
        coins: newBalance,
        streak: newStreak,
        longestStreak: newLongest,
        lastStreakDate: new Date(),
      };

      let updatedUser = null;
      try {
        updatedUser = await tx.user.update({
          where: { id: userId },
          data: { ...updateData, lastLoginISTDate: todayIST },
        });
      } catch (e) {
        if (String(e.message || "").includes("lastLoginISTDate")) {
          updatedUser = await tx.user.update({ where: { id: userId }, data: updateData });
        } else {
          throw e;
        }
      }

      // 1. Daily login base transaction (+1)
      const loginTx = await tx.coinTransaction.create({
        data: {
          userId,
          amount: 1,
          type: "DAILY_LOGIN",
          referenceId: todayIST,
          istDate: todayIST,
          balanceAfter: currentCoins + 1,
        },
      });

      // 2. Streak bonus transaction (+5 or +25) if milestone reached
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
        balanceAfter: newBalance,
        user: updatedUser || { ...user, ...updateData, lastLoginISTDate: todayIST },
      };
    });
  } catch (err) {
    console.error(`[CoinService] Daily login reward error for user ${userId}:`, err.message || err);
    return {
      coinsEarnedToday: 0,
      loginCoins: 0,
      bonusCoins: 0,
      bonusType: null,
      type: null,
      streak: 0,
      longestStreak: 0,
      isNewDay: false,
      granted: false,
      coins: 0,
    };
  }
}

/**
 * Grants daily problem reward (+2 coins) for today's assigned DailyProblem.
 * Idempotent per user per IST day.
 * Never throws to caller.
 */
export async function grantDailyProblemReward(userId, problemId, submissionIdOrDate = null) {
  let todayIST = getISTDateString(new Date());
  let submissionId = null;

  if (submissionIdOrDate instanceof Date || (typeof submissionIdOrDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(submissionIdOrDate))) {
    todayIST = getISTDateString(submissionIdOrDate);
  } else if (typeof submissionIdOrDate === "string") {
    submissionId = submissionIdOrDate;
  }

  try {
    if (!userId || !problemId) {
      return { granted: false, awarded: false, coins: 0, coinsEarned: 0, reason: "MISSING_ARGS" };
    }

    return await prisma.$transaction(async (tx) => {
      const daily = await tx.dailyProblem.findUnique({ where: { istDate: todayIST } });
      if (!daily) {
        return { granted: false, awarded: false, coins: 0, coinsEarned: 0, reason: "NO_DAILY_PROBLEM_TODAY", istDate: todayIST };
      }
      if (daily.problemId !== problemId) {
        return { granted: false, awarded: false, coins: 0, coinsEarned: 0, reason: "NOT_DAILY_PROBLEM" };
      }

      // Check if user already claimed DAILY_PROBLEM for today's IST day
      const existing = await tx.coinTransaction.findFirst({
        where: { userId, type: "DAILY_PROBLEM", istDate: todayIST },
      });
      if (existing) {
        return { granted: false, awarded: false, coins: 0, coinsEarned: 0, reason: "ALREADY_CLAIMED" };
      }

      if (daily.id) {
        const existingCompletion = await tx.dailyProblemCompletion.findUnique({
          where: {
            userId_dailyProblemId: {
              userId,
              dailyProblemId: daily.id,
            },
          },
        });
        if (existingCompletion) {
          return { granted: false, awarded: false, coins: 0, coinsEarned: 0, reason: "ALREADY_CLAIMED" };
        }
      }

      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) {
        return { granted: false, awarded: false, coins: 0, coinsEarned: 0, reason: "USER_NOT_FOUND" };
      }

      const currentCoins = safeNumber(user.coins, 100);
      const newBalance = currentCoins + 2;

      await tx.user.update({
        where: { id: userId },
        data: { coins: newBalance },
      });

      await tx.coinTransaction.create({
        data: {
          userId,
          amount: 2,
          type: "DAILY_PROBLEM",
          referenceId: submissionId || problemId,
          istDate: todayIST,
          balanceAfter: newBalance,
        },
      });

      if (daily.id) {
        try {
          await tx.dailyProblemCompletion.create({
            data: {
              userId,
              dailyProblemId: daily.id,
              submissionId: submissionId || null,
            },
          });
        } catch (_) {}
      }

      return {
        granted: true,
        awarded: true,
        coins: 2,
        coinsEarned: 2,
        balance: newBalance,
        balanceAfter: newBalance,
      };
    });
  } catch (err) {
    console.error(`[CoinService] Daily problem reward error for user ${userId}:`, err.message || err);
    return { granted: false, awarded: false, coins: 0, coinsEarned: 0, reason: "ERROR", error: String(err.message || err) };
  }
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
    lastLoginISTDate: user.lastLoginISTDate || (user.lastStreakDate ? toISTDateString(user.lastStreakDate) : null),
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
export async function getDailyProblem(istDate = getISTDateString(), userId = null) {
  let daily = await prisma.dailyProblem.findUnique({
    where: { istDate },
    include: {
      problem: {
        select: {
          id: true,
          slug: true,
          title: true,
          difficulty: true,
          description: true,
          tags: true,
        },
      },
    },
  });

  if (!daily || !daily.problem) {
    try {
      daily = await ensureDailyProblem(istDate);
    } catch (_) {
      return null;
    }
  }

  if (!daily || !daily.problem) {
    return null;
  }

  let solvedToday = false;
  let rewardClaimed = false;

  if (userId) {
    const claim = await prisma.coinTransaction.findFirst({
      where: { userId, type: "DAILY_PROBLEM", istDate },
    });
    rewardClaimed = Boolean(claim);

    const completion = await prisma.dailyProblemCompletion.findUnique({
      where: {
        userId_dailyProblemId: {
          userId,
          dailyProblemId: daily.id,
        },
      },
    });

    const submission = await prisma.submission.findFirst({
      where: {
        userId,
        problemId: daily.problemId,
        status: "ACCEPTED",
      },
    });
    solvedToday = Boolean(submission || completion || claim);
    if (completion) rewardClaimed = true;
  }

  return {
    id: daily.id,
    istDate: daily.istDate,
    problemId: daily.problemId,
    problem: {
      id: daily.problem.id,
      slug: daily.problem.slug,
      title: daily.problem.title,
      difficulty: daily.problem.difficulty,
    },
    solvedToday,
    rewardClaimed,
  };
}

/**
 * Returns total coins earned by user today in IST.
 */
export async function getCoinsEarnedToday(userId, istDate = getISTDateString()) {
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

