import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { executeCase, normalizeOutput } from "../utils/codeRunner.js";

// Cache recently seen Idempotency-Keys to prevent duplicate judging
const idempotencyCache = new Map();

/**
 * GET /api/execution/languages
 * Returns list of supported programming languages for code execution.
 */
export const getAvailableLanguages = (req, res, next) => {
  try {
    const languages = [
      {
        key: "python",
        label: "Python",
        version: "Python 3.10",
        starterAvailable: true,
      },
      {
        key: "javascript",
        label: "JavaScript",
        version: "Node.js 22",
        starterAvailable: true,
      },
      {
        key: "cpp",
        label: "C++",
        version: "GCC 13",
        starterAvailable: true,
      },
      {
        key: "java",
        label: "Java",
        version: "OpenJDK 17",
        starterAvailable: true,
      },
    ];

    res.status(200).json({ success: true, languages });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/execution/runs
 * Executes user code against visible/sample testcases (Synchronous Run).
 * Uses random marker design to capture real student stdout prints.
 * Requires user authentication.
 */
export const runCode = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      throw new ApiError(401, "Authentication required to run code.", "UNAUTHORIZED");
    }

    const { problemId, slug, language, code } = req.body;

    if (!code || typeof code !== "string") {
      throw new ApiError(400, "Code is required.", "MISSING_CODE");
    }
    if (Buffer.byteLength(code, "utf-8") > 64 * 1024) {
      throw new ApiError(413, "Code exceeds maximum size limit of 64 KB.", "CODE_TOO_LARGE");
    }

    const validLanguages = ["python", "javascript", "cpp", "java"];
    const langKey = String(language || "").toLowerCase();
    if (!validLanguages.includes(langKey)) {
      throw new ApiError(
        422,
        `Unsupported language '${language}'. Supported: ${validLanguages.join(", ")}`,
        "UNSUPPORTED_LANGUAGE"
      );
    }

    const identifier = slug || problemId;
    if (!identifier) {
      throw new ApiError(400, "problemId or slug is required.", "MISSING_IDENTIFIER");
    }

    const isNumber = /^\d+$/.test(String(identifier));
    const where = isNumber
      ? { problemNumber: Number(identifier) }
      : { slug: String(identifier).toLowerCase() };

    let problem = null;
    try {
      problem = await prisma.problem.findUnique({
        where,
        include: {
          testcases: { orderBy: { testIndex: "asc" } },
        },
      });

      if (!problem && !isNumber) {
        const all = await prisma.problem.findMany({
          include: { testcases: { orderBy: { testIndex: "asc" } } },
        });
        problem = all.find(
          (p) =>
            p.slug.toLowerCase() === String(identifier).toLowerCase() ||
            p.slug.replace(/-\d+$/, "").toLowerCase() ===
              String(identifier).toLowerCase(),
        );
      }
    } catch (e) {
      problem = null;
    }

    if (!problem) {
      throw new ApiError(404, `Problem '${identifier}' not found.`, "NOT_FOUND");
    }

    // Only run sample (visible) testcases
    const sampleCases = (problem.testcases || []).filter((tc) => tc.isVisible);
    if (sampleCases.length === 0) {
      return res.status(200).json({
        success: true,
        status: "Accepted",
        passedCount: 0,
        totalCount: 0,
        cases: [],
      });
    }

    const results = [];
    let hasCompileError = false;
    let hasRuntimeError = false;
    let hasTimeLimit = false;

    for (let idx = 0; idx < sampleCases.length; idx++) {
      const tc = sampleCases[idx];
      const execResult = await executeCase({
        language: langKey,
        code,
        stdin: tc.stdinSmall,
        timeLimitMs: problem.timeLimit || 2000,
        memoryLimitKb: (problem.memoryLimit || 256) * 1024,
      });

      let status = execResult.status;
      if (status === 'OK') {
        const expectedNorm = normalizeOutput(tc.expectedSmall);
        const actualNorm = normalizeOutput(execResult.actual);
        status = expectedNorm === actualNorm ? 'Accepted' : 'Wrong Answer';
      }

      if (status === 'Compilation Error') hasCompileError = true;
      if (status === 'Runtime Error') hasRuntimeError = true;
      if (status === 'Time Limit Exceeded') hasTimeLimit = true;

      results.push({
        index: tc.testIndex ?? idx,
        input: tc.stdinSmall,
        expected: tc.expectedSmall,
        actual: execResult.actual,
        studentStdout: execResult.studentStdout || '',
        status,
        timeMs: execResult.timeMs,
        memoryKb: execResult.memoryKb,
        errorText: execResult.errorText || null,
      });
    }

    let overallStatus = 'Accepted';
    if (hasCompileError) overallStatus = 'Compilation Error';
    else if (hasRuntimeError) overallStatus = 'Runtime Error';
    else if (hasTimeLimit) overallStatus = 'Time Limit Exceeded';
    else if (results.some((c) => c.status === 'Wrong Answer')) overallStatus = 'Wrong Answer';

    const passedCount = results.filter((c) => c.status === 'Accepted').length;

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
 * Background worker to evaluate code tier by tier asynchronously.
 */
async function processSubmissionAsync({ submissionId, problem, code, language, userId }) {
  try {
    // 1. Mark submission as running
    await prisma.submission.update({
      where: { id: submissionId },
      data: {
        status: "running",
        currentTier: 1,
      },
    });

    const allCases = problem.testcases || [];
    const totalCount = allCases.length || 1;

    // Split test cases into 3 tiers
    // Tier 1: Visible sample cases & small tests (basic correctness)
    // Tier 2: Medium/edge tests
    // Tier 3: Complex/scale tests
    const tier1Cases = allCases.filter((tc, idx) => tc.isVisible || idx < Math.ceil(totalCount / 3));
    const tier2Cases = allCases.filter((tc, idx) => !tc.isVisible && idx >= Math.ceil(totalCount / 3) && idx < Math.ceil((2 * totalCount) / 3));
    const tier3Cases = allCases.filter((tc, idx) => !tc.isVisible && idx >= Math.ceil((2 * totalCount) / 3));

    const tiers = [
      { tierNum: 1, cases: tier1Cases.length > 0 ? tier1Cases : allCases.slice(0, 1) },
      { tierNum: 2, cases: tier2Cases },
      { tierNum: 3, cases: tier3Cases },
    ];

    let tiersPassed = 0;
    let tierReached = 0;
    let passedCount = 0;
    let verdict = "Accepted";
    let maxTimeMs = 0;
    let maxMemoryKb = 0;
    let compileOutput = null;
    let firstFailure = null;

    for (const tier of tiers) {
      if (tier.cases.length === 0) {
        tiersPassed++;
        tierReached = tier.tierNum;
        continue;
      }

      await prisma.submission.update({
        where: { id: submissionId },
        data: { currentTier: tier.tierNum },
      });

      let tierFailed = false;

      for (const tc of tier.cases) {
        const execResult = await executeCase({
          language,
          code,
          stdin: tc.stdinSmall,
          timeLimitMs: problem.timeLimit || 2000,
          memoryLimitKb: (problem.memoryLimit || 256) * 1024,
        });

        maxTimeMs = Math.max(maxTimeMs, execResult.timeMs || 0);
        maxMemoryKb = Math.max(maxMemoryKb, execResult.memoryKb || 0);

        let caseStatus = execResult.status;
        if (caseStatus === 'OK') {
          const expectedNorm = normalizeOutput(tc.expectedSmall);
          const actualNorm = normalizeOutput(execResult.actual);
          caseStatus = expectedNorm === actualNorm ? 'Accepted' : 'Wrong Answer';
        }

        if (caseStatus === 'Accepted') {
          passedCount++;
        } else {
          tierFailed = true;
          verdict = caseStatus;
          if (execResult.errorText) compileOutput = execResult.errorText;

          // Per Section 9:
          // Sample / Tier 1 failures show failure type, input and expected if small (<2KB)
          // Hidden Tier 2 or 3 failures show ONLY failure type, never data
          if (tier.tierNum === 1 || tc.isVisible) {
            const inputLen = Buffer.byteLength(tc.stdinSmall || '', 'utf-8');
            firstFailure = {
              tier: tier.tierNum,
              status: caseStatus,
              input: inputLen < 2048 ? tc.stdinSmall : '[TRUNCATED_INPUT]',
              expected: inputLen < 2048 ? tc.expectedSmall : '[TRUNCATED_EXPECTED]',
              actual: execResult.actual || '',
              studentStdout: execResult.studentStdout || '',
              errorText: execResult.errorText || null,
            };
          } else {
            // Hidden tests: NEVER leak data
            firstFailure = {
              tier: tier.tierNum,
              status: caseStatus,
              message: `Failed in Tier ${tier.tierNum}. Hidden test cases are confidential.`,
            };
          }
          break; // Stop at first failing test in tier
        }
      }

      if (tierFailed) {
        // Decision #3: Tiers stop at the first failing tier
        break;
      } else {
        tiersPassed++;
        tierReached = tier.tierNum;
      }
    }

    // Tier 0 reached means failure; Tier 1 or 2 partial result; Tier 3 is accepted
    if (tiersPassed === 0) tierReached = 0;
    if (tierReached === 3 && verdict === "Accepted") {
      verdict = "Accepted";
    }

    // Points based on tiers passed
    let scoreUnitsAwarded = 0;
    if (tierReached === 3) scoreUnitsAwarded = 100;
    else if (tierReached === 2) scoreUnitsAwarded = 60;
    else if (tierReached === 1) scoreUnitsAwarded = 30;

    await prisma.submission.update({
      where: { id: submissionId },
      data: {
        status: "done",
        verdict,
        tierReached,
        tiersPassed,
        passedCount,
        totalCount,
        scoreUnitsAwarded,
        maxTimeMs,
        maxMemoryKb,
        compileOutput,
        firstFailure: firstFailure || undefined,
        time: `${maxTimeMs} ms`,
        memory: maxMemoryKb,
      },
    });
  } catch (err) {
    console.error("[Submission Evaluation Error]:", err);
    await prisma.submission.update({
      where: { id: submissionId },
      data: {
        status: "error",
        verdict: "Internal Error",
      },
    }).catch(() => {});
  }
}

/**
 * POST /api/execution/submissions
 * Submits solution for asynchronous tier evaluation (Returns 202 Accepted, then poll).
 * Requires user authentication.
 */
export const submitCode = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      throw new ApiError(401, "Authentication required to submit code.", "UNAUTHORIZED");
    }

    const { problemId, slug, language, code } = req.body;
    const userId = req.user.id;

    if (!code || typeof code !== "string") {
      throw new ApiError(400, "Code is required.", "MISSING_CODE");
    }
    if (Buffer.byteLength(code, "utf-8") > 64 * 1024) {
      throw new ApiError(413, "Code exceeds maximum size limit of 64 KB.", "CODE_TOO_LARGE");
    }

    // Check Idempotency-Key
    const idempotencyKey = req.headers["idempotency-key"];
    if (idempotencyKey && idempotencyCache.has(idempotencyKey)) {
      const cached = idempotencyCache.get(idempotencyKey);
      return res.status(202).json(cached);
    }

    const validLanguages = ["python", "javascript", "cpp", "java"];
    const langKey = String(language || "python").toLowerCase();
    if (!validLanguages.includes(langKey)) {
      throw new ApiError(422, `Unsupported language '${language}'.`, "UNSUPPORTED_LANGUAGE");
    }

    const identifier = slug || problemId;
    if (!identifier) {
      throw new ApiError(400, "problemId or slug is required.", "MISSING_IDENTIFIER");
    }

    const isNumber = /^\d+$/.test(String(identifier));
    const where = isNumber
      ? { problemNumber: Number(identifier) }
      : { slug: String(identifier).toLowerCase() };

    let problem = null;
    try {
      problem = await prisma.problem.findUnique({
        where,
        include: {
          testcases: { orderBy: { testIndex: "asc" } },
        },
      });

      if (!problem && !isNumber) {
        const all = await prisma.problem.findMany({
          include: { testcases: { orderBy: { testIndex: "asc" } } },
        });
        problem = all.find(
          (p) =>
            p.slug.toLowerCase() === String(identifier).toLowerCase() ||
            p.slug.replace(/-\d+$/, "").toLowerCase() ===
              String(identifier).toLowerCase(),
        );
      }
    } catch {
      problem = null;
    }

    if (!problem) {
      throw new ApiError(404, `Problem '${identifier}' not found.`, "NOT_FOUND");
    }

    const totalTestcases = problem.testcases?.length || 1;

    // Create submission record with status: "queued"
    let submission = null;
    try {
      submission = await prisma.submission.create({
        data: {
          problemId: problem.id,
          userId,
          language: langKey,
          code,
          status: "queued",
          currentTier: 1,
          tierReached: 0,
          tiersPassed: 0,
          passedCount: 0,
          totalCount: totalTestcases,
          scoreUnitsAwarded: 0,
        },
      });
    } catch {
      // In-memory fallback ID if DB unavailable
      submission = {
        id: `sub_${Date.now()}`,
        problemId: problem.id,
        userId,
        language: langKey,
        code,
        status: "queued",
      };
    }

    const responsePayload = {
      success: true,
      submissionId: submission.id,
      status: "queued",
    };

    if (idempotencyKey) {
      idempotencyCache.set(idempotencyKey, responsePayload);
      setTimeout(() => idempotencyCache.delete(idempotencyKey), 60000);
    }

    // Launch background asynchronous tier evaluation
    setImmediate(() => {
      processSubmissionAsync({
        submissionId: submission.id,
        problem,
        code,
        language: langKey,
        userId,
      });
    });

    // Return 202 Accepted immediately as per PRD Section 6
    res.status(202).json(responsePayload);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/execution/submissions/:id
 * Fetches submission record and evaluation status with tier breakdown.
 * Requires user authentication; owner-only access.
 */
