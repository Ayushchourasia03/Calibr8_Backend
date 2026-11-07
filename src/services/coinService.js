import prisma from "../config/db.js";
import {
  getISTDateString,
  nextStreak,
  bonusForStreak,
} from "./streakService.js";
import { resolveProblem } from "../utils/problemResolver.js";

/**
 * Coin Service - Authoritative, transactional server-side management of user coins,
 * streak rewards, daily problem bonuses, theme purchases, and audit log tracking.
 *
 * All coin changes MUST flow through this service to ensure accurate audit trails.
 */

/**
 * Grants daily login coin reward and streak bonus if logging in on a new IST Date.
 * Idempotent: repeated calls on the same IST Date grant 0 additional coins.
 *
 * @param {string} userId
 * @param {Date} [now=new Date()]
 * @returns {Promise<{
 *   coinsEarnedToday: number,
 *   loginCoins: number,
 *   bonusCoins: number,
 *   bonusType: string|null,
 *   streak: number,
 *   longestStreak: number,
 *   isNewDay: boolean,
 *   user?: object
 * }>}
 */
export async function grantDailyLoginReward(userId, now = new Date()) {
  if (!userId) {
    return {
      coinsEarnedToday: 0,
      loginCoins: 0,
      bonusCoins: 0,
      bonusType: null,
      streak: 0,
      longestStreak: 0,
      isNewDay: false,
    };
  }

  const todayISTDate = getISTDateString(now);

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          coins: true,
          streak: true,
          longestStreak: true,
          lastStreakDate: true,
          lastLoginISTDate: true,
        },
      });

      if (!user) {
        throw new Error(`User ${userId} not found`);
      }

      const lastISTDate =
        user.lastLoginISTDate ||
        (user.lastStreakDate ? getISTDateString(user.lastStreakDate) : null);

      // Check if already rewarded or logged in today
      if (lastISTDate === todayISTDate) {
        // Also verify if a DAILY_LOGIN transaction already exists for today
        const existingTx = await tx.coinTransaction.findFirst({
          where: {
            userId,
            type: "DAILY_LOGIN",
            istDate: todayISTDate,
          },
        });

        if (existingTx) {
          return {
            coinsEarnedToday: 0,
            loginCoins: 0,
            bonusCoins: 0,
            bonusType: null,
            streak: user.streak,
            longestStreak: user.longestStreak,
            isNewDay: false,
            user,
          };
        }
      }

      // It's a new login day!
      const newStreak = nextStreak(lastISTDate, todayISTDate, user.streak);
      const newLongestStreak = Math.max(user.longestStreak || 0, newStreak);
      const { bonus: bonusCoins, type: bonusType } = bonusForStreak(newStreak);

      const loginCoins = 1;
      const totalReward = loginCoins + bonusCoins;
      const balanceAfterLogin = user.coins + loginCoins;
      const finalBalance = user.coins + totalReward;

      // Update user state atomically
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          streak: newStreak,
          longestStreak: newLongestStreak,
          lastStreakDate: now,
          lastLoginISTDate: todayISTDate,
          coins: { increment: totalReward },
        },
      });

      // 1. Audit transaction for daily login (+1)
      await tx.coinTransaction.create({
        data: {
          userId,
          amount: loginCoins,
          type: "DAILY_LOGIN",
          referenceId: "LOGIN",
          istDate: todayISTDate,
          balanceAfter: balanceAfterLogin,
          createdAt: now,
        },
      });

      // 2. Audit transaction for milestone bonus (+5 or +25) if earned
      if (bonusCoins > 0 && bonusType) {
        await tx.coinTransaction.create({
          data: {
            userId,
            amount: bonusCoins,
            type: bonusType,
            referenceId: `STREAK_${newStreak}`,
            istDate: todayISTDate,
            balanceAfter: finalBalance,
            createdAt: now,
          },
        });
      }

      return {
        coinsEarnedToday: totalReward,
        loginCoins,
        bonusCoins,
        bonusType,
        streak: newStreak,
        longestStreak: newLongestStreak,
        isNewDay: true,
        user: updatedUser,
      };
    });
  } catch (err) {
    console.error(`[CoinService] Daily login reward error for user ${userId}:`, err.message);
    // Never crash login - return fallback with 0 coins
    return {
      coinsEarnedToday: 0,
      loginCoins: 0,
      bonusCoins: 0,
      bonusType: null,
      streak: 0,
      longestStreak: 0,
      isNewDay: false,
      rewardPending: true,
    };
  }
}

/**
 * Grants daily problem reward (+2 coins) if user solves today's DailyProblem on this IST Date.
 * Idempotent: re-submitting an already rewarded problem returns awarded: false.
 *
 * @param {string} userId
 * @param {string} problemId
 * @param {Date} [now=new Date()]
 * @returns {Promise<{
 *   awarded: boolean,
 *   coinsEarned: number,
 *   reason?: string,
 *   balanceAfter?: number,
 *   dailyProblemId?: string
 * }>}
 */
