import crypto from "crypto";
import prisma from "../config/db.js";
import { areOutputsEqual, exceedsOutputLimit } from "../utils/outputComparator.js";
import { readLimit } from "../config/limits.js";
import {
  buildFinalCode,
  LANGUAGE_IDS,
  normalizeLanguage,
  SUPPORTED_LANGUAGES,
} from "../utils/codeBuilder.js";
import {
  updateCachedProblemSolvedCount,
  resolveProblem,
} from "../utils/problemResolver.js";
import { ApiError } from "../utils/ApiError.js";
import { getCodeboxUrl, fetchCodeboxJson } from "../utils/codeboxClient.js";
import {
  enqueueComplexityProfile,
  markJudgingEnd,
  markJudgingStart,
  profilingEligibility,
} from "../profiling/profilingQueue.js";
import { syncProblemSolvedCount } from "../utils/problemSolvedCount.js";
import {
  applyAcceptedSubmissionReward,
  REWARD_USER_SELECT,
} from "../utils/acceptedSubmissionReward.js";
import { getUserHeaderStats } from "../utils/userHeaderStats.js";
import { publicTestResults } from "../utils/testcaseResults.js";
import { analyzeComplexitySafe, MAX_ANALYZE_CODE_BYTES } from "../services/complexityPool.js";
import { recordDailyProblemCompletion } from "../services/dailyProblemService.js";
import {
  openJudgeSession,
  runWithJudgeSession,
  withExecutionSlot,
  sandboxCostMs,
  currentJudgeSession,
} from "../utils/judgeAdmission.js";

/**
 * Duration cap for the next CodeBox request of the current judge session
 * (round 2): short while the session has not run anything yet (its code's
 * cost is unknown), then twice the target chunk duration.
 */
function requestDurationCapMs() {
  const session = currentJudgeSession();
  const blind = !session || session.spentMs === 0;
  return blind ? readLimit("JUDGE_BLIND_REQUEST_MAX_MS") : 2 * readLimit("JUDGE_TARGET_CHUNK_MS");
}
import {
  supportsMultiCase,
  isHarnessSafeUserCode,
  wrapWithHarness,
  buildHarnessStdin,
  parseHarnessOutput,
  normalizeHarnessCase,
} from "../utils/multiCaseHarness.js";

// Request byte budgets. Every byte sent to CodeBox is held in its shared,
// non-evicting Redis for about an hour, so user-controlled sizes are capped.
export const MAX_CODE_BYTES = 64 * 1024;
export const MAX_CUSTOM_STDIN_BYTES = 64 * 1024;
// Program output / error text kept per testcase after comparison (responses,
// cache). Comparison itself always uses the full output.
const MAX_RESULT_TEXT_CHARS = 4 * 1024;

