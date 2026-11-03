import crypto from "crypto";
import prisma from "../config/db.js";
import { areOutputsEqual } from "../utils/outputComparator.js";
import {
  buildFinalCode,
  LANGUAGE_IDS,
  normalizeLanguage,
  SUPPORTED_LANGUAGES,
} from "../utils/codeBuilder.js";
import { resolveProblem } from "../utils/problemResolver.js";
import { ApiError } from "../utils/ApiError.js";
import { syncProblemSolvedCount } from "../utils/problemSolvedCount.js";
import { applyAcceptedSubmissionReward } from "../utils/acceptedSubmissionReward.js";
import { publicTestResults } from "../utils/testcaseResults.js";
import { analyzeComplexity } from "../services/complexityAnalyzer.service.js";

const submissionCache = new Map();
const MAX_CASES_PER_BATCH = 20;
const BATCH_POLL_INITIAL_INTERVAL_MS = 250;
const BATCH_POLL_MAX_INTERVAL_MS = 800;
const BATCH_TIMEOUT_MS = 60 * 1000;
const MAX_CONCURRENT_BATCHES = Number(process.env.CODEBOX_MAX_CONCURRENT_BATCHES) || 2;

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


function getCodeboxUrl(required = true) {
  const codeboxUrl = process.env.CODEBOX_URL;
  const codeboxToken = process.env.CODEBOX_TOKEN;

  if (!codeboxUrl || !codeboxToken) {
    if (!required) return null;
    throw new ApiError(
      503,
      "Code execution service is unavailable.",
      "EXECUTION_UNAVAILABLE",
    );
  }

  let runnerUrl;

  try {
    runnerUrl = new URL(codeboxUrl);
  } catch {
    if (!required) return null;
    throw new ApiError(
      503,
      "Code execution service is unavailable.",
      "EXECUTION_UNAVAILABLE",
    );
  }

  const isHttps = runnerUrl.protocol === "https:";
  const isHttp = runnerUrl.protocol === "http:";
  const allowInsecureHttp =
    process.env.CODEBOX_ALLOW_INSECURE_HTTP === "true";

  if (!isHttps && !(isHttp && allowInsecureHttp)) {
    if (!required) return null;
    throw new ApiError(
      503,
      "Code execution service is unavailable.",
      "EXECUTION_UNAVAILABLE",
    );
  }

  return runnerUrl;
}


async function fetchCodeboxJson(url, options = {}) {
  const codeboxToken = process.env.CODEBOX_TOKEN;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, {
      ...options,
      redirect: "error",
      headers: {
        "X-Auth-Token": codeboxToken,
        ...options.headers,
      },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(
        500,
        "Code execution service authentication failed.",
        "EXECUTION_AUTH_FAILED",
      );
    }
    if (!response.ok) {
      throw new ApiError(
        503,
        "Code execution service returned an error status.",
        "EXECUTION_UNAVAILABLE",
      );
    }
    return await response.json();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(
      503,
      "Code execution service is unavailable.",
      "EXECUTION_UNAVAILABLE",
    );
  } finally {
    clearTimeout(timeout);
  }
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
  const wallTimeMs = Math.round(parseFloat(data.wall_time || data.time || "0") * 1000);
  const memoryKb = Number(data.memory) || 0;
  const exitCode = data.exit_code !== undefined ? Number(data.exit_code) : (status === "OK" ? 0 : 1);

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

