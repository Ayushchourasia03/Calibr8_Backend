import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";

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
        coins:true,
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
    const normalized = String(language || "").trim().toLowerCase();

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


export const getAllProblems =  async (req, res , next) => {
  try {
    const userId = req.user?.id || null;
    
    const totalUsers = await prisma.user.count();

    const problems = await prisma.problem.findMany({
      orderBy: { problemNumber: 'asc' },
      select: {
        slug: true,
        title: true,
        difficulty: true,
        solvedCount: true,
        problemNumber: true,
        submissions: userId ? {
          where: { userId, status: 'ACCEPTED' },
          select: { id: true }
        } : undefined
      }
    });

    const data = problems.map(p => ({
      name: p.title,
      slug: p.slug,
      number: p.problemNumber,
      level: p.difficulty.toLowerCase(),
      levelDisplay: p.difficulty.toLowerCase() === 'medium' ? 'mid' : p.difficulty.toLowerCase(), // easy | mid | hard
      solvedPercentage: totalUsers > 0 ? Math.round((p.solvedCount / totalUsers) * 100) : 0,
      isSolved: userId ? p.submissions.length > 0 : false
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: err.message });
  }
}