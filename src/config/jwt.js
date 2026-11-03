import dotenv from "dotenv";
dotenv.config();

function getSecret(name, fallback) {
  const value = process.env[name]?.trim();
  const minimumLength = process.env.NODE_ENV === "production" ? 32 : 24;
  if (value && value.length >= minimumLength) {
    return value;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `${name} must be explicitly configured with at least ${minimumLength} characters.`,
    );
  }
  return fallback;
}

export const JWT_SECRET = getSecret(
  "JWT_SECRET",
  "calibr8_dev_jwt_secret_token_key_safe_fallback_string_32_chars",
);
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1d"; // Short expiry (1 day)

export const OAUTH_STATE_SECRET = getSecret(
  "OAUTH_STATE_SECRET",
  "calibr8_dev_oauth_state_secret_distinct_fallback_string_32_chars",
);
if (OAUTH_STATE_SECRET === JWT_SECRET) {
  throw new Error("OAUTH_STATE_SECRET must be different from JWT_SECRET.");
}

