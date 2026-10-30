import crypto from "crypto";
import prisma from "../config/db.js";
import { executeCase, areOutputsEqual, buildSource } from "../utils/codeRunner.js";
import { buildFinalCode, LANGUAGE_IDS, normalizeLanguage, SUPPORTED_LANGUAGES } from "../utils/codeBuilder.js";
import { resolveProblem } from "../utils/problemResolver.js";
import { ApiError } from "../utils/ApiError.js";
import { syncProblemSolvedCount } from "../utils/problemSolvedCount.js";
import { applyAcceptedSubmissionReward } from "../utils/acceptedSubmissionReward.js";
import { publicTestResults } from "../utils/testcaseResults.js";

const CODEBOX_URL = process.env.CODEBOX_URL || "http://187.127.173.216";
const CODEBOX_TOKEN = process.env.CODEBOX_TOKEN;
const submissionCache = new Map();

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

/**
 * Helper to run a testcase either via remote Codebox engine or local sandboxed runner.
 * Automatically wraps user function with header and footer driver.
 */
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

  // 1. If CODEBOX_TOKEN is configured and remote VPS is accessible, attempt remote execution
  if (CODEBOX_TOKEN && CODEBOX_URL) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeLimit + 2500);

      const langId = LANGUAGE_IDS[normLang] || 54;
      const res = await fetch(`${CODEBOX_URL}/submissions?wait=true`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Auth-Token": CODEBOX_TOKEN,
        },
        body: JSON.stringify({
          source_code: fullCode,
          language_id: langId,
          stdin: stdin || "",
          cpu_time_limit: Math.ceil(timeLimit / 1000),
          memory_limit: memoryLimit * 1024,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        const rawStdout = data.stdout || "";
        const isCompileError = data.status?.id === 6 || Boolean(data.compile_output);
        const isRuntimeError = data.status?.id >= 7 && data.status?.id <= 12;

        return {
          status: isCompileError
            ? "Compilation Error"
            : isRuntimeError
            ? "Runtime Error"
            : "OK",
          studentStdout: "",
          actual: rawStdout.trim(),
          errorText: data.stderr || data.compile_output || null,
          timeMs: Math.round(parseFloat(data.time || "0") * 1000),
          memoryKb: data.memory || 0,
        };
      }
    } catch (e) {
      console.warn("[Codebox VPS] Remote call failed, using sandbox runner:", e.message);
    }
  }

  // 2. Sandboxed compiler and runner (C++, C, Java, Python 3, Node.js)
  return await executeCase({
    language: normLang,
    code,
    fullCode,
    stdin,
    timeLimitMs: timeLimit,
    memoryLimitKb: memoryLimit * 1024,
    expectedOutput,
  });
}

/**
 * POST /api/execution/runs or POST /api/problems/:slug/run
 * Executes code against sample (VISIBLE) test cases only.
 * Sequential execution (concurrency 1).
 */
