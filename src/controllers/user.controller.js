import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";

// Tier helper
function getTierFromRating(rating) {
  if (rating >= 1700) return { name: "Zenith II", color: "pink" };
  if (rating >= 1600) return { name: "Eclipse III", color: "orange" };
  if (rating >= 1500) return { name: "Eclipse I", color: "orange" };
  if (rating >= 1400) return { name: "Aurora III", color: "green" };
  if (rating >= 1300) return { name: "Aurora II", color: "green" };
  if (rating >= 1200) return { name: "Prism II", color: "purple" };
  return { name: "Prism I", color: "purple" };
}

export const updateAcademic = async (req, res) => {
  try {
    const userId = req.user.id; // if your middleware uses req.userId, change to req.userId
    const { college, batch, state, country } = req.body;

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { college, batch, state, country }
    });

    res.json(updated);
  } catch (e) {
    console.log(e);
    res.status(500).json({ error: e.message });
  }
};

// Call this when user solves a problem
export const addScore = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    const newRating = user.rating + 10;
    const tier = getTierFromRating(newRating).name;

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { 
        score: { increment: 100 },
        rating: { increment: 10 },
        tier: tier
      }
    });

    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};


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


export const getAllProblems = async (req, res, next) => {
  try {
    const userId = req.user?.id || null;
    const totalUsers = await prisma.user.count();
    const problems = await prisma.problem.findMany({
      orderBy: { problemNumber: 'asc' },
      select: {
        slug: true,
        title: true,
        difficulty: true,
        problemNumber: true,
        solvedCount: true,
        dsaTopic: { 
          select: { name: true, slug: true }
        },
        submissions: userId ? {
          where: { userId, status: 'ACCEPTED' },
          select: { id: true }
        } : false
      }
    });
    const data = problems.map(p => ({
      name: p.title,
      slug: p.slug,
      number: p.problemNumber,
      topic: p.dsaTopic?.name || null, 
      topicSlug: p.dsaTopic?.slug || null,
      level: p.difficulty.toLowerCase(),
      levelDisplay: p.difficulty.toLowerCase() === 'medium' ? 'mid' : p.difficulty.toLowerCase(),
      solvedPercentage: totalUsers > 0 ? Math.round((p.solvedCount / totalUsers) * 100) : 0,
      isSolved: userId ? p.submissions.length > 0 : false
    }));
    res.json({ success: true, data , message: 'Problems fetched successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: err.message });
  }
}


export const updateAcademicProfile = async (req, res) => {
  const { college, batch, state, country } = req.body;

  const data = {};
  if (college) data.college = college;
  if (batch) data.batch = batch.toString();
  if (state) data.state = state;
  if (country) data.country = country;

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ success: false, message: "No fields provided" });
  }

  const user = await prisma.user.update({
    where: { id: req.user.id },
    data
  });

  res.json({ success: true, message: "Academic profile saved", user });
};