import cron from "node-cron";
import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import {
  getISTDateString,
  getYesterdayIST,
  computeDailyProblemStreak,
} from "./streakService.js";

// In-flight generation promise map to prevent race conditions during concurrent requests
const pendingGenerations = new Map();
let schedulerTask = null;

/**
 * Returns today's date in Asia/Kolkata (IST) timezone formatted as "YYYY-MM-DD".
 */
export function getAuthoritativeISTDate(date = new Date()) {
  return getISTDateString(date);
}

/**
 * Calculates remaining milliseconds until 00:00:00.000 Asia/Kolkata of next calendar day.
 */
export function getMillisecondsUntilNextMidnightIST(date = new Date()) {
  const now = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istTime = now.getTime() + istOffsetMs;
  const dayProgressMs = istTime % (24 * 60 * 60 * 1000);
  return 24 * 60 * 60 * 1000 - dayProgressMs;
}

/**
 * Selects a random eligible problem from the existing problems table (FR-01).
 * Avoids selecting yesterday's problem again when at least 2 problems exist.
 */
export async function selectDailyProblemForDate(targetISTDate = getAuthoritativeISTDate()) {
  let eligibleProblems = [];
  try {
    eligibleProblems = await prisma.problem.findMany({
      select: {
        id: true,
        slug: true,
        title: true,
        difficulty: true,
        description: true,
        tags: true,
        dsaTopicId: true,
      },
    });
  } catch (err) {
    console.warn("[DailyProblemService] Problem query warning:", err.message);
  }

  if (!eligibleProblems || eligibleProblems.length === 0) {
    throw new ApiError(503, "No eligible problems found to select as daily problem.", "NO_ELIGIBLE_PROBLEMS");
  }

  // If only 1 problem exists, it is the only possible pick
  if (eligibleProblems.length === 1) {
    return { problem: eligibleProblems[0] };
  }

  // Look up yesterday's daily problem to avoid immediate back-to-back repeats (FR-01 rule 6)
  const yesterdayIST = getYesterdayIST(targetISTDate);
  const yesterdayDaily = await prisma.dailyProblem.findUnique({
    where: { istDate: yesterdayIST },
  });

  const lastProblemId = yesterdayDaily?.problemId || null;

  // Filter out yesterday's problem if >= 2 problems exist
  const candidates = eligibleProblems.filter((p) => p.id !== lastProblemId);
  const candidatePool = candidates.length > 0 ? candidates : eligibleProblems;

  const randomIndex = Math.floor(Math.random() * candidatePool.length);
  return { problem: candidatePool[randomIndex] };
}

/**
 * Ensures a DailyProblem record exists for targetISTDate.
 * Concurrency-safe via in-flight promise deduping and DB unique-key conflict handling.
 */
export async function ensureDailyProblem(targetISTDate = getAuthoritativeISTDate()) {
  // 1. Fast read check
  const existing = await prisma.dailyProblem.findUnique({
    where: { istDate: targetISTDate },
    include: {
      problem: {
        select: {
          id: true,
          slug: true,
          title: true,
          difficulty: true,
          description: true,
          tags: true,
          solvedCount: true,
          timeLimit: true,
          memoryLimit: true,
        },
      },
    },
  });

  if (existing && existing.problem) {
    return existing;
  }

  // 2. Concurrency protection via in-flight Promise map
  if (pendingGenerations.has(targetISTDate)) {
    return await pendingGenerations.get(targetISTDate);
  }

  const generationPromise = (async () => {
    try {
      const { problem } = await selectDailyProblemForDate(targetISTDate);

      try {
        const created = await prisma.dailyProblem.create({
          data: {
            istDate: targetISTDate,
            problemId: problem.id,
          },
          include: {
            problem: {
              select: {
                id: true,
                slug: true,
                title: true,
                difficulty: true,
                description: true,
                tags: true,
                solvedCount: true,
                timeLimit: true,
                memoryLimit: true,
              },
            },
          },
        });
        if (created && !created.problem) {
          created.problem = problem;
        }
        return created;
      } catch (createErr) {
        // Race condition: another concurrent request created it first (P2002)
        const recheck = await prisma.dailyProblem.findUnique({
          where: { istDate: targetISTDate },
          include: {
            problem: {
              select: {
                id: true,
                slug: true,
                title: true,
                difficulty: true,
                description: true,
                tags: true,
                solvedCount: true,
                timeLimit: true,
                memoryLimit: true,
              },
            },
          },
        });
        if (recheck && recheck.problem) return recheck;
        throw createErr;
      }
    } finally {
      pendingGenerations.delete(targetISTDate);
    }
  })();

  pendingGenerations.set(targetISTDate, generationPromise);
  return await generationPromise;
}

/**
 * Returns today's active DailyProblem metadata with authenticated user's completion status & streaks.
 */