export const getSubmission = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      throw new ApiError(401, "Authentication required.", "UNAUTHORIZED");
    }

    const { id } = req.params;
    let submission = null;
    try {
      submission = await prisma.submission.findUnique({
        where: { id },
      });
    } catch {
      submission = null;
    }

    if (!submission) {
      throw new ApiError(404, "Submission not found.", "NOT_FOUND");
    }

    // Owner check: strictly enforce that only the owner can read their code and submission.
    // Return 404 otherwise to avoid leaking existence of submissions.
    if (submission.userId && submission.userId !== req.user.id && req.user.role !== "admin") {
      throw new ApiError(404, "Submission not found.", "NOT_FOUND");
    }

    res.status(200).json({
      success: true,
      submission: {
        id: submission.id,
        problemId: submission.problemId,
        language: submission.language,
        code: submission.code,
        status: submission.status,
        progress: {
          currentTier: submission.currentTier ?? 1,
          tiersPassed: submission.tiersPassed ?? 0,
        },
        verdict: submission.verdict,
        tierReached: submission.tierReached ?? 0,
        tiersPassed: submission.tiersPassed ?? 0,
        passedCount: submission.passedCount ?? 0,
        totalCount: submission.totalCount ?? 0,
        scoreUnitsAwarded: submission.scoreUnitsAwarded ?? 0,
        maxTimeMs: submission.maxTimeMs ?? null,
        maxMemoryKb: submission.maxMemoryKb ?? null,
        compileOutput: submission.compileOutput ?? null,
        firstFailure: submission.firstFailure ?? null,
        createdAt: submission.createdAt,
        updatedAt: submission.updatedAt,
      },
    });
  } catch (err) {
    next(err);
  }
};
