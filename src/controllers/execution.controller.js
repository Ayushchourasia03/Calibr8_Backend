import crypto from "crypto";
import prisma from "../config/db.js";
import { areOutputsEqual } from "../utils/outputComparator.js";
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
import { acquireJudgeSlot } from "../utils/judgeAdmission.js";
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
export async function recoverStaleSubmissions(now = Date.now()) {
  try {
    const { count } = await prisma.submission.updateMany({
      where: { status: "PROCESSING", createdAt: { lt: new Date(now - STALE_PROCESSING_MS) } },
      data: { status: "ERROR" },
    });
    if (count) console.warn(`[Submissions] Marked ${count} abandoned PROCESSING submission(s) as ERROR.`);
    return count;
  } catch (err) {
    console.error("[Submissions] Stale-submission recovery failed:", err.message);
    return 0;
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

async function executeCodeboxBatchOnce({
  language,
  fullCode,
  testcases,
  timeLimit = 2000,
  memoryLimit = 256,
  stopOnFailure = false,
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

  const results = testcases.map((_, index) => {
    const rawResult = byIndex.get(index) || rawResults[index] || {};
    const fallback = {
      index,
      status:
        batchStatus?.status === "compile_failed" ||
        batchStatus?.status === "COMPILE_FAILED"
          ? "Compilation Error"
          : "Runtime Error",
      stderr:
        batchStatus?.status === "compile_failed" ||
        batchStatus?.status === "COMPILE_FAILED"
          ? batchStatus?.compileError || batchStatus?.error || ""
          : batchStatus?.message || "",
      stdout: "",
      exitCode: 1,
    };

    return {
      ...normalizeBatchResult({ ...fallback, ...rawResult }, index, {
        memoryLimitKb: payload.limits.memory_limit,
        cpuLimitMs: payload.limits.cpu_time_limit * 1000,
      }),
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
 * Flattens per-chunk results. Chunks never started (after a TLE) become
 * "Skipped"; with stopOnTimeout every case after the first TLE is "Skipped" too,
 * so the outcome does not depend on which parallel chunk finished first.
 */
function finishAfterTimeout(chunks, chunkResults, stopOnTimeout) {
  const cases = chunks.flat();
  const flat = [];
  chunks.forEach((chunk, i) => {
    chunk.forEach((tc, k) => flat.push(chunkResults[i] ? chunkResults[i][k] : skippedCaseResult(tc)));
  });
  if (stopOnTimeout) {
    const first = flat.findIndex((r) => r?.status === "Time Limit Exceeded");
    if (first >= 0) {
      for (let i = first + 1; i < flat.length; i++) flat[i] = skippedCaseResult(cases[i]);
    }
  }
  return flat;
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
async function executeMultiCase({
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
  const budgetMs =
    Math.min(MULTICASE_MAX_CPU_SEC, MULTICASE_MAX_WALL_SEC) * 1000 - 1500;
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
async function executeMultiCaseRounds({ language, fullCode, testcases, timeLimit, memoryLimit, stopOnTimeout }) {
  const results = new Array(testcases.length);
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
    if (stopOnTimeout && results.some((r) => r?.status === "Time Limit Exceeded")) {
      missing.forEach((i) => {
        results[i] = skippedCaseResult(testcases[i]);
      });
      missing = [];
    }
  }
  if (missing.length > 0) {
    const rerun = await executeCodeBatch({
      language,
      fullCode,
      testcases: missing.map((i) => testcases[i]),
      timeLimit,
      memoryLimit,
      allowMultiCase: false,
      stopOnTimeout,
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
}) {
  if (!testcases.length) return [];

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
      const chunks = [];
      for (let offset = 0; offset < testcases.length; offset += MAX_CASES_PER_BATCH) {
        chunks.push(testcases.slice(offset, offset + MAX_CASES_PER_BATCH));
      }
      const chunkResults = new Array(chunks.length);
      let nextChunk = 0;
      let timedOut = false;
      const worker = async () => {
        while (nextChunk < chunks.length && !timedOut) {
          const chunkIndex = nextChunk++;
          chunkResults[chunkIndex] = await executeCodeboxBatchOnce({
            language,
            fullCode,
            testcases: chunks[chunkIndex],
            timeLimit,
            memoryLimit,
          });
          if (stopOnTimeout && chunkResults[chunkIndex].some((r) => r?.status === "Time Limit Exceeded")) {
            timedOut = true;
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(MAX_CONCURRENT_BATCHES, chunks.length) }, worker),
      );
      return finishAfterTimeout(chunks, chunkResults, stopOnTimeout);
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

  // Slices testcases into chunks of at most MAX_CASES_PER_BATCH (20).
  const chunks = [];
  for (
    let offset = 0;
    offset < testcases.length;
    offset += MAX_CASES_PER_BATCH
  ) {
    chunks.push(testcases.slice(offset, offset + MAX_CASES_PER_BATCH));
  }

  // Run up to MAX_CONCURRENT_BATCHES chunks at once instead of strictly one
  // after another; results keep their original order.
  const chunkResults = new Array(chunks.length);
  let nextChunk = 0;
  let timedOut = false;
  const worker = async () => {
    while (nextChunk < chunks.length && !timedOut) {
      const chunkIndex = nextChunk++;
      chunkResults[chunkIndex] = await runLegacyChunk(chunks[chunkIndex]);
      if (stopOnTimeout && chunkResults[chunkIndex].some((r) => r?.status === "Time Limit Exceeded")) {
        timedOut = true;
      }
    }
  };
  const workerCount = Math.max(
    1,
    Math.min(MAX_CONCURRENT_BATCHES, chunks.length),
  );
  await Promise.all(Array.from({ length: workerCount }, worker));
  return finishAfterTimeout(chunks, chunkResults, stopOnTimeout);

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

    const { code, userCode, source_code, sourceCode, stdin } = req.body;
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
      const release = await acquireJudgeSlot();
      let result;
      try {
        result = await runSingleTestCase({
          problem: null,
          language: normLang,
          code: studentCode,
          stdin,
          allowMultiCase,
        });
      } finally {
        release();
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

    const release = await acquireJudgeSlot();
    let executionResults;
    try {
      executionResults = await executeCodeBatch({
        language: normLang,
        fullCode,
        testcases: visibleCases.map((testcase) => ({
          stdin: testcase.stdinSmall ?? testcase.input ?? "",
        })),
        timeLimit: problem.timeLimit || 2000,
        memoryLimit: problem.memoryLimit || 256,
        allowMultiCase,
      });
    } finally {
      release();
    }

    const results = [];
    let allPassed = true;
    let overallStatus = "Accepted";

    for (let idx = 0; idx < visibleCases.length; idx++) {
      const tc = visibleCases[idx];
      const testInput = tc.stdinSmall || tc.input || "";
      const expectedOutput = tc.expectedSmall || tc.output || "";
      const execResult = executionResults[idx];

      let caseStatus = execResult.status;
      let isPassed = false;

      if (caseStatus === "OK") {
        isPassed = areOutputsEqual(execResult.actual, expectedOutput);
        caseStatus = isPassed ? "Accepted" : "Wrong Answer";
      }

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

    // Off the event loop, with a hard timeout (never throws).
    const complexity = await analyzeComplexitySafe({
      code: studentCode,
      language: normLang,
      problemSlug: problem.slug,
      executionResult: {
        timeMs: Math.max(...results.map((r) => r.timeMs || 0), 0),
        memoryKb: Math.max(...results.map((r) => r.memoryKb || 0), 0),
      },
      include: ["time", "space"], // Compact static analysis without dynamic evidence overhead
    });

    res.status(200).json({
      success: true,
      verdict: overallStatus,
      status: overallStatus,
      passedCount,
      totalCount: results.length,
      results,
      complexity: compactComplexitySummary(complexity),
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

  for (const [tierIndex, tier] of tiers.entries()) {
    if (!tier.cases.length || shortCircuited) continue;

    let tierExecResults = precomputedTierResults?.[tierIndex];
    if (
      !tierExecResults ||
      tierExecResults.length !== tier.cases.length ||
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
      });
    }

    let tierHasFailure = false;

    for (let idx = 0; idx < tier.cases.length; idx++) {
      const tc = tier.cases[idx];
      const testInput = tc.stdinSmall || tc.input || "";
      const expectedOutput = tc.expectedSmall || tc.output || "";
      const execResult = tierExecResults[idx];
      // Not run: an earlier case in this tier hit a definitive TLE.
      if (execResult?.status === "Skipped") continue;

      maxTimeMs = Math.max(maxTimeMs, execResult.timeMs || 0);
      maxMemoryKb = Math.max(maxMemoryKb, execResult.memoryKb || 0);

      let isPassed = false;
      let failureType = execResult.status;

      if (execResult.status === "OK") {
        isPassed = areOutputsEqual(execResult.actual, expectedOutput);
        if (!isPassed) failureType = "Wrong Answer";
      }

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

    const { code, userCode, source_code, sourceCode, wait } = req.body;
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

    // Backend-wide judge admission (503 JUDGE_BUSY when saturated), before
    // anything is stored.
    releaseJudge = await acquireJudgeSlot();

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

    // If wait=true or route is /api/execute/submit (synchronous evaluation)
    const isDirectExecuteRoute =
      req.originalUrl?.includes("/execute/submit") ||
      wait === true ||
      req.query?.wait === "true" ||
      req.path === "/submit";

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
        evaluation = await evaluateAllTestcases(
          problem,
          normLang,
          studentCode,
          fullCode,
        );
      } finally {
        // The judge slot only covers CodeBox work.
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

      // Off the event loop with a hard timeout; never throws.
      const complexityTask = analyzeComplexitySafe({
        code: studentCode,
        language: normLang,
        problemSlug: problem.slug,
        executionResult: {
          timeMs: evaluation.maxTimeMs,
          memoryKb: evaluation.maxMemoryKb,
        },
        include: ["time", "space"],
      });

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
        complexity,
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
        complexity: compactComplexitySummary(completed.complexity),
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
        releaseInFlight?.();
        activeEvaluations.delete(job);
      });
    activeEvaluations.add(job);

    res.status(202).json({
      success: true,
      submissionId: submission.id,
      verdict: "QUEUED",
      status: "QUEUED",
      pollUrl: `/api/execution/submissions/${submission.id}`,
      message: "Submission received and queued for execution.",
      problem: {
        slug: problem.slug,
        title: problem.title,
      },
    });
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
        complexity: compactComplexitySummary(
          cachedSubmission?.complexity || submission.complexity || null,
        ),
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
      req.body;
    const studentCode = userCode || code || source_code;
    const rawLang = language || lang || "python";
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
      language: String(rawLang),
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
