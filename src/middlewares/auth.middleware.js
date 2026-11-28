import { verifyToken } from '../utils/jwt.js';
import { ApiError } from '../utils/ApiError.js';
import { isTokenBlacklisted } from '../utils/tokenBlacklist.js';
import { securityEvent } from '../utils/securityLog.js';
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
  lastLoginISTDate: true,
  tokenVersion: true,
  createdAt: true,
  updatedAt: true,
};

function extractBearerToken(req) {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}

/**
 * Verifies the token and loads its user. Returns null for a valid token whose
 * account no longer exists. Throws for invalid, expired or revoked tokens.
 */
async function authenticate(token) {
  const decoded = verifyToken(token);
  if (typeof decoded?.id !== 'string' || !decoded.id) {
    throw new ApiError(401, 'Invalid token. Please log in again.', 'INVALID_TOKEN');
  }

  // Revocation check and user lookup are independent: run them together.
  // DB errors propagate to the error handler (503); revocation fails closed.
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
  if (!user) return { decoded, user: null };

  // Every token carries the tokenVersion it was issued under (legacy tokens
  // without the claim count as version 0). Password changes and "log out
  // everywhere" bump the version, revoking all earlier tokens at once.
  const { tokenVersion, ...safeUser } = user;
  if ((Number(decoded.tv) || 0) !== (Number(tokenVersion) || 0)) {
    throw new ApiError(401, 'Your session was ended. Please log in again.', 'TOKEN_REVOKED');
  }
  return { decoded, user: safeUser, tokenVersion: Number(tokenVersion) || 0 };
}

/**
 * Middleware to protect routes.
 * Expects: Authorization: Bearer <token>
 * Attaches the user object to req.user, the token to req.token and the
 * verified claims to req.auth.
 */
export const protect = async (req, res, next) => {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      throw new ApiError(401, 'No token provided. Please log in.', 'UNAUTHORIZED');
    }

    const { decoded, user, tokenVersion } = await authenticate(token);

    // A valid signature is not enough: the account must still exist. Never
    // recreate a deleted account from token claims.
    if (!user) {
      throw new ApiError(401, 'Account no longer exists. Please log in again.', 'UNAUTHORIZED');
    }

    req.token = token;
    req.user = user;
    req.auth = { decoded, tokenVersion };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(new ApiError(401, 'Token expired. Please log in again.', 'TOKEN_EXPIRED'));
    }
    if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
      // A bad signature/issuer/audience is never produced by our own clients.
      securityEvent('token_rejected', { req, reason: err.name });
      return next(new ApiError(401, 'Invalid token. Please log in again.', 'INVALID_TOKEN'));
    }
    if (err.code === 'TOKEN_REVOKED') securityEvent('token_rejected', { req, reason: 'revoked' });
    next(err);
  }
};

/**
 * Optional authentication middleware: attaches user if valid token present,
 * but allows unauthenticated access to public resources.
 */
export const optionalAuth = async (req, res, next) => {
  try {
    const token = extractBearerToken(req);
    if (!token) return next();

    const { decoded, user, tokenVersion } = await authenticate(token);
    // Unknown users are treated as anonymous rather than trusted from claims.
    if (user) {
      req.token = token;
      req.user = user;
      req.auth = { decoded, tokenVersion };
    }
    next();
  } catch (_) {
    next();
  }
};
