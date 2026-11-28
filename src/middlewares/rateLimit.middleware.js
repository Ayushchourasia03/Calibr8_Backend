import crypto from "crypto";
import { ApiError } from "../utils/ApiError.js";
import { clientIpKey } from "../utils/clientIp.js";
import { readLimit } from "../config/limits.js";
import { securityEvent } from "../utils/securityLog.js";
import { verifyToken } from "../utils/jwt.js";

// NOTE: counters live in this process. With several backend instances each
// instance enforces its own budget, so put an edge/WAF rate limit in front of
// the API as well (see BACKEND_PRODUCTION_AUDIT.md, M3).

const MAX_TRACKED_KEYS = 100_000;

/**
 * Creates an in-memory fixed-window rate limiter middleware.
 * @param {object} options
 * @param {number} options.windowMs - Window time in milliseconds
 * @param {number} options.max - Maximum requests allowed per window
 * @param {function} options.keyGenerator - Generates a key for grouping (e.g. IP or userId)
 * @param {string} [options.message] - Custom message on rate limit exceed
 * @param {string} [options.code] - Custom error code
 */
export function createRateLimiter(options) {
  const {
    windowMs = 60 * 1000,
    max = 60,
    keyGenerator = (req) => clientIpKey(req),
    message = "Too many requests. Please wait a moment before trying again.",
    code = "RATE_LIMITED",
    name = "rate_limit",
  } = options;

  const hits = new Map();

  // Periodic cleanup of stale entries
  setInterval(
    () => {
      const now = Date.now();
      for (const [key, record] of hits.entries()) {
        if (now > record.resetTime) {
          hits.delete(key);
        }
      }
    },
    Math.min(windowMs, 60000),
  ).unref?.();

  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
    let record = hits.get(key);

    if (!record || now > record.resetTime) {
      // Bound memory when flooded with distinct keys: evict the oldest.
      if (!record && hits.size >= MAX_TRACKED_KEYS) {
        hits.delete(hits.keys().next().value);
      }
      record = {
        count: 1,
        resetTime: now + windowMs,
      };
      hits.set(key, record);
    } else {
      record.count += 1;
    }

    const remaining = Math.max(0, max - record.count);
    const resetSeconds = Math.ceil((record.resetTime - now) / 1000);

    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetSeconds);

    if (record.count > max) {
      res.setHeader("Retry-After", resetSeconds);
      if (record.count === max + 1) securityEvent("rate_limited", { limiter: name, req });
      return next(
        new ApiError(429, message, code, { retryAfterSeconds: resetSeconds }),
      );
    }

    next();
  };
}

/**
 * Per-IP rate limiter for auth endpoints (register, login)
 * 30 attempts per 15 minutes per IP (IPv6: per /64).
 */
export const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `auth:${clientIpKey(req)}`,
  message:
    "Too many login or registration attempts. Please try again in a few minutes.",
  code: "AUTH_RATE_LIMITED",
  name: "auth",
});

/**
 * Account creation per IP (IPv6: per /64), on top of authLimiter (SA-M4):
 * slows down bulk creation of throwaway accounts, each of which would bring
 * its own per-user execution budget.
 */
export const registerLimiter = createRateLimiter({
  windowMs: readLimit("REGISTER_RATE_LIMIT_WINDOW_MS"),
  max: readLimit("REGISTER_RATE_LIMIT_MAX"),
  keyGenerator: (req) => `register:${clientIpKey(req)}`,
  message: "Too many accounts were created from this network. Please try again later.",
  code: "REGISTER_RATE_LIMITED",
  name: "register",
});

/**
 * Generous per-IP ceiling for every /api request (SA-M6). Endpoints with
 * their own, stricter limiter keep it; this one bounds what a single client
 * can make the database do through public, otherwise unthrottled reads.
 */
