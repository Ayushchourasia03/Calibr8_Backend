// Readiness probe (SA-M6 / FV-3, round 2).
//
// /health/ready used to run a database query for every request, with no
// limit. Now one check runs at a time (single flight) and its result is
// reused for READINESS_CACHE_MS, so a flood of probes makes at most one query
// per interval, whatever the request rate. The cache never hides an outage
// for long: a failing database is reported within READINESS_CACHE_MS plus
// the check timeout, and a failed check is cached exactly like a good one
// (an outage cannot be turned into a query storm either). Liveness (/health)
// stays dependency-free.
import { readLimit } from "../config/limits.js";

/**
 * @param {{ checkDatabase: () => Promise<unknown>, checkCodebox: () => Promise<boolean|null>,
 *           timeoutMs?: number, now?: () => number }} deps
 * @returns {() => Promise<{ ready: boolean, checks: { database: boolean, codebox: boolean|null }, checkedAt: number }>}
 */
export function createReadinessProbe({ checkDatabase, checkCodebox, timeoutMs = 2000, now = Date.now }) {
  let cached = null;
  let inflight = null;

  const withTimeout = (promise) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs).unref?.()),
    ]);

  const runCheck = async () => {
    const [database, codebox] = await Promise.all([
      withTimeout(Promise.resolve().then(checkDatabase)).then(() => true, () => false),
      Promise.resolve().then(checkCodebox).catch(() => false),
    ]);
    const value = { ready: database && codebox !== false, checks: { database, codebox }, checkedAt: now() };
    cached = value;
    return value;
  };

  return function probe() {
    if (cached && now() - cached.checkedAt < readLimit("READINESS_CACHE_MS")) return Promise.resolve(cached);
    if (!inflight) inflight = runCheck().finally(() => { inflight = null; });
    return inflight;
  };
}
