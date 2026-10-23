import prisma from "../config/db.js";
import { hashPassword, comparePassword } from "../utils/bcrypt.js";
import { signToken } from "../utils/jwt.js";
import { ApiError } from "../utils/ApiError.js";
import { blacklistToken } from "../utils/tokenBlacklist.js";

/**
 * POST /api/auth/register
 */
export const register = async (req, res, next) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      throw new ApiError(400, "email, password, and name are required.");
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new ApiError(409, "An account with this email already exists.");
    }

    const passwordHash = await hashPassword(password);

    const user = await prisma.user.create({
      data: { email: normalizedEmail, passwordHash, name: name.trim() },
      include: {
        socialAccounts: true,
        topics: { include: { topic: true } },
      },
    });

    const token = signToken({ id: user.id });
    const { passwordHash: _omit, ...safeUser } = user;

    res.status(201).json({ success: true, user: safeUser, token });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/login
 */
export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      throw new ApiError(400, "email and password are required.");
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: {
        socialAccounts: true,
        topics: { include: { topic: true } },
      },
    });
    if (!user) {
      throw new ApiError(401, "Invalid email or password.");
    }

    const isMatch = await comparePassword(password, user.passwordHash);
    if (!isMatch) {
      throw new ApiError(401, "Invalid email or password.");
    }

    const token = signToken({ id: user.id });
    const { passwordHash: _omit, ...safeUser } = user;

    res.status(200).json({ success: true, user: safeUser, token });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/logout
 * Protected route: revokes the bearer token.
 */
export const logout = async (req, res, next) => {
  try {
    const token =
      req.token ||
      (req.headers.authorization
        ? req.headers.authorization.split(" ")[1]
        : null);

    if (token) {
      blacklistToken(token);
    }

    res
      .status(200)
      .json({ success: true, message: "Logged out successfully." });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/auth/me or GET /api/auth/verify
 * Protected route: verifies token and returns user profile.
 */
export const verifyAuth = async (req, res, next) => {
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
        topics: { include: { topic: true } },
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
 * POST /api/auth/change-password
 * Protected route: changes user password.
 */
export const changePassword = async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      throw new ApiError(400, "oldPassword and newPassword are required.");
    }
    if (newPassword.length < 6) {
      throw new ApiError(400, "New password must be at least 6 characters.");
    }

    const userId = req.user.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new ApiError(404, "User not found.");
    }

    const isMatch = await comparePassword(oldPassword, user.passwordHash);
    if (!isMatch) {
      throw new ApiError(400, "Current password is incorrect.");
    }

    const newHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newHash },
    });

    res
      .status(200)
      .json({ success: true, message: "Password updated successfully." });
  } catch (err) {
    next(err);
  }
};