function clipText(value, max = MAX_RESULT_TEXT_CHARS) {
  if (typeof value !== "string" || value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} characters]`;
}

// Holds per-testcase results/complexity that are not persisted, so polling
// clients can read them. Bounded by TTL, entry count AND total bytes, and
// only ever holds public (hidden-stripped, clipped) results.
const SUBMISSION_CACHE_TTL_MS = 30 * 60 * 1000;
const SUBMISSION_CACHE_MAX_ENTRIES = 2000;
const SUBMISSION_CACHE_MAX_BYTES = Number(process.env.SUBMISSION_CACHE_MAX_BYTES) || 32 * 1024 * 1024;
const submissionCacheEntries = new Map(); // id -> { value, expiresAt, bytes }
let submissionCacheBytes = 0;
function dropCacheEntry(id) {
  const entry = submissionCacheEntries.get(id);
  if (!entry) return;
  submissionCacheBytes -= entry.bytes;
  submissionCacheEntries.delete(id);
}
const submissionCache = {
  get(id) {
    const entry = submissionCacheEntries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      dropCacheEntry(id);
      return undefined;
    }
    return entry.value;
  },
  set(id, rawValue) {
    dropCacheEntry(id);
    const value = rawValue?.results
      ? { ...rawValue, results: publicTestResults(rawValue.results) }
      : rawValue;
    let bytes = 0;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value) || "", "utf-8");
    } catch {
      return;
    }
    if (bytes > SUBMISSION_CACHE_MAX_BYTES / 4) return; // never let one entry dominate
    while (
      submissionCacheEntries.size > 0 &&
      (submissionCacheEntries.size >= SUBMISSION_CACHE_MAX_ENTRIES ||
        submissionCacheBytes + bytes > SUBMISSION_CACHE_MAX_BYTES)
    ) {
      // Map preserves insertion order: evict the oldest entry.
      dropCacheEntry(submissionCacheEntries.keys().next().value);
    }
    submissionCacheEntries.set(id, {
      value,
      bytes,
      expiresAt: Date.now() + SUBMISSION_CACHE_TTL_MS,
    });
    submissionCacheBytes += bytes;
  },
};
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of submissionCacheEntries) {
    if (entry.expiresAt <= now) dropCacheEntry(id);
  }
}, 5 * 60 * 1000).unref?.();

// Background (202) evaluations still running in this process, so a graceful
// shutdown can wait for them instead of leaving rows in PROCESSING.
const activeEvaluations = new Set();

/** Waits (bounded) for background evaluations to settle. */
export async function drainEvaluations(timeoutMs = 25_000) {
  if (activeEvaluations.size === 0) return 0;
  const pending = activeEvaluations.size;
  await Promise.race([
    Promise.allSettled([...activeEvaluations]),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
  return pending;
}

// Submissions older than this that are still PROCESSING were abandoned by a
// crashed/restarted process (judging is bounded far below this).
const STALE_PROCESSING_MS = 15 * 60 * 1000;

/** Marks abandoned PROCESSING submissions as ERROR. Safe on every instance. */
export async function recoverStaleSubmissions(now = Date.now(), { userId } = {}) {
  try {
    const { count } = await prisma.submission.updateMany({
      // userId narrows the sweep (tests run against the real database).
      where: { status: "PROCESSING", createdAt: { lt: new Date(now - STALE_PROCESSING_MS) }, ...(userId ? { userId } : {}) },
      data: { status: "ERROR" },
    });
    if (count) console.warn(`[Submissions] Marked ${count} abandoned PROCESSING submission(s) as ERROR.`);
    return count;
  } catch (err) {
    console.error("[Submissions] Stale-submission recovery failed:", err.message);
    return 0;
  }
}

// Asynchronous submissions still being judged in this process, keyed by
// user + problem + language + code hash (duplicate-request protection).
const pendingSubmissions = new Map();

function queuedSubmissionResponse(submissionId, problem) {
  return {
    success: true,
    submissionId,
    verdict: "QUEUED",
    status: "QUEUED",
    pollUrl: `/api/execution/submissions/${submissionId}`,
    message: "Submission received and queued for execution.",
    problem: { slug: problem.slug, title: problem.title },
  };
}

/**
 * Cross-instance per-user cap (SA-H2): the in-process limiters only see one
 * backend instance, the submissions table is shared by all of them. Counts the
 * user's recent PROCESSING rows (index userId+status+createdAt). A failing
 * count is not a reason to reject: the insert that follows reports a database
 * outage on its own.
 */
async function assertSubmissionCapacity(userId) {
  const limit = readLimit("JUDGE_MAX_PROCESSING_PER_USER");
  let processing;
  try {
    processing = await prisma.submission.count({
      where: { userId, status: "PROCESSING", createdAt: { gt: new Date(Date.now() - STALE_PROCESSING_MS) } },
    });
  } catch {
    return;
  }
  if (processing >= limit) {
    throw new ApiError(
      429,
      "You already have submissions being judged. Wait for them to finish before submitting again.",
      "SUBMISSION_IN_PROGRESS",
      { retryAfterSeconds: 5 },
    );
  }
}

const MAX_CASES_PER_BATCH = 20;
const BATCH_POLL_INITIAL_INTERVAL_MS = 150;
const BATCH_POLL_MAX_INTERVAL_MS = 800;
const BATCH_TIMEOUT_MS = 60 * 1000;
const MAX_CONCURRENT_BATCHES =
  Number(process.env.CODEBOX_MAX_CONCURRENT_BATCHES) || 2;

/** Compact complexity summary avoiding unnecessary metadata */
export function compactComplexitySummary(complexity) {
  if (!complexity) return null;
  return {
    time: complexity.time
      ? {
          bestEstimate: complexity.time.bestEstimate,
          confidence: complexity.time.confidence,
        }
      : null,
    space: complexity.space
      ? {
          bestEstimate: complexity.space.bestEstimate,
          confidence: complexity.space.confidence,
        }
      : null,
    summary: complexity.summary || null,
  };
}

/**
 * List enabled execution languages, versions and Judge0 IDs.
 * GET /api/execution/languages
 */
export const getLanguages = async (req, res, next) => {
  try {
    const languages = [
      {
        key: "python",
        label: "Python 3",
        version: "Python 3.10",
        judge0Id: 71,
        starterAvailable: true,
        monacoLanguage: "python",
      },
      {
        key: "javascript",
        label: "JavaScript",
        version: "Node.js 22",
        judge0Id: 63,
        starterAvailable: true,
        monacoLanguage: "javascript",
      },
      {
        key: "cpp",
        label: "C++ (GCC)",
        version: "GCC 13 (C++20)",
        judge0Id: 54,
        starterAvailable: true,
        monacoLanguage: "cpp",
      },
      {
        key: "c",
        label: "C (GCC)",
        version: "GCC 13",
        judge0Id: 50,
        starterAvailable: true,
        monacoLanguage: "c",
      },
      {
        key: "java",
        label: "Java (OpenJDK)",
        version: "OpenJDK 17",
        judge0Id: 62,
        starterAvailable: true,
        monacoLanguage: "java",
      },
    ];

    res.status(200).json({
      success: true,
      languages,
    });
  } catch (err) {
    next(err);
  }
};



// CODEBOX_BATCH_EXECUTION_ENABLED: "auto" (default) | "true" | "false".
// auto: use POST /batches (compile once, run many) when the CodeBox server
// supports it; a 404 disables it for a while so old servers cost one probe.
const BATCH_UNSUPPORTED_RETRY_MS = 10 * 60 * 1000;
let batchUnsupportedUntil = 0;

function isCodeboxBatchExecutionEnabled() {
  const mode = String(process.env.CODEBOX_BATCH_EXECUTION_ENABLED ?? "auto")
    .trim()
    .toLowerCase();
  if (mode === "false" || mode === "0") return false;
  if (mode === "true" || mode === "1") return true;
  return Date.now() >= batchUnsupportedUntil;
}

function normalizeBatchStatus(status) {
  const normalized = String(status || "")
    .trim()
    .toLowerCase();
  if (["completed", "done", "success"].includes(normalized)) return "OK";
  // Not run because an earlier tier failed (stop_on_failure).
  if (normalized === "skipped") return "Skipped";
  if (
    [
      "compile_failed",
      "compile-failed",
      "compilation_error",
      "compilation-error",
      "compile-error",
      "ce",
    ].includes(normalized)
  )
    return "Compilation Error";
  if (
    ["timeout", "time_limit_exceeded", "time-limit-exceeded", "tle"].includes(
      normalized,
    )
  )
    return "Time Limit Exceeded";
  if (
    ["memory_limit_exceeded", "memory-limit-exceeded", "memory-limit"].includes(
      normalized,
    )
  )
    return "Memory Limit Exceeded";
  if (
    ["output_limit_exceeded", "output-limit-exceeded", "output-limit"].includes(
      normalized,
    )
  )
    return "Output Limit Exceeded";
  if (
    [
      "cancelled",
      "canceled",
      "cancelled_by_user",
      "cancelled-by-user",
    ].includes(normalized)
  )
    return "Cancelled";
  if (
    ["failed", "error", "runtime_error", "runtime-error"].includes(normalized)
  )
    return "Runtime Error";
  return "Runtime Error";
}

/**
 * Submission verdict for a failed testcase. Only a genuine output mismatch is
 * a Wrong Answer; resource-limit and crash outcomes keep their own verdict.
 */
export function verdictForFailure(failureType) {
  switch (failureType) {
    case "Time Limit Exceeded":
      return "TIME_LIMIT_EXCEEDED";
    case "Memory Limit Exceeded":
      return "MEMORY_LIMIT_EXCEEDED";
    case "Compilation Error":
      return "COMPILATION_ERROR";
    case "Runtime Error":
    case "Output Limit Exceeded": // like Judge0: runtime error (SIGXFSZ)
      return "RUNTIME_ERROR";
    default:
      return "WRONG_ANSWER";
  }
}

/**
 * Verdict of one executed testcase. Output is only compared when the program
 * completed normally and its output is within the comparable size
 * (exceedsOutputLimit, SA-H1); larger output is Output Limit Exceeded.
 * @returns {{ passed: boolean, status: string }} status: "Accepted",
 *   "Wrong Answer", "Output Limit Exceeded", "Skipped" or the execution status
 */
export function judgeTestcase(execResult, expectedOutput) {
  if (!execResult || execResult.status === "Skipped") return { passed: false, status: "Skipped" };
  if (execResult.status !== "OK") return { passed: false, status: execResult.status };
  if (exceedsOutputLimit(execResult.actual, expectedOutput)) {
    return { passed: false, status: "Output Limit Exceeded" };
  }
  return areOutputsEqual(execResult.actual, expectedOutput)
    ? { passed: true, status: "Accepted" }
    : { passed: false, status: "Wrong Answer" };
}

/**
 * CodeBox reuses one sandbox (cgroup) per batch lane, and isolate's "OOM
 * killed" flag is that cgroup's cumulative counter: after one memory-limit
 * kill, every later testcase in the lane comes back as memory_limit_exceeded
 * (CodeBox fix pending deployment). A testcase only hit the memory limit if
 * its process was actually SIGKILLed; a SIGKILL at the time limit is a TLE.
 */
function correctStickyMemoryLimit(status, { exitCode, exitSignal, timeMs, memoryKb }, limits) {
  if (status !== "Memory Limit Exceeded") return status;
  const signal = Number(exitSignal) || 0;
  // CodeBox runs batch testcases through a shell: a SIGKILLed program shows up
  // as exit code 137 (128 + 9) with no signal.
  const sigkilled = signal === 9 || (!signal && exitCode === 137);
  if (!sigkilled) return exitCode === 0 && !signal ? "OK" : "Runtime Error";
  const memLimitKb = Number(limits?.memoryLimitKb) || 0;
  const cpuLimitMs = Number(limits?.cpuLimitMs) || 0;
  const nearMemLimit = memLimitKb > 0 && memoryKb >= memLimitKb * 0.95;
  if (!nearMemLimit && cpuLimitMs > 0 && timeMs >= cpuLimitMs) return "Time Limit Exceeded";
  return status;
}

function normalizeBatchResult(rawResult = {}, fallbackIndex = 0, limits = null) {
  const rawStatus = String(
    rawResult.status || rawResult.state || "completed",
  ).trim();
  const exitCode = Number(rawResult.exitCode ?? rawResult.exit_code ?? 0);
  const stdout = typeof rawResult.stdout === "string" ? rawResult.stdout : "";
  const stderr = typeof rawResult.stderr === "string" ? rawResult.stderr : "";
  const compileOutput =
    typeof rawResult.compile_output === "string"
      ? rawResult.compile_output
      : "";
  const timeMs = Number(
    rawResult.timeMs ?? rawResult.time ?? rawResult.elapsedMs ?? 0,
  );
  const wallTimeMs = Number(
    rawResult.wallTimeMs ?? rawResult.wall_time ?? timeMs ?? 0,
  );
  const memoryKb = Number(
    rawResult.memory ?? rawResult.memoryKb ?? rawResult.memory_kb ?? 0,
  );
  const exitSignal = rawResult.exitSignal ?? rawResult.exit_signal ?? null;
  const status = correctStickyMemoryLimit(
    normalizeBatchStatus(rawStatus),
    { exitCode, exitSignal, timeMs, memoryKb },
    limits,
  );

  return {
    status,
    studentStdout: "",
    actual: stdout.trim(),
    errorText: stderr || compileOutput || rawResult.message || null,
    timeMs,
    cpuTimeMs: timeMs,
    wallTimeMs,
    memoryKb,
    memorySource: rawResult.memory_source || "max-rss",
    exitCode,
    index: Number(rawResult.index ?? fallbackIndex),
    inputBytes: Number(rawResult.inputBytes ?? 0),
  };
}

// Long-poll: CodeBox holds each request open until the batch finishes (up to
// this long), so results arrive the moment they are ready instead of on the
// next poll tick. Servers that ignore ?wait just answer immediately.
const BATCH_LONG_POLL_MS =
  Number(process.env.CODEBOX_BATCH_WAIT_MS) || 20_000;

const BATCH_TERMINAL_STATUSES = new Set([
  "completed",
  "compile_failed",
  "compile-failed",
  "failed",
  "timeout",
  "cancelled",
  "canceled",
]);

function isBatchTerminal(batchStatus) {
  return BATCH_TERMINAL_STATUSES.has(
    String(batchStatus?.status || "").trim().toLowerCase(),
  );
}

/** One CodeBox batch request, in a judge slot of the current session (round 2). */
function executeCodeboxBatchOnce(args) {
  if (!Array.isArray(args?.testcases) || args.testcases.length === 0) return Promise.resolve([]);
  return withExecutionSlot(() => executeCodeboxBatchOnceUnscheduled(args));
}

async function executeCodeboxBatchOnceUnscheduled({
  language,
  fullCode,
  testcases,
  timeLimit = 2000,
  memoryLimit = 256,
  stopOnFailure = false,
  maxDurationMs = requestDurationCapMs(),
}) {
  if (!Array.isArray(testcases) || testcases.length === 0) return [];

  const runnerUrl = getCodeboxUrl(true);
  const languageId = LANGUAGE_IDS[language] || 54;
  const headers = { "Content-Type": "application/json" };
  const payload = {
    language_id: languageId,
    source_code: fullCode,
    testcases: testcases.map((testcase) => ({
      stdin: testcase.stdin ?? testcase.stdinSmall ?? testcase.input ?? "",
      ...(Number.isInteger(testcase.group) ? { group: testcase.group } : {}),
    })),
    ...(stopOnFailure ? { stop_on_failure: true } : {}),
    // Round 2: CodeBox stops starting testcases after this long and returns
    // the rest as skipped, so one request holds a worker (and a judge slot)
    // for a bounded time whatever the code does.
    ...(maxDurationMs ? { max_duration_ms: Math.max(500, Math.round(maxDurationMs)) } : {}),
    limits: {
      cpu_time_limit: Math.max(1, Math.ceil((timeLimit || 2000) / 1000)),
      wall_time_limit: Math.max(2, Math.ceil((timeLimit || 2000) / 1000) * 2),
      memory_limit: Math.max(1, Number(memoryLimit || 256) * 1024),
      max_processes_and_or_threads: 60,
    },
  };

  let created;
  try {
    const createUrl = new URL("/batches", runnerUrl);
    createUrl.searchParams.set("wait", String(BATCH_LONG_POLL_MS));
    created = await fetchCodeboxJson(createUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      timeoutMs: BATCH_LONG_POLL_MS + 10_000,
    });
  } catch (err) {
    if (err?.httpStatus === 404) {
      batchUnsupportedUntil = Date.now() + BATCH_UNSUPPORTED_RETRY_MS;
    }
    throw err;
  }

  const batchId = created?.batchId || created?.id || created?.batch_id;
  if (!batchId) {
    throw new ApiError(
      503,
      "Code execution service returned an invalid batch response.",
      "EXECUTION_UNAVAILABLE",
    );
  }

  const statusUrl = new URL("/batches", runnerUrl);
  statusUrl.searchParams.set("batchId", batchId);
  statusUrl.searchParams.set("wait", String(BATCH_LONG_POLL_MS));

  // Allow for every testcase hitting its wall-clock limit before giving up.
  const deadline =
    Date.now() +
    BATCH_TIMEOUT_MS +
    testcases.length * payload.limits.wall_time_limit * 1000;
  let currentInterval = BATCH_POLL_INITIAL_INTERVAL_MS;
  let batchStatus = created;

  while (!isBatchTerminal(batchStatus)) {
    const requestStart = Date.now();
    batchStatus = await fetchCodeboxJson(statusUrl, {
      headers,
      timeoutMs: BATCH_LONG_POLL_MS + 10_000,
    });
    if (isBatchTerminal(batchStatus)) break;
    if (Date.now() >= deadline) {
      const timeoutErr = new ApiError(
        503,
        "Code execution service timed out.",
        "EXECUTION_UNAVAILABLE",
      );
      // The batch API exists but is slow: retrying on the legacy path would
      // just double the user's wait, so callers must not fall back.
      timeoutErr.isBatchTimeout = true;
      throw timeoutErr;
    }

    // A server that does not support ?wait answers instantly: fall back to
    // interval polling instead of hammering it.
    if (Date.now() - requestStart < 1000) {
      await new Promise((resolve) => setTimeout(resolve, currentInterval));
      currentInterval = Math.min(
        BATCH_POLL_MAX_INTERVAL_MS,
        Math.round(currentInterval * 1.35),
      );
    }
  }

  // The batch (source, every stdin, every output) is no longer needed: free
  // it from CodeBox's Redis now instead of after its TTL (SA-H2). CodeBox
  // servers without DELETE /batches/:id answer 404, which is ignored.
  fetchCodeboxJson(new URL(`/batches/${encodeURIComponent(batchId)}`, runnerUrl), {
    method: "DELETE",
    headers,
    timeoutMs: 5000,
  }).catch(() => {});

  const rawResults = Array.isArray(batchStatus?.results)
    ? batchStatus.results
    : [];

  // "failed" = internal CodeBox error (not the user's code): let the caller
  // fall back to another execution path instead of reporting Runtime Error.
  if (
    String(batchStatus?.status || "").toLowerCase() === "failed" &&
    rawResults.length === 0
  ) {
    throw new ApiError(
      503,
      "Code execution service failed to run the batch.",
      "EXECUTION_UNAVAILABLE",
    );
  }
  const byIndex = new Map(
    rawResults.map((result, index) => [Number(result.index ?? index), result]),
  );

  const isCompileFailed =
    batchStatus?.status === "compile_failed" ||
    batchStatus?.status === "COMPILE_FAILED" ||
    batchStatus?.status === "compile-failed";

  let sawExecutionFailure = false;
  const results = testcases.map((_, index) => {
    const rawResult = byIndex.get(index) ?? rawResults[index];
    if (!rawResult && !isCompileFailed) {
      if (sawExecutionFailure) {
        return {
          status: "Skipped",
          actual: "",
          studentStdout: "",
          errorText: null,
          timeMs: 0,
          cpuTimeMs: 0,
          wallTimeMs: 0,
          memoryKb: 0,
          inputBytes: Buffer.byteLength(String(testcases[index]?.stdin ?? ""), "utf-8"),
        };
      }
      throw new ApiError(
        503,
        "Code execution service returned incomplete batch results.",
        "EXECUTION_UNAVAILABLE",
      );
    }

    const fallback = {
      index,
      status: isCompileFailed ? "Compilation Error" : "Runtime Error",
      stderr: isCompileFailed
        ? batchStatus?.compileError || batchStatus?.error || ""
        : batchStatus?.message || "",
      stdout: "",
      exitCode: 1,
    };

    const normalized = normalizeBatchResult({ ...fallback, ...(rawResult || {}) }, index, {
      memoryLimitKb: payload.limits.memory_limit,
      cpuLimitMs: payload.limits.cpu_time_limit * 1000,
    });
    if (normalized.status !== "OK" && normalized.status !== "Skipped") {
      sawExecutionFailure = true;
    }

    return {
      ...normalized,
      inputBytes: Buffer.byteLength(
        String(testcases[index]?.stdin ?? ""),
        "utf-8",
      ),
    };
  });

  if (
    batchStatus?.status === "compile_failed" ||
    batchStatus?.status === "COMPILE_FAILED" ||
    batchStatus?.status === "compile-failed"
  ) {
    return results.map((result, index) => ({
      ...result,
      status: "Compilation Error",
      actual: "",
      studentStdout: "",
      errorText:
        rawResults[index]?.stderr ||
        rawResults[index]?.compile_output ||
        batchStatus?.message ||
        batchStatus?.error ||
        "Compilation failed.",
      timeMs: 0,
      cpuTimeMs: 0,
      wallTimeMs: 0,
      memoryKb: 0,
      exitCode: 1,
      inputBytes: Buffer.byteLength(
        String(testcases[index]?.stdin ?? ""),
        "utf-8",
      ),
    }));
  }

  return results;
}

function normalizeRunnerResult(data) {
  const statusId = Number(data.status?.id);
  const status =
    statusId === 5
      ? "Time Limit Exceeded"
      : statusId === 6 || Boolean(data.compile_output)
        ? "Compilation Error"
        : statusId >= 7 && statusId <= 12
          ? "Runtime Error"
          : statusId >= 13
            ? "Runtime Error"
            : "OK";

  const cpuTimeMs = Math.round(parseFloat(data.time || "0") * 1000);
  const wallTimeMs = Math.round(
    parseFloat(data.wall_time || data.time || "0") * 1000,
  );
  const memoryKb = Number(data.memory) || 0;
  const exitCode =
    data.exit_code !== undefined
      ? Number(data.exit_code)
      : status === "OK"
        ? 0
        : 1;

  return {
    status,
    studentStdout: "",
    actual: (data.stdout || "").trim(),
    errorText: data.stderr || data.compile_output || data.message || null,
    timeMs: cpuTimeMs,
    cpuTimeMs,
    wallTimeMs,
    memoryKb,
    memorySource: data.memory_source || "max-rss",
    exitCode,
  };
}

function isMultiCaseEnabled() {
  const flag = String(process.env.CODEBOX_MULTICASE_ENABLED ?? "true").toLowerCase();
  return flag !== "false" && flag !== "0";
}

// Judge0-compatible servers cap per-submission limits (defaults: 15s CPU, 20s wall).
const MULTICASE_MAX_CPU_SEC = Number(process.env.CODEBOX_MAX_CPU_TIME_LIMIT) || 15;
const MULTICASE_MAX_WALL_SEC = Number(process.env.CODEBOX_MAX_WALL_TIME_LIMIT) || 20;
const MULTICASE_POLL_INITIAL_INTERVAL_MS = 120;
const MULTICASE_MAX_CASES_PER_SUBMISSION =
  Number(process.env.CODEBOX_MULTICASE_MAX_CASES) || 500;
// Keeps each harness request well under CodeBox's 5 MB body limit (base64 adds 33%).
const MULTICASE_MAX_STDIN_BYTES = 3 * 1024 * 1024;
const MULTICASE_MAX_ROUNDS = 6;

/** Thrown when the harness-wrapped source fails to compile (see executeCodeBatch). */
const HARNESS_COMPILE_FAILED = "HARNESS_COMPILE_FAILED";

/**
 * Infrastructure failures (CodeBox down, sandbox/queue errors, bad responses)
 * may fall back to another execution path. Anything else - including every
 * verdict about the user's code - must not.
 */
function isInfrastructureError(err) {
  return err instanceof ApiError && err.code === "EXECUTION_UNAVAILABLE" && !err.isBatchTimeout;
}

/** Result for a testcase that was intentionally not run (after a definitive TLE). */
function skippedCaseResult(testcase) {
  return {
    status: "Skipped",
    studentStdout: "",
    actual: "",
    errorText: null,
    timeMs: 0,
    cpuTimeMs: 0,
    wallTimeMs: 0,
    memoryKb: 0,
    memorySource: "none",
    exitCode: null,
    inputBytes: Buffer.byteLength(String(testcase?.stdin ?? ""), "utf-8"),
  };
}

/**
 * Completes a result array: cases that were never run become "Skipped"; with
 * stopOnTimeout every case after the first TLE is "Skipped" too, so the
 * outcome does not depend on which parallel chunk finished first.
 */
function finishResults(testcases, results, stopOnTimeout) {
  const flat = testcases.map((tc, i) => results[i] || skippedCaseResult(tc));
  if (stopOnTimeout) {
    const first = flat.findIndex((r) => r?.status === "Time Limit Exceeded");
    if (first >= 0) {
      for (let i = first + 1; i < flat.length; i++) flat[i] = skippedCaseResult(testcases[i]);
    }
  }
  return flat;
}

/**
 * Judging cost control (SA-H2). `failure.isFailure(result, index)` tells
 * whether an executed case failed definitively (wrong answer, crash, limit).
 * After the first failure the rest of the tier is still judged, so
 * passedCount keeps its meaning, but only while the CPU time spent on cases
 * after that failure stays below JUDGE_POST_FAILURE_CPU_BUDGET_MS of sandbox
 * time (per case max(CPU, wall), round 2; CPU alone let sleeping code run
 * every case). Ordinary
 * (fast) wrong answers are judged exactly as before; deliberately slow wrong
 * code can no longer hold a judge slot for minutes.
 */
/** Lets other requests run during long synchronous judging loops (SA-H1). */
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
const YIELD_EVERY_MS = 10;

function createFailureControl(failure) {
  if (!failure || typeof failure.isFailure !== "function") return null;
  const budgetMs = failure.budgetMs ?? readLimit("JUDGE_POST_FAILURE_CPU_BUDGET_MS");
  let firstFailure = Infinity;
  const judged = new Set(); // each index is judged once
  return {
    get failureSeen() {
      return firstFailure !== Infinity;
    },
    /** Takes all results so far (by index); resolves true = start no further chunk. */
    async record(results) {
      let sliceStart = Date.now();
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r || r.status === "Skipped" || judged.has(i)) continue;
        judged.add(i);
        if (i < firstFailure && failure.isFailure(r, i)) firstFailure = i;
        if (Date.now() - sliceStart > YIELD_EVERY_MS) {
          await yieldToEventLoop();
          sliceStart = Date.now();
        }
      }
      if (firstFailure === Infinity) return false;
      let spentMs = 0;
      for (let i = firstFailure + 1; i < results.length; i++) {
        // Sandbox time, not CPU only: sleeping code costs wall time (FV-1).
        spentMs += sandboxCostMs(results[i]);
      }
      return spentMs >= budgetMs;
    },
  };
}

/**
 * Runs `testcases` through runChunk(cases, offset) in chunks of `chunkSize`
 * with up to `concurrency` chunks in flight. Returns results by index
 * (undefined for cases that were never run).
 *  - stopOnTimeout: no chunk starts after one reported a TLE.
 *  - control (createFailureControl): for large tiers a small first chunk
 *    (JUDGE_FIRST_CHUNK_CASES) runs alone, so a failing submission is
 *    detected cheaply; once a failure is known, chunks are small and run one
 *    at a time until the post-failure budget is spent.
 */
async function runInChunks(testcases, runChunk, { chunkSize, concurrency, stopOnTimeout = false, control = null, budget = null }) {
  const results = new Array(testcases.length);
  const smallChunk = Math.min(readLimit("JUDGE_FIRST_CHUNK_CASES"), chunkSize);
  const targetChunkMs = readLimit("JUDGE_TARGET_CHUNK_MS");
  // Indexes still to run. CodeBox's duration cap can return cases as skipped
  // (not a verdict): they go back to the front and run in a later request.
  const pending = testcases.map((_, i) => i);
  let stopped = false;
  let executedCases = 0;
  let executedCostMs = 0;

  // Round 2: one chunk is one CodeBox request and one judge slot. Size it
  // from the observed per-case sandbox time so a request stays near
  // JUDGE_TARGET_CHUNK_MS even for code that sleeps or burns its whole limit.
  const adaptiveSize = (size) => {
    if (executedCases === 0) return size;
    const perCaseMs = Math.max(1, executedCostMs / executedCases);
    return Math.max(1, Math.min(size, Math.floor(targetChunkMs / perCaseMs)));
  };

  const runNext = async (size) => {
    if (budget?.exceeded) {
      stopped = true;
      return;
    }
    const indexes = pending.splice(0, adaptiveSize(size));
    if (indexes.length === 0) return;
    const cases = indexes.map((i) => testcases[i]);
    const chunkResults = await runChunk(cases, indexes[0]);
    const retry = [];
    indexes.forEach((index, k) => {
      const result = chunkResults[k];
      if (result?.status === "Skipped") retry.push(index);
      else results[index] = result;
    });
    const ran = indexes.length - retry.length;
    if (retry.length) {
      pending.unshift(...retry);
      // CodeBox always starts a request's first case; nothing ran means it
      // cannot make progress: stop (unrun cases end up Skipped, never passed).
      if (ran === 0) stopped = true;
    }
    const costMs = sandboxCostMs(chunkResults);
    executedCases += ran;
    executedCostMs += costMs;
    if (budget && chargeEvaluationBudget(budget, costMs)) stopped = true;
    if (stopOnTimeout && chunkResults.some((r) => r?.status === "Time Limit Exceeded")) stopped = true;
    if (control && (await control.record(results))) stopped = true;
  };

  // Large lists start with a small chunk: a failing or slow submission is
  // detected cheaply, and the per-case cost sizes the following chunks.
  if ((control || budget) && testcases.length > smallChunk) await runNext(smallChunk);

  const lane = async (laneIndex) => {
    while (!stopped && pending.length > 0) {
      if (control?.failureSeen) {
        if (laneIndex !== 0) return;
        await runNext(smallChunk);
      } else {
        await runNext(chunkSize);
      }
    }
  };
  const remainingChunks = Math.ceil(pending.length / chunkSize);
  const lanes = Math.max(1, Math.min(concurrency, remainingChunks || 1));
  await Promise.all(Array.from({ length: lanes }, (_, i) => lane(i)));
  return results;
}

/**
 * Total sandbox time one evaluation may use (round 2, JUDGE_EVALUATION_BUDGET_MS),
 * shared by every tier, chunk and execution path of a Run or Submit.
 */
export function createEvaluationBudget(limitMs = readLimit("JUDGE_EVALUATION_BUDGET_MS")) {
  return { limitMs, spentMs: 0, exceeded: false };
}

/** Adds costMs; returns true once the budget is used up. */
function chargeEvaluationBudget(budget, costMs) {
  if (!budget) return false;
  budget.spentMs += Math.max(0, Number(costMs) || 0);
  if (budget.spentMs >= budget.limitMs) budget.exceeded = true;
  return budget.exceeded;
}

/** Splits testcases into harness chunks bounded by case count and stdin bytes. */
function chunkForHarness(testcases) {
  const chunks = [];
  let current = null;
  testcases.forEach((tc, index) => {
    const bytes = Buffer.byteLength(String(tc.stdin ?? tc.stdinSmall ?? tc.input ?? ""), "utf-8") + 16;
    if (
      !current ||
      current.cases.length >= MULTICASE_MAX_CASES_PER_SUBMISSION ||
      (current.cases.length > 0 && current.bytes + bytes > MULTICASE_MAX_STDIN_BYTES)
    ) {
      current = { offset: index, cases: [], bytes: 0 };
      chunks.push(current);
    }
    current.cases.push(tc);
    current.bytes += bytes;
  });
  return chunks;
}

/**
 * Runs testcases through the fork-per-case harness: one compile and one
 * sandbox per chunk. Returns results by index; entries are undefined for cases
 * that did not report (budget ran out). With stopOnTimeout, cases after a
 * definitive TLE come back as "Skipped" and no further chunk is started.
 */
/** One harness run on CodeBox, in a judge slot of the current session (round 2). */
function executeMultiCase(args) {
  return withExecutionSlot(() => executeMultiCaseUnscheduled(args));
}

async function executeMultiCaseUnscheduled({
  language,
  fullCode,
  testcases,
  timeLimit,
  memoryLimit,
  stopOnTimeout = false,
}) {
  const runnerUrl = getCodeboxUrl(true);
  const languageId = LANGUAGE_IDS[language] || 54;
  const headers = { "Content-Type": "application/json" };
  const perCaseMs = Math.max(100, Number(timeLimit) || 2000);
  const memLimitMb = Math.max(1, Number(memoryLimit) || 256);
  const source = Buffer.from(wrapWithHarness(fullCode, language)).toString("base64");

  // The harness stops starting new cases before the budget runs out, so a
  // slow chunk reports partial results instead of being killed; the caller
  // re-runs whatever was not reported.
  // Round 2: no longer than the session's request cap (short while blind),
  // but always long enough to run at least one case.
  const budgetMs = Math.min(
    Math.min(MULTICASE_MAX_CPU_SEC, MULTICASE_MAX_WALL_SEC) * 1000 - 1500,
    Math.max(perCaseMs * 2 + 500, requestDurationCapMs()),
  );
  const chunks = chunkForHarness(testcases);

  const runChunk = async ({ cases }) => {
    const stdins = cases.map(
      (tc) => tc.stdin ?? tc.stdinSmall ?? tc.input ?? "",
    );
    // wait=true: CodeBox holds the request until the run finishes (up to its
    // 30 s sync window), so results arrive without client-side poll delays.
    const created = await fetchCodeboxJson(
      new URL("/submissions?base64_encoded=true&wait=true", runnerUrl),
      {
        method: "POST",
        headers,
        timeoutMs: 40_000,
        body: JSON.stringify({
          source_code: source,
          language_id: languageId,
          stdin: buildHarnessStdin(stdins, perCaseMs, budgetMs, { stopOnTimeout }).toString("base64"),
          cpu_time_limit: MULTICASE_MAX_CPU_SEC,
          wall_time_limit: MULTICASE_MAX_WALL_SEC,
          memory_limit: memLimitMb * 1024,
          max_processes_and_or_threads: 60,
        }),
      },
    );
    const isPending = (s) => !s?.status?.id || [1, 2].includes(Number(s.status.id));
    if (!created || (isPending(created) && !created.token)) {
      throw new ApiError(
        503,
        "Code execution service returned an invalid response.",
        "EXECUTION_UNAVAILABLE",
      );
    }

    const deadline = Date.now() + BATCH_TIMEOUT_MS;
    let interval = MULTICASE_POLL_INITIAL_INTERVAL_MS;
    let sub = created;
    while (isPending(sub)) {
      // Still queued/running after the sync window (or an old server that
      // ignores wait): fall back to polling by token.
      await new Promise((resolve) => setTimeout(resolve, interval));
      const pollUrl = new URL(`/submissions/${created.token}`, runnerUrl);
      pollUrl.searchParams.set("base64_encoded", "true");
      sub = await fetchCodeboxJson(pollUrl, { headers });
      if (!isPending(sub)) break;
      if (Date.now() >= deadline) {
        throw new ApiError(503, "Code execution service timed out.", "EXECUTION_UNAVAILABLE");
      }
      interval = Math.min(BATCH_POLL_MAX_INTERVAL_MS, Math.round(interval * 1.25));
    }

    // The harness request carries every testcase of the chunk; free it from
    // CodeBox's Redis right away instead of letting it sit there for an hour.
    if (created?.token) {
      fetchCodeboxJson(new URL(`/submissions/${created.token}`, runnerUrl), {
        method: "DELETE",
        headers,
        timeoutMs: 5000,
      }).catch(() => {});
    }

    const decode = (v) => (v ? Buffer.from(v, "base64").toString("utf-8") : "");
    const inputBytesOf = (i) => Buffer.byteLength(String(stdins[i] ?? ""), "utf-8");

    // The harness-wrapped source did not compile. Never report that as the
    // user's Compilation Error: the caller re-judges with the plain source.
    if (Number(sub.status?.id) === 6 || (sub.compile_output && !sub.stdout)) {
      const err = new Error(decode(sub.compile_output) || decode(sub.message) || "Compilation failed.");
      err.code = HARNESS_COMPILE_FAILED;
      throw err;
    }
    // Internal CodeBox error (status 13): infrastructure, not the user's code.
    if (Number(sub.status?.id) === 13) {
      throw new ApiError(503, "Code execution service internal error.", "EXECUTION_UNAVAILABLE");
    }

    const parsed = parseHarnessOutput(
      sub.stdout ? Buffer.from(sub.stdout, "base64") : Buffer.alloc(0),
      cases.length,
    );
    if (!parsed) {
      // Harness never started (unexpected environment) - let caller fall back.
      throw new ApiError(503, "Multi-case harness unavailable.", "EXECUTION_UNAVAILABLE");
    }
    const normalized = parsed.map((raw, i) =>
      raw
        ? normalizeHarnessCase(raw, {
            timeLimitMs: perCaseMs,
            memoryLimitMb: memLimitMb,
            inputBytes: inputBytesOf(i),
          })
        : undefined,
    );
    normalized.stoppedOnTimeout = parsed.stoppedOnTimeout;
    return normalized;
  };

  const results = new Array(testcases.length);
  let nextChunk = 0;
  let timedOut = false;
  const worker = async () => {
    while (nextChunk < chunks.length && !timedOut) {
      const chunk = chunks[nextChunk++];
      const chunkResults = await runChunk(chunk);
      chunkResults.forEach((r, i) => {
        results[chunk.offset + i] = r;
      });
      if (stopOnTimeout && chunkResults.some((r) => r?.status === "Time Limit Exceeded")) {
        timedOut = true;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(MAX_CONCURRENT_BATCHES, chunks.length)) }, worker),
  );

  if (timedOut) {
    // Definitive TLE: everything after the first timed-out case is not run.
    const firstTle = results.findIndex((r) => r?.status === "Time Limit Exceeded");
    for (let i = firstTle + 1; i < results.length; i++) {
      results[i] = skippedCaseResult(testcases[i]);
    }
  }
  return results;
}

/**
 * Multi-case execution with re-runs: each round compiles once; the harness
 * reports as many cases as fit in its time budget and later rounds pick up the
 * rest. Anything still unreported runs on the next execution path so verdicts
 * are never guessed.
 */
async function executeMultiCaseRounds({ language, fullCode, testcases, timeLimit, memoryLimit, stopOnTimeout, failure = null, budget = null }) {
  const results = new Array(testcases.length);
  const control = createFailureControl(failure);
  let missing = testcases.map((_, i) => i);
  for (let round = 0; round < MULTICASE_MAX_ROUNDS && missing.length; round++) {
    const roundResults = await executeMultiCase({
      language,
      fullCode,
      testcases: missing.map((i) => testcases[i]),
      timeLimit,
      memoryLimit,
      stopOnTimeout,
    });
    let progressed = false;
    missing.forEach((caseIndex, k) => {
      if (roundResults[k]) {
        results[caseIndex] = roundResults[k];
        progressed = true;
      }
    });
    if (!progressed) break;
    missing = missing.filter((i) => !results[i]);
    // Evaluation budget spent (round 2): the remaining cases are not run.
    if (chargeEvaluationBudget(budget, sandboxCostMs(roundResults)) && missing.length) {
      missing.forEach((i) => {
        results[i] = skippedCaseResult(testcases[i]);
      });
      missing = [];
    }
    if (stopOnTimeout && results.some((r) => r?.status === "Time Limit Exceeded")) {
      missing.forEach((i) => {
        results[i] = skippedCaseResult(testcases[i]);
      });
      missing = [];
    }
    // Post-failure budget spent (SA-H2): the remaining cases are not run.
    if (missing.length && control && (await control.record(results))) {
      missing.forEach((i) => {
        results[i] = skippedCaseResult(testcases[i]);
      });
      missing = [];
    }
  }
  if (missing.length > 0) {
    const rerunIndexes = missing;
    const rerun = await executeCodeBatch({
      language,
      fullCode,
      testcases: missing.map((i) => testcases[i]),
      timeLimit,
      memoryLimit,
      allowMultiCase: false,
      stopOnTimeout,
      failure: failure && {
        isFailure: (result, k) => failure.isFailure(result, rerunIndexes[k]),
        budgetMs: failure.budgetMs,
      },
      budget,
    });
    missing.forEach((caseIndex, k) => {
      results[caseIndex] = rerun[k];
    });
  }
  return results;
}

/**
 * Runs testcases on CodeBox and returns normalized results in input order.
 *
 * Execution paths, in order of preference:
 *   1. C/C++: multi-case harness - compile once, all cases in one sandbox.
 *   2. CodeBox batch API - compile once, one sandbox per case.
 *   3. Legacy per-testcase submissions.
 * Only infrastructure failures fall through to the next path; verdicts about
 * the user's code (WA/RE/TLE/MLE/CE) never do.
 *
 * stopOnTimeout: after a definitive Time Limit Exceeded, remaining cases are
 * not run and come back with status "Skipped".
 */
export async function executeCodeBatch(options) {
  // Background complexity profiling yields while judging is in progress.
  markJudgingStart();
  try {
    return await executeCodeBatchImpl(options);
  } finally {
    markJudgingEnd();
  }
}

async function executeCodeBatchImpl({
  language,
  fullCode,
  testcases,
  timeLimit = 2000,
  memoryLimit = 256,
  allowMultiCase = true,
  stopOnTimeout = false,
  failure = null,
  budget = null,
}) {
  if (!testcases.length) return [];
  if (budget?.exceeded) return testcases.map((tc) => skippedCaseResult(tc));

  const normLang = normalizeLanguage(language);
  if (allowMultiCase && isMultiCaseEnabled() && supportsMultiCase(normLang)) {
    try {
      return await executeMultiCaseRounds({
        language: normLang,
        fullCode,
        testcases,
        timeLimit,
        memoryLimit,
        stopOnTimeout,
        failure,
        budget,
      });
    } catch (err) {
      if (err?.code === HARNESS_COMPILE_FAILED) {
        // Almost always a genuine compile error; the plain path below compiles
        // the unmodified source and reports the real verdict.
      } else if (!isInfrastructureError(err)) {
        throw err;
      } else {
        console.warn("[Execution] Multi-case path unavailable, falling back:", err.message);
      }
    }
  }

  // CodeBox batch API: compiles once and runs every testcase in its own
  // sandbox. Chunks run in parallel; after the first chunk compiles, the
  // others hit CodeBox's build cache.
  if (isCodeboxBatchExecutionEnabled()) {
    try {
      const results = await runInChunks(
        testcases,
        (cases) => executeCodeboxBatchOnce({ language, fullCode, testcases: cases, timeLimit, memoryLimit }),
        {
          chunkSize: MAX_CASES_PER_BATCH,
          concurrency: MAX_CONCURRENT_BATCHES,
          stopOnTimeout,
          control: createFailureControl(failure),
          budget,
        },
      );
      return finishResults(testcases, results, stopOnTimeout);
    } catch (err) {
      if (!isInfrastructureError(err)) {
        throw err;
      }
      // Batch API unavailable (old CodeBox server): fall through.
    }
  }

  // CodeBox is the exclusive execution engine - no local fallback allowed.
  const runnerUrl = getCodeboxUrl(true);

  const languageId = LANGUAGE_IDS[language] || 54;
  const cpuTimeLimit = Math.max(1, Math.ceil(timeLimit / 1000));
  const headers = { "Content-Type": "application/json" };

  // Chunks of at most MAX_CASES_PER_BATCH (20), up to MAX_CONCURRENT_BATCHES
  // in flight; results keep their original order.
  const results = await runInChunks(testcases, (cases) => withExecutionSlot(() => runLegacyChunk(cases)), {
    chunkSize: MAX_CASES_PER_BATCH,
    concurrency: MAX_CONCURRENT_BATCHES,
    stopOnTimeout,
    control: createFailureControl(failure),
    budget,
  });
  return finishResults(testcases, results, stopOnTimeout);

  async function runLegacyChunk(cases) {
    const created = await fetchCodeboxJson(
      new URL("/submissions/batch?base64_encoded=false", runnerUrl),
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          submissions: cases.map((testcase) => ({
            source_code: fullCode,
            language_id: languageId,
            stdin:
              testcase.stdin ?? testcase.stdinSmall ?? testcase.input ?? "",
            cpu_time_limit: cpuTimeLimit,
            wall_time_limit: cpuTimeLimit * 2 + 1,
            memory_limit: memoryLimit * 1024,
          })),
        }),
      },
    );

    const createdSubmissions = Array.isArray(created)
      ? created
      : created.submissions;
    if (
      !Array.isArray(createdSubmissions) ||
      createdSubmissions.length !== cases.length ||
      createdSubmissions.some((submission) => !submission.token)
    ) {
      throw new ApiError(
        503,
        "Code execution service returned an invalid response.",
        "EXECUTION_UNAVAILABLE",
      );
    }

    const tokens = createdSubmissions.map(({ token }) => token);
    const deadline = Date.now() + BATCH_TIMEOUT_MS;
    let completedSubmissions;
    let currentInterval = BATCH_POLL_INITIAL_INTERVAL_MS;

    while (true) {
      const pollUrl = new URL("/submissions/batch", runnerUrl);
      pollUrl.searchParams.set("tokens", tokens.join(","));
      pollUrl.searchParams.set("base64_encoded", "false");
      const polled = await fetchCodeboxJson(pollUrl, { headers });
      const polledSubmissions = Array.isArray(polled)
        ? polled
        : polled.submissions;
      if (!Array.isArray(polledSubmissions)) {
        throw new ApiError(
          503,
          "Code execution service returned an invalid response.",
          "EXECUTION_UNAVAILABLE",
        );
      }

      const byToken = new Map(
        polledSubmissions.map((submission) => [submission.token, submission]),
      );
      completedSubmissions = tokens.map((token) => byToken.get(token));
      if (completedSubmissions.some((submission) => !submission)) {
        throw new ApiError(
          503,
          "Code execution service returned an invalid response.",
          "EXECUTION_UNAVAILABLE",
        );
      }

      const hasPending = completedSubmissions.some((submission) =>
        [1, 2].includes(Number(submission.status?.id)),
      );
      if (!hasPending) break;
      if (Date.now() >= deadline) {
        throw new ApiError(
          503,
          "Code execution service timed out.",
          "EXECUTION_UNAVAILABLE",
        );
      }

      await new Promise((resolve) => setTimeout(resolve, currentInterval));
      // Adaptive backoff up to BATCH_POLL_MAX_INTERVAL_MS
      currentInterval = Math.min(
        BATCH_POLL_MAX_INTERVAL_MS,
        Math.round(currentInterval * 1.35),
      );
    }

    return completedSubmissions.map((sub, i) => {
      const normalized = normalizeRunnerResult(sub);
      const originalCase = cases[i];
      const stdinStr = String(originalCase?.stdin ?? "");
      normalized.inputBytes = Buffer.byteLength(stdinStr, "utf-8");
      return normalized;
    });
  }
}

/** Builds the driver source and runs a single custom-input testcase. */
async function runSingleTestCase({
  problem,
  language,
  code,
  fullCode: providedFullCode,
  stdin,
  timeLimit = 3000,
  memoryLimit = 256,
  expectedOutput = "",
  allowMultiCase = true,
}) {
  const normLang = normalizeLanguage(language);
  if (!normLang) {
    return {
      status: "Compilation Error",
      studentStdout: "",
      actual: "",
      errorText: `Unsupported language: '${language}'. Supported languages: ${SUPPORTED_LANGUAGES.join(", ")}.`,
      timeMs: 0,
      memoryKb: 0,
    };
  }

  let fullCode = providedFullCode;
  if (!fullCode) {
    try {
      fullCode = buildFinalCode(problem, code, normLang);
    } catch (err) {
      return {
        status: "Compilation Error",
        studentStdout: "",
        actual: "",
        errorText: err.message,
        timeMs: 0,
        memoryKb: 0,
      };
    }
  }

  const [result] = await executeCodeBatch({
    language: normLang,
    fullCode,
    testcases: [{ stdin: stdin || "" }],
    timeLimit,
    memoryLimit,
    allowMultiCase,
  });
  return result;
}

function validateCodeSize(studentCode) {
  if (typeof studentCode !== "string" || studentCode.trim().length === 0) {
    throw new ApiError(400, "Code is required.", "MISSING_CODE");
  }
  if (Buffer.byteLength(studentCode, "utf-8") > MAX_CODE_BYTES) {
    throw new ApiError(
      413,
      "Code exceeds maximum allowable size (64 KB).",
      "CODE_TOO_LARGE",
    );
  }
}

/**
 * POST /api/execution/runs or POST /api/problems/:slug/run
 * Executes code against sample (VISIBLE) test cases only.
 * Sequential execution (concurrency 1).
 */
export const runCode = async (req, res, next) => {
  try {
    const slug =
      req.params?.slug ||
      req.body?.slug ||
      req.body?.problemSlug ||
      req.body?.problemId;
    const rawLang =
      req.body?.language ?? req.body?.lang ?? req.query?.language ?? "cpp";
    const normLang = normalizeLanguage(rawLang);

    if (!normLang) {
      throw new ApiError(
        422,
        `Unsupported language: '${rawLang}'. Supported languages: ${SUPPORTED_LANGUAGES.join(", ")}.`,
        "UNSUPPORTED_LANGUAGE",
      );
    }

    const { code, userCode, source_code, sourceCode, stdin } = req.body ?? {};
    const studentCode = userCode || code || source_code || sourceCode;
    validateCodeSize(studentCode);
    const allowMultiCase = isHarnessSafeUserCode(studentCode);

    // If custom stdin is provided without a problem
    if (stdin !== undefined && !slug) {
      if (typeof stdin !== "string") {
        throw new ApiError(400, "stdin must be a string.", "INVALID_STDIN");
      }
      if (Buffer.byteLength(stdin, "utf-8") > MAX_CUSTOM_STDIN_BYTES) {
        throw new ApiError(413, "Custom input exceeds maximum allowable size (64 KB).", "STDIN_TOO_LARGE");
      }
      // One judge session per Run (round 2): its first slot is reserved now,
      // so a saturated judge still answers 503 JUDGE_BUSY right away.
      const session = openJudgeSession({ userId: req.user?.id, accountCreatedAt: req.user?.createdAt });
      let result;
      try {
        await session.reserve();
        result = await runWithJudgeSession(session, () => runSingleTestCase({
          problem: null,
          language: normLang,
          code: studentCode,
          stdin,
          allowMultiCase,
        }));
      } finally {
        session.close();
      }

      return res.status(200).json({
        success: true,
        verdict: result.status === "OK" ? "Accepted" : result.status,
        status: result.status === "OK" ? "Accepted" : result.status,
        passedCount: result.status === "OK" ? 1 : 0,
        totalCount: 1,
        results: [
          {
            index: 0,
            testIndex: 0,
            input: clipText(stdin),
            expected: "",
            actual: clipText(result.actual),
            studentStdout: result.studentStdout,
            status: result.status === "OK" ? "Accepted" : result.status,
            passed: result.status === "OK",
            timeMs: result.timeMs,
            memoryKb: result.memoryKb,
            errorText: clipText(result.errorText),
          },
        ],
      });
    }

    const problem = await resolveProblem(slug);
    if (!problem) {
      throw new ApiError(404, `Problem '${slug}' not found.`, "NOT_FOUND");
    }

    if (!problem.testcases?.length) {
      throw new ApiError(
        422,
        "This problem has no testcases and cannot be accepted.",
        "NO_TESTCASES",
      );
    }

    // Validate function-only submission and build executable source upfront
    const fullCode = buildFinalCode(problem, studentCode, normLang);

    // Filter to strictly VISIBLE testcases only
    const allTestcases = problem.testcases || [];
    const visibleCases = allTestcases.filter((tc) => tc.isVisible === true);

    if (visibleCases.length === 0) {
      throw new ApiError(
        400,
        "No sample test cases configured for this problem.",
        "NO_TESTCASES",
      );
    }

    const session = openJudgeSession({ userId: req.user?.id, accountCreatedAt: req.user?.createdAt });
    let executionResults;
    try {
      await session.reserve();
      executionResults = await runWithJudgeSession(session, () => executeCodeBatch({
        language: normLang,
        fullCode,
        testcases: visibleCases.map((testcase) => ({
          stdin: testcase.stdinSmall ?? testcase.input ?? "",
        })),
        timeLimit: problem.timeLimit || 2000,
        memoryLimit: problem.memoryLimit || 256,
        allowMultiCase,
        budget: createEvaluationBudget(),
      }));
    } finally {
      session.close();
    }

    const results = [];
    let allPassed = true;
    let overallStatus = "Accepted";

    for (let idx = 0; idx < visibleCases.length; idx++) {
      const tc = visibleCases[idx];
      const testInput = tc.stdinSmall || tc.input || "";
      const expectedOutput = tc.expectedSmall || tc.output || "";
      const execResult = executionResults[idx];

      const verdict = judgeTestcase(execResult, expectedOutput);
      const caseStatus = verdict.status;
      const isPassed = verdict.passed;

      if (!isPassed) {
        allPassed = false;
        if (overallStatus === "Accepted") {
          overallStatus = caseStatus;
        }
      }

      results.push({
        index: idx,
        testIndex: tc.testIndex ?? idx,
        isVisible: true,
        input: testInput,
        expected: expectedOutput,
        actual: clipText(execResult.actual),
        studentStdout: execResult.studentStdout,
        status: caseStatus,
        passed: isPassed,
        timeMs: execResult.timeMs,
        cpuTimeMs: execResult.cpuTimeMs ?? execResult.timeMs,
        wallTimeMs: execResult.wallTimeMs ?? execResult.timeMs,
        memoryKb: execResult.memoryKb,
        inputBytes:
          execResult.inputBytes ?? Buffer.byteLength(testInput, "utf-8"),
        errorText: clipText(execResult.errorText),
      });
    }

    const passedCount = results.filter((r) => r.passed).length;

    res.status(200).json({
      success: true,
      verdict: overallStatus,
      status: overallStatus,
      passedCount,
      totalCount: results.length,
      results,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Evaluates testcases for a problem using true tier short-circuiting.
 * Executes Tier 1 first; if any Tier 1 test fails, halts immediately
 * without executing Tier 2 or Tier 3 batches.
 */
// Largest submission sent to CodeBox as a single batch (CodeBox default max 200).
const SINGLE_BATCH_MAX_CASES =
  Number(process.env.CODEBOX_BATCH_MAX_CASES) || 200;

/**
 * Runs all tiers' testcases in one CodeBox batch. Returns per-tier result
 * arrays, or null when the batch API is unavailable (caller falls back to the
 * per-tier loop). Skipped testcases come back with status "Skipped".
 */
async function runAllTiersInOneBatch({ tiers, language, fullCode, timeLimit, memoryLimit }) {
  const total = tiers.reduce((sum, tier) => sum + tier.cases.length, 0);
  if (!isCodeboxBatchExecutionEnabled() || total === 0 || total > SINGLE_BATCH_MAX_CASES) {
    return null;
  }
  // SA-H2: the one-shot batch runs every case even after a wrong answer
  // (CodeBox does not know expected outputs), so it is only used when the
  // worst case (every case near its time limit) is cheap. Larger problems use
  // the per-tier path with its post-failure budget.
  if (total * Math.max(1, Number(timeLimit) || 2000) > readLimit("JUDGE_ONE_SHOT_MAX_COST_MS")) {
    return null;
  }
  try {
    const flat = await executeCodeboxBatchOnce({
      language,
      fullCode,
      testcases: tiers.flatMap((tier, group) =>
        tier.cases.map((testcase) => ({
          stdin: testcase.stdinSmall ?? testcase.input ?? "",
          group,
        })),
      ),
      timeLimit,
      memoryLimit,
      stopOnFailure: true,
      // A slow program stops the one-shot early (skipped cases are re-run per
      // tier below). The one-shot is always a blind request.
      maxDurationMs: readLimit("JUDGE_BLIND_REQUEST_MAX_MS"),
    });
    const perTier = [];
    let offset = 0;
    for (const tier of tiers) {
      perTier.push(flat.slice(offset, offset + tier.cases.length));
      offset += tier.cases.length;
    }
    return perTier;
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.code === "EXECUTION_UNAVAILABLE" &&
      !err.isBatchTimeout
    ) {
      return null;
    }
    throw err;
  }
}

export async function evaluateAllTestcases(problem, language, code, providedFullCode) {
  const normLang = normalizeLanguage(language) || "cpp";
  const rawTestcases = problem.testcases || [];
  const allTestcases = rawTestcases;

  if (allTestcases.length === 0) {
    throw new ApiError(
      422,
      "This problem has no testcases and cannot be accepted.",
      "NO_TESTCASES",
    );
  }

  const fullCode = providedFullCode || buildFinalCode(problem, code, normLang);
  // User code that could subvert the in-binary multi-case harness is judged
  // on the batch path (one sandbox per testcase) instead.
  const allowMultiCase = isHarnessSafeUserCode(code);

  let passedCount = 0;
  let maxTimeMs = 0;
  let maxMemoryKb = 0;
  let firstFailure = null;
  let finalStatus = "ACCEPTED";
  const results = [];
  // Total sandbox time this Submit may use, across all tiers (round 2).
  const budget = createEvaluationBudget();

  const total = allTestcases.length;
  const tier1Count = Math.max(1, Math.floor(total * 0.35));
  const tier2Count = Math.max(tier1Count + 1, Math.floor(total * 0.7));

  const tier1Cases = allTestcases.slice(0, tier1Count);
  const tier2Cases = allTestcases.slice(tier1Count, tier2Count);
  const tier3Cases = allTestcases.slice(tier2Count);

  const tiers = [
    {
      name: "Tier 1",
      cases: tier1Cases,
      rankIfFailed: "Tier 0 (Failed)",
      rankIfPassed: "Tier 1 (Brute Force)",
    },
    {
      name: "Tier 2",
      cases: tier2Cases,
      rankIfFailed: "Tier 1 (Brute Force)",
      rankIfPassed: "Tier 2 (Better)",
    },
    {
      name: "Tier 3",
      cases: tier3Cases,
      rankIfFailed: "Tier 2 (Better)",
      rankIfPassed: "Tier 3 (Optimal)",
    },
  ];

  let tierReached = "Tier 0 (Failed)";
  let shortCircuited = false;

  // One verdict per executed case, shared by the failure control and the
  // result loop below, so no output is compared twice.
  const verdicts = new WeakMap();
  const verdictOf = (result, expected) => {
    if (!result || typeof result !== "object") return judgeTestcase(result, expected);
    let verdict = verdicts.get(result);
    if (!verdict) {
      verdict = judgeTestcase(result, expected);
      verdicts.set(result, verdict);
    }
    return verdict;
  };
  const expectedOf = (testcase) => testcase.expectedSmall || testcase.output || "";

  // Fast path: every tier in ONE CodeBox batch (one request, one compile).
  // Testcases carry their tier as a group; with stop_on_failure CodeBox skips
  // later tiers once a testcase crashes/times out, so failing submissions still
  // stop early. Verdicts below are computed exactly as in the per-tier loop.
  // C/C++ use the multi-case harness instead (one compile, one sandbox per
  // tier) via executeCodeBatch below.
  const multiCasePrimary = allowMultiCase && isMultiCaseEnabled() && supportsMultiCase(normLang);
  const precomputedTierResults = multiCasePrimary ? null : await runAllTiersInOneBatch({
    tiers,
    language: normLang,
    fullCode,
    timeLimit: problem.timeLimit || 2000,
    memoryLimit: problem.memoryLimit || 256,
  });
  if (precomputedTierResults) {
    chargeEvaluationBudget(budget, precomputedTierResults.reduce((sum, tierResults) => sum + sandboxCostMs(tierResults), 0));
  }

  for (const [tierIndex, tier] of tiers.entries()) {
    if (!tier.cases.length || shortCircuited) continue;

    let tierExecResults = precomputedTierResults?.[tierIndex];
    if (
      !tierExecResults ||
      tierExecResults.length !== tier.cases.length ||
      // Any skipped case means the one-shot batch stopped early: re-run the
      // tier so verdicts and passedCount match the per-tier path exactly and
      // a tier can never pass with cases that were not executed.
      tierExecResults.some((r) => !r || r.status === "Skipped")
    ) {
      tierExecResults = await executeCodeBatch({
        language: normLang,
        fullCode,
        testcases: tier.cases.map((testcase) => ({
          stdin: testcase.stdinSmall ?? testcase.input ?? "",
        })),
        timeLimit: problem.timeLimit || 2000,
        memoryLimit: problem.memoryLimit || 256,
        stopOnTimeout: true,
        allowMultiCase,
        failure: {
          isFailure: (result, i) => !verdictOf(result, expectedOf(tier.cases[i])).passed,
        },
        budget,
      });
    }

    let tierHasFailure = false;
    let sliceStart = Date.now();

    for (let idx = 0; idx < tier.cases.length; idx++) {
      // Comparing hundreds of large outputs must not hold the event loop.
      if (Date.now() - sliceStart > YIELD_EVERY_MS) {
        await yieldToEventLoop();
        sliceStart = Date.now();
      }
      const tc = tier.cases[idx];
      const testInput = tc.stdinSmall || tc.input || "";
      const expectedOutput = expectedOf(tc);
      const execResult = tierExecResults[idx];
      // Not run: an earlier case in this tier hit a definitive TLE.
      if (execResult?.status === "Skipped") continue;

      maxTimeMs = Math.max(maxTimeMs, execResult.timeMs || 0);
      maxMemoryKb = Math.max(maxMemoryKb, execResult.memoryKb || 0);

      const verdict = verdictOf(execResult, expectedOutput);
      const isPassed = verdict.passed;
      const failureType = verdict.status;

      const caseItem = {
        testIndex: tc.testIndex ?? results.length,
        input: testInput,
        expected: expectedOutput,
        actual: clipText(execResult.actual),
        passed: isPassed,
        isVisible: tc.isVisible === true,
        time: execResult.timeMs || 0,
        timeMs: execResult.timeMs || 0,
        cpuTimeMs: execResult.cpuTimeMs ?? execResult.timeMs ?? 0,
        wallTimeMs: execResult.wallTimeMs ?? execResult.timeMs ?? 0,
        memory: execResult.memoryKb || 0,
        memoryKb: execResult.memoryKb || 0,
        inputBytes:
          execResult.inputBytes ?? Buffer.byteLength(testInput, "utf-8"),
        status: isPassed ? "Accepted" : failureType,
        errorText: clipText(execResult.errorText),
      };
      results.push(caseItem);

      if (isPassed) {
        passedCount++;
      } else {
        tierHasFailure = true;
        if (!firstFailure) {
          finalStatus = verdictForFailure(failureType);

          const isVisible = Boolean(tc.isVisible);
          firstFailure = {
            testIndex: tc.testIndex ?? results.length - 1,
            status: failureType,
            errorText: isVisible ? clipText(execResult.errorText) : null,
            input: isVisible ? testInput : undefined,
            expected: isVisible ? expectedOutput : undefined,
            actual: isVisible ? clipText(execResult.actual) : undefined,
            message: isVisible
              ? `Failed sample test ${results.length}: expected '${clipText(expectedOutput, 500)}', got '${clipText(execResult.actual, 500)}'`
              : `Failed on hidden evaluation test case #${results.length}.`,
          };
        }
      }
    }

    // Unexecuted cases can never let a tier pass (round 2): skipped without
    // any failure means the evaluation budget or CodeBox's duration cap ran
    // out, i.e. the code is too slow. Judged as Time Limit Exceeded.
    if (!tierHasFailure && tierExecResults.some((r) => !r || r.status === "Skipped")) {
      tierHasFailure = true;
      if (!firstFailure) {
        finalStatus = verdictForFailure("Time Limit Exceeded");
        firstFailure = {
          testIndex: null,
          status: "Time Limit Exceeded",
          budgetExceeded: budget.exceeded,
          errorText: null,
          message: budget.exceeded
            ? `The submission used its total execution time budget (${Math.round(budget.limitMs / 1000)} s of sandbox time) before every test case ran.`
            : "The submission ran too slowly to finish every test case.",
        };
      }
    }

    if (tierHasFailure) {
      tierReached = tier.rankIfFailed;
      shortCircuited = true;
      break;
    } else {
      tierReached = tier.rankIfPassed;
    }
  }

  return {
    status: finalStatus,
    tierReached,
    passedCount,
    totalCount: total,
    maxTimeMs,
    maxMemoryKb,
    firstFailure,
    results,
    sandboxTimeMs: Math.round(budget.spentMs),
    budgetExceeded: budget.exceeded,
  };
}