export async function getDailyProblemWithUserStatus(
  targetISTDate = getAuthoritativeISTDate(),
  userId = null,
) {
  const daily = await ensureDailyProblem(targetISTDate);
  if (!daily || !daily.problem) {
    throw new ApiError(404, "Daily problem not found.", "DAILY_PROBLEM_NOT_FOUND");
  }

  let completed = false;
  let rewardClaimed = false;
  let completedAt = null;
  let currentStreak = 0;
  let longestStreak = 0;

  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { streak: true, longestStreak: true },
    });
    if (user) {
      currentStreak = user.streak || 0;
      longestStreak = user.longestStreak || 0;
    }

    // Single source of truth: check DailyProblemCompletion table
    const completion = await prisma.dailyProblemCompletion.findUnique({
      where: {
        userId_dailyProblemId: {
          userId,
          dailyProblemId: daily.id,
        },
      },
    });

    if (completion) {
      completed = true;
      rewardClaimed = true;
      completedAt = completion.completedAt;
    } else {
      // Check coin transaction audit
      const claim = await prisma.coinTransaction.findFirst({
        where: {
          userId,
          type: "DAILY_PROBLEM",
          istDate: targetISTDate,
        },
      });
      if (claim) {
        rewardClaimed = true;
        completed = true;
        completedAt = claim.createdAt;
      }
    }
  }

  const msUntilMidnight = getMillisecondsUntilNextMidnightIST();

  return {
    success: true,
    istDate: daily.istDate,
    problem: {
      id: daily.problem.id,
      slug: daily.problem.slug,
      title: daily.problem.title,
      difficulty: daily.problem.difficulty,
      description: daily.problem.description,
      tags: daily.problem.tags || [],
      solvedCount: daily.problem.solvedCount || 0,
    },
    reward: {
      coins: 2,
      description: "+2 coins and +1 streak for your first ACCEPTED submission on today's challenge",
    },
    completed,
    solvedToday: completed,
    rewardClaimed,
    completedAt,
    streak: currentStreak,
    longestStreak,
    nextRefreshMs: msUntilMidnight,
    nextRefreshTime: "12:00 AM IST",
  };
}

/**
 * Returns historical daily problems with pagination and optional user completion status.
 */
