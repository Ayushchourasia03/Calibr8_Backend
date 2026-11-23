import prisma from "../config/db.js";
import { hashPassword, comparePassword, needsRehash } from "../utils/bcrypt.js";
import { signSessionToken, decodeToken, assertSessionWithinMaxAge } from "../utils/jwt.js";
import { ApiError } from "../utils/ApiError.js";
import { blacklistToken } from "../utils/tokenBlacklist.js";
import { getUserHeaderStats } from "../utils/userHeaderStats.js";
import { requireEmail, requireText } from "../utils/validation.js";
import {
  assertLoginAllowed,
  recordFailedLogin,
  clearFailedLogins,
} from "../middlewares/rateLimit.middleware.js";
import { grantDailyLoginReward, getCoinsEarnedToday } from "../services/coinService.js";
import { getISTDateString } from "../services/streakService.js";

// Never sent to clients.
function stripSecrets(user) {
  if (!user) return user;
  const { passwordHash: _hash, tokenVersion: _tv, ...safe } = user;
  return safe;
}

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

/** The daily login coin is granted at most once per IST day; skip the write otherwise. */
async function grantLoginRewardIfNewDay(user) {
  if (user?.lastLoginISTDate && user.lastLoginISTDate === getISTDateString()) {
    return null;
  }
  return grantDailyLoginReward(user.id);
}

/**
 * POST /api/auth/register
 * Registers a new user account with strong password enforcement and issues a JWT token.
 */
