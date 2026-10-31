import dotenv from "dotenv";
dotenv.config();

function requireSecret(name) {
  const value = process.env[name]?.trim();
  const minimumLength = process.env.NODE_ENV === "production" ? 32 : 24;
  if (!value || value.length < minimumLength) {
    throw new Error(
      `${name} must be explicitly configured with at least ${minimumLength} characters.`,
    );
  }
  return value;
}

export const JWT_SECRET = requireSecret("JWT_SECRET");
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1d"; // Short expiry (1 day)

export const OAUTH_STATE_SECRET = requireSecret("OAUTH_STATE_SECRET");
if (OAUTH_STATE_SECRET === JWT_SECRET) {
  throw new Error("OAUTH_STATE_SECRET must be different from JWT_SECRET.");
}
