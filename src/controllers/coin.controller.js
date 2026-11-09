import {
  getBalance as getCoinBalance,
  getCoinHistory,
  getDailyProblem,
} from "../services/coinService.js";
import {
  getDailyProblemWithUserStatus,
  getDailyProblemHistory,
} from "../services/dailyProblemService.js";
import { getISTDateString } from "../services/streakService.js";

/**
 * GET /api/coins/balance
 * Returns coin balance and streak metrics for the authenticated user.
 */
export const getBalance = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const balance = await getCoinBalance(userId);

    res.status(200).json({
      success: true,
      ...balance,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/coins/history
 * Returns paginated audit log of coin transactions for the authenticated user.
 * Query: ?limit=20&offset=0
 */
export const getHistory = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : 20;
    const offset = req.query.offset !== undefined ? Number(req.query.offset) : 0;

    const data = await getCoinHistory(userId, { limit, offset });

    res.status(200).json({
      success: true,
      ...data,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/daily-problem or GET /api/coins/daily-problem
 * Returns today's active DailyProblem metadata and user's completion status.
 * Ensures today's assignment exists (lazy generation fallback).
 */
export const getTodayDailyProblem = async (req, res, next) => {
  try {
    const userId = req.user?.id || null;
    const todayIST = getISTDateString();

    const data = await getDailyProblemWithUserStatus(todayIST, userId);

    res.status(200).json({
      success: true,
      istDate: data.istDate,
      problem: data.problem,
      reward: data.reward,
      completed: data.completed,
      solvedToday: data.solvedToday,
      rewardClaimed: data.rewardClaimed,
      completedAt: data.completedAt,
      streak: data.streak ?? 0,
      longestStreak: data.longestStreak ?? 0,
      nextRefreshMs: data.nextRefreshMs,
      nextRefreshTime: data.nextRefreshTime,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/daily-problem/history or GET /api/coins/daily-problem/history
 * Returns historical daily problems with pagination.
 */
export const getDailyProblemHistoryController = async (req, res, next) => {
  try {
    const userId = req.user?.id || null;
    const page = req.query.page;
    const limit = req.query.limit;

    const data = await getDailyProblemHistory({ page, limit, userId });

    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};