export async function getDailyProblemHistory({
  page = 1,
  limit = 30,
  userId = null,
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
  const skip = (safePage - 1) * safeLimit;

  const total = await prisma.dailyProblem.count();
  const records = await prisma.dailyProblem.findMany({
    orderBy: { istDate: "desc" },
    skip,
    take: safeLimit,
    include: {
      problem: {
        select: {
          id: true,
          slug: true,
          title: true,
          difficulty: true,
          tags: true,
          solvedCount: true,
        },
      },
    },
  });

  let userCompletionsSet = new Set();
  if (userId && records.length > 0) {
    const dailyIds = records.map((r) => r.id);
    const completions = await prisma.dailyProblemCompletion.findMany({
      where: {
        userId,
        dailyProblemId: { in: dailyIds },
      },
      select: { dailyProblemId: true },
    });
    userCompletionsSet = new Set(completions.map((c) => c.dailyProblemId));
  }

  const data = records.map((r) => ({
    id: r.id,
    istDate: r.istDate,
    createdAt: r.createdAt,
    completed: userCompletionsSet.has(r.id),
    problem: r.problem ? {
      id: r.problem.id,
      slug: r.problem.slug,
      title: r.problem.title,
      difficulty: r.problem.difficulty,
      tags: r.problem.tags || [],
      solvedCount: r.problem.solvedCount || 0,
    } : null,
  }));

  return {
    success: true,
    count: data.length,
    total,
    page: safePage,
    totalPages: Math.ceil(total / safeLimit) || 1,
    history: data,
  };
}

/**
 * Completes today's daily problem submission (FR-03, FR-04, FR-06):
 * 1. Validates verdict is ACCEPTED.
 * 2. Validates problem matches today's daily problem.
 * 3. Enforces idempotency via atomic transaction: creates completion, updates streak, & awards +2 coins.
 */
export async function completeDailyProblemSubmission({
  userId,
  problemId,
  submissionId = null,
  isAccepted = false,
  targetISTDate = getAuthoritativeISTDate(),
}) {
  if (!userId || !problemId) {
    return { granted: false, awarded: false, coins: 0, coinsEarned: 0, reason: "MISSING_ARGS" };
  }
  if (!isAccepted) {
    return { granted: false, awarded: false, coins: 0, coinsEarned: 0, reason: "NOT_ACCEPTED" };
  }

  let todayDaily = await prisma.dailyProblem.findUnique({
    where: { istDate: targetISTDate },
    include: { problem: true },
  });
  if (!todayDaily && targetISTDate === getAuthoritativeISTDate()) {
    todayDaily = await ensureDailyProblem(targetISTDate);
  }
  if (!todayDaily) {
    return { granted: false, awarded: false, coins: 0, coinsEarned: 0, reason: "NO_DAILY_PROBLEM_TODAY" };
  }
  const cleanId = String(problemId).replace(/^prob[-_]/, "");
  const isMatch =
    todayDaily.problemId === problemId ||
    todayDaily.problem?.id === problemId ||
    todayDaily.problem?.slug === problemId ||
    todayDaily.problem?.slug === cleanId ||
    todayDaily.problemId === cleanId;
  if (!isMatch) {
    return { granted: false, awarded: false, coins: 0, coinsEarned: 0, reason: "NOT_DAILY_PROBLEM" };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // 1. Check if user already has a DailyProblemCompletion record for this daily problem
      const existingCompletion = await tx.dailyProblemCompletion.findUnique({
        where: {
          userId_dailyProblemId: {
            userId,
            dailyProblemId: todayDaily.id,
          },
        },
      });

      if (existingCompletion) {
        return {
          granted: false,
          awarded: false,
          coins: 0,
          coinsEarned: 0,
          reason: "ALREADY_COMPLETED",
        };
      }

      // 2. Double check coin transaction for DAILY_PROBLEM on this IST date
      const existingCoinTx = await tx.coinTransaction.findFirst({
        where: {
          userId,
          type: "DAILY_PROBLEM",
          istDate: targetISTDate,
        },
      });

      if (existingCoinTx) {
        return {
          granted: false,
          awarded: false,
          coins: 0,
          coinsEarned: 0,
          reason: "ALREADY_COMPLETED",
        };
      }

      // 3. Fetch user and calculate streak advancement (FR-04)
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) {
        return { granted: false, awarded: false, coins: 0, coinsEarned: 0, reason: "USER_NOT_FOUND" };
      }

      const streakCalc = computeDailyProblemStreak(
        user.lastStreakDate,
        targetISTDate,
        user.streak,
      );
      const newStreak = streakCalc.newStreak;
      const newLongestStreak = Math.max(user.longestStreak || 0, newStreak);
      const currentCoins = Number(user.coins) || 100;
      const newBalance = currentCoins + 2;

      // 4. Create DailyProblemCompletion record (composite PK [userId, dailyProblemId])
      await tx.dailyProblemCompletion.create({
        data: {
          userId,
          dailyProblemId: todayDaily.id,
          submissionId: submissionId || null,
        },
      });

      // 5. Update user streak, longestStreak, lastStreakDate, and coins atomically (FR-04, FR-06)
      await tx.user.update({
        where: { id: userId },
        data: {
          coins: newBalance,
          streak: newStreak,
          longestStreak: newLongestStreak,
          lastStreakDate: new Date(),
        },
      });

      // 6. Record coin transaction audit (+2 coins)
      await tx.coinTransaction.create({
        data: {
          userId,
          amount: 2,
          type: "DAILY_PROBLEM",
          referenceId: submissionId || problemId || todayDaily.problemId || todayDaily.id,
          istDate: targetISTDate,
          balanceAfter: newBalance,
        },
      });

      return {
        granted: true,
        awarded: true,
        coins: 2,
        coinsEarned: 2,
        streak: newStreak,
        longestStreak: newLongestStreak,
        balance: newBalance,
        balanceAfter: newBalance,
      };
    });
  } catch (err) {
    if (err.code === "P2002") {
      return {
        granted: false,
        awarded: false,
        coins: 0,
        coinsEarned: 0,
        reason: "ALREADY_COMPLETED",
      };
    }
    console.error(`[DailyProblemService] completeDailyProblemSubmission error for user ${userId}:`, err.message);
    return {
      granted: false,
      awarded: false,
      coins: 0,
      coinsEarned: 0,
      reason: "ERROR",
      error: err.message,
    };
  }
}

/**
 * Starts the automated 12:00 AM Asia/Kolkata daily scheduler (FR-02).
 */
export function startDailyProblemScheduler() {
  if (schedulerTask) return;

  // 1. Immediate lazy check on boot
  ensureDailyProblem().catch((err) => {
    console.warn("[DailyProblemScheduler] Initial startup check notice:", err.message);
  });

  // 2. Schedule cron for 00:00 every day in Asia/Kolkata timezone
  try {
    schedulerTask = cron.schedule(
      "0 0 * * *",
      async () => {
        const todayIST = getAuthoritativeISTDate();
        console.log(`[DailyProblemScheduler] Midnight IST triggered. Generating daily problem for ${todayIST}...`);
        try {
          const selected = await ensureDailyProblem(todayIST);
          console.log(`[DailyProblemScheduler] Daily problem assigned for ${todayIST}: ${selected.problemId}`);
        } catch (err) {
          console.error(`[DailyProblemScheduler] Failed to select daily problem for ${todayIST}:`, err.message);
        }
      },
      {
        scheduled: true,
        timezone: "Asia/Kolkata",
      },
    );
    console.log("⏰ [DailyProblemScheduler] Midnight IST scheduler started (Asia/Kolkata 00:00).");
  } catch (cronErr) {
    console.warn("[DailyProblemScheduler] Cron setup notice:", cronErr.message);
  }
}

/**
 * Stops scheduler (useful for tests and graceful shutdown).
 */
export function stopDailyProblemScheduler() {
  if (schedulerTask) {
    try {
      schedulerTask.stop();
    } catch (_) {}
    schedulerTask = null;
  }
}