import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, JWT_EXPIRES_IN } from '../config/jwt.js';

/**
 * Sign a JWT containing the given payload with an automatic unique jti.
 * @param {{ id: string, [key: string]: any }} payload
 * @param {string} [expiresIn]
 * @returns {string}
 */
export const signToken = (payload, expiresIn = JWT_EXPIRES_IN) => {
  const jti = payload.jti || crypto.randomUUID();
  return jwt.sign({ ...payload, jti }, JWT_SECRET, { expiresIn });
};

/**
 * Verify and decode a JWT.
 * @param {string} token
 * @returns {object} decoded payload with jti, id, iat, exp
 * @throws {JsonWebTokenError | TokenExpiredError}
 */
export const verifyToken = (token) => jwt.verify(token, JWT_SECRET);

/**
 * Decode token without verification (useful for inspecting exp/jti on expired/revoking tokens).
 * @param {string} token
 * @returns {object|null}
 */
export const decodeToken = (token) => jwt.decode(token);
