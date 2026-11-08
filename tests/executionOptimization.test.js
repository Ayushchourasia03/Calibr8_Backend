import assert from "node:assert/strict";
import {
  analyzeComplexity,
  computeComplexityHash,
  clearComplexityCache,
  getComplexityCacheSize,
  ANALYZER_VERSION,
} from "../src/services/complexityAnalyzer.service.js";

process.env.JWT_SECRET = "a".repeat(40);
process.env.OAUTH_STATE_SECRET = "b".repeat(40);
process.env.DATABASE_URL = "";
process.env.CODEBOX_URL = "https://codebox.internal";
process.env.CODEBOX_TOKEN = "test-token";

let lastSubmittedSubmissions = [];
let codeboxCallCount = 0;
const originalFetch = globalThis.fetch;

// Mock CodeBox VPS fetch handler
globalThis.fetch = async (input, options = {}) => {
  const urlStr = typeof input === "string" ? input : input.toString();

  if (urlStr.startsWith("https://codebox.internal")) {
    codeboxCallCount++;
    const url = new URL(urlStr);

    if (options.method === "POST") {
      const payload = JSON.parse(options.body || "{}");
      lastSubmittedSubmissions = payload.submissions || [];

      assert.ok(lastSubmittedSubmissions.length <= 20, "Batch constraint violated (>20)");
      assert.strictEqual(options.headers["X-Auth-Token"], "test-token");

      return new Response(
        JSON.stringify(
          lastSubmittedSubmissions.map((_, idx) => ({
            token: `token-${idx}-${Date.now()}`,
          })),
        ),
        { status: 201 },
      );
    }

    const tokens = (url.searchParams.get("tokens") || "").split(",");
    return new Response(
      JSON.stringify({
        submissions: tokens.map((token, idx) => {
          const sub = lastSubmittedSubmissions[idx] || {};
          const stdin = sub.stdin || "";

          let stdout = "0 1";
          if (stdin.includes("3 2 4") || stdin.startsWith("3 6")) {
            stdout = "1 2";
          } else if (stdin.includes("3 3") || stdin.startsWith("2 6")) {
            stdout = "0 1";
          }

          return {
            token,
            status: { id: 3 }, // Accepted
            stdout,
            time: "0.02",
            memory: 1420,
          };
        }),
      }),
      { status: 200 },
    );
  }

  return originalFetch(input, options);
};

const app = (await import("../src/app.js")).default;
const { signToken } = await import("../src/utils/jwt.js");

