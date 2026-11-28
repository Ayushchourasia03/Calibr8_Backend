import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { queryString, FIELD_LIMITS } from "../utils/validation.js";

const SCOPES = ["global", "college", "batch", "state", "country"];

/**
 * GET /api/rankings
 * Leaderboard ordered by score.
 *
 * Privacy: anonymous callers get a minimal public view (display name and
 * scores) and only the global scope. Signed-in users also see the regional
 * fields (college/batch/state/country) and can filter by them. Internal
 * user ids and account creation dates are never exposed; the caller's own
 * row is flagged with isCurrentUser.
 */
const REGIONAL_FIELDS = ["college", "branch", "batch", "state", "country"];

/**
 * Regional fields shown to signed-in users for OTHER users' rows (SA-L10,
 * round 2): LEADERBOARD_REGIONAL_FIELDS = "all" (default, unchanged
 * behaviour), "none", or a comma-separated subset. A product decision; the
 * caller's own row always shows its own fields.
 */
export function visibleRegionalFields(raw = process.env.LEADERBOARD_REGIONAL_FIELDS) {
  const value = String(raw ?? "all").trim().toLowerCase();
  if (value === "" || value === "all") return REGIONAL_FIELDS;
  if (value === "none") return [];
  const wanted = new Set(value.split(",").map((f) => f.trim()));
  return REGIONAL_FIELDS.filter((f) => wanted.has(f));
}

export const getRankings = async (req, res, next) => {
  try {
    const signedIn = Boolean(req.user?.id);
    const scope = (queryString(req.query.scope, { max: 20 }) || "global").toLowerCase();
    if (!SCOPES.includes(scope)) {
      throw new ApiError(400, `scope must be one of: ${SCOPES.join(", ")}.`, "INVALID_SCOPE");
    }
    if (scope !== "global" && !signedIn) {
      throw new ApiError(401, "Log in to view regional rankings.", "UNAUTHORIZED");
    }

    const where = {};
    if (scope !== "global") {
      const value = queryString(req.query[scope], { max: FIELD_LIMITS[scope] });
      if (value) where[scope] = value;
    }

    const rawLimit = parseInt(queryString(req.query.limit, { max: 6 }) ?? "50", 10);
    const parsedLimit = Number.isNaN(rawLimit)
      ? 50
      : Math.min(Math.max(rawLimit, 1), 100);

    const users = await prisma.user.findMany({
      where,
      orderBy: [{ score: "desc" }, { createdAt: "asc" }],
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
      },
    });

    const shownFields = visibleRegionalFields();
    const data = users.map(({ id, college, branch, batch, state, country, ...row }, index) => {
      const isCurrentUser = signedIn && id === req.user.id;
      const regional = { college, branch, batch, state, country };
      const fields = isCurrentUser ? REGIONAL_FIELDS : signedIn ? shownFields : [];
      return {
        rank: index + 1,
        ...row,
        ...Object.fromEntries(fields.map((f) => [f, regional[f]])),
        isCurrentUser,
      };
    });

    res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (err) {
    next(err);
  }
};
