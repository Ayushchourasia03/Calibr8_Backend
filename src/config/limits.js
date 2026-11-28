// src/config/limits.js
//
// Central, validated tunables for the security and resource controls added in
// the 2026-11 remediation (SECURITY_REMEDIATION.md). Each value is read from
// the environment on use (tests and operators can change it without a
// restart), falls back to its default when unset, and is validated at startup
// by validateLimits() (src/config/validateEnv.js): an out-of-range value is a
// startup error in production and a warning elsewhere, and never silently
// takes effect.

const LIMITS = {
  // Judge scheduler (src/utils/judgeAdmission.js), per backend instance.
  // Round 2: a slot is ONE CodeBox request (a chunk of testcases), not a whole
  // evaluation, so long evaluations cannot hold capacity; waiting requests are
  // served lightest-user-first (recent sandbox time).
  JUDGE_MAX_CONCURRENT: { default: 4, min: 1, max: 256 },
  JUDGE_MAX_QUEUE: { default: 40, min: 0, max: 10_000 },
  // Longest wait for a session's FIRST slot (then 503 JUDGE_BUSY).
  JUDGE_QUEUE_TIMEOUT_MS: { default: 30_000, min: 1_000, max: 600_000 },
  // Longest wait for each later slot of an admitted session.
  JUDGE_CONTINUATION_TIMEOUT_MS: { default: 300_000, min: 5_000, max: 3_600_000 },
  // Concurrent CodeBox requests and queued requests per user.
  JUDGE_MAX_ACTIVE_PER_USER: { default: 2, min: 1, max: 64 },
  JUDGE_MAX_QUEUED_PER_USER: { default: 2, min: 0, max: 64 },
  // Concurrent judge sessions (one Run or Submit each) per user (429 JUDGE_USER_BUSY).
  JUDGE_MAX_SESSIONS_PER_USER: { default: 2, min: 1, max: 64 },
  // Half-life of the recent-usage score that orders waiting users.
  JUDGE_COST_HALF_LIFE_MS: { default: 600_000, min: 1_000, max: 86_400_000 },
  // Sandbox time a user may use per window on this instance (429 EXECUTION_BUDGET_EXHAUSTED);
  // CodeBox enforces its own per-user budget across all instances (TENANT_BUDGET_MS).
  JUDGE_USER_BUDGET_MS: { default: 900_000, min: 1_000, max: 86_400_000 },
  JUDGE_USER_BUDGET_WINDOW_MS: { default: 3_600_000, min: 60_000, max: 86_400_000 },
  // Accounts younger than this: smaller budget, and their usage weighs more
  // when ordering waiting users (account farming, SA-M4).
  JUDGE_NEW_ACCOUNT_AGE_MS: { default: 86_400_000, min: 0, max: 90 * 86_400_000 },
  JUDGE_NEW_ACCOUNT_BUDGET_MS: { default: 300_000, min: 1_000, max: 86_400_000 },
  JUDGE_NEW_ACCOUNT_COST_WEIGHT: { default: 2, min: 1, max: 100 },
  // Cross-instance cap on a user's PROCESSING submissions (database count).
  JUDGE_MAX_PROCESSING_PER_USER: { default: 2, min: 1, max: 64 },
  // Judging cost controls (src/controllers/execution.controller.js). Costs
  // are sandbox time per case = max(CPU, wall), so sleeping code is counted.
  // Name kept for compatibility: it is no longer CPU-only (round 2, FV-1).
  JUDGE_POST_FAILURE_CPU_BUDGET_MS: { default: 10_000, min: 0, max: 3_600_000 },
  // Total sandbox time one evaluation (all tiers of a Submit, or a Run) may
  // use; beyond it the rest is not run and the verdict is Time Limit Exceeded.
  JUDGE_EVALUATION_BUDGET_MS: { default: 120_000, min: 1_000, max: 3_600_000 },
  // Target duration of one CodeBox request; chunks shrink for slow code.
  JUDGE_TARGET_CHUNK_MS: { default: 8_000, min: 500, max: 600_000 },
  // A session's first CodeBox request (its cost is still unknown) asks
  // CodeBox to start no testcase after this long; skipped cases are re-run in
  // the next request. Keeps fresh accounts' blind requests short (round 2).
  JUDGE_BLIND_REQUEST_MAX_MS: { default: 2_000, min: 500, max: 600_000 },
  // First request of a large tier: its per-case cost is still unknown, so it
  // is kept small (round 2: 2 cases bound a sleeper's blind first request).
  JUDGE_FIRST_CHUNK_CASES: { default: 2, min: 1, max: 200 },
  // Largest problem (cases x time limit) judged as ONE request. Kept at 30 s:
  // lowering it moves mid-size problems to the per-tier path, whose
  // passedCount after a TLE differs (verdict compatibility, round 2). Bounds
  // the longest single request (and slot hold) at about cases x wall / 2.
  JUDGE_ONE_SHOT_MAX_COST_MS: { default: 30_000, min: 0, max: 3_600_000 },
  JUDGE_MAX_OUTPUT_CHARS: { default: 65_536, min: 1_024, max: 64 * 1024 * 1024 },
  // CodeBox client.
  CODEBOX_MAX_RESPONSE_BYTES: { default: 32 * 1024 * 1024, min: 64 * 1024, max: 512 * 1024 * 1024 },
  // Password hashing worker pool (src/services/passwordPool.js).
  PASSWORD_HASH_WORKERS: { default: 2, min: 1, max: 32 },
  PASSWORD_HASH_MAX_QUEUE: { default: 64, min: 0, max: 10_000 },
  PASSWORD_HASH_TIMEOUT_MS: { default: 10_000, min: 1_000, max: 120_000 },
  // Request limits (src/app.js, src/middlewares/rateLimit.middleware.js).
  API_RATE_LIMIT_WINDOW_MS: { default: 60_000, min: 1_000, max: 3_600_000 },
  // Per client IP (IPv6: per /64). Many users can share one IP (campus NAT),
  // so these are ceilings against single-source floods, not per-user quotas.
  API_RATE_LIMIT_MAX: { default: 1200, min: 10, max: 1_000_000 },
  // Round 2 (FV-5): requests with a validly signed session token are budgeted
  // per user, not per IP, so many students behind one NAT do not share 1200.
  API_USER_RATE_LIMIT_MAX: { default: 900, min: 10, max: 1_000_000 },
  // Safety ceiling for signed-token traffic from one IP (one machine with many accounts).
  API_AUTHENTICATED_IP_RATE_LIMIT_MAX: { default: 30_000, min: 100, max: 10_000_000 },
  // Submission-status polling per user (GET .../submissions/:id).
  POLL_RATE_LIMIT_MAX: { default: 240, min: 10, max: 100_000 },
  // Readiness probe (src/utils/readiness.js): results reused for this long,
  // and requests per IP per minute.
  READINESS_CACHE_MS: { default: 5_000, min: 250, max: 60_000 },
  HEALTH_RATE_LIMIT_MAX: { default: 120, min: 1, max: 1_000_000 },
  // HTTP log lines (src/utils/logLimiter.js) per category per minute; the
  // rest is counted and summarized once a minute.
  LOG_HTTP_4XX_MAX_PER_MINUTE: { default: 120, min: 0, max: 1_000_000 },
  LOG_HTTP_5XX_MAX_PER_MINUTE: { default: 600, min: 1, max: 1_000_000 },
  REGISTER_RATE_LIMIT_MAX: { default: 30, min: 1, max: 10_000 },
  REGISTER_RATE_LIMIT_WINDOW_MS: { default: 60 * 60 * 1000, min: 60_000, max: 7 * 24 * 3600 * 1000 },
  OAUTH_CALLBACK_RATE_LIMIT_MAX: { default: 20, min: 1, max: 10_000 },
  REQUEST_TIMEOUT_MS: { default: 120_000, min: 5_000, max: 3_600_000 },
  // Static analyzer worker heap cap (src/services/complexityPool.js).
  COMPLEXITY_WORKER_MAX_HEAP_MB: { default: 256, min: 32, max: 4096 },
};

/** Integer tunable `name`, or its default when unset or invalid. */
export function readLimit(name) {
  const spec = LIMITS[name];
  if (!spec) throw new Error(`Unknown limit ${name}`);
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return spec.default;
  const value = Number(raw);
  return Number.isInteger(value) && value >= spec.min && value <= spec.max ? value : spec.default;
}

/** Problems with the configured values: [{ name, message }]. Never includes values of secrets. */
export function validateLimits(env = process.env) {
  const problems = [];
  for (const [name, spec] of Object.entries(LIMITS)) {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === "") continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
      problems.push({ name, message: `${name} must be an integer between ${spec.min} and ${spec.max} (default ${spec.default}).` });
    }
  }
  return problems;
}

export const LIMIT_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(LIMITS).map(([name, spec]) => [name, spec.default])),
);
