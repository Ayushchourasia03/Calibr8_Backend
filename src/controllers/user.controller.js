import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { getSuccessfulSubmissionActivity } from "../utils/successfulSubmissionActivity.js";

async function getActivitySummary(userId) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 371);

  if (typeof prisma.$queryRaw === "function") {
    try {
      const dailyCounts = await prisma.$queryRaw`
        SELECT TO_CHAR(DATE_TRUNC('day', "createdAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS count
        FROM "submissions"
        WHERE "userId" = ${userId}
          AND "status" = 'ACCEPTED'
          AND "totalCount" > 0
          AND "passedCount" = "totalCount"
          AND "createdAt" >= ${since}
        GROUP BY 1
      `;
      const activity = Object.fromEntries(
        dailyCounts.map(({ day, count }) => [day, Number(count)]),
      );
      return {
        activity,
        total: Object.values(activity).reduce((sum, count) => sum + count, 0),
        activeDays: Object.keys(activity).length,
      };
    } catch {
      // Fall back to the in-memory-compatible query when raw SQL is unavailable.
    }
  }

  const submissions = await prisma.submission.findMany({
    where: {
      userId,
      status: { equals: "ACCEPTED", mode: "insensitive" },
      totalCount: { gt: 0 },
      createdAt: { gte: since },
    },
    select: {
      createdAt: true,
      passedCount: true,
      totalCount: true,
      status: true,
    },
  });

  const activity = getSuccessfulSubmissionActivity(submissions);
  return {
    activity,
    total: Object.values(activity).reduce((sum, count) => sum + count, 0),
    activeDays: Object.keys(activity).length,
  };
}

/**
 * GET /api/users/me
 * Returns the authenticated user's profile details with topics and preferences.
 */
export const getMe = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        name: true,
        difficulty: true,
        rating: true,
        score: true,
        streak: true,
        strictPercent: true,
        tier: true,
        college: true,
        branch: true,
        batch: true,
        state: true,
        country: true,
        coins: true,
        onboarded: true,
        preferredLanguage: true,
        createdAt: true,
        updatedAt: true,
        socialAccounts: true,
        topics: {
          include: {
            topic: true,
          },
        },
      },
    });

    if (!user) {
      throw new ApiError(404, "User not found.");
    }

    res.status(200).json({ success: true, user });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/users/me/overview
 * Returns profile details and successful submission activity for the profile page.
 */
