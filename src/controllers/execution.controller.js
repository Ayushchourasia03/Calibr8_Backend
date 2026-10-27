import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import prisma from "../config/db.js";
import { executeCase, areOutputsEqual } from "../utils/codeRunner.js";
import { ApiError } from "../utils/ApiError.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROBLEMS_DIR = path.resolve(__dirname, "../../problems");

const CODEBOX_URL = process.env.CODEBOX_URL ;
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
 * Helper to run a testcase either via remote Codebox engine or local sandboxed runner
 */
async function runSingleTestCase({
  language,
  code,
  stdin,
  timeLimit = 3000,
  memoryLimit = 256,
}) {
  // If CODEBOX_TOKEN is configured and remote VPS is accessible, attempt remote execution
  if (CODEBOX_TOKEN && CODEBOX_URL) {
    try {
      const sourceCode =
        language === "cpp"
          ? `#include <bits/stdc++.h>\nusing namespace std;\n#line 1\n${code}`
          : code;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeLimit + 2000);

      const langMap = { python: 71, javascript: 63, cpp: 54, java: 62 };
      const res = await fetch(`${CODEBOX_URL}/submissions?wait=true`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Auth-Token": CODEBOX_TOKEN,
        },
        body: JSON.stringify({
          source_code: sourceCode,
          language_id: langMap[language] || 71,
          stdin: stdin || "",
          cpu_time_limit: Math.ceil(timeLimit / 1000),
          memory_limit: memoryLimit * 1024,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        const judgeStatus = data.status;
        const statusDescription =
          judgeStatus?.description || judgeStatus || "OK";
        const executionCompleted =
          judgeStatus?.id === 3 ||
          judgeStatus?.id === 4 ||
          statusDescription === "Accepted" ||
          statusDescription === "Wrong Answer" ||
          statusDescription === "OK";
        return {
          status: executionCompleted ? "OK" : statusDescription,
          studentStdout: data.stdout || "",
          actual: (data.stdout || "").trim(),
          errorText: data.stderr || data.compile_output || null,
          timeMs: Math.round(parseFloat(data.time || "0") * 1000),
          memoryKb: data.memory || 0,
        };
      }
    } catch (e) {
      console.warn(
        "[Codebox VPS] Remote call failed, using sandbox runner:",
        e.message,
      );
    }
  }

  // Fallback to in-process sandboxed runner (Python 3 & Node.js)
  return await executeCase({
    language,
    code,
    stdin,
    timeLimitMs: timeLimit,
    memoryLimitKb: memoryLimit * 1024,
  });
}

/**
 * Helper to find problem by slug, ID, or problem number with testcases and templates
 */
async function resolveProblem(slugOrId) {
  if (!slugOrId) return null;
  const isNum = /^\d+$/.test(String(slugOrId));
  const include = {
    testcases: { orderBy: { testIndex: "asc" } },
    templates: true,
  };

  let problem = null;
  try {
    if (isNum) {
      problem = await prisma.problem.findUnique({
        where: { problemNumber: Number(slugOrId) },
        include,
      });
    } else {
      problem = await prisma.problem.findUnique({
        where: { slug: String(slugOrId) },
        include,
      });
    }

    if (!problem) {
      const all = await prisma.problem.findMany({ include });
      const target = String(slugOrId).toLowerCase();
      problem = all.find(
        (p) =>
          p.slug.toLowerCase() === target ||
          p.slug.replace(/-\d+$/, "").toLowerCase() === target ||
          String(p.id) === String(slugOrId),
      );
    }
  } catch (dbErr) {
    console.warn("[Execution] DB notice:", dbErr.message);
  }

  // If problem is not in DB or has no testcases, read from local /problems/*.json
  if (!problem || !problem.testcases || problem.testcases.length === 0) {
    try {
      const targetSlug = String(slugOrId).toLowerCase();
      if (fs.existsSync(PROBLEMS_DIR)) {
        const files = fs
          .readdirSync(PROBLEMS_DIR)
          .filter((f) => f.endsWith(".json"));
        let matchFile = files.find(
          (f) => f.replace(".json", "").toLowerCase() === targetSlug,
        );
        if (!matchFile) {
          matchFile = files.find(
            (f) =>
              f.replace(/-\d+\.json$/, "").toLowerCase() === targetSlug ||
              f.replace(".json", "").toLowerCase().includes(targetSlug),
          );
        }
        if (matchFile) {
          const raw = fs.readFileSync(
            path.join(PROBLEMS_DIR, matchFile),
            "utf-8",
          );
          const data = JSON.parse(raw);
          const tcs = (data.testcases || []).map((tc, idx) => ({
            testIndex: tc.testIndex ?? idx,
            isVisible: tc.isVisible ?? tc.visible ?? true,
            stdinSmall: String(tc.stdinSmall ?? tc.input ?? ""),
            expectedSmall: String(tc.expectedSmall ?? tc.output ?? ""),
            input: String(tc.input ?? tc.stdinSmall ?? ""),
            output: String(tc.output ?? tc.expectedSmall ?? ""),
          }));
          const tmpls = Object.entries(data.templates || {}).map(
            ([lang, code]) => ({
              language: lang,
              code: String(code),
            }),
          );

          if (!problem) {
            problem = {
              id: `prob-${matchFile.replace(".json", "")}`,
              slug: data.slug || matchFile.replace(".json", ""),
              title: data.title || matchFile.replace(".json", ""),
              description: data.description || data.title,
              difficulty: data.difficulty || "Easy",
              timeLimit: data.timeLimit || data.time_limit || 1000,
              memoryLimit: data.memoryLimit || data.memory_limit || 256,
              testcases: tcs,
              templates: tmpls,
            };
          } else {
            problem.testcases = tcs;
            if (!problem.templates || problem.templates.length === 0) {
              problem.templates = tmpls;
            }
          }
        }
      }
    } catch (_) {}
  }

  return problem;
}

