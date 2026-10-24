import prisma from '../config/db.js';
import { decodeToken } from './jwt.js';

// Fast local memory cache of revoked token identifiers
const inMemoryBlacklist = new Set();

/**
 * Add a token to the persistent blacklist in PostgreSQL and memory cache.
 * Stores the revoked token id (jti) with its expiry date.
 * @param {string} token
 * @param {object} [decodedPayload]
 */
export const blacklistToken = async (token, decodedPayload = null) => {
  if (!token) return;

  inMemoryBlacklist.add(token);

  try {
    const payload = decodedPayload || decodeToken(token) || {};
    const jti = payload.jti || token;
    const expiresAt = payload.exp
      ? new Date(payload.exp * 1000)
      : new Date(Date.now() + 24 * 60 * 60 * 1000); // default 1 day
    const userId = payload.id || null;

    inMemoryBlacklist.add(jti);

    if (prisma && prisma.revokedToken) {
      await prisma.revokedToken.upsert({
        where: { jti },
        create: {
          jti,
          token,
          userId,
          expiresAt,
        },
        update: {
          token,
          expiresAt,
        },
      });
    }
  } catch (err) {
    // Fall back to memory blacklist if database write fails
    console.warn('[TokenBlacklist] Could not persist revoked token to PostgreSQL:', err.message);
  }
};

/**
 * Check if a token has been blacklisted.
 * Checks local cache first, then PostgreSQL for persistent revocation check.
 * @param {string} token
 * @param {object} [decodedPayload]
 * @returns {Promise<boolean>}
 */
export const isTokenBlacklisted = async (token, decodedPayload = null) => {
  if (!token) return false;

  // 1. Fast in-memory check
  if (inMemoryBlacklist.has(token)) return true;

  const payload = decodedPayload || decodeToken(token);
  if (payload?.jti && inMemoryBlacklist.has(payload.jti)) {
    return true;
  }

  // 2. Persistent PostgreSQL check
  try {
    if (prisma && prisma.revokedToken) {
      const revoked = await prisma.revokedToken.findFirst({
        where: {
          OR: [
            ...(payload?.jti ? [{ jti: payload.jti }] : []),
            { token },
          ],
          expiresAt: { gt: new Date() },
        },
      });

      if (revoked) {
        if (payload?.jti) inMemoryBlacklist.add(payload.jti);
        inMemoryBlacklist.add(token);
        return true;
      }
    }
  } catch (err) {
    console.warn('[TokenBlacklist] Database query warning:', err.message);
  }

  return false;
};
