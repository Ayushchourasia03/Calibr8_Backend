import { cleanupTestUsers } from "./helpers/dbCleanup.js"; // keep first: snapshots the DB before this test writes
// Unique per run: tests share the real database, so a run only creates and
// deletes rows carrying its own tag (concurrent runs cannot delete each other's).
const RUN_TAG = `${process.pid.toString(36)}${Date.now().toString(36)}`;
import "dotenv/config";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
process.env.OAUTH_STATE_SECRET = "test-oauth-secret-key-at-least-32-chars";
process.env.CODEBOX_URL = "https://runner.calibr8.internal";
process.env.CODEBOX_TOKEN = "secret-codebox-token";
process.env.CODEBOX_BATCH_EXECUTION_ENABLED = "false";

let currentBehavior = null;
let tokenCounter = 0;
const stdinByToken = new Map();

// Correct two-sum answer for a testcase stdin ("n target\nnums"), so the
// submission test does not depend on how many testcases the problem has.
function solveTwoSum(stdin = "") {
  const [head = "", nums = ""] = String(stdin).trim().split(/\n/);
  const target = Number(head.trim().split(/\s+/)[1]);
  const values = nums.trim().split(/\s+/).map(Number);
  const seen = new Map();
  for (let j = 0; j < values.length; j++) {
    if (seen.has(target - values[j])) return `${seen.get(target - values[j])} ${j}`;
    if (!seen.has(values[j])) seen.set(values[j], j);
  }
  return "";
}
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
    return originalFetch(input, options);
  }

  if (options.method === "POST" && url.pathname.includes("/submissions/batch")) {
    const payload = JSON.parse(options.body);
    return new Response(
      JSON.stringify(
        payload.submissions.map((sub) => {
          const token = `tok-${tokenCounter++}`;
          stdinByToken.set(token, sub.stdin);
          return { token };
        })
      ),
      { status: 201 }
    );
  }

  if (url.pathname.includes("/submissions/batch")) {
    const tokens = url.searchParams.get("tokens").split(",");
    const submissions = tokens.map((tok, idx) => {
      const b = currentBehavior ? currentBehavior(tok, idx) : { statusId: 3, stdout: "" };
      return {
        token: tok,
        status: { id: b.statusId ?? 3 },
        stdout: b.stdout ?? "",
        stderr: b.stderr || null,
        compile_output: b.compile_output || null,
        time: b.time || "0.02",
        wall_time: b.wall_time || "0.03",
        memory: b.memory || 1024,
        exit_code: b.exit_code ?? 0,
      };
    });

    return new Response(JSON.stringify({ submissions }), { status: 200 });
  }

  return originalFetch(input, options);
};

const { default: app } = await import("../src/app.js");
const { default: prisma } = await import("../src/config/db.js");
const { signSessionToken } = await import("../src/utils/jwt.js");
const signToken = (user) => signSessionToken({ id: user.id, tokenVersion: user.tokenVersion ?? 0 });

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
const token = signToken({ id: `user-exec-${RUN_TAG}`, userId: `user-exec-${RUN_TAG}`, email: `runner-${RUN_TAG}@calibr8.test` });

