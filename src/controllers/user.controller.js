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
