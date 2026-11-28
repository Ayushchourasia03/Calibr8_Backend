import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, JWT_EXPIRES_IN, JWT_ALGORITHM, SESSION_MAX_AGE_DAYS } from '../config/jwt.js';
import { ApiError } from './ApiError.js';

/**
 * Issues a session token for a user.
 *
 * Claims: id, tv (the user's tokenVersion: bumping it revokes every token,
 * e.g. on password change or "log out everywhere"), auth_time (original
 * login, carried over by /refresh to bound the session lifetime) and a
 * unique jti (per-token revocation on logout). No PII (email) in the token.
 *
 * @param {{ id: string, tokenVersion?: number }} user
 * @param {{ authTime?: number, expiresIn?: string }} [options]
 * @returns {string}
 */
const JWT_ISSUER = "calibr8";
const JWT_AUDIENCE = "calibr8-api";

export const signSessionToken = (user, { authTime, expiresIn = JWT_EXPIRES_IN } = {}) =>
  jwt.sign(
    {
      id: user.id,
      tv: Number(user.tokenVersion) || 0,
      auth_time: authTime ?? Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
    },
    JWT_SECRET,
    {
      expiresIn,
      algorithm: JWT_ALGORITHM,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    },
  );

/**
 * Verify and decode a JWT (HS256 only).
 * @param {string} token
 * @returns {object} decoded payload with jti, id, tv, auth_time, iat, exp
 * @throws {JsonWebTokenError | TokenExpiredError}
 */
export const verifyToken = (token) => {
  const decoded = jwt.verify(token, JWT_SECRET, {
    algorithms: [JWT_ALGORITHM],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
  // Every session token is issued with an expiry; one without is never valid
  // (FV-7: jsonwebtoken only checks exp when it is present).
  if (typeof decoded?.exp !== "number") {
    throw new jwt.JsonWebTokenError("jwt exp claim required");
  }
  return decoded;
};

/**
 * Decode token without verification (useful for inspecting exp/jti on expired/revoking tokens).
 * @param {string} token
 * @returns {object|null}
 */
export const decodeToken = (token) => jwt.decode(token);

/** Original login time of a verified token (seconds). Legacy tokens: iat. */
export const tokenAuthTime = (decoded) => Number(decoded?.auth_time) || Number(decoded?.iat) || 0;

/** Throws 401 SESSION_EXPIRED when the session is older than SESSION_MAX_AGE_DAYS. */
export function assertSessionWithinMaxAge(decoded, nowMs = Date.now()) {
  const authTime = tokenAuthTime(decoded);
  if (!authTime || nowMs / 1000 - authTime > SESSION_MAX_AGE_DAYS * 86400) {
    throw new ApiError(401, 'Your session has expired. Please log in again.', 'SESSION_EXPIRED');
  }
  return authTime;
}
