// src/profiling/profilingQueue.js
//
// Background queue for complexity profiling. The complexity_profiles table IS
// the queue (no Redis in this backend):
//   - one row per submission (unique submissionId) -> no duplicate jobs
//   - jobs are claimed atomically (FOR UPDATE SKIP LOCKED), safe with several
//     backend instances
//   - bounded backlog (COMPLEXITY_PROFILING_MAX_PENDING), bounded concurrency
//   - infrastructure errors are retried with backoff, user-code outcomes never
//   - every job has a hard timeout that aborts its CodeBox requests; CodeBox's
//     own sandbox limits guarantee nothing keeps running after an abandon
//   - RUNNING rows left behind by a crash/restart are recovered at startup
//   - normal judging has priority: a job waits while judging is in progress
// The worker is event-driven (enqueue / retry timers), so an idle backend
// does not poll the database.

import prisma from "../config/db.js";
import { normalizeLanguage } from "../utils/codeBuilder.js";
import { getProfilingConfig, runComplexityProfile, ProfilingError } from "./profiler.js";
import { getProfileDefinition, isProfilingSupported } from "./registry.js";

const state = {
  running: 0,
  activeJudging: 0,
  wakeTimer: null,
  kicking: false,
  started: false,
};

// Hooks for tests.
let db = prisma;
export function __setPrismaForTests(fake) {
  db = fake || prisma;
}
let runProfile = runComplexityProfile;
export function __setProfileRunnerForTests(fn) {
  runProfile = fn || runComplexityProfile;
}
export function __resetQueueStateForTests() {
  state.running = 0;
  state.activeJudging = 0;
  if (state.wakeTimer) clearTimeout(state.wakeTimer);
  state.wakeTimer = null;
  state.kicking = false;
}

/** Judging-priority markers, called around every judge execution. */
export function markJudgingStart() {
  state.activeJudging++;
}
export function markJudgingEnd() {
  state.activeJudging = Math.max(0, state.activeJudging - 1);
}

export const PROFILE_STATUSES = ["PENDING", "RUNNING", "COMPLETED", "INCONCLUSIVE", "FAILED"];

/**
 * Whether an accepted submission will be profiled, without touching the DB.
 * Lets the submit response say "PENDING" immediately.
 */
export function profilingEligibility({ problemSlug, language }) {
  const config = getProfilingConfig();
  if (!config.enabled) return { eligible: false, reason: "Complexity profiling is disabled." };
  const lang = normalizeLanguage(language);
  if (!isProfilingSupported(problemSlug, lang)) {
    return { eligible: false, reason: "Complexity profiling is not available for this problem/language yet." };
  }
  return { eligible: true };
}

/**
 * Creates the profiling job for an ACCEPTED submission. Never throws.
 * @returns {Promise<{ status: string, reason?: string }>}
 */
export async function enqueueComplexityProfile({ submissionId, problemSlug, language }) {
  try {
    const eligibility = profilingEligibility({ problemSlug, language });
    if (!eligibility.eligible) return { status: "UNAVAILABLE", reason: eligibility.reason };
    const config = getProfilingConfig();
    const lang = normalizeLanguage(language);

    const backlog = await db.complexityProfile.count({ where: { status: { in: ["PENDING", "RUNNING"] } } });
    const queueFull = backlog >= config.maxPending;
    try {
      await db.complexityProfile.create({
        data: {
          submissionId,
          language: lang,
          problemSlug,
          status: queueFull ? "FAILED" : "PENDING",
          failureReason: queueFull ? "Profiling queue is full; this submission was not profiled." : null,
        },
      });
    } catch (err) {
      if (err?.code === "P2002") {
        // Already queued for this submission: duplicates are impossible.
        const existing = await db.complexityProfile.findUnique({ where: { submissionId }, select: { status: true } });
        return { status: existing?.status || "PENDING" };
      }
      throw err;
    }
    if (queueFull) return { status: "FAILED", reason: "QUEUE_FULL" };
    kick();
    return { status: "PENDING" };
  } catch (err) {
    console.error("[Complexity Profiling] Could not enqueue:", err.message);
    return { status: "UNAVAILABLE", reason: "Profiling could not be scheduled." };
  }
}

/** Atomically claims the oldest due PENDING job. */
async function claimNextJob(store = db) {
  const rows = await store.$queryRaw`
    UPDATE "complexity_profiles"
       SET "status" = 'RUNNING', "startedAt" = NOW(), "attempts" = "attempts" + 1, "updatedAt" = NOW()
     WHERE "id" = (
       SELECT "id" FROM "complexity_profiles"
        WHERE "status" = 'PENDING' AND "nextAttemptAt" <= NOW()
        ORDER BY "createdAt"
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING "id", "submissionId", "attempts", "language", "problemSlug"`;
  return rows[0] || null;
}

/** Schedules a wake-up for the next job whose retry time is in the future. */
async function scheduleNextWake(store = db) {
  const next = await store.complexityProfile.findFirst({
    where: { status: "PENDING" },
    orderBy: { nextAttemptAt: "asc" },
    select: { nextAttemptAt: true },
  });
  if (!next) return;
  const delay = Math.max(1000, next.nextAttemptAt.getTime() - Date.now());
  if (state.wakeTimer) clearTimeout(state.wakeTimer);
  state.wakeTimer = setTimeout(() => {
    state.wakeTimer = null;
    kick();
  }, Math.min(delay, 10 * 60 * 1000));
  state.wakeTimer.unref?.();
}