export const register = async (req, res, next) => {
  try {
    const { email, password, name } = req.body ?? {};

    // 1. Validate required input fields
    if (!email || !password || !name) {
      throw new ApiError(400, "email, password, and name are required.", "VALIDATION_ERROR");
    }

    // 2. Normalize email address and profile name
    const normalizedEmail = requireEmail(email);
    const cleanName = requireText(name, "name");

    // 3. Enforce strict password requirements (min 8, max 72 bytes, != email)
    validatePassword(password, normalizedEmail);

    // 4. Check if user already exists
    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    if (existing) {
      throw new ApiError(409, "An account with this email already exists.", "EMAIL_ALREADY_EXISTS");
    }

    // 5. Hash password with bcrypt
    const passwordHash = await hashPassword(password);

    // 6. Create user record in database
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        name: cleanName,
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

    // 7. Generate authentication JWT token with jti
    const token = signSessionToken(user);

    // 7b. Registration day counts as a daily login (FR-05); idempotent per IST day.
    const loginReward = await grantDailyLoginReward(user.id);
    if (loginReward?.user) {
      user.coins = loginReward.user.coins;
      user.lastLoginISTDate = loginReward.user.lastLoginISTDate;
    }

    // 8. Strip secrets before sending
    const safeUser = stripSecrets(user);

    res.status(201).json({
      success: true,
      user: safeUser,
      stats: getUserHeaderStats(safeUser),
      token,
      isNewUser: true,
      rewards: {
        coinsEarnedToday: loginReward?.coinsEarnedToday ?? 0,
        loginCoins: loginReward?.loginCoins ?? 0,
        streak: user.streak ?? 0,
        longestStreak: user.longestStreak ?? 0,
        isNewDay: loginReward?.isNewDay ?? false,
      },
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
    const { email, password } = req.body ?? {};

    if (!email || !password) {
      throw new ApiError(400, "email and password are required.", "MISSING_CREDENTIALS");
    }
    if (typeof email !== "string" || typeof password !== "string") {
      throw new ApiError(400, "email and password must be strings.", "MISSING_CREDENTIALS");
    }

    const normalizedEmail = email.trim().toLowerCase();
    // Per-account throttle on top of the per-IP limiter (credential stuffing).
    assertLoginAllowed(normalizedEmail);

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

    // Same bcrypt cost whether or not the account exists (no timing oracle).
    const isMatch = await comparePassword(password, user?.passwordHash);
    if (!user || !isMatch) {
      recordFailedLogin(normalizedEmail);
      throw new ApiError(401, "Invalid email or password.", "INVALID_CREDENTIALS");
    }
    clearFailedLogins(normalizedEmail);

    // Upgrade hashes created with an older cost factor.
    if (needsRehash(user.passwordHash)) {
      hashPassword(password)
        .then((passwordHash) =>
          prisma.user.updateMany({
            where: { id: user.id, passwordHash: user.passwordHash },
            data: { passwordHash },
          }),
        )
        .catch(() => {});
    }

    const token = signSessionToken(user);

    // Execute daily login reward grant (server-side, idempotent, audited per FR-05)
    let rewards = {
      coinsEarnedToday: 0,
      loginCoins: 0,
      streak: user.streak ?? 0,
      longestStreak: user.longestStreak ?? 0,
      isNewDay: false,
    };

    try {
      const loginReward = await grantDailyLoginReward(user.id);
      if (loginReward) {
        rewards = {
          coinsEarnedToday: loginReward.coinsEarnedToday,
          loginCoins: loginReward.loginCoins,
          streak: loginReward.streak ?? user.streak ?? 0,
          longestStreak: loginReward.longestStreak ?? user.longestStreak ?? 0,
          isNewDay: loginReward.isNewDay,
        };

        if (loginReward.user) {
          user.coins = loginReward.user.coins;
          user.lastLoginISTDate = loginReward.user.lastLoginISTDate;
        }
      }
    } catch (rewardErr) {
      console.warn("[Auth Login Reward Warning]:", rewardErr.message);
    }

    const safeUser = stripSecrets(user);

    res.status(200).json({
      success: true,
      user: safeUser,
      stats: getUserHeaderStats(safeUser),
      token,
      isNewUser: false,
      rewards,
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
    if (req.token) {
      await blacklistToken(req.token, req.auth?.decoded || decodeToken(req.token));
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
 * POST /api/auth/logout-all
 * Ends every session of the account (all devices) by bumping tokenVersion.
 */
export const logoutAll = async (req, res, next) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { tokenVersion: { increment: 1 } },
      select: { id: true },
    });
    if (req.token) {
      await blacklistToken(req.token, req.auth?.decoded || decodeToken(req.token));
    }
    res.status(200).json({
      success: true,
      message: "Logged out of all sessions.",
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/refresh
 * Refreshes active JWT session: issues a new token and revokes the old one.
 * A session can be refreshed for at most SESSION_MAX_AGE_DAYS after login.
 */
export const refreshToken = async (req, res, next) => {
  try {
    const oldToken = req.token;
    const authTime = assertSessionWithinMaxAge(req.auth?.decoded);

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
        longestStreak: true,
        tier: true,
        coins: true,
        onboarded: true,
        preferredLanguage: true,
        createdAt: true,
        updatedAt: true,
        tokenVersion: true,
        socialAccounts: true,
        topics: { include: { topic: true } },
      },
    });
    if (!user) {
      throw new ApiError(401, "Account no longer exists. Please log in again.", "UNAUTHORIZED");
    }

    // Users who stay signed in via refresh still earn their daily login coin.
    const loginReward = await grantLoginRewardIfNewDay(req.user);
    if (loginReward?.user) user.coins = loginReward.user.coins;

    // Fresh token, same session (original login time is carried over).
    const newToken = signSessionToken(user, { authTime });

    // Revoke old token
    if (oldToken) {
      await blacklistToken(oldToken, req.auth?.decoded || decodeToken(oldToken));
    }

    const safeUser = stripSecrets(user);
    res.status(200).json({
      success: true,
      token: newToken,
      user: safeUser,
      stats: getUserHeaderStats(safeUser),
      rewards: {
        coinsEarnedToday: loginReward?.coinsEarnedToday ?? 0,
        loginCoins: loginReward?.loginCoins ?? 0,
        isNewDay: loginReward?.isNewDay ?? false,
      },
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
    const todayISTDate = getISTDateString();
    // Opening the app with a still-valid token counts as today's login
    // (idempotent per IST day; no write once today's login is recorded).
    // Runs first so the user read and coinsEarnedToday below include the reward.
    const loginReward = await grantLoginRewardIfNewDay(req.user);
    // getCoinsEarnedToday never throws, so both queries can run concurrently.
    const [user, coinsEarnedToday] = await Promise.all([
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
        longestStreak: true,
        coins: true,
        lastStreakDate: true,
        lastLoginISTDate: true,
        tier: true,
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
      }),
      getCoinsEarnedToday(req.user.id, todayISTDate),
    ]);

    if (!user) {
      throw new ApiError(404, "User not found.", "NOT_FOUND");
    }

    const enrichedUser = {
      ...user,
      todayISTDate,
      coinsEarnedToday,
      loginCoins: loginReward?.loginCoins ?? 0,
    };

    res.status(200).json({
      success: true,
      user: enrichedUser,
      stats: getUserHeaderStats(enrichedUser),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/change-password
 * Changes the current authenticated user's password with strength validation.
 * Revokes every existing session and returns a new token for this one.
 * Body: { currentPassword (or oldPassword), newPassword }
 */
export const changePassword = async (req, res, next) => {
  try {
    const { newPassword } = req.body ?? {};
    const currentPassword = req.body?.currentPassword ?? req.body?.oldPassword;

    if (!currentPassword || !newPassword) {
      throw new ApiError(400, "currentPassword and newPassword are required.", "MISSING_FIELDS");
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, passwordHash: true },
    });
    if (!user) {
      throw new ApiError(404, "User not found.", "NOT_FOUND");
    }

    validatePassword(newPassword, user.email);

    const isMatch = await comparePassword(currentPassword, user.passwordHash);
    if (!isMatch) {
      throw new ApiError(400, "Current password is incorrect.", "INVALID_CURRENT_PASSWORD");
    }

    const newHash = await hashPassword(newPassword);
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      // Bumping tokenVersion invalidates every token issued before now,
      // including any stolen ones.
      data: { passwordHash: newHash, tokenVersion: { increment: 1 } },
      select: { id: true, tokenVersion: true },
    });
    clearFailedLogins(user.email);

    res.status(200).json({
      success: true,
      message: "Password updated successfully. Other sessions have been signed out.",
      token: signSessionToken(updated),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/users/me
 * Permanently deletes the authenticated account and its data.
 * Body: { password, confirm: "DELETE" }
 */
export const deleteAccount = async (req, res, next) => {
  try {
    const { password, confirm } = req.body ?? {};
    if (confirm !== "DELETE") {
      throw new ApiError(400, 'Send confirm: "DELETE" to delete your account.', "CONFIRMATION_REQUIRED");
    }
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, passwordHash: true },
    });
    if (!user) throw new ApiError(404, "User not found.", "NOT_FOUND");
    if (!(await comparePassword(password, user.passwordHash))) {
      throw new ApiError(400, "Password is incorrect.", "INVALID_CURRENT_PASSWORD");
    }

    // Related rows (submissions, progress, coins, themes, daily completions,
    // social accounts, profiles) are removed by ON DELETE CASCADE.
    await prisma.user.delete({ where: { id: user.id } });
    if (req.token) {
      await blacklistToken(req.token, req.auth?.decoded || decodeToken(req.token));
    }

    res.status(200).json({ success: true, message: "Your account has been deleted." });
  } catch (err) {
    next(err);
  }
};
