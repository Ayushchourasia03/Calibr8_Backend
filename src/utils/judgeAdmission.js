import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { ApiError } from "./ApiError.js";
import { readLimit } from "../config/limits.js";
import { JWT_SECRET } from "../config/jwt.js";

// Judge scheduler in front of CodeBox (SA-H2, round 2).
//
// Round 1 admitted whole evaluations: a slot was held from the start of a
// Submit to its end. Code that sleeps instead of using CPU kept a slot for
// minutes, and four free accounts held all four slots of an instance while
// everyone else got 503 JUDGE_BUSY (FV-1).
//
// Now:
//   - A judge SESSION is one Run or Submit. Opening one checks the user's
//     concurrent sessions (JUDGE_MAX_SESSIONS_PER_USER, 429 JUDGE_USER_BUSY)
//     and the user's sandbox-time budget for the current window
//     (JUDGE_USER_BUDGET_MS, lower for new accounts; 429
//     EXECUTION_BUDGET_EXHAUSTED).
//   - A SLOT covers ONE CodeBox request (a chunk of testcases), at most
//     JUDGE_MAX_CONCURRENT per instance and JUDGE_MAX_ACTIVE_PER_USER per
//     user. Between chunks the slot goes back to the scheduler, so a long
//     evaluation cannot keep capacity from others.
//   - Waiting requests are served lightest user first: fewest running
//     requests, then least recent sandbox time (decaying with
//     JUDGE_COST_HALF_LIFE_MS; new accounts' usage weighs
//     JUDGE_NEW_ACCOUNT_COST_WEIGHT times more), then arrival. A newcomer
//     therefore waits for at most one running chunk, however many heavy
//     users are queued.
//   - A session's first slot waits at most JUDGE_QUEUE_TIMEOUT_MS (503
//     JUDGE_BUSY); later slots of an admitted session wait up to
//     JUDGE_CONTINUATION_TIMEOUT_MS. JUDGE_MAX_QUEUE bounds waiting first
//     requests.
//   - Costs are the sandbox time CodeBox reports: per testcase max(CPU, wall).
//
// Cross-instance limits: the PROCESSING cap in the database (submitSolution)
// and CodeBox's per-tenant cap, budget and priority (X-Codebox-Tenant),
// which every backend instance shares.

const config = () => ({
  maxConcurrent: readLimit("JUDGE_MAX_CONCURRENT"),
  maxQueue: readLimit("JUDGE_MAX_QUEUE"),
  queueTimeoutMs: readLimit("JUDGE_QUEUE_TIMEOUT_MS"),
  continuationTimeoutMs: readLimit("JUDGE_CONTINUATION_TIMEOUT_MS"),
  maxActivePerUser: readLimit("JUDGE_MAX_ACTIVE_PER_USER"),
  maxQueuedPerUser: readLimit("JUDGE_MAX_QUEUED_PER_USER"),
  maxSessionsPerUser: readLimit("JUDGE_MAX_SESSIONS_PER_USER"),
  halfLifeMs: readLimit("JUDGE_COST_HALF_LIFE_MS"),
  budgetMs: readLimit("JUDGE_USER_BUDGET_MS"),
  budgetWindowMs: readLimit("JUDGE_USER_BUDGET_WINDOW_MS"),
  newAccountAgeMs: readLimit("JUDGE_NEW_ACCOUNT_AGE_MS"),
  newAccountBudgetMs: readLimit("JUDGE_NEW_ACCOUNT_BUDGET_MS"),
  newAccountWeight: readLimit("JUDGE_NEW_ACCOUNT_COST_WEIGHT"),
});

const MIN_REQUEST_COST_MS = 50; // a request always costs something (compile, overhead)
const MAX_TRACKED_USERS = 50_000;

let active = 0;
let seq = 0;
const waiting = []; // { user, session, first, seq, resolve, reject, timer }
const users = new Map(); // key -> { active, queuedFirst, sessions, score, scoreAt, windowStart, used, weight }
const context = new AsyncLocalStorage();

function busyError() {
  return new ApiError(503, "The judge is busy right now. Please try again in a few seconds.", "JUDGE_BUSY", { retryAfterSeconds: 5 });
}

function userBusyError() {
  return new ApiError(429, "You already have code running. Wait for it to finish before starting another run.", "JUDGE_USER_BUSY", { retryAfterSeconds: 5 });
}

function budgetError(retryAfterSeconds) {
  return new ApiError(
    429,
    "You have used your code execution time for now. Please try again later.",
    "EXECUTION_BUDGET_EXHAUSTED",
    { retryAfterSeconds },
  );
}

const keyFor = (userId) => (userId ? `u:${userId}` : "anonymous");

