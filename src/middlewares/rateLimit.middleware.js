import { ApiError } from '../utils/ApiError.js';

/**
 * Creates an in-memory sliding window rate limiter middleware.
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
    keyGenerator = (req) => req.ip || req.connection.remoteAddress || 'unknown',
    message = 'Too many requests. Please wait a moment before trying again.',
    code = 'RATE_LIMITED',
  } = options;

  const hits = new Map();

  // Periodic cleanup of stale entries every 60 seconds
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of hits.entries()) {
      if (now > record.resetTime) {
        hits.delete(key);
      }
    }
  }, Math.min(windowMs, 60000)).unref?.();

  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
    let record = hits.get(key);

    if (!record || now > record.resetTime) {
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

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', resetSeconds);

    if (record.count > max) {
      res.setHeader('Retry-After', resetSeconds);
      return next(new ApiError(429, message, code, { retryAfterSeconds: resetSeconds }));
    }

    next();
  };
}

/**
 * Per-IP rate limiter for auth endpoints (register, login)
 * 30 attempts per 15 minutes per IP.
 */
export const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `auth:${req.ip || 'ip'}`,
  message: 'Too many login or registration attempts. Please try again in a few minutes.',
  code: 'AUTH_RATE_LIMITED',
});

/**
 * Per-user rate limiter for Run executions.
 * Max 10 runs per minute per user (as specified in PRD section 6).
 */
export const runLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => `run:${req.user?.id || req.ip}`,
  message: 'Run rate limit exceeded. You can perform at most 10 runs per minute.',
  code: 'RATE_LIMITED',
});

/**
 * Per-user rate limiter for Submit executions.
 * Max 6 submissions per minute per user (as specified in PRD section 6).
 */
export const submitLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 6,
  keyGenerator: (req) => `submit:${req.user?.id || req.ip}`,
  message: 'Submission rate limit exceeded. You can submit at most 6 times per minute.',
  code: 'RATE_LIMITED',
});

// Track concurrent in-flight jobs per user (cap at 2 in flight)
const activeJobsPerUser = new Map();

/**
 * Enforces maximum 2 jobs in flight per user.
 */
export const inFlightLimiter = (req, res, next) => {
  const userId = req.user?.id;
  if (!userId) return next();

  const currentCount = activeJobsPerUser.get(userId) || 0;
  if (currentCount >= 2) {
    return next(new ApiError(429, 'Maximum 2 code execution jobs in flight simultaneously.', 'RATE_LIMITED'));
  }

  activeJobsPerUser.set(userId, currentCount + 1);

  const release = () => {
    const cnt = activeJobsPerUser.get(userId) || 1;
    if (cnt <= 1) {
      activeJobsPerUser.delete(userId);
    } else {
      activeJobsPerUser.set(userId, cnt - 1);
    }
  };

  res.on('finish', release);
  res.on('close', release);
  next();
};
