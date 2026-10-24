import prisma from "../config/db.js";
import { hashPassword, comparePassword } from "../utils/bcrypt.js";
import { signToken, decodeToken } from "../utils/jwt.js";
import { ApiError } from "../utils/ApiError.js";
import { blacklistToken } from "../utils/tokenBlacklist.js";

/**
 * Validate password strength:
 * - Minimum 8 characters
 * - Maximum 72 bytes (bcrypt limit)
 * - Must differ from email
 */
function validatePassword(password, email) {
  if (typeof password !== "string" || password.length < 8) {
    throw new ApiError(400, "Password must be at least 8 characters long.", "WEAK_PASSWORD");
  }

  const byteLen = Buffer.byteLength(password, "utf-8");
  if (byteLen > 72) {
    throw new ApiError(400, "Password cannot exceed 72 bytes.", "PASSWORD_TOO_LONG");
  }

  if (email && password.toLowerCase() === email.trim().toLowerCase()) {
    throw new ApiError(400, "Password must differ from the email address.", "PASSWORD_EQUALS_EMAIL");
  }
}

/**
 * POST /api/auth/register
 * Registers a new user account with strong password enforcement and issues a JWT token.
 */
export const register = async (req, res, next) => {
  try {
    const { email, password, name, role } = req.body;

    // 1. Validate required input fields
    if (!email || !password || !name) {
      throw new ApiError(400, "email, password, and name are required.", "VALIDATION_ERROR");
    }

    // 2. Normalize email address
    const normalizedEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      throw new ApiError(400, "Please provide a valid email address.", "INVALID_EMAIL");
    }

    // 3. Enforce strict password requirements (min 8, max 72 bytes, != email)
    validatePassword(password, normalizedEmail);

    // 4. Check if user already exists
    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new ApiError(409, "An account with this email already exists.", "EMAIL_ALREADY_EXISTS");
    }

    // 5. Hash password with bcrypt (10 rounds)
    const passwordHash = await hashPassword(password);

    // 6. Assign role (default 'user', allow 'admin' only with valid ADMIN_SECRET if provided)
    let assignedRole = "user";
    if (role === "admin") {
      const adminSecret = req.body.adminSecret || req.headers["x-admin-secret"];
      if (adminSecret && adminSecret === process.env.ADMIN_SECRET) {
        assignedRole = "admin";
      } else {
        // If no admin secret is configured in dev and it's explicitly requested
        if (process.env.NODE_ENV !== "production" && process.env.ADMIN_SECRET === undefined) {
          assignedRole = "admin";
        }
      }
    }

    // 7. Create user record in database
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        name: name.trim(),
       // role: assignedRole,
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

    // 8. Generate authentication JWT token with jti
    const token = signToken({ id: user.id, email: user.email, role: user.role });

    // 9. Strip password hash before sending
    const { passwordHash: _, ...safeUser } = user;

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
 * Authenticates user credentials and returns a fresh JWT token.
 */
export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new ApiError(400, "email and password are required.", "MISSING_CREDENTIALS");
    }

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
      throw new ApiError(401, "Invalid email or password.", "INVALID_CREDENTIALS");
    }

    const isMatch = await comparePassword(password, user.passwordHash);
    if (!isMatch) {
      throw new ApiError(401, "Invalid email or password.", "INVALID_CREDENTIALS");
    }

    const token = signToken({ id: user.id, email: user.email, role: user.role || "user" });

    const { passwordHash: _, ...safeUser } = user;

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
 * Revokes current bearer token by adding its jti and expiry to persistent storage.
 */
export const logout = async (req, res, next) => {
  try {
    const token =
      req.token ||
      (req.headers.authorization
        ? req.headers.authorization.split(" ")[1]
        : null);

    if (token) {
      const decoded = decodeToken(token);
      await blacklistToken(token, decoded);
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
 * POST /api/auth/refresh
 * Refreshes active JWT session: issues a new 1-day token and revokes the old one.
 */
export const refreshToken = async (req, res, next) => {
  try {
    const user = req.user;
    const oldToken = req.token;

    // Issue fresh 1-day token
    const newToken = signToken({ id: user.id, email: user.email, role: user.role || "user" });

    // Revoke old token
    if (oldToken) {
      const decoded = decodeToken(oldToken);
      await blacklistToken(oldToken, decoded);
    }

    res.status(200).json({
      success: true,
      token: newToken,
      user,
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
        role: true,
        difficulty: true,
        rating: true,
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
      throw new ApiError(404, "User not found.", "NOT_FOUND");
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
 * Changes the current authenticated user's password with strength validation.
 */
export const changePassword = async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      throw new ApiError(400, "oldPassword and newPassword are required.", "MISSING_FIELDS");
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });
    if (!user) {
      throw new ApiError(404, "User not found.", "NOT_FOUND");
    }

    validatePassword(newPassword, user.email);

    const isMatch = await comparePassword(oldPassword, user.passwordHash);
    if (!isMatch) {
      throw new ApiError(400, "Current password is incorrect.", "INVALID_CURRENT_PASSWORD");
    }

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