try {
  // Auth requires the token's user to exist (deleted/unknown users get 401).
  await prisma.user.upsert({
    where: { id: `user-exec-${RUN_TAG}` },
    update: {},
    create: {
      id: `user-exec-${RUN_TAG}`,
      email: `runner-${RUN_TAG}@calibr8.test`,
      passwordHash: "test-only-not-a-real-hash",
      name: "Execution Verdicts Test",
    },
  });

  console.log("=== Running Execution Verdicts & Multi-Tier Test Suite ===");

  // 1. GET /api/execution/languages
  const langRes = await fetch(`${baseUrl}/execution/languages`);
  assert.equal(langRes.status, 200);
  const langBody = await langRes.json();
  assert.equal(langBody.success, true);
  assert.ok(Array.isArray(langBody.languages));
  const keys = langBody.languages.map((l) => l.key);
  assert.ok(keys.includes("python"));
  assert.ok(keys.includes("javascript"));
  assert.ok(keys.includes("cpp"));
  assert.ok(keys.includes("c"));
  assert.ok(keys.includes("java"));
  console.log("Languages endpoint verified.");

  // 2. Validation & Error Handling on POST /api/execution/run
  // Unauthenticated -> 401
  const unauth = await fetch(`${baseUrl}/execution/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug: "two-sum", code: "print(1)" }),
  });
  assert.equal(unauth.status, 401);

  // Unsupported language -> 422
  const badLang = await fetch(`${baseUrl}/execution/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ slug: "two-sum", language: "brainfuck", code: "++[>++<-]" }),
  });
  assert.equal(badLang.status, 422);

  // Missing code -> 400
  const noCode = await fetch(`${baseUrl}/execution/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ slug: "two-sum", language: "python", code: "   " }),
  });
  assert.equal(noCode.status, 400);

  // Code too large -> 413
  const tooLarge = await fetch(`${baseUrl}/execution/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ slug: "two-sum", language: "python", code: "a".repeat(65 * 1024) }),
  });
  assert.equal(tooLarge.status, 413);

  // Function-only violation (defining main()) -> 400
  const mainViol = await fetch(`${baseUrl}/execution/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ slug: "two-sum", language: "python", code: "def main(): pass" }),
  });
  assert.equal(mainViol.status, 400);

  // Non-existent problem -> 404
  const notFound = await fetch(`${baseUrl}/execution/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      slug: "non-existent-problem-slug",
      language: "python",
      code: "class Solution:\n    def twoSum(self, nums, target): return [0, 1]",
    }),
  });
  assert.equal(notFound.status, 404);
  console.log("Validation and error handling verified.");

  // 3. Custom stdin execution without problem slug
  currentBehavior = () => ({ statusId: 3, stdout: "42" });
  const customStdinRes = await fetch(`${baseUrl}/execution/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      language: "python",
      code: "import sys; print(sys.stdin.read().strip())",
      stdin: "42",
    }),
  });
  assert.equal(customStdinRes.status, 200);
  const customStdinData = await customStdinRes.json();
  assert.equal(customStdinData.success, true);
  assert.equal(customStdinData.verdict, "Accepted");
  assert.equal(customStdinData.results[0].actual, "42");
  console.log("Custom stdin execution verified.");

  // 4. Sample testcase verdicts on POST /api/execution/run
  // Accepted
  currentBehavior = (_tok, idx) => ({ statusId: 3, stdout: idx === 0 ? "0 1" : "1 2" });
  const resAccepted = await fetch(`${baseUrl}/execution/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      slug: "two-sum",
      language: "python",
      code: "class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]",
    }),
  });
  assert.equal(resAccepted.status, 200);
  const dataAccepted = await resAccepted.json();
  assert.equal(dataAccepted.verdict, "Accepted");
  assert.equal(dataAccepted.passedCount, 2);
  assert.equal(dataAccepted.complexity, undefined);

  // Wrong Answer
  currentBehavior = () => ({ statusId: 3, stdout: "99 99" });
  const resWA = await fetch(`${baseUrl}/execution/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      slug: "two-sum",
      language: "python",
      code: "class Solution:\n    def twoSum(self, nums, target):\n        return [99, 99]",
    }),
  });
  assert.equal(resWA.status, 200);
  const dataWA = await resWA.json();
  assert.equal(dataWA.verdict, "Wrong Answer");
  assert.equal(dataWA.complexity, undefined);

  // Time Limit Exceeded (statusId: 5)
  currentBehavior = () => ({ statusId: 5, stdout: "" });
  const resTLE = await fetch(`${baseUrl}/execution/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      slug: "two-sum",
      language: "python",
      code: "class Solution:\n    def twoSum(self, nums, target):\n        while True: pass",
    }),
  });
  assert.equal(resTLE.status, 200);
  const dataTLE = await resTLE.json();
  assert.equal(dataTLE.verdict, "Time Limit Exceeded");
  assert.equal(dataTLE.complexity, undefined);

  // Compilation Error (statusId: 6)
  currentBehavior = () => ({ statusId: 6, compile_output: "SyntaxError: invalid syntax" });
  const resCE = await fetch(`${baseUrl}/execution/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      slug: "two-sum",
      language: "python",
      code: "class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]",
    }),
  });
  assert.equal(resCE.status, 200);
  const dataCE = await resCE.json();
  assert.equal(dataCE.verdict, "Compilation Error");
  assert.equal(dataCE.complexity, undefined);
  console.log("Run verdicts (Accepted, WA, TLE, CE) verified.");

  // 5. Multi-Tier Submission: POST /api/execution/submit & Polling
  // Full Accepted Submission across all 3 tiers
  const twoSumCount = await prisma.testcase.count({ where: { problem: { slug: "two-sum" } } });
  currentBehavior = (tok) => ({ statusId: 3, stdout: solveTwoSum(stdinByToken.get(tok)), time: "0.015", memory: 2048 });

  const resSubmit = await fetch(`${baseUrl}/execution/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      slug: "two-sum",
      language: "python",
      code: "class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]",
    }),
  });
  assert.equal(resSubmit.status, 200);
  const dataSubmit = await resSubmit.json();
  assert.equal(dataSubmit.success, true);
  assert.equal(dataSubmit.verdict, "ACCEPTED");
  assert.equal(dataSubmit.tierReached, "Tier 3 (Optimal)");
  assert.equal(dataSubmit.passedCount, twoSumCount);
  assert.equal(dataSubmit.totalCount, twoSumCount);
  assert.ok(dataSubmit.complexity);
  const submissionId = dataSubmit.submissionId;
  assert.ok(submissionId);

  // Poll submission details via GET /api/execution/submissions/:id
  const pollRes = await fetch(`${baseUrl}/execution/submissions/${submissionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(pollRes.status, 200);
  const pollData = await pollRes.json();
  assert.equal(pollData.success, true);
  assert.equal(pollData.submission.id, submissionId);
  assert.equal(pollData.submission.verdict, "ACCEPTED");
  assert.equal(pollData.submission.tierReached, "Tier 3 (Optimal)");
  assert.ok(pollData.submission.complexity);

  // Hidden testcase protection check: ensure hidden testcases have input/expected omitted
  const hiddenCases = pollData.submission.results.filter((r) => !r.isVisible);
  assert.ok(hiddenCases.length > 0);
  assert.ok(hiddenCases.every((r) => r.input === undefined && r.expected === undefined));
  console.log("Full submission, polling, and testcase privacy protection verified.");

  // 6. Tier Short-Circuiting Test: Tier 1 fails -> Halts evaluation immediately
  currentBehavior = () => ({ statusId: 3, stdout: "wrong-answer" });
  const resShort = await fetch(`${baseUrl}/execution/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      slug: "two-sum",
      language: "python",
      code: "class Solution:\n    def twoSum(self, nums, target):\n        return [99, 99]",
    }),
  });
  assert.equal(resShort.status, 200);
  const shortData = await resShort.json();
  assert.equal(shortData.verdict, "WRONG_ANSWER");
  assert.equal(shortData.tierReached, "Tier 0 (Failed)");
  assert.equal(shortData.complexity, undefined);
  const shortPoll = await fetch(`${baseUrl}/execution/submissions/${shortData.submissionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(shortPoll.status, 200);
  assert.equal((await shortPoll.json()).submission.complexity, undefined);
  assert.equal(shortData.totalCount, twoSumCount);
  assert.ok(shortData.results.length < twoSumCount, "Tier 2 and Tier 3 should be short-circuited");
  console.log("Tier short-circuiting verified.");

  // 7. POST /api/execution/analyze-complexity Standalone Endpoint
  const noCompCode = await fetch(`${baseUrl}/execution/analyze-complexity`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language: "python" }),
  });
  assert.equal(noCompCode.status, 400);

  const compRes = await fetch(`${baseUrl}/execution/analyze-complexity`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      language: "python",
      code: `
def twoSum(nums, target):
    seen = {}
    for i, num in enumerate(nums):
        diff = target - num
        if diff in seen:
            return [seen[diff], i]
        seen[num] = i
    return []
`,
    }),
  });
  assert.equal(compRes.status, 200);
  const compData = await compRes.json();
  assert.equal(compData.success, true);
  assert.ok(compData.complexity);
  assert.ok(compData.complexity.time);
  assert.ok(compData.complexity.space);
  console.log("Standalone complexity analyzer verified.");

  console.log("=== All Execution Verdicts Tests Passed Successfully ===");
} finally {
  globalThis.fetch = originalFetch;
  await cleanupTestUsers({ id: `user-exec-${RUN_TAG}` });
  await prisma.$disconnect().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
