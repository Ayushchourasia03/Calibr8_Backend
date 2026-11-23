import crypto from 'crypto';
import prisma from '../config/db.js';
import { decodeToken } from './jwt.js';

// Local cache of revoked token ids -> expiry (ms). Entries are pruned once the
// underlying JWT has expired, since an expired token is rejected anyway.
const revokedCache = new Map();
// Short-lived cache of ids confirmed NOT revoked, to avoid a DB round-trip on
// every authenticated request. Kept short so revocations made by other
// instances propagate quickly.
const notRevokedCache = new Map();
const NOT_REVOKED_TTL_MS = 10 * 1000;
const MAX_NOT_REVOKED_ENTRIES = 50_000;

let persistenceAvailable = true;

setInterval(() => {
  const now = Date.now();
  for (const [id, exp] of revokedCache) if (exp <= now) revokedCache.delete(id);
  for (const [id, exp] of notRevokedCache) if (exp <= now) notRevokedCache.delete(id);
}, 60 * 1000).unref?.();

/** Stable identifier for a token: its jti, or a hash of the token for legacy tokens. */
function tokenId(token, payload) {
  if (payload?.jti) return String(payload.jti);
  return `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

function expiryMs(payload) {
  return payload?.exp ? payload.exp * 1000 : Date.now() + 24 * 60 * 60 * 1000;
}

function handlePersistenceError(err) {
  // P2021: table does not exist (migration not applied yet). Stop retrying so
  // we don't add a failing query + log line to every request.
  if (err?.code === 'P2021') {
    persistenceAvailable = false;
    console.warn('[TokenBlacklist] revoked_tokens table missing; using in-memory revocation only. Run prisma migrate deploy.');
    return;
  }
  console.warn('[TokenBlacklist] Database warning:', err?.message);
}

/**
 * Revoke a token: persists its id + expiry in PostgreSQL and the local cache.
 * The raw token is never stored.
 * @param {string} token
 * @param {object} [decodedPayload]
 */
export const blacklistToken = async (token, decodedPayload = null) => {
  if (!token) return;

  const payload = decodedPayload || decodeToken(token) || {};
  const jti = tokenId(token, payload);
  const expiresAtMs = expiryMs(payload);

  revokedCache.set(jti, expiresAtMs);
  notRevokedCache.delete(jti);

  if (!persistenceAvailable || !prisma?.revokedToken) return;

  try {
    await prisma.revokedToken.upsert({
      where: { jti },
      create: {
        jti,
        userId: payload.id || null,
        expiresAt: new Date(expiresAtMs),
      },
      update: { expiresAt: new Date(expiresAtMs) },
    });
  } catch (err) {
    handlePersistenceError(err);
  }
};

/**
 * Check if a token has been revoked.
 * @param {string} token
 * @param {object} [decodedPayload]
 * @returns {Promise<boolean>}
 */
export const isTokenBlacklisted = async (token, decodedPayload = null) => {
  if (!token) return false;

  const payload = decodedPayload || decodeToken(token);
  const jti = tokenId(token, payload);
  const now = Date.now();

  if (revokedCache.has(jti)) return true;

  const notRevokedUntil = notRevokedCache.get(jti);
  if (notRevokedUntil && notRevokedUntil > now) return false;

  if (!persistenceAvailable || !prisma?.revokedToken) return false;

  let revoked;
  try {
    revoked = await prisma.revokedToken.findUnique({
      where: { jti },
      select: { expiresAt: true },
    });
  } catch (err) {
    handlePersistenceError(err);
    // Fail closed: a revocation that cannot be checked is not assumed absent
    // (P2021 = table missing is handled above and degrades to memory only).
    if (err?.code !== 'P2021') throw err;
    return false;
  }

  if (revoked && revoked.expiresAt.getTime() > now) {
    revokedCache.set(jti, revoked.expiresAt.getTime());
    return true;
  }

  if (notRevokedCache.size >= MAX_NOT_REVOKED_ENTRIES) notRevokedCache.clear();
  notRevokedCache.set(jti, now + NOT_REVOKED_TTL_MS);
  return false;
};

/** Deletes expired revocation rows. Safe to call periodically. */
export const purgeExpiredRevokedTokens = async () => {
  if (!persistenceAvailable || !prisma?.revokedToken) return 0;
  try {
    const { count } = await prisma.revokedToken.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    return count;
  } catch (err) {
    handlePersistenceError(err);
    return 0;
  }
};