function userState(key, now = Date.now()) {
  let u = users.get(key);
  if (!u) {
    if (users.size >= MAX_TRACKED_USERS) pruneUsers(now);
    u = { active: 0, queuedFirst: 0, sessions: 0, score: 0, scoreAt: now, windowStart: now, used: 0, weight: 1 };
    users.set(key, u);
  }
  return u;
}

/** Recent usage, decayed to `now`. */
function scoreOf(u, now, halfLifeMs) {
  if (u.score <= 0) return 0;
  return u.score * 2 ** (-(now - u.scoreAt) / halfLifeMs);
}

function pruneUsers(now) {
  const { halfLifeMs, budgetWindowMs } = config();
  for (const [key, u] of users) {
    if (u.sessions || u.active || u.queuedFirst) continue;
    if (scoreOf(u, now, halfLifeMs) < 1 && now - u.windowStart > budgetWindowMs) users.delete(key);
  }
}

function charge(u, costMs, now = Date.now()) {
  const { halfLifeMs, budgetWindowMs } = config();
  const cost = Math.max(0, Number(costMs) || 0);
  u.score = scoreOf(u, now, halfLifeMs) + cost * u.weight;
  u.scoreAt = now;
  if (now - u.windowStart >= budgetWindowMs) {
    u.windowStart = now;
    u.used = 0;
  }
  u.used += cost;
}

/** Picks the next waiting request: fewest running requests, least recent usage, then arrival. */
function pickNext(now, cfg) {
  let best = -1;
  let bestKey = null;
  for (let i = 0; i < waiting.length; i++) {
    const entry = waiting[i];
    const u = entry.user;
    if (u.active >= cfg.maxActivePerUser) continue;
    const key = [u.active, scoreOf(u, now, cfg.halfLifeMs), entry.seq];
    if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
      best = i;
      bestKey = key;
    }
  }
  return best;
}

function dispatch() {
  const cfg = config();
  const now = Date.now();
  while (active < cfg.maxConcurrent && waiting.length > 0) {
    const index = pickNext(now, cfg);
    if (index < 0) return;
    const [entry] = waiting.splice(index, 1);
    clearTimeout(entry.timer);
    if (entry.first) entry.user.queuedFirst--;
    entry.resolve(grant(entry.user));
  }
}

function grant(u) {
  active++;
  u.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active = Math.max(0, active - 1);
    u.active = Math.max(0, u.active - 1);
    dispatch();
  };
}

/** Waits for a slot for `session`. Resolves to a release function (idempotent). */
function acquireSlot(session) {
  const cfg = config();
  const u = session.user;
  const first = !session.started;
  const queuedAhead = waiting.length > 0;
  if (active < cfg.maxConcurrent && u.active < cfg.maxActivePerUser && !queuedAhead) {
    session.started = true;
    return Promise.resolve(grant(u));
  }
  if (first) {
    const firstWaiting = waiting.filter((e) => e.first).length;
    if (firstWaiting >= cfg.maxQueue) return Promise.reject(busyError());
    if (u.queuedFirst >= cfg.maxQueuedPerUser) return Promise.reject(userBusyError());
  }
  return new Promise((resolve, reject) => {
    const entry = { user: u, session, first, seq: seq++, resolve: null, reject, timer: null };
    entry.resolve = (release) => {
      session.started = true;
      resolve(release);
    };
    entry.timer = setTimeout(() => {
      const index = waiting.indexOf(entry);
      if (index >= 0) {
        waiting.splice(index, 1);
        if (first) u.queuedFirst--;
      }
      reject(busyError());
    }, first ? cfg.queueTimeoutMs : cfg.continuationTimeoutMs);
    entry.timer.unref?.();
    if (first) u.queuedFirst++;
    waiting.push(entry);
    dispatch();
  });
}

/** Sandbox time of a CodeBox request's results: per testcase max(CPU, wall). */
export function sandboxCostMs(results) {
  const list = Array.isArray(results) ? results : results ? [results] : [];
  let total = 0;
  for (const r of list) {
    if (!r || r.status === "Skipped") continue;
    total += Math.max(Number(r.cpuTimeMs ?? r.timeMs) || 0, Number(r.wallTimeMs) || 0);
  }
  return total;
}

/**
 * Opaque, stable per-user id for CodeBox (X-Codebox-Tenant): an HMAC of the
 * user id, so CodeBox and its logs never see real user ids.
 */
export function codeboxTenantFor(userId) {
  if (!userId) return null;
  return `u.${crypto.createHmac("sha256", JWT_SECRET).update(`codebox-tenant:${userId}`).digest("base64url").slice(0, 32)}`;
}

