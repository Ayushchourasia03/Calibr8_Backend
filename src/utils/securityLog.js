// src/utils/securityLog.js
//
// Structured security events (SA-L9): one JSON line per event on stderr, e.g.
//   {"ts":"…","security":"login_failed","account":"<hash>","ip":"203.0.113.7","requestId":"…"}
//
// Never logged: passwords, tokens, Authorization headers, emails (accounts are
// identified by a truncated SHA-256 of the normalized email), request bodies,
// submitted code. String fields are truncated.
//
// Flood control: at most SECURITY_LOG_MAX_PER_MINUTE lines per event type per
// minute; the rest are counted and reported as one "log_suppressed" line, so
// an attacker cannot use failed logins to flood the logs.
import { clientIpKey } from "./clientIp.js";

const WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_MINUTE = 60;
const buckets = new Map(); // type -> { windowStart, count, suppressed }

function maxPerMinute() {
  const value = Number(process.env.SECURITY_LOG_MAX_PER_MINUTE);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_PER_MINUTE;
}

let sink = (line) => console.warn(line);

// Field names that are never logged, whatever a caller passes.
const FORBIDDEN_FIELD = /pass|token|secret|authorization|cookie|email|code|body|stdin/i;

function clean(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || FORBIDDEN_FIELD.test(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") out[key] = value.slice(0, 200);
  }
  return out;
}

/**
 * Records a security event.
 * @param {string} type e.g. login_failed, login_locked, rate_limited, token_rejected
 * @param {object} [fields] primitive fields only; `req` adds requestId, ip, path, userId
 */
export function securityEvent(type, { req, ...fields } = {}) {
  const now = Date.now();
  let bucket = buckets.get(type);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    if (bucket?.suppressed) {
      sink(JSON.stringify({ ts: new Date(now).toISOString(), security: "log_suppressed", event: type, count: bucket.suppressed }));
    }
    bucket = { windowStart: now, count: 0, suppressed: 0 };
    buckets.set(type, bucket);
  }
  bucket.count += 1;
  if (bucket.count > maxPerMinute()) {
    bucket.suppressed += 1;
    return;
  }
  const entry = { ts: new Date(now).toISOString(), security: type, ...clean(fields) };
  if (req) {
    Object.assign(
      entry,
      clean({ requestId: req.id, ip: clientIpKey(req), method: req.method, path: req.path, userId: req.user?.id }),
    );
  }
  sink(JSON.stringify(entry));
}

/** Test hook: capture lines instead of printing them. Returns a restore function. */
export function __captureSecurityLog(capture) {
  const previous = sink;
  sink = capture;
  buckets.clear();
  return () => {
    sink = previous;
    buckets.clear();
  };
}
