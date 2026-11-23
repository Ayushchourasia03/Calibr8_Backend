import {
  getBalance as getCoinBalance,
  getCoinHistory,
} from "../services/coinService.js";

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