const unauthenticatedApiLimiter = createRateLimiter({
  windowMs: readLimit("API_RATE_LIMIT_WINDOW_MS"),
  max: readLimit("API_RATE_LIMIT_MAX"),
  keyGenerator: (req) => `api:${clientIpKey(req)}`,
  name: "api",
});
const userApiLimiter = createRateLimiter({
  windowMs: readLimit("API_RATE_LIMIT_WINDOW_MS"),
  max: readLimit("API_USER_RATE_LIMIT_MAX"),
  keyGenerator: (req) => `apiuser:${req.rateLimitUserId}`,
  name: "api_user",
});
const authenticatedIpApiLimiter = createRateLimiter({
  windowMs: readLimit("API_RATE_LIMIT_WINDOW_MS"),
  max: readLimit("API_AUTHENTICATED_IP_RATE_LIMIT_MAX"),
  keyGenerator: (req) => `apiip:${clientIpKey(req)}`,
  name: "api_ip_authenticated",
});

/** User id of a validly signed, unexpired session token on the request, else null (no database). */
function signedSessionUserId(req) {
  const header = req.headers?.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 4096) return null;
  try {
    const decoded = verifyToken(header.slice(7).trim());
    return typeof decoded?.id === "string" && decoded.id.length <= 64 ? decoded.id : null;
  } catch {
    return null;
  }
}

/**
 * Ceiling for every /api request (SA-M6), identity-aware since round 2
 * (FV-5). Requests with a validly signed session token are budgeted per user
 * (API_USER_RATE_LIMIT_MAX), with a high per-IP safety ceiling
 * (API_AUTHENTICATED_IP_RATE_LIMIT_MAX), so students behind one campus NAT
 * no longer share one bucket. Everything else keeps the per-IP budget
 * (API_RATE_LIMIT_MAX). A forged token cannot pick a bucket: the signature
 * is checked (HMAC only; revocation is checked later by protect).
 */
export function apiLimiter(req, res, next) {
  const userId = signedSessionUserId(req);
  if (!userId) return unauthenticatedApiLimiter(req, res, next);
  req.rateLimitUserId = userId;
  return authenticatedIpApiLimiter(req, res, (err) => (err ? next(err) : userApiLimiter(req, res, next)));
}

/**
 * Submission-status polling per user (round 2). Its own budget, so polling
 * cannot use up the global one and a stuck client cannot poll without bound.
 */
export const pollLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: readLimit("POLL_RATE_LIMIT_MAX"),
  keyGenerator: (req) => `poll:${req.user?.id || clientIpKey(req)}`,
  message: "You are checking submission status too often. Please slow down.",
  name: "poll",
});

/** Readiness probes per IP (SA-M6 round 2); load balancers probe a few times a minute. */
export const healthLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: readLimit("HEALTH_RATE_LIMIT_MAX"),
  keyGenerator: (req) => `health:${clientIpKey(req)}`,
  name: "health",
});

/** OAuth callback (unauthenticated, makes outbound GitHub calls) per IP (SA-L6). */
export const oauthCallbackLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: readLimit("OAUTH_CALLBACK_RATE_LIMIT_MAX"),
  keyGenerator: (req) => `oauth-callback:${clientIpKey(req)}`,
  name: "oauth_callback",
});

/**
 * Per-(account, IP) login throttle: stops online brute-force / stuffing from
 * an attacker IP without allowing a third party to lock out a victim's real IP.
 */
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_MAX = 10;
const loginFailures = new Map(); // `${email}|${ipKey}` -> { count, resetTime }
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of loginFailures) if (now > record.resetTime) loginFailures.delete(key);
}, 60_000).unref?.();

// Fixed-size key per account (SA-M1): the raw email is attacker-sized input
// and used to be kept in this map for 15 minutes per failed attempt.
function accountKey(email) {
  return crypto.createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("base64url").slice(0, 22);
}

function loginThrottleKey(email, ipKey = "default") {
  return `${accountKey(email)}|${String(ipKey || "default").slice(0, 64)}`;
}