/** Starts as many jobs as concurrency allows. Safe to call any time. */
export function kick() {
  if (state.kicking) return;
  state.kicking = true;
  (async () => {
    try {
      const { concurrency, enabled } = getProfilingConfig();
      if (!enabled) return;
      const store = db; // one handle for the claim and the job it starts
      while (state.running < concurrency) {
        const job = await claimNextJob(store);
        if (!job) {
          await scheduleNextWake(store);
          break;
        }
        state.running++;
        processJob(job, store)
          .catch((err) => console.error("[Complexity Profiling] Job error:", err?.message || err))
          .finally(() => {
            state.running--;
            kick();
          });
      }
    } catch (err) {
      // Database unavailable: try again later.
      console.error("[Complexity Profiling] Queue error:", err.message);
      if (!state.wakeTimer) {
        state.wakeTimer = setTimeout(() => {
          state.wakeTimer = null;
          kick();
        }, 30_000);
        state.wakeTimer.unref?.();
      }
    } finally {
      state.kicking = false;
    }
  })();
}

/** Waits (bounded) while normal judging is in progress. */
async function yieldToJudging(maxWaitMs = 15_000) {
  const until = Date.now() + maxWaitMs;
  while (state.activeJudging > 0 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250));
  }
}

const toJson = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/** Runs one claimed job and stores its outcome. */
export async function processJob(job, store = db) {
  const config = getProfilingConfig();
  await yieldToJudging();

  const finish = (data) =>
    store.complexityProfile.update({
      where: { id: job.id },
      data: { ...data, completedAt: new Date() },
    });

  const submission = await store.submission.findUnique({
    where: { id: job.submissionId },
    select: {
      code: true,
      language: true,
      status: true,
      problem: { select: { slug: true, templates: true } },
    },
  });
  if (!submission || submission.status !== "ACCEPTED") {
    await finish({ status: "FAILED", failureReason: "Submission is no longer available or not accepted." });
    return;
  }
  const definition = getProfileDefinition(submission.problem.slug);
  if (!definition) {
    await finish({ status: "FAILED", failureReason: "Profiling is not available for this problem." });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  timer.unref?.();
  const started = Date.now();
  try {
    const result = await Promise.race([
      runProfile({
        definition,
        problem: submission.problem,
        language: submission.language,
        userCode: submission.code,
        config,
        signal: controller.signal,
      }),
      new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new ProfilingError(`Profiling exceeded ${config.timeoutMs} ms.`, { code: "PROFILE_TIMEOUT", retryable: true })),
        );
      }),
    ]);
    await finish({
      status: result.status,
      timeComplexity: result.timeComplexity,
      timeConfidence: result.timeConfidence,
      spaceComplexity: result.spaceComplexity,
      spaceConfidence: result.spaceConfidence,
      confidence: result.confidence,
      inputSizes: toJson(result.inputSizes),
      measurements: toJson(result.measurements),
      baseline: toJson(result.baseline),
      analysis: toJson({ ...result.analysis, validSizes: result.validSizes, sandbox: result.sandbox }),
      durationMs: result.durationMs,
      failureReason: result.failureReason,
    });
  } catch (err) {
    const retryable = err instanceof ProfilingError ? err.retryable : false;
    const reason = `${err.code || "ERROR"}: ${err.message}`.slice(0, 1000);
    if (retryable && job.attempts < config.maxAttempts) {
      // Transient infrastructure problem: back to the queue with backoff.
      await store.complexityProfile.update({
        where: { id: job.id },
        data: {
          status: "PENDING",
          failureReason: reason,
          nextAttemptAt: new Date(Date.now() + 30_000 * job.attempts),
        },
      });
      return;
    }
    // Outcomes caused by the solution itself on oversized inputs (the sandbox
    // killed it, ...) make the estimate unreliable -> INCONCLUSIVE. Internal
    // problems (driver compile error, generator bug, retries exhausted) -> FAILED.
    const inconclusiveCodes = new Set(["PROFILE_NO_REPORT"]);
    await finish({
      status: inconclusiveCodes.has(err.code) ? "INCONCLUSIVE" : "FAILED",
      failureReason: reason,
      durationMs: Date.now() - started,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts the worker: recovers jobs abandoned by a previous process (RUNNING
 * for longer than the job timeout) and resumes pending work.
 */
export async function startProfilingWorker() {
  if (state.started) return;
  state.started = true;
  const config = getProfilingConfig();
  if (!config.enabled) return;
  await recoverStaleJobs(config);
  // Jobs that were RUNNING when a previous process died shortly before this
  // start only become "stale" after the timeout: check once more then.
  const later = setTimeout(() => recoverStaleJobs(getProfilingConfig()).then(kick), config.timeoutMs + 61_000);
  later.unref?.();
  kick();
}

async function recoverStaleJobs(config) {
  try {
    const staleBefore = new Date(Date.now() - config.timeoutMs - 60_000);
    const requeued = await db.complexityProfile.updateMany({
      where: { status: "RUNNING", startedAt: { lt: staleBefore }, attempts: { lt: config.maxAttempts } },
      data: { status: "PENDING", failureReason: "Worker restarted during profiling; retrying." },
    });
    const failed = await db.complexityProfile.updateMany({
      where: { status: "RUNNING", startedAt: { lt: staleBefore } },
      data: { status: "FAILED", failureReason: "Worker restarted during profiling; attempts exhausted.", completedAt: new Date() },
    });
    if (requeued.count || failed.count) {
      console.log(`[Complexity Profiling] Recovered ${requeued.count} job(s), failed ${failed.count} stale job(s).`);
    }
  } catch (err) {
    console.error("[Complexity Profiling] Stale-job recovery failed:", err.message);
  }
}
