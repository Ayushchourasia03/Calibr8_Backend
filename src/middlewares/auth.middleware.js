import { verifyToken } from '../utils/jwt.js';
import { ApiError } from '../utils/ApiError.js';
import { isTokenBlacklisted } from '../utils/tokenBlacklist.js';
import prisma from '../config/db.js';

// Lean projection loaded on every authenticated request. Handlers that need
// relations (topics, social accounts) load them explicitly, so we avoid two
// extra relation queries per request here.
const AUTH_USER_SELECT = {
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
};

function extractBearerToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}

/**
 * Middleware to protect routes.
 * Expects: Authorization: Bearer <token>
 * Attaches the user object to req.user and the token to req.token.
 */
export const protect = async (req, res, next) => {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      throw new ApiError(401, 'No token provided. Please log in.', 'UNAUTHORIZED');
    }

    const decoded = verifyToken(token);

    // Revocation check and user lookup are independent: run them together
    // (one database round trip instead of two when the revocation check is
    // not cached). DB errors propagate to the error handler (503).
    const [revoked, user] = await Promise.all([
      isTokenBlacklisted(token, decoded),
      prisma.user.findUnique({
        where: { id: decoded.id },
        select: AUTH_USER_SELECT,
      }),
    ]);
    if (revoked) {
      throw new ApiError(401, 'Token has been revoked. Please log in again.', 'TOKEN_REVOKED');
    }

    // A valid signature is not enough: the account must still exist. Never
    // recreate a deleted account from token claims.
    if (!user) {
      throw new ApiError(401, 'Account no longer exists. Please log in again.', 'UNAUTHORIZED');
    }

    req.token = token;
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(new ApiError(401, 'Token expired. Please log in again.', 'TOKEN_EXPIRED'));
    }
    if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
      return next(new ApiError(401, 'Invalid token. Please log in again.', 'INVALID_TOKEN'));
    }
    next(err);
  }
};

/**
 * Optional authentication middleware: attaches user if valid token present,
 * but allows unauthenticated playground/sandbox access.
 */
export const optionalAuth = async (req, res, next) => {
  try {
    const token = extractBearerToken(req);
    if (!token) return next();

    const decoded = verifyToken(token);
    const [revoked, user] = await Promise.all([
      isTokenBlacklisted(token, decoded),
      prisma.user.findUnique({
        where: { id: decoded.id },
        select: AUTH_USER_SELECT,
      }),
    ]);
    if (revoked) return next();

    // Unknown users are treated as anonymous rather than trusted from claims.
    if (user) {
      req.token = token;
      req.user = user;
    }
    next();
  } catch (_) {
    next();
  }
};