async function runOptimizationTests() {
  console.log("=== Calibr8 Execution API Optimization Test Suite ===");

  // Setup user auth tokens
  const testUser = {
    id: "usr_opt_test_123",
    email: "test.optimizer@calibr8.test",
    role: "USER",
    tier: "Prism I",
    rating: 800,
    score: 0,
    coins: 50,
  };
  const otherUser = {
    id: "usr_other_456",
    email: "other@calibr8.test",
    role: "USER",
    tier: "Prism I",
    rating: 800,
    score: 0,
    coins: 50,
  };

  const userToken = signToken(testUser);
  const otherUserToken = signToken(otherUser);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // -------------------------------------------------------------------------
    // 1. Complexity Analyzer Caching & Static/Dynamic Separation Tests
    // -------------------------------------------------------------------------
    console.log("\n[Test 1] Complexity Analyzer Hash Caching & Dynamic Confidence");
    clearComplexityCache();
    assert.strictEqual(getComplexityCacheSize(), 0, "Cache should start empty");

    const samplePythonCode = `class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        seen = {}
        for i, num in enumerate(nums):
            rem = target - num
            if rem in seen:
                return [seen[rem], i]
            seen[num] = i
        return []`;

    const hash1 = computeComplexityHash(samplePythonCode, "python", ANALYZER_VERSION);
    assert.ok(hash1 && hash1.length === 64, "Should generate 64-char sha256 hash");

    // Version invalidation check
    const hashDiffVersion = computeComplexityHash(samplePythonCode, "python", "99.9.9");
    assert.notStrictEqual(hash1, hashDiffVersion, "Different analyzer version must produce different hash");

    // First analysis
    const analysis1 = await analyzeComplexity({ code: samplePythonCode, language: "python" });
    assert.strictEqual(getComplexityCacheSize(), 1, "Cache size should be 1 after first analysis");
    assert.strictEqual(analysis1.time.bestEstimate, "O(n)");

    // Second analysis of identical code - must return cached reference
    const analysis2 = await analyzeComplexity({ code: samplePythonCode, language: "python" });
    assert.strictEqual(analysis1, analysis2, "Identical code must return cached reference");
    assert.strictEqual(getComplexityCacheSize(), 1, "Cache size should remain 1");

    // Test dynamic evidence does NOT claim high confidence on small testcases (<6)
    const smallTestcases = [
      { input: "1\n2", expected: "3" },
      { input: "2\n3", expected: "5" },
      { input: "3\n4", expected: "7" },
    ];
    const smallExecutionResult = {
      results: [
        { testIndex: 0, time: "0.01", memory: 100 },
        { testIndex: 1, time: "0.01", memory: 100 },
        { testIndex: 2, time: "0.02", memory: 100 },
      ],
    };
    const analysisSmallDynamic = await analyzeComplexity({
      code: samplePythonCode,
      language: "python",
      evidenceScope: "all",
      testcases: smallTestcases,
      executionResult: smallExecutionResult,
    });
    // With < 6 data points, dynamic confidence must be low/medium, never "high"
    if (analysisSmallDynamic.dynamicEvidence) {
      assert.notStrictEqual(
        analysisSmallDynamic.dynamicEvidence.confidence,
        "high",
        "Dynamic confidence must not be high for small testcase count (<6)",
      );
    }
    console.log("✔ Complexity analyzer hash caching and dynamic confidence verified");

    // -------------------------------------------------------------------------
    // 2. POST /api/execution/run Optimization & Schema Verification
    // -------------------------------------------------------------------------
    console.log("\n[Test 2] POST /api/execution/run: Schema & Visible-only Execution");
    const runRes = await fetch(`${baseUrl}/api/execution/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        slug: "two-sum",
        language: "python",
        code: samplePythonCode,
      }),
    });

    assert.strictEqual(runRes.status, 200, "Run endpoint should return HTTP 200");
    const runData = await runRes.json();

    // Verify standardized response fields
    assert.strictEqual(runData.success, true);
    assert.ok(runData.verdict, "Must include canonical verdict");
    assert.strictEqual(runData.status, runData.verdict, "status must match verdict for backward compatibility");
    assert.strictEqual(typeof runData.passedCount, "number", "Must include passedCount");
    assert.strictEqual(typeof runData.totalCount, "number", "Must include totalCount");

    // Verify duplicate fields are eliminated
    assert.strictEqual(runData.cases, undefined, "Duplicate 'cases' array must NOT exist");
    assert.strictEqual(runData.passed, undefined, "Duplicate 'passed' root count must NOT exist");
    assert.strictEqual(runData.total, undefined, "Duplicate 'total' root count must NOT exist");

    // Verify results array is used
    assert.ok(Array.isArray(runData.results), "Must return results array");
    assert.strictEqual(runData.results.length, runData.totalCount);

    // Verify visible testcases only
    for (const r of runData.results) {
      assert.strictEqual(r.isVisible, true, "Run endpoint must execute visible testcases only");
      assert.ok(r.input !== undefined, "Visible testcases must have input in run mode");
    }

    // Verify compact complexity summary
    assert.ok(runData.complexity, "Run response must include compact complexity");
    assert.ok(runData.complexity.time && runData.complexity.time.bestEstimate, "Must have compact time estimate");
    assert.ok(runData.complexity.space && runData.complexity.space.bestEstimate, "Must have compact space estimate");
    // Ensure verbose dynamic profiler is not leaked to frontend in compact summary
    assert.strictEqual(runData.complexity.dynamicProfiles, undefined, "Verbose dynamic profiles must not be exposed");

    // Ensure Run did not persist a submission ID
    assert.strictEqual(runData.submissionId, undefined, "Run endpoint must not persist or return submissionId");
    console.log("✔ POST /api/execution/run schema and visible-only constraints verified");

    // -------------------------------------------------------------------------
    // 3. POST /api/execution/submit Optimization (Sync Mode & Redaction)
    // -------------------------------------------------------------------------
    console.log("\n[Test 3] POST /api/execution/submit: Sync Execution, Redaction, & Compact Schema");
    const submitRes = await fetch(`${baseUrl}/api/execution/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        slug: "two-sum",
        language: "python",
        code: samplePythonCode,
        wait: true,
      }),
    });

    assert.strictEqual(submitRes.status, 200, "Synchronous submit should return 200");
    const submitData = await submitRes.json();

    assert.strictEqual(submitData.success, true);
    assert.ok(submitData.submissionId, "Must return submissionId");
    assert.ok(submitData.verdict, "Must return canonical verdict");
    assert.strictEqual(submitData.status, submitData.verdict);
    assert.strictEqual(typeof submitData.passedCount, "number");
    assert.strictEqual(typeof submitData.totalCount, "number");

    // Verify duplicate fields are eliminated
    assert.strictEqual(submitData.cases, undefined, "Duplicate 'cases' array must NOT exist");
    assert.strictEqual(submitData.passed, undefined, "Duplicate 'passed' root count must NOT exist");
    assert.strictEqual(submitData.total, undefined, "Duplicate 'total' root count must NOT exist");

    // Verify compact problem representation
    assert.ok(submitData.problem, "Must return compact problem");
    assert.strictEqual(submitData.problem.slug, "two-sum");
    assert.strictEqual(submitData.problem.title, "Two Sum");
    assert.strictEqual(submitData.problem.testcases, undefined, "Full problem entity testcases must NOT be returned");
    assert.strictEqual(submitData.problem.description, undefined, "Full problem description must NOT be returned");

    // Verify hidden testcase redaction (CRITICAL SECURITY)
    assert.ok(Array.isArray(submitData.results), "Must return results");
    const hiddenResults = submitData.results.filter((c) => c.isVisible === false);
    assert.ok(hiddenResults.length > 0, "Submit must evaluate hidden testcases");

    for (const hiddenCase of hiddenResults) {
      assert.strictEqual(hiddenCase.input, undefined, "Hidden testcase input must NEVER be exposed");
      assert.strictEqual(hiddenCase.expected, undefined, "Hidden testcase expected output must NEVER be exposed");
      assert.strictEqual(hiddenCase.actual, undefined, "Hidden testcase actual output must NEVER be exposed");
      assert.strictEqual(hiddenCase.errorText, undefined, "Hidden testcase errorText must NEVER be exposed");
      assert.strictEqual(hiddenCase.isVisible, false);
      assert.ok(hiddenCase.passed !== undefined, "Status and pass state should be retained");
    }
    console.log("✔ POST /api/execution/submit response schema and hidden testcase security verified");

    // -------------------------------------------------------------------------
    // 4. POST /api/execution/submissions (Async Mode, wait: false)
    // -------------------------------------------------------------------------
    console.log("\n[Test 4] POST /api/execution/submissions: Async Mode (wait: false)");
    const asyncSubRes = await fetch(`${baseUrl}/api/execution/submissions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        slug: "two-sum",
        language: "python",
        code: samplePythonCode,
        wait: false,
      }),
    });

    assert.strictEqual(asyncSubRes.status, 202, "Async submission should return 202 Accepted");
    const asyncData = await asyncSubRes.json();
    assert.strictEqual(asyncData.success, true);
    assert.strictEqual(asyncData.verdict, "QUEUED");
    assert.strictEqual(asyncData.status, "QUEUED");
    assert.ok(asyncData.pollUrl, "Must include pollUrl");
    assert.ok(asyncData.submissionId, "Must include submissionId");
    assert.strictEqual(asyncData.problem.slug, "two-sum");
    console.log("✔ Async submission returned 202 Accepted with pollUrl");

    // -------------------------------------------------------------------------
    // 5. GET /api/execution/submissions/:id Details & Cache Reuse
    // -------------------------------------------------------------------------
    console.log("\n[Test 5] GET /api/execution/submissions/:id: Fetch & Reuse Cached Analysis");
    const targetSubmissionId = submitData.submissionId;
    const initialCodeboxCalls = codeboxCallCount;

    const detailsRes = await fetch(
      `${baseUrl}/api/execution/submissions/${targetSubmissionId}`,
      {
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      },
    );

    assert.strictEqual(detailsRes.status, 200, "Should successfully fetch submission details");
    const detailsData = await detailsRes.json();
    assert.strictEqual(detailsData.success, true);
    assert.ok(detailsData.submission, "Must return submission object");

    const sub = detailsData.submission;
    assert.strictEqual(sub.id, targetSubmissionId);
    assert.ok(sub.verdict, "Must return canonical verdict");
    assert.strictEqual(sub.status, sub.verdict);
    assert.strictEqual(typeof sub.passedCount, "number");
    assert.strictEqual(typeof sub.totalCount, "number");

    // Verify CodeBox was NOT rerun for fetching historical details
    assert.strictEqual(
      codeboxCallCount,
      initialCodeboxCalls,
      "CodeBox must NOT be invoked when retrieving historical submission details",
    );

    // Verify stored complexity analysis is reused
    assert.ok(sub.complexity, "Must return stored complexity analysis");
    assert.strictEqual(sub.complexity.time.bestEstimate, "O(n)");

    // Verify compact problem info
    assert.strictEqual(sub.problem.slug, "two-sum");
    assert.strictEqual(sub.problem.title, "Two Sum");
    assert.strictEqual(sub.problem.testcases, undefined, "Problem testcases must NOT be returned in submission details");

    // Verify hidden testcases remain strictly redacted on retrieval
    const retrievedHidden = sub.results.filter((c) => c.isVisible === false);
    assert.ok(retrievedHidden.length > 0, "Must have hidden testcase results");
    for (const h of retrievedHidden) {
      assert.strictEqual(h.input, undefined, "Hidden input must NOT leak on GET submission details");
      assert.strictEqual(h.expected, undefined, "Hidden expected output must NOT leak");
      assert.strictEqual(h.actual, undefined, "Hidden actual output must NOT leak");
      assert.strictEqual(h.errorText, undefined, "Hidden errorText must NOT leak");
    }

    // -------------------------------------------------------------------------
    // 6. Security: Non-owner Access Restriction
    // -------------------------------------------------------------------------
    console.log("\n[Test 6] Security: Non-owner Access Restriction");
    const forbiddenRes = await fetch(
      `${baseUrl}/api/execution/submissions/${targetSubmissionId}`,
      {
        headers: {
          Authorization: `Bearer ${otherUserToken}`,
        },
      },
    );

    assert.strictEqual(forbiddenRes.status, 404, "Non-owner should receive 404 SUBMISSION_NOT_FOUND");
    const forbiddenData = await forbiddenRes.json();
    assert.strictEqual(forbiddenData.code, "SUBMISSION_NOT_FOUND");
    console.log("✔ Non-owner retrieval rejected with 404 SUBMISSION_NOT_FOUND");

    console.log("\n=======================================================");
    console.log("✔ ALL CALIBR8 EXECUTION OPTIMIZATION TESTS PASSED!");
    console.log("=======================================================\n");
  } finally {
    server.close();
  }
}

await runOptimizationTests();
