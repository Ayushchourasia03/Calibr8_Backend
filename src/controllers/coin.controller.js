import {
  getCoinHistory,
  getDailyProblem,
} from "../services/coinService.js";
import { getISTDateString } from "../services/streakService.js";

/**
 * GET /api/coins/history
 * Returns paginated audit log of coin transactions for the authenticated user.
 * Query: ?limit=20&cursor=...
 */
export const getHistory = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const limit = Number(req.query.limit) || 20;
    const cursor = req.query.cursor ? String(req.query.cursor) : null;

    const data = await getCoinHistory(userId, { limit, cursor });

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
 * Returns today's active DailyProblem, problem metadata, and whether current user solved it and claimed +2.
 */
export const getTodayDailyProblem = async (req, res, next) => {
  try {
    const userId = req.user?.id || null;
    const todayIST = getISTDateString();

    const data = await getDailyProblem(todayIST, userId);

    res.status(200).json({
      success: true,
      ...data,
    });
  } catch (err) {
    next(err);
  }
};