export const runCode = async (req, res, next) => {
  try {
    const slug = req.params?.slug || req.body?.slug || req.body?.problemSlug || req.body?.problemId;
    const rawLang = req.body?.language ?? req.body?.lang ?? req.query?.language ?? "cpp";
    const normLang = normalizeLanguage(rawLang);

    if (!normLang) {
      throw new ApiError(
        422,
        `Unsupported language: '${rawLang}'. Supported languages: ${SUPPORTED_LANGUAGES.join(", ")}.`,
        "UNSUPPORTED_LANGUAGE"
      );
    }

    const { code, userCode, source_code, sourceCode, stdin } = req.body;
    const studentCode = userCode || code || source_code || sourceCode;

    if (!studentCode || studentCode.trim().length === 0) {
      throw new ApiError(400, "Code is required.", "MISSING_CODE");
    }

    if (Buffer.byteLength(studentCode, "utf-8") > 64 * 1024) {
      throw new ApiError(413, "Code exceeds maximum allowable size (64 KB).", "CODE_TOO_LARGE");
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
    let visibleCases = allTestcases.filter((tc) => tc.isVisible === true);

    if (visibleCases.length === 0 && allTestcases.length > 0) {
      visibleCases = allTestcases.slice(0, Math.min(3, allTestcases.length));
    }

    if (visibleCases.length === 0) {
      throw new ApiError(400, "No sample test cases configured for this problem.", "NO_TESTCASES");
    }

    const results = [];
    let allPassed = true;
    let overallStatus = "Accepted";

    // Sequential execution (concurrency 1 for KVM1 - do NOT parallelize)
    for (let idx = 0; idx < visibleCases.length; idx++) {
      const tc = visibleCases[idx];
      const testInput = tc.stdinSmall || tc.input || "";
      const expectedOutput = tc.expectedSmall || tc.output || "";

      const execResult = await runSingleTestCase({
        problem,
        language: normLang,
        code: studentCode,
        fullCode,
        stdin: testInput,
        timeLimit: problem.timeLimit || 2000,
        memoryLimit: problem.memoryLimit || 256,
        expectedOutput,
      });

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
        memoryKb: execResult.memoryKb,
        errorText: execResult.errorText,
      });
    }

    const passedCount = results.filter((r) => r.passed).length;

    res.status(200).json({
      success: true,
      status: overallStatus,
      passedCount,
      totalCount: results.length,
      cases: results,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Evaluates every visible and hidden testcase for a problem.
 * Sequential execution (concurrency 1 for KVM1 - do NOT parallelize)
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

  // Sequential execution (concurrency 1 - KVM1 safety)
  for (let idx = 0; idx < total; idx++) {
    const tc = allTestcases[idx];
    const testInput = tc.stdinSmall || tc.input || "";
    const expectedOutput = tc.expectedSmall || tc.output || "";

    const execResult = await runSingleTestCase({
      problem,
      language: normLang,
      code,
      fullCode,
      stdin: testInput,
      timeLimit: problem.timeLimit || 2000,
      memoryLimit: problem.memoryLimit || 256,
      expectedOutput,
    });

    maxTimeMs = Math.max(maxTimeMs, execResult.timeMs || 0);
    maxMemoryKb = Math.max(maxMemoryKb, execResult.memoryKb || 0);

    let isPassed = false;
    let failureType = execResult.status;

    if (execResult.status === "OK") {
      isPassed = areOutputsEqual(execResult.actual, expectedOutput);
      if (!isPassed) failureType = "Wrong Answer";
    }

    const caseItem = {
      testIndex: tc.testIndex ?? idx,
      input: testInput,
      expected: expectedOutput,
      actual: execResult.actual,
      passed: isPassed,
      isVisible: tc.isVisible === true,
      time: execResult.timeMs || 0,
      memory: execResult.memoryKb || 0,
      status: isPassed ? "Accepted" : failureType,
      errorText: execResult.errorText,
    };
    results.push(caseItem);

    if (isPassed) {
      passedCount++;
    } else {
      if (failureType === "Time Limit Exceeded") finalStatus = "TIME_LIMIT_EXCEEDED";
      else if (failureType === "Runtime Error") finalStatus = "RUNTIME_ERROR";
      else if (failureType === "Compilation Error") finalStatus = "COMPILATION_ERROR";
      else finalStatus = "WRONG_ANSWER";

      const isVisible = Boolean(tc.isVisible);
      firstFailure = {
        testIndex: tc.testIndex ?? idx,
        status: failureType,
        errorText: execResult.errorText,
        input: isVisible ? testInput : undefined,
        expected: isVisible ? expectedOutput : undefined,
        actual: isVisible ? execResult.actual : undefined,
        message: isVisible
          ? `Failed sample test ${idx + 1}: expected '${expectedOutput}', got '${execResult.actual}'`
          : `Failed on hidden evaluation test case #${idx + 1}.`,
      };
    }
  }

  let tierReached = "Tier 0 (Failed)";
  if (passedCount === total) {
    tierReached = "Tier 3 (Optimal)";
  } else if (passedCount >= tier2Count) {
    tierReached = "Tier 2 (Better)";
  } else if (passedCount >= tier1Count) {
    tierReached = "Tier 1 (Brute Force)";
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
    const slug = req.params?.slug || req.body?.slug || req.body?.problemSlug || req.body?.problemId;
    const rawLang = req.body?.language ?? req.body?.lang ?? req.query?.language ?? "cpp";
    const normLang = normalizeLanguage(rawLang);

    if (!normLang) {
      throw new ApiError(
        422,
        `Unsupported language: '${rawLang}'. Supported languages: ${SUPPORTED_LANGUAGES.join(", ")}.`,
        "UNSUPPORTED_LANGUAGE"
      );
    }

    const { code, userCode, source_code, sourceCode, wait } = req.body;
    const studentCode = userCode || code || source_code || sourceCode;
    const userId = req.user?.id || null;

    if (!studentCode || studentCode.trim().length === 0) {
      throw new ApiError(400, "Code is required.", "MISSING_CODE");
    }

    if (Buffer.byteLength(studentCode, "utf-8") > 64 * 1024) {
      throw new ApiError(413, "Code exceeds maximum allowable size (64 KB).", "CODE_TOO_LARGE");
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
      const evaluation = await evaluateAllTestcases(problem, normLang, studentCode, fullCode);
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
        problem: {
          slug: problem.slug,
          title: problem.title,
        },
      });
    }

    // Async execution in background for polling flow
    runEvaluation().catch((err) => {
      console.error("[Submission Background Error]:", err);
      submissionCache.set(submission.id, {
        ...submission,
        status: "ERROR",
        verdict: "ERROR",
      });
      prisma.submission.update({
        where: { id: submission.id },
        data: { status: "ERROR" },
      }).catch(() => {});
    });

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

    // Authenticated users may only inspect their own submissions.
    if (
      req.user?.id &&
      submission.userId &&
      submission.userId !== req.user.id
    ) {
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
        problem: submission.problem || { slug: "problem", title: "Problem" },
      },
    });
  } catch (err) {
    next(err);
  }
};
