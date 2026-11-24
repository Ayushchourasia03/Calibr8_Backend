// src/services/dailyProblemService.js
// Daily Problem: one problem per IST calendar day, the same for every user.
//
// Assignment  A row in daily_problems is created ahead of time for today and
//             tomorrow (at startup and every hour), and lazily on first use as
//             a fallback. The app never updates or deletes a row once it
//             exists, so what users saw (and completed) stays in the history,
//             and the rows are safe to cache.
// Selection   pickDailyProblem: no repeat within COOLDOWN_DAYS, and every
//             eligible problem is featured once before any is featured again.
// Refresh     The day changes at 00:00 IST. The next day's row already exists
//             by then, so the rollover does no work on the request path.
// Completion  The first ACCEPTED submission of a day's problem, submitted
//             during that IST day, earns DAILY_PROBLEM_COINS and advances the
//             streak, exactly once (completion primary key + partial unique
//             index on coin_transactions).
// Decay       Just after midnight, streaks whose last completion is older than
//             yesterday are reset to 0, so every reader of users.streak shows
//             the live value.
//
// Every scheduled job is idempotent, so running several backend instances is
// safe without leader election.

import cron from "node-cron";
import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import {
  getISTDateString,
  isISTDateString,
  toISTDateString,
  addDaysToISTDate,
  startOfISTDay,
  nextISTMidnight,
  computeDailyProblemStreak,
} from "./streakService.js";

export const DAILY_PROBLEM_COINS = 2;
export const COOLDOWN_DAYS = 7;

const IST_TIMEZONE = "Asia/Kolkata";
const ROW_CACHE_TTL_MS = 5 * 60 * 1000;
const ROW_CACHE_MAX_ENTRIES = 8;
// Submissions made just before midnight are still being judged for a moment
// after it; decay waits this long so their streak is counted first.
const STREAK_DECAY_GRACE_MS = 5 * 60 * 1000;

const PROBLEM_SUMMARY_SELECT = {
  id: true,
  slug: true,
  title: true,
  difficulty: true,
  tags: true,
  solvedCount: true,
};

const DAILY_ROW_SELECT = {
  id: true,
  istDate: true,
  problemId: true,
  problem: { select: PROBLEM_SUMMARY_SELECT },
};