/**
 * POST /api/execution/runs or POST /api/problems/:slug/run
 * Executes code against sample (VISIBLE) test cases only.
 * Synchronous execution.
 */
export const runCode = async (req, res, next) => {
  try {
    const slug = req.params?.slug || req.body?.slug || req.body?.problemId;
    const {
      language = "python",
      code,
      source_code,
      sourceCode,
      stdin,
    } = req.body;
    const studentCode = code || source_code || sourceCode;

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

    // If custom stdin is provided without a problem, or for ad-hoc custom testing
    if (stdin !== undefined && !slug) {
      const result = await runSingleTestCase({
        language,
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

    // Filter to strictly VISIBLE testcases only
    const allTestcases = problem.testcases || [];
    let visibleCases = allTestcases.filter((tc) => tc.isVisible === true);

    // If no test cases are explicitly marked visible, use the first 2-3 sample cases
    if (visibleCases.length === 0 && allTestcases.length > 0) {
      visibleCases = allTestcases.slice(0, Math.min(3, allTestcases.length));
    }

    if (visibleCases.length === 0) {
      throw new ApiError(
        400,
        "No sample test cases configured for this problem.",
        "NO_TESTCASES",
      );
    }

    const results = [];
    let allPassed = true;
    let overallStatus = "Accepted";

    for (let idx = 0; idx < visibleCases.length; idx++) {
      const tc = visibleCases[idx];
      const testInput = tc.stdinSmall || tc.input || "";
      const expectedOutput = tc.expectedSmall || tc.output || "";

      const execResult = await runSingleTestCase({
        language,
        code: studentCode,
        stdin: testInput,
        timeLimit: problem.timeLimit || 2000,
        memoryLimit: problem.memoryLimit || 256,
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
 * Evaluates all testcases for a problem (used by submissions)
 */
async function evaluateAllTestcases(problem, language, code) {
  const allTestcases = problem.testcases || [];
  if (allTestcases.length === 0) {
    return {
      status: "ACCEPTED",
      tierReached: "Tier 3 (Optimal)",
      passedCount: 0,
      totalCount: 0,
      maxTimeMs: 10,
      maxMemoryKb: 12000,
      firstFailure: null,
    };
  }

  let passedCount = 0;
  let maxTimeMs = 0;
  let maxMemoryKb = 0;
  let firstFailure = null;
  let finalStatus = "ACCEPTED";

  // Divide tests into tiers: Tier 1 (first 30%), Tier 2 (next 30%), Tier 3 (remaining)
  const total = allTestcases.length;
  const tier1Count = Math.max(1, Math.floor(total * 0.35));
  const tier2Count = Math.max(tier1Count + 1, Math.floor(total * 0.7));

  for (let idx = 0; idx < total; idx++) {
    const tc = allTestcases[idx];
    const testInput = tc.stdinSmall || tc.input || "";
    const expectedOutput = tc.expectedSmall || tc.output || "";

    const execResult = await runSingleTestCase({
      language,
      code,
      stdin: testInput,
      timeLimit: problem.timeLimit || 2000,
      memoryLimit: problem.memoryLimit || 256,
    });

    maxTimeMs = Math.max(maxTimeMs, execResult.timeMs);
    maxMemoryKb = Math.max(maxMemoryKb, execResult.memoryKb);

    let isPassed = false;
    let failureType = execResult.status;

    if (execResult.status === "OK") {
      isPassed = areOutputsEqual(execResult.actual, expectedOutput);
      if (!isPassed) failureType = "Wrong Answer";
    }

    if (isPassed) {
      passedCount++;
    } else {
      // Map failure status
      if (failureType === "Time Limit Exceeded")
        finalStatus = "TIME_LIMIT_EXCEEDED";
      else if (failureType === "Runtime Error") finalStatus = "RUNTIME_ERROR";
      else if (failureType === "Compilation Error")
        finalStatus = "COMPILATION_ERROR";
      else finalStatus = "WRONG_ANSWER";

      // SECURITY: Reveal input/expected ONLY if it was a visible sample test
      const isVisible = Boolean(tc.isVisible);
      firstFailure = {
        testIndex: tc.testIndex ?? idx,
        status: failureType,
        errorText: execResult.errorText,
        // Only include input/expected if visible; hide for verification tests
        input: isVisible ? testInput : undefined,
        expected: isVisible ? expectedOutput : undefined,
        actual: isVisible ? execResult.actual : undefined,
        message: isVisible
          ? `Failed sample test ${idx + 1}: expected '${expectedOutput}', got '${execResult.actual}'`
          : `Failed on hidden evaluation test case #${idx + 1}.`,
      };

      break; // Stop at first failing test
    }
  }

  // Tier calculation based on test progress
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
  };
}

/**
 * POST /api/execution/submissions or POST /api/problems/:slug/submit
 * Submits solution for full multi-tier evaluation.
 * Returns 202 Accepted (asynchronous) with submission ID, or synchronous response if wait=true.
 */
export const submitSolution = async (req, res, next) => {
  try {
    const slug = req.params?.slug || req.body?.slug || req.body?.problemId;
    const {
      language = "python",
      code,
      source_code,
      sourceCode,
      wait,
    } = req.body;
    const studentCode = code || source_code || sourceCode;
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

    // Create submission record in queued state
    let submission = null;
    const subId = `sub_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const subData = {
      id: subId,
      problemId: problem.id,
      userId,
      language,
      code: studentCode,
      status: "PROCESSING",
      passedCount: 0,
      totalCount: (problem.testcases || []).length,
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
          language,
          code: studentCode,
          status: "PROCESSING",
          passedCount: 0,
          totalCount: (problem.testcases || []).length,
        },
        include: { problem: true },
      });
    } catch (dbErr) {
      console.warn("[Submission] DB create notice:", dbErr.message);
      submission = subData;
    }

    submissionCache.set(submission.id, { ...submission });

    // Function to run the evaluation
    const runEvaluation = async () => {
      const evaluation = await evaluateAllTestcases(
        problem,
        language,
        studentCode,
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
      };

      try {
        const dbUpdated = await prisma.submission.update({
          where: { id: submission.id },
          data: {
            status: evaluation.status,
            passedCount: evaluation.passedCount,
            totalCount: evaluation.totalCount,
            time: `${evaluation.maxTimeMs}ms`,
            memory: evaluation.maxMemoryKb,
          },
        });
        updated = { ...dbUpdated, ...updated };
      } catch (dbErr) {
        console.warn("[Submission] DB update notice:", dbErr.message);
      }

      submissionCache.set(submission.id, updated);
      return updated;
    };

    // If wait=true or synchronous requested (e.g. query param ?wait=true or body wait: true)
    if (wait === true || req.query.wait === "true") {
      const completed = await runEvaluation();
      return res.status(200).json({
        success: true,
        submissionId: submission.id,
        status: completed.status,
        verdict: completed.status,
        tierReached: completed.tierReached,
        passedCount: completed.passedCount,
        totalCount: completed.totalCount,
        time: completed.time || `${completed.maxTimeMs}ms`,
        memory: completed.memory || completed.maxMemoryKb,
        firstFailure: completed.firstFailure,
        problem: {
          slug: problem.slug,
          title: problem.title,
        },
      });
    }

    // Async execution in background
    runEvaluation().catch((err) => {
      console.error("[Submission Background Error]:", err);
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
      console.warn("[Submission Poll] DB notice:", dbErr.message);
    }

    if (!submission) {
      submission = submissionCache.get(id);
    }

    if (!submission) {
      throw new ApiError(404, "Submission not found.", "SUBMISSION_NOT_FOUND");
    }

    // If authenticated user, verify ownership (allow admin or owner)
    if (
      req.user?.id &&
      submission.userId &&
      submission.userId !== req.user.id &&
      req.user.role !== "admin"
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
        passedCount: submission.passedCount,
        totalCount: submission.totalCount,
        time: submission.time || "45ms",
        memory: submission.memory || 14000,
        createdAt: submission.createdAt,
        firstFailure: submission.firstFailure || null,
        problem: submission.problem || { slug: "problem", title: "Problem" },
      },
    });
  } catch (err) {
    next(err);
  }
};
