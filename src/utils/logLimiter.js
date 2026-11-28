// Bounded HTTP logging (SA-L9 / FV-4, round 2).
//
// Every rejected request used to write one morgan line plus one error-
// middleware line, with no limit, so a flood of cheap bad requests became a
// flood of log lines. Now:
//   - each category (4xx, 5xx) has a per-minute line budget
//     (LOG_HTTP_4XX_MAX_PER_MINUTE, LOG_HTTP_5XX_MAX_PER_MINUTE), checked
//     BEFORE any formatting, so dropped lines cost a counter increment;
//   - lines over the budget are counted and summarized once per minute per
//     category ("suppressed N lines"), so the volume stays visible;
//   - one rejected request is logged once (morgan), not twice;
//   - request-derived text is stripped of control characters and line
//     separators and length-capped (no log injection, no giant lines).
// Categories are a fixed set, so memory is constant. Security events
// (utils/securityLog.js) have their own per-type budget.
import { readLimit } from "../config/limits.js";

const CATEGORY_LIMIT = {
  "4xx": "LOG_HTTP_4XX_MAX_PER_MINUTE",
  "5xx": "LOG_HTTP_5XX_MAX_PER_MINUTE",
};
const WINDOW_MS = 60_000;

let sink = (line) => console.warn(line);
let httpSink = (line) => process.stdout.write(line);

/** Stream for the request log (morgan); replaceable in tests. */
export const httpLogStream = { write: (line) => httpSink(line) };
const state = new Map(); // category -> { windowStart, emitted, suppressed }

function flush(category, s, now) {
  if (s.suppressed > 0) {
    sink(`[log] suppressed ${s.suppressed} ${category} request log lines in the last ${Math.round((now - s.windowStart) / 1000)} s`);
  }
  s.windowStart = now;
  s.emitted = 0;
  s.suppressed = 0;
}

/** True when a line of `category` may be written now; otherwise it is counted. */
export function allowLogLine(category, now = Date.now()) {
  const limitName = CATEGORY_LIMIT[category];
  if (!limitName) return true;
  let s = state.get(category);
  if (!s) {
    s = { windowStart: now, emitted: 0, suppressed: 0 };
    state.set(category, s);
  }
  if (now - s.windowStart >= WINDOW_MS) flush(category, s, now);
  if (s.emitted < readLimit(limitName)) {
    s.emitted++;
    return true;
  }
  s.suppressed++;
  return false;
}

/** Category of an HTTP status, or null when it is not logged. */
export const statusCategory = (status) => (status >= 500 ? "5xx" : status >= 400 ? "4xx" : null);

// Summaries are also written when traffic stops (no later request would flush them).
const timer = setInterval(() => {
  const now = Date.now();
  for (const [category, s] of state) {
    if (s.suppressed > 0 && now - s.windowStart >= WINDOW_MS) flush(category, s, now);
  }
}, WINDOW_MS);
timer.unref?.();

// Control characters, C1 controls and the Unicode line/paragraph separators
// (built from code points: a raw separator would end a regex literal).
const UNSAFE_LOG_CHARS = new RegExp(`[\u0000-\u001f\u007f-\u009f${String.fromCharCode(0x2028, 0x2029)}]`, "g");

/**
 * Request-derived text safe for a single log line: control characters and
 * Unicode line separators replaced, at most `max` characters.
 */
export function sanitizeLogText(value, max = 200) {
  const text = String(value ?? "");
  const clean = text.replace(UNSAFE_LOG_CHARS, "?");
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

/** Test hooks. */
export function __setLogSinkForTests(fn) {
  sink = fn || ((line) => console.warn(line));
}
export function __setHttpLogSinkForTests(fn) {
  httpSink = fn || ((line) => process.stdout.write(line));
}
export function __resetLogLimiterForTests() {
  state.clear();
}
export function __flushLogLimiterForTests(now = Date.now() + WINDOW_MS) {
  for (const [category, s] of state) flush(category, s, now);
}
