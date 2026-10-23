import prisma from "../config/db.js";
import { hashPassword, comparePassword } from "../utils/bcrypt.js";
import { signToken } from "../utils/jwt.js";
import { ApiError } from "../utils/ApiError.js";
import { blacklistToken } from "../utils/tokenBlacklist.js";

/**
 * POST /api/auth/register
 * Registers a new user account and returns a JWT token.
 */
export const register = async (req, res, next) => {
  try {
    const { email, password, name } = req.body;

    // 1. Validate required input fields
    if (!email || !password || !name) {
      throw new ApiError(400, "email, password, and name are required.");
    }

    // 2. Normalize email address
    const normalizedEmail = email.trim().toLowerCase();

    // 3. Check if user already exists
    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new ApiError(409, "An account with this email already exists.");
    }

    // 4. Hash password with bcrypt
    const passwordHash = await hashPassword(password);

    // 5. Create user record in database
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        name: name.trim(),
      },
      include: {
        socialAccounts: true,
        topics: {
          include: {
            topic: true,
          },
        },
      },
    });

    // 6. Generate authentication JWT token
    const token = signToken({ id: user.id });

    // 7. Strip password hash before sending to client
    const { passwordHash: _, ...safeUser } = user;

    // 8. Send response
    res.status(201).json({
      success: true,
      user: safeUser,
      token,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/login
 * Authenticates user credentials and returns a JWT token.
 */
export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // 1. Validate input fields
    if (!email || !password) {
      throw new ApiError(400, "email and password are required.");
    }

    // 2. Find user by normalized email
    const normalizedEmail = email.trim().toLowerCase();
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: {
        socialAccounts: true,
        topics: {
          include: {
            topic: true,
          },
        },
      },
    });

    if (!user) {
      throw new ApiError(401, "Invalid email or password.");
    }

    // 3. Compare password hash
    const isMatch = await comparePassword(password, user.passwordHash);
    if (!isMatch) {
      throw new ApiError(401, "Invalid email or password.");
    }

    // 4. Sign JWT token
    const token = signToken({ id: user.id });

    // 5. Strip password hash
    const { passwordHash: _, ...safeUser } = user;

    // 6. Send response
    res.status(200).json({
      success: true,
      user: safeUser,
      token,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/logout
 * Revokes current bearer token by adding it to the blacklist.
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

    res.status(200).json({
      success: true,
      message: "Logged out successfully.",
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/auth/me or GET /api/auth/verify
 * Returns current authenticated user's profile details.
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

    res.status(200).json({
      success: true,
      user,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/change-password
 * Changes the current authenticated user's password.
 */
export const changePassword = async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body;

    // 1. Validate inputs
    if (!oldPassword || !newPassword) {
      throw new ApiError(400, "oldPassword and newPassword are required.");
    }
    if (newPassword.length < 6) {
      throw new ApiError(400, "New password must be at least 6 characters.");
    }

    // 2. Fetch existing user
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });
    if (!user) {
      throw new ApiError(404, "User not found.");
    }

    // 3. Verify old password
    const isMatch = await comparePassword(oldPassword, user.passwordHash);
    if (!isMatch) {
      throw new ApiError(400, "Current password is incorrect.");
    }

    // 4. Hash new password and save
    const newHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: req.user.id },
      data: { passwordHash: newHash },
    });

    res.status(200).json({
      success: true,
      message: "Password updated successfully.",
    });
  } catch (err) {
    next(err);
  }
};