export function assertLoginAllowed(email, ipKey = "default") {
  const record = loginFailures.get(loginThrottleKey(email, ipKey));
  if (record && Date.now() <= record.resetTime && record.count >= LOGIN_FAILURE_MAX) {
    const retryAfterSeconds = Math.ceil((record.resetTime - Date.now()) / 1000);
    securityEvent("login_locked", { account: accountKey(email), ip: ipKey });
    throw new ApiError(
      429,
      "Too many failed login attempts for this account. Please try again later.",
      "ACCOUNT_LOGIN_LOCKED",
      { retryAfterSeconds },
    );
  }
}

export function recordFailedLogin(email, ipKey = "default") {
  const key = loginThrottleKey(email, ipKey);
  const now = Date.now();
  let record = loginFailures.get(key);
  if (!record || now > record.resetTime) {
    if (!record && loginFailures.size >= MAX_TRACKED_KEYS) {
      loginFailures.delete(loginFailures.keys().next().value);
    }
    record = { count: 0, resetTime: now + LOGIN_FAILURE_WINDOW_MS };
    loginFailures.set(key, record);
  }
  record.count += 1;
}

export function clearFailedLogins(email, ipKey = null) {
  if (ipKey) {
    loginFailures.delete(loginThrottleKey(email, ipKey));
    return;
  }
  const prefix = `${accountKey(email)}|`;
  for (const key of loginFailures.keys()) {
    if (key.startsWith(prefix)) loginFailures.delete(key);
  }
}

/**
 * Per-user limiter for token refresh and other session endpoints.
 */
export const sessionLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => `session:${req.user?.id || clientIpKey(req)}`,
  message: "Too many session requests. Please try again in a few minutes.",
  code: "RATE_LIMITED",
});

/**
 * Per-user rate limiter for Run executions.
 * Max 10 runs per minute per user (as specified in PRD section 6).
 */
export const runLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => `run:${req.user?.id || clientIpKey(req)}`,
  message:
    "Run rate limit exceeded. You can perform at most 10 runs per minute.",
  code: "RATE_LIMITED",
});

/**
 * Per-user rate limiter for Submit executions.
 * Max 6 submissions per minute per user (as specified in PRD section 6).
 */
export const submitLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 6,
  keyGenerator: (req) => `submit:${req.user?.id || clientIpKey(req)}`,
  message:
    "Submission rate limit exceeded. You can submit at most 6 times per minute.",
  code: "RATE_LIMITED",
});

/**
 * Per-user limiter for standalone complexity analysis (runs in a worker pool
 * with a hard timeout, so it is cheaper than a judged run).
 */
export const analyzeLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => `analyze:${req.user?.id || clientIpKey(req)}`,
  message: "Analysis rate limit exceeded. Please wait a moment.",
  code: "RATE_LIMITED",
});

// Track concurrent in-flight jobs per user (cap at 2 in flight)
const activeJobsPerUser = new Map();

/**
 * Enforces maximum 2 jobs in flight per user.
 */
export const inFlightLimiter = (req, res, next) => {
  const identity = req.user?.id
    ? `user:${req.user.id}`
    : `ip:${clientIpKey(req)}`;

  const currentCount = activeJobsPerUser.get(identity) || 0;
  if (currentCount >= 2) {
    return next(
      new ApiError(
        429,
        "Maximum 2 code execution jobs in flight simultaneously.",
        "RATE_LIMITED",
      ),
    );
  }

  activeJobsPerUser.set(identity, currentCount + 1);

  const release = () => {
    const cnt = activeJobsPerUser.get(identity) || 1;
    if (cnt <= 1) {
      activeJobsPerUser.delete(identity);
    } else {
      activeJobsPerUser.set(identity, cnt - 1);
    }
  };

  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };

  let releaseWhenResponseCloses = true;
  req.holdInFlightSlot = () => {
    releaseWhenResponseCloses = false;
    return releaseOnce;
  };

  const releaseIfResponseOwned = () => {
    if (releaseWhenResponseCloses) releaseOnce();
  };
  res.once("finish", releaseIfResponseOwned);
  res.once("close", releaseIfResponseOwned);
  next();
};
