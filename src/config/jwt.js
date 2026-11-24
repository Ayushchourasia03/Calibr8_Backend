import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();

const isProduction = process.env.NODE_ENV === "production";

/**
 * Signing secrets must be stable across restarts and identical on every
 * instance. In production a missing or short secret is a fatal
 * misconfiguration: refuse to start instead of silently using a random
 * per-process secret (which logs everyone out on each restart and makes
 * instances reject each other's tokens).
 */
function getSecret(name) {
  const value = process.env[name]?.trim();
  const minimumLength = isProduction ? 32 : 24;
  if (value && value.length >= minimumLength) {
    return value;
  }
  if (isProduction) {
    throw new Error(
      `[Security] ${name} must be set to at least ${minimumLength} characters in production.`,
    );
  }
  if (value) {
    console.warn(`[Security] ${name} is shorter than ${minimumLength} characters; using an ephemeral development secret.`);
  }
  return crypto.randomBytes(32).toString("hex");
}

export const JWT_SECRET = getSecret("JWT_SECRET");
export const JWT_ALGORITHM = "HS256";
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1d"; // Short expiry (1 day)

// Absolute session lifetime: /refresh never extends a session beyond this
// many days after the original login.
export const SESSION_MAX_AGE_DAYS = Math.max(1, Number(process.env.SESSION_MAX_AGE_DAYS) || 30);

export const OAUTH_STATE_SECRET = getSecret("OAUTH_STATE_SECRET");
if (OAUTH_STATE_SECRET === JWT_SECRET) {
  throw new Error("OAUTH_STATE_SECRET must be different from JWT_SECRET.");
}
