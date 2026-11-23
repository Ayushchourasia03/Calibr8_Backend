import {
  getTodayDailyProblem,
  getDailyProblemHistory,
} from "../services/dailyProblemService.js";

/**
 * GET /api/daily-problem (optional auth)
 * Today's daily problem; with a token, also the caller's completion and streak.
 */
export const getToday = async (req, res, next) => {
  try {
    const data = await getTodayDailyProblem({ user: req.user ?? null });
    res.status(200).json({ success: true, ...data });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/daily-problem/history?page=1&limit=30 (optional auth)
 * Daily problems up to today, newest first; with a token, each has `completed`.
 */
export const getHistory = async (req, res, next) => {
  try {
    const data = await getDailyProblemHistory({
      userId: req.user?.id ?? null,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.status(200).json({ success: true, ...data });
  } catch (err) {
    next(err);
  }
};