/**
 * POST /api/execute/submit or POST /api/execution/submissions
 * Submits solution for full evaluation.
 * Returns: { passed, total, results: [{input, expected, actual, passed, time, memory}] }
 */
export const submitSolution = async (req, res, next) => {
  const submittedAt = new Date();
  let releaseJudge = null;
  try {
    const slug =
      req.params?.slug ||
      req.body?.slug ||
      req.body?.problemSlug ||
      req.body?.problemId;
    const rawLang =
      req.body?.language ?? req.body?.lang ?? req.query?.language ?? "cpp";
    const normLang = normalizeLanguage(rawLang);

    if (!normLang) {
      throw new ApiError(
        422,
        `Unsupported language: '${rawLang}'. Supported languages: ${SUPPORTED_LANGUAGES.join(", ")}.`,
        "UNSUPPORTED_LANGUAGE",
      );
    }

    const { code, userCode, source_code, sourceCode, wait } = req.body ?? {};
    const studentCode = userCode || code || source_code || sourceCode;
    const userId = req.user?.id || null;
    // Every execution route requires authentication; never judge anonymously.
    if (!userId) {
      throw new ApiError(401, "Please log in to submit solutions.", "UNAUTHORIZED");
    }
    validateCodeSize(studentCode);

    const problem = await resolveProblem(slug);
    if (!problem) {
      throw new ApiError(404, `Problem '${slug}' not found.`, "NOT_FOUND");
    }

    // Reject up front rather than storing a submission that can only error out.
    if (!problem.testcases?.length) {
      throw new ApiError(
        422,
        "This problem has no testcases and cannot be accepted.",
        "NO_TESTCASES",
      );
    }

    // Validate function-only submission and build executable source upfront
    const fullCode = buildFinalCode(problem, studentCode, normLang);
    const totalTcs = (problem.testcases || []).length;

    // If wait=true or route is /api/execute/submit (synchronous evaluation)
    const isDirectExecuteRoute =
      req.originalUrl?.includes("/execute/submit") ||
      wait === true ||
      req.query?.wait === "true" ||
      req.path === "/submit";

    // The same code for the same problem is already being judged in the
    // background: hand back that submission instead of judging it twice.
    const dedupeKey = `${userId}|${problem.id}|${normLang}|${crypto
      .createHash("sha256")
      .update(studentCode)
      .digest("hex")}`;
    if (!isDirectExecuteRoute) {
      const pending = pendingSubmissions.get(dedupeKey);
      if (pending) {
        return res.status(202).json({ ...queuedSubmissionResponse(pending.submissionId, problem), deduplicated: true });
      }
    }

    // Cross-instance per-user cap (database), then backend-wide judge
    // admission (per-user share, 503 JUDGE_BUSY when saturated), before
    // anything is stored.
    await assertSubmissionCapacity(userId);
    // One judge session per Submit (round 2). Its first slot is reserved
    // before anything is stored (503 JUDGE_BUSY synchronously); every later
    // CodeBox request of the evaluation takes its own slot.
    const judgeSession = openJudgeSession({ userId, accountCreatedAt: req.user?.createdAt });
    releaseJudge = () => judgeSession.close();
    await judgeSession.reserve();

    let submission;
    try {
      submission = await prisma.submission.create({
        data: {
          problemId: problem.id,
          userId,
          language: normLang,
          code: studentCode,
          status: "PROCESSING",
          passedCount: 0,
          totalCount: totalTcs,
        },
        select: {
          id: true,
          problemId: true,
          userId: true,
          language: true,
          status: true,
          passedCount: true,
          totalCount: true,
          createdAt: true,
        },
      });
    } catch {
      throw new ApiError(
        503,
        "Unable to save this submission. Please try again.",
        "SUBMISSION_STORAGE_UNAVAILABLE",
      );
    }
    submissionCache.set(submission.id, {
      ...submission,
      problem: { slug: problem.slug, title: problem.title },
    });

    // "Already solved?" lookup, overlapped with execution: an accepted
    // re-submit of a solved problem earns nothing, so it can skip the reward
    // transaction entirely.
    const priorSolvePromise = prisma.userProblemProgress
      .findUnique({
        where: { userId_problemId: { userId, problemId: problem.id } },
        select: {
          user: {
            select: { rating: true, score: true, coins: true, streak: true, longestStreak: true },
          },
        },
      })
      .catch(() => null);

    // Reads a first solve's reward needs (rating, solved count), also done
    // while the code runs, so the reward transaction only has to write.
    const rewardPrefetchPromise = priorSolvePromise.then((priorSolve) =>
      !priorSolve
        ? Promise.all([
          prisma.user.findUnique({ where: { id: userId }, select: REWARD_USER_SELECT }),
          prisma.userProblemProgress.count({ where: { userId } }),
        ]).then(([user, completedBefore]) => (user ? { user, completedBefore } : null))
        : null,
    ).catch(() => null);

    const runEvaluation = async () => {
      let evaluation;
      try {
        evaluation = await runWithJudgeSession(judgeSession, () => evaluateAllTestcases(
          problem,
          normLang,
          studentCode,
          fullCode,
        ));
      } finally {
        // The judge session only covers CodeBox work.
        releaseJudge?.();
        releaseJudge = null;
      }
      let updated = {
        ...submission,
        status: evaluation.status,
        verdict: evaluation.status,
        passedCount: evaluation.passedCount,
        totalCount: evaluation.totalCount,
        time: `${evaluation.maxTimeMs}ms`,
        memory: evaluation.maxMemoryKb,
        tierReached: evaluation.tierReached,
        firstFailure: evaluation.firstFailure,
        results: evaluation.results,
      };

      const isAccepted =
        evaluation.status === "ACCEPTED" &&
        evaluation.totalCount > 0 &&
        evaluation.passedCount === evaluation.totalCount;

      // Complexity is only meaningful after every visible and hidden testcase
      // has passed; Run only evaluates visible cases and never analyzes it.
      const complexityTask = isAccepted
        ? analyzeComplexitySafe({
          code: studentCode,
          language: normLang,
          problemSlug: problem.slug,
          executionResult: {
            timeMs: evaluation.maxTimeMs,
            memoryKb: evaluation.maxMemoryKb,
          },
          include: ["time", "space"],
        })
        : Promise.resolve(null);

      // 1. The verdict is persisted first. Rewards are derived from a stored
      //    verdict only, so a failed verdict write can never leave score,
      //    rating or coins granted for a submission that shows ERROR.
      let dbUpdated;
      try {
        dbUpdated = await prisma.submission.update({
          where: { id: submission.id },
          data: {
            status: evaluation.status,
            passedCount: evaluation.passedCount,
            totalCount: evaluation.totalCount,
            time: `${evaluation.maxTimeMs}ms`,
            memory: evaluation.maxMemoryKb,
          },
          select: {
            id: true,
            status: true,
            passedCount: true,
            totalCount: true,
            time: true,
            memory: true,
          },
        });
      } catch {
        throw new ApiError(
          503,
          "Unable to save the submission verdict. Please try again.",
          "SUBMISSION_STORAGE_UNAVAILABLE",
        );
      }

      // 2. Rewards (user/progress/coins) and the problem's solved count touch
      //    different rows, so they run in parallel. Both are idempotent.
      const rewardsChain = async () => {
        let reward = null;
        let rewardError = false;
        let dailyProblemReward = { granted: false, coins: 0 };
        if (!isAccepted) return { reward, rewardError, dailyProblemReward };

        const priorSolve = await priorSolvePromise;
        try {
          if (priorSolve?.user) {
            // Already solved: no points/rating change, same response shape.
            reward = {
              awarded: false,
              points: 0,
              scoreDelta: 0,
              coinsEarned: 0,
              stats: getUserHeaderStats(priorSolve.user),
            };
          } else {
            const prefetched = await rewardPrefetchPromise;
            reward = await prisma.$transaction((tx) =>
              applyAcceptedSubmissionReward(tx, { userId, problem, prefetched }),
            );
          }
          rewardError = !reward;
        } catch (rewardDbErr) {
          rewardError = true;
          console.error(
            `[Submission Rewards] Failed to save rewards for submission ${submission.id}:`,
            rewardDbErr?.code || rewardDbErr?.message || rewardDbErr,
          );
        }

        // Never throws; counts for the IST day the code was submitted on.
        const dpReward = await recordDailyProblemCompletion({
          userId,
          problemId: problem.id,
          submissionId: submission.id,
          submittedAt,
        });
        dailyProblemReward = { granted: dpReward.granted, coins: dpReward.coins };
        if (dpReward.granted && reward?.stats) {
          reward.stats.coins = dpReward.balance;
          reward.stats.streak = dpReward.streak;
          reward.stats.longestStreak = dpReward.longestStreak;
          reward.coinsEarned = (Number(reward.coinsEarned) || 0) + dpReward.coins;
        }
        return { reward, rewardError, dailyProblemReward };
      };

      const solvedCountChain = async () => {
        // Counts ACCEPTED rows, so it runs after the verdict update. A user
        // who had already solved this problem is already counted.
        if (!isAccepted || (await priorSolvePromise)) return;
        try {
          const solvedCount = await syncProblemSolvedCount(prisma, problem.id);
          updateCachedProblemSolvedCount(problem.id, solvedCount);
        } catch (syncError) {
          console.error(
            `[Problem solved count] Failed to update problem ${problem.id}:`,
            syncError?.message || syncError,
          );
        }
      };

      const [rewards] = await Promise.all([rewardsChain(), solvedCountChain()]);
      updated = {
        ...dbUpdated,
        ...updated,
        ...rewards,
      };

      const complexity = await complexityTask;

      // Empirical complexity profiling runs in the background and never
      // delays or changes this verdict. The response only announces it.
      let complexityProfile = null;
      if (isAccepted) {
        const eligibility = profilingEligibility({ problemSlug: problem.slug, language: normLang });
        if (eligibility.eligible) {
          complexityProfile = {
            status: "PENDING",
            url: `/api/execution/submissions/${submission.id}/complexity`,
          };
          enqueueComplexityProfile({
            submissionId: submission.id,
            problemSlug: problem.slug,
            language: normLang,
          });
        }
      }

      updated = {
        ...updated,
        ...(complexity ? { complexity } : {}),
        complexityProfile,
      };

      submissionCache.set(submission.id, updated);

      return updated;
    };

    if (isDirectExecuteRoute) {
      let completed;
      try {
        completed = await runEvaluation();
      } catch (evaluationErr) {
        // Never leave a synchronous submission PROCESSING forever.
        await prisma.submission
          .update({ where: { id: submission.id }, data: { status: "ERROR" } })
          .catch(() => {});
        throw evaluationErr;
      }

      return res.status(200).json({
        success: true,
        submissionId: submission.id,
        verdict: completed.status,
        status: completed.status,
        tierReached: completed.tierReached,
        passedCount: completed.passedCount,
        totalCount: completed.totalCount,
        time: completed.time || `${completed.maxTimeMs}ms`,
        memory: completed.memory || completed.maxMemoryKb,
        results: publicTestResults(completed.results || []),
        firstFailure: completed.firstFailure || null,
        ...(completed.status === "ACCEPTED" && completed.complexity
          ? { complexity: compactComplexitySummary(completed.complexity) }
          : {}),
        complexityProfile: completed.complexityProfile || null,
        reward: completed.reward || null,
        rewardError: completed.rewardError || false,
        dailyProblemReward: completed.dailyProblemReward || { granted: false, coins: 0 },
        problem: {
          slug: problem.slug,
          title: problem.title,
        },
      });
    }

    // Keep the per-user execution slot until the background job settles.
    const releaseInFlight = req.holdInFlightSlot?.();
    pendingSubmissions.set(dedupeKey, { submissionId: submission.id });
    const job = runEvaluation()
      .catch((err) => {
        console.error("[Submission Background Error]:", err?.code || err?.name || "Error");
        submissionCache.set(submission.id, {
          ...submission,
          status: "ERROR",
          verdict: "ERROR",
        });
        return prisma.submission
          .update({
            where: { id: submission.id },
            data: { status: "ERROR" },
          })
          .catch(() => {});
      })
      .finally(() => {
        if (pendingSubmissions.get(dedupeKey)?.submissionId === submission.id) {
          pendingSubmissions.delete(dedupeKey);
        }
        releaseInFlight?.();
        activeEvaluations.delete(job);
      });
    activeEvaluations.add(job);

    res.status(202).json(queuedSubmissionResponse(submission.id, problem));
  } catch (err) {
    // Synchronous failures before the evaluation took over the slot.
    releaseJudge?.();
    releaseJudge = null;
    next(err);
  }
};

