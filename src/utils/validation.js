import { ApiError } from "./ApiError.js";

// Length limits for user-editable text. Profile fields are shown publicly on
// the leaderboard, so they must stay short.
export const FIELD_LIMITS = Object.freeze({
  email: 254,
  name: 60,
  college: 120,
  branch: 80,
  batch: 20,
  state: 60,
  country: 60,
});

// C0/C1 control characters and bidi overrides (except tab/newline handling
// below): never meaningful in names and usable for spoofing.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;

/** Trims, normalizes Unicode and strips control characters from a text field. */
export function cleanText(value) {
  return String(value).normalize("NFC").replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/**
 * Validates a required string field.
 * @returns {string} the cleaned value
 */
export function requireText(value, field, { max = FIELD_LIMITS[field] ?? 200, min = 1, code = "VALIDATION_ERROR" } = {}) {
  if (typeof value !== "string") {
    throw new ApiError(400, `${field} must be a string.`, code, { field });
  }
  const cleaned = cleanText(value);
  if (cleaned.length < min) {
    throw new ApiError(400, `${field} cannot be empty.`, code, { field });
  }
  if (cleaned.length > max) {
    throw new ApiError(400, `${field} must be at most ${max} characters.`, code, { field, max });
  }
  return cleaned;
}

/**
 * Validates an optional string field. `undefined` means "not provided";
 * null or "" clear the field (returns "").
 */
export function optionalText(value, field, { max = FIELD_LIMITS[field] ?? 200 } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return "";
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ApiError(400, `${field} must be a string.`, "VALIDATION_ERROR", { field });
  }
  const cleaned = cleanText(value);
  if (cleaned.length > max) {
    throw new ApiError(400, `${field} must be at most ${max} characters.`, "VALIDATION_ERROR", { field, max });
  }
  return cleaned;
}

/** Normalizes an email address and validates its shape and length. */
export function requireEmail(value, code = "INVALID_EMAIL") {
  if (typeof value !== "string") {
    throw new ApiError(400, "Please provide a valid email address.", code);
  }
  const email = value.trim().toLowerCase();
  if (email.length > FIELD_LIMITS.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "Please provide a valid email address.", code);
  }
  return email;
}

/** Returns a single string query parameter (first value if repeated), or undefined. */
export function queryString(value, { max = 200 } = {}) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return undefined;
  return raw.length > max ? raw.slice(0, max) : raw;
}