class JudgeSession {
  constructor(user, tenant = null) {
    this.user = user;
    this.tenant = tenant;
    this.started = false;
    this.closed = false;
    this.spentMs = 0;
    this.heldRelease = null;
  }

  /**
   * Runs one CodeBox request in a slot and charges its sandbox time
   * (costOf(result), default sandboxCostMs) to the user.
   */
  async run(fn, costOf = sandboxCostMs) {
    if (this.closed) throw new Error("judge session is closed");
    let release = this.heldRelease;
    this.heldRelease = null;
    if (!release) release = await acquireSlot(this);
    let result;
    let cost = MIN_REQUEST_COST_MS;
    try {
      result = await fn();
      cost = Math.max(MIN_REQUEST_COST_MS, costOf(result));
      return result;
    } finally {
      this.spentMs += cost;
      charge(this.user, cost);
      release();
    }
  }

  /** Waits for the first slot now (503 JUDGE_BUSY synchronously) and keeps it for the first run(). */
  async reserve() {
    if (!this.heldRelease && !this.started) this.heldRelease = await acquireSlot(this);
    return this;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.heldRelease?.();
    this.heldRelease = null;
    this.user.sessions = Math.max(0, this.user.sessions - 1);
  }
}

/**
 * Opens a judge session for one Run or Submit. Throws 429 JUDGE_USER_BUSY
 * (too many concurrent sessions) or 429 EXECUTION_BUDGET_EXHAUSTED.
 * @param {{ userId?: string, accountCreatedAt?: Date|string|number }} owner
 */
export function openJudgeSession({ userId, accountCreatedAt } = {}) {
  const cfg = config();
  const now = Date.now();
  const u = userState(keyFor(userId), now);
  const created = accountCreatedAt ? new Date(accountCreatedAt).getTime() : NaN;
  const isNew = Number.isFinite(created) && now - created < cfg.newAccountAgeMs;
  u.weight = isNew ? cfg.newAccountWeight : 1;
  if (u.sessions >= cfg.maxSessionsPerUser) throw userBusyError();
  if (now - u.windowStart >= cfg.budgetWindowMs) {
    u.windowStart = now;
    u.used = 0;
  }
  const budget = isNew ? Math.min(cfg.newAccountBudgetMs, cfg.budgetMs) : cfg.budgetMs;
  if (u.used >= budget) {
    throw budgetError(Math.max(1, Math.ceil((u.windowStart + cfg.budgetWindowMs - now) / 1000)));
  }
  u.sessions++;
  return new JudgeSession(u, codeboxTenantFor(userId));
}

/** Runs fn with `session` as the current judge session (CodeBox requests inside use its slots). */
export function runWithJudgeSession(session, fn) {
  return context.run(session, fn);
}

/** Opens a session, runs fn inside it, closes it. */
export async function withJudgeSession(owner, fn, { reserve = false } = {}) {
  const session = openJudgeSession(owner);
  try {
    if (reserve) await session.reserve();
    return await runWithJudgeSession(session, () => fn(session));
  } finally {
    session.close();
  }
}

export function currentJudgeSession() {
  return context.getStore() || null;
}

/**
 * Runs one CodeBox request in a slot of the current judge session. Outside a
 * session (background profiling, scripts) it runs in a one-off anonymous
 * session, so nothing reaches CodeBox unscheduled.
 */
export async function withExecutionSlot(fn, costOf) {
  const session = currentJudgeSession();
  if (session && !session.closed) return session.run(fn, costOf);
  const oneOff = new JudgeSession(userState("anonymous"));
  try {
    return await oneOff.run(fn, costOf);
  } finally {
    oneOff.closed = true;
  }
}

/**
 * Compatibility: one slot held until the returned release is called.
 * @param {{ userId?: string }} [owner]
 */
export async function acquireJudgeSlot({ userId } = {}) {
  const session = openJudgeSession({ userId });
  try {
    await session.reserve();
  } catch (err) {
    session.close();
    throw err;
  }
  return () => session.close();
}

export function judgeAdmissionStats() {
  const firstWaiting = waiting.filter((e) => e.first).length;
  return { active, queued: waiting.length, queuedFirst: firstWaiting, users: users.size, ...config() };
}

/** Recent usage and budget use of a user (tests and diagnostics). */
export function judgeUserUsage(userId) {
  const u = users.get(keyFor(userId));
  if (!u) return { score: 0, used: 0, sessions: 0, active: 0 };
  return { score: scoreOf(u, Date.now(), config().halfLifeMs), used: u.used, sessions: u.sessions, active: u.active };
}

/** Test hook. */
export function __resetJudgeAdmissionForTests() {
  for (const entry of waiting) clearTimeout(entry.timer);
  waiting.length = 0;
  users.clear();
  active = 0;
}
