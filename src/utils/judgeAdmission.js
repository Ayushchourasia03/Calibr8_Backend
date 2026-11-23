import { ApiError } from "./ApiError.js";

// Backend-wide admission control in front of CodeBox. CodeBox is a single
// shared VPS with one request budget for the whole backend, so per-user
// limits alone cannot stop a handful of users from exhausting it. At most
// JUDGE_MAX_CONCURRENT judge jobs (runs/submissions) execute at once per
// backend instance; further jobs wait in a bounded queue and are rejected
// with 503 JUDGE_BUSY when it is full or the wait is too long.

const config = () => ({
  maxConcurrent: Math.max(1, Number(process.env.JUDGE_MAX_CONCURRENT) || 4),
  maxQueue: Math.max(0, Number(process.env.JUDGE_MAX_QUEUE) || 20),
  queueTimeoutMs: Math.max(1000, Number(process.env.JUDGE_QUEUE_TIMEOUT_MS) || 30_000),
});

let active = 0;
const waiting = []; // { resolve, reject, timer }

function busyError() {
  return new ApiError(
    503,
    "The judge is busy right now. Please try again in a few seconds.",
    "JUDGE_BUSY",
    { retryAfterSeconds: 5 },
  );
}

function makeRelease() {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(makeRelease()); // hand the slot over directly
    } else {
      active = Math.max(0, active - 1);
    }
  };
}

/**
 * Waits for a judge slot. Resolves to a release function that must be called
 * exactly once when the job finishes (extra calls are ignored).
 */
export function acquireJudgeSlot() {
  const { maxConcurrent, maxQueue, queueTimeoutMs } = config();
  if (active < maxConcurrent) {
    active++;
    return Promise.resolve(makeRelease());
  }
  if (waiting.length >= maxQueue) return Promise.reject(busyError());
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      const index = waiting.indexOf(entry);
      if (index >= 0) waiting.splice(index, 1);
      reject(busyError());
    }, queueTimeoutMs);
    entry.timer.unref?.();
    waiting.push(entry);
  });
}

export function judgeAdmissionStats() {
  return { active, queued: waiting.length, ...config() };
}

/** Test hook. */
export function __resetJudgeAdmissionForTests() {
  for (const entry of waiting.splice(0)) clearTimeout(entry.timer);
  active = 0;
}