function assertISTDate(istDate) {
  if (!isISTDateString(istDate)) {
    throw new ApiError(400, `Invalid IST date: ${istDate}`, "INVALID_IST_DATE");
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Chooses the problem to feature from plain data (no I/O).
 *
 * @param candidates     eligible problem ids
 * @param featureCounts  Map problemId -> times featured before the target day
 * @param recent         problem ids featured near the target day, nearest
 *                       first: [yesterday, tomorrow, 2 days ago, ...]; null
 *                       for days without a row
 * @param random         () => [0, 1)
 *
 * Problems in `recent` are skipped. When that leaves nothing (a small pool),
 * the window shrinks from the far end, so yesterday's problem is the last to
 * become allowed again. Among what is left, the least-featured problems win
 * and ties are broken at random: each problem is featured once, in random
 * order, before any is featured twice, and newly added problems come up soon.
 */
export function pickDailyProblem({ candidates, featureCounts = new Map(), recent = [], random = Math.random }) {
  if (!candidates || candidates.length === 0) return null;

  let pool = candidates;
  for (let window = recent.length; window > 0; window--) {
    const blocked = new Set(recent.slice(0, window));
    const allowed = candidates.filter((id) => !blocked.has(id));
    if (allowed.length > 0) {
      pool = allowed;
      break;
    }
  }

  const countOf = (id) => featureCounts.get(id) ?? 0;
  const minCount = pool.reduce((min, id) => Math.min(min, countOf(id)), Infinity);
  const leastFeatured = pool.filter((id) => countOf(id) === minCount);
  return leastFeatured[Math.floor(random() * leastFeatured.length)];
}

async function chooseProblemFor(istDate) {
  const tomorrow = addDaysToISTDate(istDate, 1);
  const [eligible, counts, nearby] = await Promise.all([
    // A problem without testcases cannot be judged, so it cannot be solved.
    prisma.problem.findMany({
      where: { testcases: { some: {} } },
      select: { id: true },
      orderBy: { problemNumber: "asc" },
    }),
    prisma.dailyProblem.groupBy({
      by: ["problemId"],
      where: { istDate: { lt: istDate } },
      _count: { _all: true },
    }),
    prisma.dailyProblem.findMany({
      where: { istDate: { gte: addDaysToISTDate(istDate, -COOLDOWN_DAYS), lte: tomorrow, not: istDate } },
      select: { istDate: true, problemId: true },
    }),
  ]);

  const byDate = new Map(nearby.map((row) => [row.istDate, row.problemId]));
  const recent = [byDate.get(addDaysToISTDate(istDate, -1)) ?? null, byDate.get(tomorrow) ?? null];
  for (let back = 2; back <= COOLDOWN_DAYS; back++) {
    recent.push(byDate.get(addDaysToISTDate(istDate, -back)) ?? null);
  }

  return pickDailyProblem({
    candidates: eligible.map((p) => p.id),
    featureCounts: new Map(counts.map((c) => [c.problemId, c._count._all])),
    recent,
  });
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

// istDate -> { promise, expiresAt }. Rows never change, so the TTL only
// bounds how long a manual database edit takes to show up.
const rowCache = new Map();
const pendingCreates = new Map();

function loadDailyProblem(istDate) {
  return prisma.dailyProblem.findUnique({ where: { istDate }, select: DAILY_ROW_SELECT });
}

function cacheRow(istDate, promise) {
  if (rowCache.size >= ROW_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [key, entry] of rowCache) {
      if (entry.expiresAt <= now) rowCache.delete(key);
    }
    if (rowCache.size >= ROW_CACHE_MAX_ENTRIES) rowCache.clear();
  }
  rowCache.set(istDate, { promise, expiresAt: Date.now() + ROW_CACHE_TTL_MS });
}

/** The day's row (cached), or null when it has not been created. */
function getDailyProblemRow(istDate) {
  const hit = rowCache.get(istDate);
  if (hit && hit.expiresAt > Date.now()) return hit.promise;

  const promise = loadDailyProblem(istDate).then(
    (row) => {
      if (!row && rowCache.get(istDate)?.promise === promise) rowCache.delete(istDate);
      return row;
    },
    (err) => {
      if (rowCache.get(istDate)?.promise === promise) rowCache.delete(istDate);
      throw err;
    },
  );
  cacheRow(istDate, promise);
  return promise;
}

async function createDailyProblem(istDate) {
  const problemId = await chooseProblemFor(istDate);
  if (!problemId) {
    throw new ApiError(503, "No eligible problems are available for the daily problem.", "NO_ELIGIBLE_PROBLEMS");
  }

  // ON CONFLICT DO NOTHING: when instances race, the first insert wins and
  // every caller reads that row back.
  const { count } = await prisma.dailyProblem.createMany({
    data: [{ istDate, problemId }],
    skipDuplicates: true,
  });
  const row = await loadDailyProblem(istDate);
  if (!row) throw new Error(`Daily problem row for ${istDate} is missing right after insert`);

  cacheRow(istDate, Promise.resolve(row));
  if (count > 0) console.log(`[DailyProblem] Assigned ${istDate}: ${row.problem.slug}`);
  return row;
}

/** Returns the day's row, creating it when missing. Safe under concurrency. */
export async function ensureDailyProblem(istDate = getISTDateString()) {
  assertISTDate(istDate);
  const existing = await getDailyProblemRow(istDate);
  if (existing) return existing;

  if (!pendingCreates.has(istDate)) {
    pendingCreates.set(
      istDate,
      createDailyProblem(istDate).finally(() => pendingCreates.delete(istDate)),
    );
  }
  return pendingCreates.get(istDate);
}

/** Creates today's and tomorrow's rows if missing (today first, so tomorrow avoids it). */
export async function ensureUpcomingDailyProblems(now = new Date()) {
  const today = getISTDateString(now);
  const todayRow = await ensureDailyProblem(today);
  const tomorrowRow = await ensureDailyProblem(addDaysToISTDate(today, 1));
  return { today: todayRow, tomorrow: tomorrowRow };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Today's problem plus the caller's status.
 * @param user the authenticated user (needs id, streak, longestStreak) or null
 */
export async function getTodayDailyProblem({ user = null, now = new Date() } = {}) {
  const istDate = getISTDateString(now);
  const daily = await ensureDailyProblem(istDate);

  const completion = user
    ? await prisma.dailyProblemCompletion.findUnique({
        where: { userId_dailyProblemId: { userId: user.id, dailyProblemId: daily.id } },
        select: { completedAt: true },
      })
    : null;

  const refreshAt = nextISTMidnight(now);
  return {
    istDate,
    problem: daily.problem,
    reward: { coins: DAILY_PROBLEM_COINS, streak: 1 },
    completed: Boolean(completion),
    completedAt: completion?.completedAt ?? null,
    streak: user?.streak ?? 0,
    longestStreak: user?.longestStreak ?? 0,
    nextRefreshAt: refreshAt.toISOString(),
    nextRefreshMs: refreshAt.getTime() - now.getTime(),
  };
}

function toBoundedInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Past daily problems up to and including today, newest first. */
export async function getDailyProblemHistory({ userId = null, page = 1, limit = 30, now = new Date() } = {}) {
  const safePage = toBoundedInt(page, 1, 1, 10_000);
  const safeLimit = toBoundedInt(limit, 30, 1, 100);
  // Tomorrow's row already exists; it must not leak before its day.
  const where = { istDate: { lte: getISTDateString(now) } };

  const [total, rows] = await Promise.all([
    prisma.dailyProblem.count({ where }),
    prisma.dailyProblem.findMany({
      where,
      orderBy: { istDate: "desc" },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
      select: DAILY_ROW_SELECT,
    }),
  ]);

  const completedAtById = new Map();
  if (userId && rows.length > 0) {
    const completions = await prisma.dailyProblemCompletion.findMany({
      where: { userId, dailyProblemId: { in: rows.map((r) => r.id) } },
      select: { dailyProblemId: true, completedAt: true },
    });
    for (const c of completions) completedAtById.set(c.dailyProblemId, c.completedAt);
  }

  return {
    page: safePage,
    limit: safeLimit,
    total,
    totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    history: rows.map((r) => ({
      istDate: r.istDate,
      problem: r.problem,
      completed: completedAtById.has(r.id),
      completedAt: completedAtById.get(r.id) ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

function notGranted(reason) {
  return { granted: false, coins: 0, reason };
}

/**
 * Records an ACCEPTED submission against the daily problem of the IST day it
 * was submitted on, and grants the reward the first time. Never throws: the
 * reward must never block a submission.
 *
 * @param submittedAt when the user submitted. Judging can finish after
 *   midnight; the submission still counts for the day it was made on.
 * @returns { granted, coins, reason? , streak?, longestStreak?, balance? }
 */
export async function recordDailyProblemCompletion({ userId, problemId, submissionId = null, submittedAt = new Date() }) {
  if (!userId || !problemId) return notGranted("MISSING_ARGS");
  if (!(submittedAt instanceof Date) || isNaN(submittedAt.getTime())) submittedAt = new Date();

  try {
    const istDate = getISTDateString(submittedAt);
    const daily = istDate === getISTDateString()
      ? await ensureDailyProblem(istDate)
      : await getDailyProblemRow(istDate);
    if (!daily) return notGranted("NO_DAILY_PROBLEM");
    if (daily.problemId !== problemId) return notGranted("NOT_DAILY_PROBLEM");

    return await prisma.$transaction(async (tx) => {
      // The completion's primary key is the idempotency gate: a concurrent
      // duplicate waits on it, then inserts nothing.
      const { count } = await tx.dailyProblemCompletion.createMany({
        data: [{ userId, dailyProblemId: daily.id, submissionId }],
        skipDuplicates: true,
      });
      if (count === 0) return notGranted("ALREADY_COMPLETED");

      // Updating coins first also locks the user row, so the streak below is
      // computed from values nothing else can change until commit.
      const user = await tx.user.update({
        where: { id: userId },
        data: { coins: { increment: DAILY_PROBLEM_COINS } },
        select: { coins: true, streak: true, longestStreak: true, lastStreakDate: true },
      });

      let { streak, longestStreak } = user;
      const lastIST = toISTDateString(user.lastStreakDate);
      // Only move the streak forward in time. A late-judged completion for an
      // earlier day (around midnight) still earns coins but leaves it alone.
      if (!lastIST || lastIST < istDate) {
        streak = computeDailyProblemStreak(lastIST, istDate, streak).newStreak;
        longestStreak = Math.max(longestStreak, streak);
        await tx.user.update({
          where: { id: userId },
          data: { streak, longestStreak, lastStreakDate: submittedAt },
        });
      }

      await tx.coinTransaction.create({
        data: {
          userId,
          amount: DAILY_PROBLEM_COINS,
          type: "DAILY_PROBLEM",
          referenceId: submissionId ?? daily.id,
          istDate,
          balanceAfter: user.coins,
        },
      });

      return { granted: true, coins: DAILY_PROBLEM_COINS, streak, longestStreak, balance: user.coins };
    });
  } catch (err) {
    // P2002: the one-reward-per-day unique index caught a duplicate.
    if (err?.code === "P2002") return notGranted("ALREADY_COMPLETED");
    // P2003 / P2025: the user no longer exists.
    if (err?.code === "P2003" || err?.code === "P2025") return notGranted("USER_NOT_FOUND");
    console.error(`[DailyProblem] Completion failed for user ${userId}:`, err?.message || err);
    return notGranted("ERROR");
  }
}

// ---------------------------------------------------------------------------
// Streak decay
// ---------------------------------------------------------------------------

/**
 * Resets streaks whose last completion is before yesterday (IST). Users who
 * solved yesterday keep their streak until today ends.
 * Affects every user: never call it with a future `now` on a shared database.
 */
export async function resetBrokenStreaks(now = new Date()) {
  const yesterday = addDaysToISTDate(getISTDateString(now), -1);
  const { count } = await prisma.user.updateMany({
    where: {
      streak: { gt: 0 },
      OR: [{ lastStreakDate: null }, { lastStreakDate: { lt: startOfISTDay(yesterday) } }],
    },
    data: { streak: 0 },
  });
  return count;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let scheduledTasks = [];

async function runAssignmentJob() {
  try {
    await ensureUpcomingDailyProblems();
  } catch (err) {
    console.error("[DailyProblem] Assignment job failed:", err?.message || err);
  }
}

async function runStreakDecayJob() {
  try {
    const count = await resetBrokenStreaks();
    if (count > 0) console.log(`[DailyProblem] Reset ${count} broken streak(s)`);
  } catch (err) {
    console.error("[DailyProblem] Streak decay job failed:", err?.message || err);
  }
}

/**
 * Starts the jobs: assignment at startup and at the top of every hour (the
 * 00:00 run creates the new tomorrow; the others retry after a failure), and
 * streak decay at startup and at 00:05 IST.
 */
export function startDailyProblemScheduler() {
  if (process.env.ENABLE_CRON_JOBS === "false") {
    return;
  }
  if (scheduledTasks.length > 0) return;

  runAssignmentJob();
  const now = new Date();
  // Within the grace period the 00:05 run covers it.
  if (now.getTime() - startOfISTDay(getISTDateString(now)).getTime() >= STREAK_DECAY_GRACE_MS) {
    runStreakDecayJob();
  }

  scheduledTasks = [
    cron.schedule("0 * * * *", runAssignmentJob, {
      name: "daily-problem-assignment",
      timezone: IST_TIMEZONE,
      noOverlap: true,
    }),
    cron.schedule("5 0 * * *", runStreakDecayJob, {
      name: "daily-problem-streak-decay",
      timezone: IST_TIMEZONE,
      noOverlap: true,
    }),
  ];
  console.log("⏰ [DailyProblem] Scheduler started (assignment hourly, streak decay 00:05 IST)");
}

export function stopDailyProblemScheduler() {
  for (const task of scheduledTasks) {
    try {
      task.stop();
    } catch {
      // already stopped
    }
  }
  scheduledTasks = [];
}
