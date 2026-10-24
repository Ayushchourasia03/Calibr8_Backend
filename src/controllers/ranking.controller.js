import prisma from "../config/db.js";

/**
 * GET /api/rankings
 * Retrieves public user leaderboard rankings filtered by scope.
 * Excludes sensitive fields (e.g., password hashes).
 */
export const getRankings = async (req, res, next) => {
  try {
    const { scope, college, batch, state, country, limit = 50 } = req.query;
    const where = {};

    if (scope === "college" && college) where.college = college;
    if (scope === "batch" && batch) where.batch = batch;
    if (scope === "state" && state) where.state = state;
    if (scope === "country" && country) where.country = country;

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

    const users = await prisma.user.findMany({
      where,
      orderBy: { score: "desc" },
      take: parsedLimit,
      select: {
        id: true,
        name: true,
        score: true,
        rating: true,
        streak: true,
        strictPercent: true,
        tier: true,
        college: true,
        branch: true,
        batch: true,
        state: true,
        country: true,
        createdAt: true,
      },
    });

    res.status(200).json({
      success: true,
      count: users.length,
      data: users,
    });
  } catch (err) {
    next(err);
  }
};