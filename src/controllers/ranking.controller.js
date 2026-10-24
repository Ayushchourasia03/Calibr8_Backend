import prisma from "../config/db.js";

export const getRankings = async (req, res) => {
  try {
    const { scope, college, batch, state, country, limit = 50 } = req.query;
    let where = {};
    if (scope === 'college' && college) where.college = college;
    if (scope === 'batch' && batch) where.batch = batch;
    if (scope === 'state' && state) where.state = state;
    if (scope === 'country' && country) where.country = country;

    const users = await prisma.user.findMany({
      where,
      orderBy: { score: 'desc' },
      take: parseInt(limit),
    });
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};