export const getProfileOverview = async (req, res, next) => {
  try {
    const [user, activitySummary] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          id: true,
          email: true,
          name: true,
          difficulty: true,
          rating: true,
          score: true,
          streak: true,
          strictPercent: true,
          tier: true,
          college: true,
          branch: true,
          batch: true,
          state: true,
          country: true,
          coins: true,
          onboarded: true,
          preferredLanguage: true,
          createdAt: true,
          updatedAt: true,
          socialAccounts: true,
          topics: { include: { topic: true } },
        },
      }),
      getActivitySummary(req.user.id),
    ]);

    if (!user) {
      throw new ApiError(404, "User not found.");
    }

    res.status(200).json({
      success: true,
      user,
      ...activitySummary,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/users/me/activity
 * Returns daily counts of fully accepted code submissions from the past year.
 */
export const getMyActivity = async (req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      ...(await getActivitySummary(req.user.id)),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/users/me
 * Updates editable profile details (e.g. name) for the authenticated user.
 */
export const updateMe = async (req, res, next) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      throw new ApiError(400, "Name cannot be empty.");
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { name: name.trim() },
      select: {
        id: true,
        email: true,
        name: true,
        difficulty: true,
        rating: true,
        score: true,
        streak: true,
        strictPercent: true,
        tier: true,
        college: true,
        branch: true,
        batch: true,
        state: true,
        country: true,
        coins: true,
        onboarded: true,
        preferredLanguage: true,
        createdAt: true,
        updatedAt: true,
        topics: {
          include: {
            topic: true,
          },
        },
      },
    });

    res.status(200).json({ success: true, user: updated });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/users/me/language
 * Updates the user's preferred programming language (cpp, c, java, python, javascript).
 */
export const updateLanguage = async (req, res, next) => {
  try {
    const { language } = req.body;
    const allowed = ["cpp", "c", "java", "python", "javascript"];
    const normalized = String(language || "")
      .trim()
      .toLowerCase();

    if (!allowed.includes(normalized)) {
      throw new ApiError(
        400,
        `Invalid language. Allowed options: ${allowed.join(", ")}`,
      );
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { preferredLanguage: normalized },
      select: {
        id: true,
        preferredLanguage: true,
      },
    });

    res.status(200).json({
      success: true,
      language: updated.preferredLanguage,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/users/all
 * Lists all problems formatted with solve status for the authenticated user.
 */
export const getAllProblems = async (req, res, next) => {
  try {
    const userId = req.user?.id || null;
    const totalUsers = await prisma.user.count();
    const problems = await prisma.problem.findMany({
      orderBy: { problemNumber: "asc" },
      select: {
        slug: true,
        title: true,
        difficulty: true,
        problemNumber: true,
        solvedCount: true,
        dsaTopic: {
          select: { name: true, slug: true },
        },
        submissions: userId
          ? {
              where: { userId, status: "ACCEPTED" },
              select: { id: true, passedCount: true, totalCount: true },
            }
          : false,
      },
    });

    const data = problems.map((p) => ({
      name: p.title,
      slug: p.slug,
      number: p.problemNumber,
      topic: p.dsaTopic?.name || null,
      topicSlug: p.dsaTopic?.slug || null,
      level: p.difficulty.toLowerCase(),
      levelDisplay:
        p.difficulty.toLowerCase() === "medium"
          ? "mid"
          : p.difficulty.toLowerCase(),
      solvedPercentage:
        totalUsers > 0 ? Math.round((p.solvedCount / totalUsers) * 100) : 0,
      isSolved: userId
        ? (p.submissions || []).some(
            (submission) =>
              submission.totalCount > 0 &&
              submission.passedCount === submission.totalCount,
          )
        : false,
    }));

    res.status(200).json({
      success: true,
      data,
      message: "Problems fetched successfully",
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/users/me
 * Updates the editable fields shown on the profile page in one request.
 */
export const updateProfile = async (req, res, next) => {
  try {
    const { name, college, branch, batch, state, country } = req.body;
    const data = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        throw new ApiError(400, "Name cannot be empty.");
      }
      data.name = name.trim();
    }

    for (const [field, value] of Object.entries({
      college,
      branch,
      batch,
      state,
      country,
    })) {
      if (value !== undefined) data[field] = String(value ?? "").trim();
    }

    if (Object.keys(data).length === 0) {
      throw new ApiError(400, "At least one profile field must be provided.");
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: {
        id: true,
        email: true,
        name: true,
        difficulty: true,
        rating: true,
        score: true,
        streak: true,
        strictPercent: true,
        tier: true,
        college: true,
        branch: true,
        batch: true,
        state: true,
        country: true,
        coins: true,
        onboarded: true,
        preferredLanguage: true,
        createdAt: true,
        updatedAt: true,
        socialAccounts: true,
        topics: { include: { topic: true } },
      },
    });

    res.status(200).json({ success: true, user });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/users/me/academic
 * Updates academic profile (college, branch, batch, state, country) for rankings and filters.
 */
export const updateAcademicProfile = async (req, res, next) => {
  try {
    const { college, branch, batch, state, country } = req.body;

    const data = {};
    if (college !== undefined) data.college = String(college).trim();
    if (branch !== undefined) data.branch = String(branch).trim();
    if (batch !== undefined) data.batch = String(batch).trim();
    if (state !== undefined) data.state = String(state).trim();
    if (country !== undefined) data.country = String(country).trim();

    if (Object.keys(data).length === 0) {
      throw new ApiError(
        400,
        "At least one academic field (college, branch, batch, state, country) must be provided.",
      );
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: {
        id: true,
        name: true,
        email: true,
        college: true,
        branch: true,
        batch: true,
        state: true,
        country: true,
        updatedAt: true,
      },
    });

    res
      .status(200)
      .json({ success: true, message: "Academic profile saved", user });
  } catch (err) {
    next(err);
  }
};