/**
 * GET /api/execution/submissions/:id
 * Polls status and verdict of a submission.
 */
export const getSubmissionStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    // Per-case results, tier, rewards and complexity are not columns of the
    // submissions table; they come from the in-memory submissionCache below.
    let submission = await prisma.submission.findUnique({
      where: { id },
      select: {
        id: true,
        problemId: true,
        userId: true,
        language: true,
        code: true,
        status: true,
        passedCount: true,
        totalCount: true,
        time: true,
        memory: true,
        createdAt: true,
        problem: {
          select: {
            slug: true,
            title: true,
          },
        },
      },
    });

    if (!submission) {
      throw new ApiError(404, "Submission not found.", "SUBMISSION_NOT_FOUND");
    }

    const cachedSubmission = submissionCache.get(id);
    if (cachedSubmission) {
      submission = {
        ...submission,
        results: cachedSubmission.results,
        complexity: cachedSubmission.complexity,
        firstFailure: cachedSubmission.firstFailure,
        tierReached: cachedSubmission.tierReached,
        reward: cachedSubmission.reward,
        dailyProblemReward: cachedSubmission.dailyProblemReward,
        problem: submission.problem || cachedSubmission.problem,
      };
    }

    // Authenticated users may only inspect submissions explicitly owned by them.
    if (!req.user?.id || submission.userId !== req.user.id) {
      throw new ApiError(404, "Submission not found.", "SUBMISSION_NOT_FOUND");
    }

    let complexityProfile = cachedSubmission?.complexityProfile || null;
    if (submission.status === "ACCEPTED") {
      const row = await prisma.complexityProfile
        .findUnique({
          where: { submissionId: submission.id },
          select: { status: true, timeComplexity: true, spaceComplexity: true, confidence: true },
        })
        .catch(() => null);
      if (row) {
        complexityProfile = {
          ...row,
          url: `/api/execution/submissions/${submission.id}/complexity`,
        };
      }
    }

    const total = submission.totalCount || 1;
    const passed = submission.passedCount || 0;
    let tierReached = submission.tierReached || "Tier 0 (Failed)";
    if (!submission.tierReached) {
      if (submission.status === "ACCEPTED") {
        tierReached = "Tier 3 (Optimal)";
      } else if (passed >= Math.floor(total * 0.7)) {
        tierReached = "Tier 2 (Better)";
      } else if (passed >= Math.floor(total * 0.35)) {
        tierReached = "Tier 1 (Brute Force)";
      }
    }

    res.status(200).json({
      success: true,
      submission: {
        id: submission.id,
        problemId: submission.problemId,
        language: submission.language,
        verdict: submission.status,
        status: submission.status,
        tierReached,
        passedCount: submission.passedCount,
        totalCount: submission.totalCount,
        time: submission.time || "0ms",
        memory: submission.memory || 0,
        createdAt: submission.createdAt,
        firstFailure: submission.firstFailure || null,
        results: publicTestResults(submission.results || []),
        ...((submission.status === "ACCEPTED" &&
          (cachedSubmission?.complexity || submission.complexity))
          ? {
            complexity: compactComplexitySummary(
              cachedSubmission?.complexity || submission.complexity,
            ),
          }
          : {}),
        complexityProfile,
        reward: submission.reward || null,
        rewardError: submission.rewardError || false,
        dailyProblemReward: submission.dailyProblemReward || { granted: false, coins: 0 },
        problem: {
          slug: submission.problem?.slug || "problem",
          title: submission.problem?.title || "Problem",
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/execution/analyze-complexity
 * Standalone complexity analysis endpoint.
 */
export const getComplexityAnalysis = async (req, res, next) => {
  try {
    const { code, userCode, source_code, language, lang, slug, problemSlug } =
      req.body ?? {};
    const studentCode = userCode || code || source_code;
    const rawLang = language || lang || "python";
    const normLang = normalizeLanguage(rawLang);
    if (!normLang) {
      throw new ApiError(
        422,
        `Unsupported language: '${rawLang}'. Supported languages: ${SUPPORTED_LANGUAGES.join(", ")}.`,
        "UNSUPPORTED_LANGUAGE",
      );
    }
    const problemId = slug || problemSlug || "";

    if (typeof studentCode !== "string" || !studentCode.trim()) {
      throw new ApiError(400, "Code is required.", "MISSING_CODE");
    }
    if (Buffer.byteLength(studentCode, "utf-8") > MAX_ANALYZE_CODE_BYTES) {
      throw new ApiError(413, "Code exceeds maximum allowable size (64 KB).", "CODE_TOO_LARGE");
    }

    // Runs in a worker thread with a hard timeout: an adversarial input can
    // cost at most one worker for COMPLEXITY_TIMEOUT_MS, never the event loop.
    const complexity = await analyzeComplexitySafe({
      code: studentCode,
      language: normLang,
      problemSlug: String(problemId),
    });

    res.status(200).json({
      success: true,
      complexity,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/execution/submissions/:id/complexity
 * Empirical complexity profile of a submission (owner only, like the
 * submission itself). Status: PENDING | RUNNING | COMPLETED | INCONCLUSIVE |
 * FAILED, or UNAVAILABLE when the submission is not profiled.
 */
export const getSubmissionComplexity = async (req, res, next) => {
  try {
    const { id } = req.params;
    const submission = await prisma.submission.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true, language: true, problem: { select: { slug: true } } },
    });
    // Same rule as GET /submissions/:id: only the owner, 404 otherwise.
    if (!submission || !req.user?.id || submission.userId !== req.user.id) {
      throw new ApiError(404, "Submission not found.", "SUBMISSION_NOT_FOUND");
    }

    const profile = await prisma.complexityProfile.findUnique({ where: { submissionId: id } });
    if (!profile) {
      const eligibility =
        submission.status === "ACCEPTED"
          ? profilingEligibility({ problemSlug: submission.problem?.slug, language: submission.language })
          : { eligible: false, reason: "Only accepted submissions are profiled." };
      return res.status(200).json({
        success: true,
        submissionId: id,
        status: "UNAVAILABLE",
        reason: eligibility.eligible ? "Profiling was not scheduled for this submission." : eligibility.reason,
      });
    }

    const analysis = profile.analysis || {};
    const finished = ["COMPLETED", "INCONCLUSIVE", "FAILED"].includes(profile.status);
    res.status(200).json({
      success: true,
      submissionId: id,
      status: profile.status,
      language: profile.language,
      time: profile.timeComplexity
        ? {
            complexity: profile.timeComplexity,
            confidence: profile.timeConfidence,
            method: analysis.time?.method || "raw",
          }
        : null,
      space: profile.spaceComplexity
        ? {
            complexity: profile.spaceComplexity,
            confidence: profile.spaceConfidence,
            kind: "auxiliary (estimate)",
            outputSpace: analysis.space?.outputSpace || null,
          }
        : null,
      confidence: profile.confidence,
      worstCase: analysis.worstCase ?? null,
      notes: analysis.notes || [],
      inputSizes: profile.inputSizes || [],
      measurements: finished
        ? {
            time: (analysis.time?.points || []).map((p) => ({
              n: p.n,
              functionNs: Math.round(p.cost),
              referenceNs: p.refCost != null ? Math.round(p.refCost) : null,
              repetitionsNs: (p.raw || []).map(Math.round),
              spread: p.spread,
            })),
            space: (analysis.space?.points || []).map((p) => ({
              n: p.n,
              auxiliaryBytes: p.cost,
              heapBytes: p.heapBytes,
              stackBytes: p.stackBytes,
              outputBytes: p.outputBytes,
              peakRssKb: p.userRssKb,
              baselineRssKb: p.baselineRssKb,
            })),
            fits: { time: analysis.time?.fits || [], space: analysis.space?.fits || [] },
            raw: profile.measurements || [],
          }
        : null,
      failureReason: profile.failureReason,
      attempts: profile.attempts,
      durationMs: profile.durationMs,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    });
  } catch (err) {
    next(err);
  }
};