export async function executeCodeBatch({
  language,
  fullCode,
  testcases,
  timeLimit = 2000,
  memoryLimit = 256,
}) {
  if (!testcases.length) return [];

  // CodeBox is the exclusive execution engine - no local fallback allowed.
  const runnerUrl = getCodeboxUrl(true);

  const languageId = LANGUAGE_IDS[language] || 54;
  const cpuTimeLimit = Math.max(1, Math.ceil(timeLimit / 1000));
  const headers = { "Content-Type": "application/json" };
  const results = [];

  // Slices testcases into batches of at most MAX_CASES_PER_BATCH (20)
  for (
    let offset = 0;
    offset < testcases.length;
    offset += MAX_CASES_PER_BATCH
  ) {
    const cases = testcases.slice(offset, offset + MAX_CASES_PER_BATCH);
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

      await new Promise((resolve) =>
        setTimeout(resolve, currentInterval),
      );
      // Adaptive backoff up to BATCH_POLL_MAX_INTERVAL_MS
      currentInterval = Math.min(
        BATCH_POLL_MAX_INTERVAL_MS,
        Math.round(currentInterval * 1.35),
      );
    }

    const batchResults = completedSubmissions.map((sub, i) => {
      const normalized = normalizeRunnerResult(sub);
      const originalCase = cases[i];
      const stdinStr = String(originalCase?.stdin ?? "");
      normalized.inputBytes = Buffer.byteLength(stdinStr, "utf-8");
      return normalized;
    });
    results.push(...batchResults);
  }

  return results;
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
  });
  return result;
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

    if (!studentCode || studentCode.trim().length === 0) {
      throw new ApiError(400, "Code is required.", "MISSING_CODE");
    }

    if (Buffer.byteLength(studentCode, "utf-8") > 64 * 1024) {
      throw new ApiError(
        413,
        "Code exceeds maximum allowable size (64 KB).",
        "CODE_TOO_LARGE",
      );
    }

    // If custom stdin is provided without a problem
    if (stdin !== undefined && !slug) {
      const result = await runSingleTestCase({
        problem: null,
        language: normLang,
        code: studentCode,
        stdin,
      });

      return res.status(200).json({
        success: true,
        status: result.status === "OK" ? "Accepted" : result.status,
        passedCount: result.status === "OK" ? 1 : 0,
        totalCount: 1,
        cases: [
          {
            index: 0,
            testIndex: 0,
            input: stdin,
            expected: "",
            actual: result.actual,
            studentStdout: result.studentStdout,
            status: result.status === "OK" ? "Accepted" : result.status,
            passed: result.status === "OK",
            timeMs: result.timeMs,
            memoryKb: result.memoryKb,
            errorText: result.errorText,
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

    const executionResults = await executeCodeBatch({
      language: normLang,
      fullCode,
      testcases: visibleCases.map((testcase) => ({
        stdin: testcase.stdinSmall ?? testcase.input ?? "",
      })),
      timeLimit: problem.timeLimit || 2000,
      memoryLimit: problem.memoryLimit || 256,
    });

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
        actual: execResult.actual,
        studentStdout: execResult.studentStdout,
        status: caseStatus,
        passed: isPassed,
        timeMs: execResult.timeMs,
        cpuTimeMs: execResult.cpuTimeMs ?? execResult.timeMs,
        wallTimeMs: execResult.wallTimeMs ?? execResult.timeMs,
        memoryKb: execResult.memoryKb,
        inputBytes: execResult.inputBytes ?? Buffer.byteLength(testInput, "utf-8"),
        errorText: execResult.errorText,
      });
    }

    const passedCount = results.filter((r) => r.passed).length;

    let complexity = null;
    try {
      complexity = await analyzeComplexity({
        code: studentCode,
        language: normLang,
        problemSlug: slug,
        executionResult: {
          timeMs: Math.max(...results.map((r) => r.timeMs || 0), 0),
          memoryKb: Math.max(...results.map((r) => r.memoryKb || 0), 0),
        },
        testcases: results,
        evidenceScope: "visible_tests",
      });
    } catch {}

    res.status(200).json({
      success: true,
      status: overallStatus,
      passedCount,
      totalCount: results.length,
      cases: results,
      complexity,
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
async function evaluateAllTestcases(problem, language, code, providedFullCode) {
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
    { name: "Tier 1", cases: tier1Cases, rankIfFailed: "Tier 0 (Failed)", rankIfPassed: "Tier 1 (Brute Force)" },
    { name: "Tier 2", cases: tier2Cases, rankIfFailed: "Tier 1 (Brute Force)", rankIfPassed: "Tier 2 (Better)" },
    { name: "Tier 3", cases: tier3Cases, rankIfFailed: "Tier 2 (Better)", rankIfPassed: "Tier 3 (Optimal)" },
  ];

  let tierReached = "Tier 0 (Failed)";
  let shortCircuited = false;

  for (const tier of tiers) {
    if (!tier.cases.length || shortCircuited) continue;

    const tierExecResults = await executeCodeBatch({
      language: normLang,
      fullCode,
      testcases: tier.cases.map((testcase) => ({
        stdin: testcase.stdinSmall ?? testcase.input ?? "",
      })),
      timeLimit: problem.timeLimit || 2000,
      memoryLimit: problem.memoryLimit || 256,
    });

    let tierHasFailure = false;

    for (let idx = 0; idx < tier.cases.length; idx++) {
      const tc = tier.cases[idx];
      const testInput = tc.stdinSmall || tc.input || "";
      const expectedOutput = tc.expectedSmall || tc.output || "";
      const execResult = tierExecResults[idx];

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
        actual: execResult.actual,
        passed: isPassed,
        isVisible: tc.isVisible === true,
        time: execResult.timeMs || 0,
        timeMs: execResult.timeMs || 0,
        cpuTimeMs: execResult.cpuTimeMs ?? execResult.timeMs ?? 0,
        wallTimeMs: execResult.wallTimeMs ?? execResult.timeMs ?? 0,
        memory: execResult.memoryKb || 0,
        memoryKb: execResult.memoryKb || 0,
        inputBytes: execResult.inputBytes ?? Buffer.byteLength(testInput, "utf-8"),
        status: isPassed ? "Accepted" : failureType,
        errorText: execResult.errorText,
      };
      results.push(caseItem);

      if (isPassed) {
        passedCount++;
      } else {
        tierHasFailure = true;
        if (!firstFailure) {
          if (failureType === "Time Limit Exceeded")
            finalStatus = "TIME_LIMIT_EXCEEDED";
          else if (failureType === "Runtime Error") finalStatus = "RUNTIME_ERROR";
          else if (failureType === "Compilation Error")
            finalStatus = "COMPILATION_ERROR";
          else finalStatus = "WRONG_ANSWER";

          const isVisible = Boolean(tc.isVisible);
          firstFailure = {
            testIndex: tc.testIndex ?? (results.length - 1),
            status: failureType,
            errorText: execResult.errorText,
            input: isVisible ? testInput : undefined,
            expected: isVisible ? expectedOutput : undefined,
            actual: isVisible ? execResult.actual : undefined,
            message: isVisible
              ? `Failed sample test ${results.length}: expected '${expectedOutput}', got '${execResult.actual}'`
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

    if (!studentCode || studentCode.trim().length === 0) {
      throw new ApiError(400, "Code is required.", "MISSING_CODE");
    }

    if (Buffer.byteLength(studentCode, "utf-8") > 64 * 1024) {
      throw new ApiError(
        413,
        "Code exceeds maximum allowable size (64 KB).",
        "CODE_TOO_LARGE",
      );
    }

    const problem = await resolveProblem(slug);
    if (!problem) {
      throw new ApiError(404, `Problem '${slug}' not found.`, "NOT_FOUND");
    }

    // Validate function-only submission and build executable source upfront
    const fullCode = buildFinalCode(problem, studentCode, normLang);

    const subId = `sub_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const totalTcs = (problem.testcases || []).length;

    let submission = {
      id: subId,
      problemId: problem.id,
      userId,
      language: normLang,
      code: studentCode,
      status: "PROCESSING",
      passedCount: 0,
      totalCount: totalTcs,
      createdAt: new Date().toISOString(),
      problem: {
        slug: problem.slug,
        title: problem.title,
      },
    };

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
        include: { problem: true },
      });
    } catch (dbErr) {
      if (userId) {
        throw new ApiError(
          503,
          "Unable to save this submission. Please try again.",
          "SUBMISSION_STORAGE_UNAVAILABLE",
        );
      }
    }

    submissionCache.set(submission.id, { ...submission });

    const runEvaluation = async () => {
      const evaluation = await evaluateAllTestcases(
        problem,
        normLang,
        studentCode,
        fullCode,
      );
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

      try {
        let reward = null;
        let rewardError = false;
        const isAccepted =
          evaluation.status === "ACCEPTED" &&
          evaluation.totalCount > 0 &&
          evaluation.passedCount === evaluation.totalCount;

        if (userId && isAccepted) {
          try {
            reward = await prisma.$transaction((tx) =>
              applyAcceptedSubmissionReward(tx, { userId, problem }),
            );
            rewardError = !reward;
          } catch (rewardDbErr) {
            rewardError = true;
            console.error(
              `[Submission Rewards] Failed to save rewards for submission ${submission.id}:`,
              rewardDbErr,
            );
          }
        }

        const dbUpdated = await prisma.submission.update({
          where: { id: submission.id },
          data: {
            status: evaluation.status,
            passedCount: evaluation.passedCount,
            totalCount: evaluation.totalCount,
            time: `${evaluation.maxTimeMs}ms`,
            memory: evaluation.maxMemoryKb,
          },
          include: { problem: true },
        });
        updated = {
          ...dbUpdated,
          ...updated,
          reward,
          rewardError,
        };

        if (
          userId &&
          evaluation.status === "ACCEPTED" &&
          evaluation.totalCount > 0 &&
          evaluation.passedCount === evaluation.totalCount
        ) {
          try {
            await syncProblemSolvedCount(prisma, problem.id);
          } catch (syncError) {
            console.error(
              `[Problem solved count] Failed to update problem ${problem.id}:`,
              syncError,
            );
          }
        }
      } catch (dbErr) {
        if (userId) {
          throw new ApiError(
            503,
            "Unable to save the submission verdict. Please try again.",
            "SUBMISSION_STORAGE_UNAVAILABLE",
          );
        }
      }

      let complexity = null;
      try {
        complexity = await analyzeComplexity({
          code: studentCode,
          language: normLang,
          problemSlug: problem.slug,
          executionResult: {
            timeMs: evaluation.maxTimeMs,
            memoryKb: evaluation.maxMemoryKb,
          },
          testcases: evaluation.results || [],
          evidenceScope: "submission_tests",
        });
      } catch (err) {
        console.warn("[Complexity Analyzer Warning]:", err.message);
      }

      updated = {
        ...updated,
        complexity,
      };
      submissionCache.set(submission.id, updated);

      return updated;
    };

    // If wait=true or route is /api/execute/submit (synchronous evaluation)
    const isDirectExecuteRoute =
      req.originalUrl?.includes("/execute/submit") ||
      wait === true ||
      req.query?.wait === "true" ||
      req.path === "/submit";

    if (isDirectExecuteRoute) {
      const completed = await runEvaluation();
      const passed = completed.passedCount;
      const total = completed.totalCount;

      return res.status(200).json({
        success: true,
        passed,
        total,
        results: publicTestResults(completed.results || []),
        submissionId: submission.id,
        verdict: completed.status,
        status: completed.status,
        tierReached: completed.tierReached,
        reward: completed.reward || null,
        rewardError: completed.rewardError || false,
        passedCount: passed,
        totalCount: total,
        time: completed.time || `${completed.maxTimeMs}ms`,
        memory: completed.memory || completed.maxMemoryKb,
        firstFailure: completed.firstFailure,
        cases: publicTestResults(completed.results || []),
        complexity: completed.complexity || null,
        problem: {
          slug: problem.slug,
          title: problem.title,
        },
      });
    }

    // Keep the per-user execution slot until the background job settles.
    const releaseInFlight = req.holdInFlightSlot?.();
    runEvaluation()
      .catch((err) => {
        console.error("[Submission Background Error]:", err.name || "Error");
        submissionCache.set(submission.id, {
          ...submission,
          status: "ERROR",
          verdict: "ERROR",
        });
        prisma.submission
          .update({
            where: { id: submission.id },
            data: { status: "ERROR" },
          })
          .catch(() => {});
      })
      .finally(() => releaseInFlight?.());

    res.status(202).json({
      success: true,
      submissionId: submission.id,
      status: "QUEUED",
      pollUrl: `/api/execution/submissions/${submission.id}`,
      message: "Submission received and queued for execution.",
      problem: {
        slug: problem.slug,
        title: problem.title,
      },
    });
  } catch (err) {
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
    let submission = null;

    try {
      submission = await prisma.submission.findUnique({
        where: { id },
        include: { problem: true },
      });
    } catch (dbErr) {
      // In-memory poll
    }

    const cachedSubmission = submissionCache.get(id);
    if (cachedSubmission) {
      submission = submission
        ? { ...cachedSubmission, ...submission }
        : cachedSubmission;
    }

    if (!submission) {
      throw new ApiError(404, "Submission not found.", "SUBMISSION_NOT_FOUND");
    }

    // Authenticated users may only inspect submissions explicitly owned by them.
    if (!req.user?.id || submission.userId !== req.user.id) {
      throw new ApiError(404, "Submission not found.", "SUBMISSION_NOT_FOUND");
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
        status: submission.status,
        verdict: submission.status,
        tierReached,
        reward: submission.reward || null,
        rewardError: submission.rewardError || false,
        passedCount: submission.passedCount,
        totalCount: submission.totalCount,
        time: submission.time || "45ms",
        memory: submission.memory || 14000,
        createdAt: submission.createdAt,
        firstFailure: submission.firstFailure || null,
        results: publicTestResults(submission.results || []),
        complexity: cachedSubmission?.complexity || submission.complexity || null,
        problem: submission.problem || { slug: "problem", title: "Problem" },
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
    const { code, userCode, source_code, language, lang, slug, problemSlug } = req.body;
    const studentCode = userCode || code || source_code;
    const rawLang = language || lang || "python";
    const problemId = slug || problemSlug || "";

    if (!studentCode || !studentCode.trim()) {
      throw new ApiError(400, "Code is required.", "MISSING_CODE");
    }

    const complexity = await analyzeComplexity({
      code: studentCode,
      language: rawLang,
      problemSlug: problemId,
    });

    res.status(200).json({
      success: true,
      complexity,
    });
  } catch (err) {
    next(err);
  }
};