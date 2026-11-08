import cron from "node-cron";
import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { getISTDateString } from "./streakService.js";

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
 * Selects an eligible problem following the no-repeat-until-exhaustion policy:
 * 1. Prefer problems that have never appeared in the current selection cycle.
 * 2. If all eligible problems have already appeared, reset the selection cycle.
 * 3. Start a new cycle without selecting the immediately previous day's problem (if > 1 problem exists).
 * 4. Handle edge cases (1 eligible problem, or 0 eligible problems).
 */
export async function selectDailyProblemForDate(targetISTDate = getAuthoritativeISTDate()) {
  // Fetch all active/published problems from database
  let eligibleProblems = [];
  try {
    eligibleProblems = await prisma.problem.findMany({
      select: {
        id: true,
        slug: true,
        title: true,
        difficulty: true,
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
    return {
      problem: eligibleProblems[0],
      cycle: 1,
    };
  }

  // Find the most recent daily problem record strictly before targetISTDate
  const allPastDailies = await prisma.dailyProblem.findMany({
    where: {
      istDate: { lt: targetISTDate },
    },
    orderBy: { istDate: "desc" },
    take: 1000,
  });

  const lastDaily = allPastDailies[0] || null;
  const currentCycle = lastDaily?.cycle || 1;

  // Find problems already used in the current cycle
  const usedInCurrentCycle = allPastDailies
    .filter((d) => d.cycle === currentCycle)
    .map((d) => d.problemId);
  const usedIdsSet = new Set(usedInCurrentCycle);

  // Eligible problems not yet picked in current cycle
  let unpickedInCycle = eligibleProblems.filter((p) => !usedIdsSet.has(p.id));

  if (unpickedInCycle.length > 0) {
    // Pick randomly from unpicked problems in current cycle
    const randomIndex = Math.floor(Math.random() * unpickedInCycle.length);
    return {
      problem: unpickedInCycle[randomIndex],
      cycle: currentCycle,
    };
  }

  // All eligible problems have been used in currentCycle: reset selection cycle!
  const newCycle = currentCycle + 1;
  const lastProblemId = lastDaily?.problemId;

  // New cycle: exclude immediately previous day's problem to prevent back-to-back repeats
  let candidatesForNewCycle = eligibleProblems.filter((p) => p.id !== lastProblemId);
  if (candidatesForNewCycle.length === 0) {
    candidatesForNewCycle = eligibleProblems;
  }

  const randomIndex = Math.floor(Math.random() * candidatesForNewCycle.length);
  return {
    problem: candidatesForNewCycle[randomIndex],
    cycle: newCycle,
  };
}

/**
 * Ensures a DailyProblem record exists for targetISTDate.
 * Thread-safe with in-flight promise deduping and DB unique-key conflict handling.
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
      const { problem, cycle } = await selectDailyProblemForDate(targetISTDate);

      try {
        const created = await prisma.dailyProblem.create({
          data: {
            istDate: targetISTDate,
            problemId: problem.id,
            cycle,
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
        // Race condition: another thread created it concurrently (P2002)
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
 * Returns today's active DailyProblem metadata with authenticated user's completion status.
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

  if (userId) {
    // 1. Check dedicated DailyProblemCompletion table
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
      completedAt = completion.completedAt;
    }

    // 2. Check coin transaction for DAILY_PROBLEM
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
      if (!completedAt) completedAt = claim.createdAt;
    }

    // 3. Check accepted submission for today's problem
    if (!completed) {
      const submission = await prisma.submission.findFirst({
        where: {
          userId,
          problemId: daily.problemId,
          status: "ACCEPTED",
        },
      });
      if (submission) {
        completed = true;
        if (!completedAt) completedAt = submission.createdAt;
      }
    }
  }

  const msUntilMidnight = getMillisecondsUntilNextMidnightIST();

  return {
    success: true,
    istDate: daily.istDate,
    cycle: daily.cycle || 1,
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
      description: "+2 coins for your first ACCEPTED submission on today's challenge",
    },
    completed,
    solvedToday: completed,
    rewardClaimed,
    completedAt,
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
    cycle: r.cycle || 1,
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
 * Completes today's daily problem submission:
 * 1. Validates verdict is ACCEPTED.
 * 2. Validates problem matches today's daily problem.
 * 3. Enforces idempotency via atomic transaction: creates completion & awards +2 coins once.
 */
export async function completeDailyProblemSubmission({
  userId,
  problemId,
  submissionId = null,
  isAccepted = false,
  targetISTDate = getAuthoritativeISTDate(),
}) {
  if (!userId || !problemId) {
    return { granted: false, awarded: false, coins: 0, reason: "MISSING_ARGS" };
  }
  if (!isAccepted) {
    return { granted: false, awarded: false, coins: 0, reason: "NOT_ACCEPTED" };
  }

  const todayDaily = await ensureDailyProblem(targetISTDate);
  if (!todayDaily || todayDaily.problemId !== problemId) {
    return { granted: false, awarded: false, coins: 0, reason: "NOT_DAILY_PROBLEM" };
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
          reason: "ALREADY_COMPLETED",
        };
      }

      // 2. Check existing coin transaction for DAILY_PROBLEM on this IST date
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
          reason: "ALREADY_COMPLETED",
        };
      }

      // 3. Create DailyProblemCompletion record
      await tx.dailyProblemCompletion.create({
        data: {
          userId,
          dailyProblemId: todayDaily.id,
          submissionId: submissionId || null,
        },
      });

      // 4. Update user balance and record coin transaction
      const user = await tx.user.findUnique({ where: { id: userId } });
      const currentCoins = Number(user?.coins) || 100;
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
          referenceId: submissionId || todayDaily.id,
          istDate: targetISTDate,
          balanceAfter: newBalance,
        },
      });

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
    // If unique constraint failed concurrently (P2002)
    if (err.code === "P2002") {
      return {
        granted: false,
        awarded: false,
        coins: 0,
        reason: "ALREADY_COMPLETED",
      };
    }
    console.error(`[DailyProblemService] completeDailyProblemSubmission error for user ${userId}:`, err.message);
    return {
      granted: false,
      awarded: false,
      coins: 0,
      reason: "ERROR",
      error: err.message,
    };
  }
}

/**
 * Starts the automated 12:00 AM Asia/Kolkata daily scheduler.
 */
export function startDailyProblemScheduler() {
  if (schedulerTask) return;

  // 1. Immediate initialization check on boot to recover missed assignments
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
 * Stops scheduler (useful for test isolation).
 */
export function stopDailyProblemScheduler() {
  if (schedulerTask) {
    try {
      schedulerTask.stop();
    } catch (_) {}
    schedulerTask = null;
  }
}