export async function grantDailyProblemReward(userId, problemId, now = new Date()) {
  if (!userId || !problemId) {
    return { awarded: false, coinsEarned: 0, reason: "MISSING_PARAMS" };
  }

  const todayISTDate = getISTDateString(now);

  try {
    return await prisma.$transaction(async (tx) => {
      // 1. Check if today's DailyProblem exists
      const dailyProblem = await tx.dailyProblem.findUnique({
        where: { istDate: todayISTDate },
      });

      if (!dailyProblem) {
        return {
          awarded: false,
          coinsEarned: 0,
          reason: "NO_DAILY_PROBLEM_TODAY",
        };
      }

      // Normalize problem IDs to handle prefixing or slug differences
      const isMatch =
        dailyProblem.problemId === problemId ||
        dailyProblem.problemId === String(problemId).replace(/^prob-/, "");

      if (!isMatch) {
        return {
          awarded: false,
          coinsEarned: 0,
          reason: "NOT_DAILY_PROBLEM",
        };
      }

      // 2. Prevent double reward: check if already claimed for today's daily problem
      const existingTx = await tx.coinTransaction.findFirst({
        where: {
          userId,
          type: "DAILY_PROBLEM",
          istDate: todayISTDate,
          referenceId: dailyProblem.problemId,
        },
      });

      if (existingTx) {
        return {
          awarded: false,
          coinsEarned: 0,
          reason: "ALREADY_CLAIMED",
        };
      }

      // 3. User must exist
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, coins: true },
      });

      if (!user) {
        return { awarded: false, coinsEarned: 0, reason: "USER_NOT_FOUND" };
      }

      const rewardAmount = 2;
      const newBalance = user.coins + rewardAmount;

      await tx.user.update({
        where: { id: userId },
        data: { coins: { increment: rewardAmount } },
      });

      await tx.coinTransaction.create({
        data: {
          userId,
          amount: rewardAmount,
          type: "DAILY_PROBLEM",
          referenceId: dailyProblem.problemId,
          istDate: todayISTDate,
          balanceAfter: newBalance,
          createdAt: now,
        },
      });

      return {
        awarded: true,
        coinsEarned: rewardAmount,
        balanceAfter: newBalance,
        dailyProblemId: dailyProblem.id,
      };
    });
  } catch (err) {
    console.error(`[CoinService] Daily problem reward error for user ${userId}:`, err.message);
    return { awarded: false, coinsEarned: 0, reason: "TRANSACTION_FAILED" };
  }
}

/**
 * Writes an audit CoinTransaction row when a user purchases a store theme.
 *
 * @param {object} tx Prisma transaction client
 * @param {{ userId: string, themeId: string, price: number, balanceAfter: number, now?: Date }} params
 */
export async function recordThemePurchase(tx, { userId, themeId, price, balanceAfter, now = new Date() }) {
  const istDate = getISTDateString(now);
  return await tx.coinTransaction.create({
    data: {
      userId,
      amount: -Math.abs(price),
      type: "THEME_PURCHASE",
      referenceId: themeId,
      istDate,
      balanceAfter,
      createdAt: now,
    },
  });
}

/**
 * Retrieves paginated audit history of coin transactions for a user.
 *
 * @param {string} userId
 * @param {{ limit?: number, cursor?: string }} [options={}]
 * @returns {Promise<{ transactions: Array, nextCursor: string|null, hasMore: boolean }>}
 */
export async function getCoinHistory(userId, { limit = 20, cursor = null } = {}) {
  const take = Math.min(100, Math.max(1, Number(limit) || 20));

  const args = {
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: take + 1,
  };

  if (cursor) {
    args.cursor = { id: cursor };
    args.skip = 1;
  }

  const items = await prisma.coinTransaction.findMany(args);

  let nextCursor = null;
  if (items.length > take) {
    const nextItem = items.pop();
    nextCursor = nextItem.id;
  }

  return {
    transactions: items,
    nextCursor,
    hasMore: Boolean(nextCursor),
  };
}

/**
 * Retrieves today's DailyProblem along with solve and reward status for current user.
 *
 * @param {string} [istDate=getISTDateString()]
 * @param {string|null} [userId=null]
 */
export async function getDailyProblem(istDate = getISTDateString(), userId = null) {
  const targetDate = istDate || getISTDateString();

  const dp = await prisma.dailyProblem.findUnique({
    where: { istDate: targetDate },
  });

  if (!dp) {
    return {
      date: targetDate,
      dailyProblem: null,
      message: "No daily problem assigned for today.",
    };
  }

  const resolved = await resolveProblem(dp.problemId);

  let isSolvedToday = false;
  let dailyRewardClaimed = false;

  if (userId) {
    const claim = await prisma.coinTransaction.findFirst({
      where: {
        userId,
        type: "DAILY_PROBLEM",
        istDate: targetDate,
        referenceId: dp.problemId,
      },
    });
    dailyRewardClaimed = Boolean(claim);

    const submission = await prisma.submission.findFirst({
      where: {
        userId,
        problemId: dp.problemId,
        status: "ACCEPTED",
      },
    });
    isSolvedToday = Boolean(submission);
  }

  return {
    date: targetDate,
    dailyProblem: {
      id: dp.id,
      istDate: dp.istDate,
      problemId: dp.problemId,
      title: resolved?.title || dp.problemId,
      slug: resolved?.slug || dp.problemId,
      difficulty: resolved?.difficulty || "Easy",
      timeLimit: resolved?.timeLimit || 1000,
      memoryLimit: resolved?.memoryLimit || 256,
      tags: resolved?.tags || [],
      description: resolved?.description || "",
      solvedCount: resolved?.solvedCount || 0,
    },
    isSolvedToday,
    dailyRewardClaimed,
  };
}

/**
 * Computes total coins earned by user today.
 *
 * @param {string} userId
 * @param {string} [istDate=getISTDateString()]
 * @returns {Promise<number>}
 */
export async function getCoinsEarnedToday(userId, istDate = getISTDateString()) {
  if (!userId) return 0;
  const txs = await prisma.coinTransaction.findMany({
    where: {
      userId,
      istDate,
    },
  });

  return txs
    .filter((t) => t.amount > 0)
    .reduce((sum, t) => sum + t.amount, 0);
}
