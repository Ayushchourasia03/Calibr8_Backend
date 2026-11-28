// SA-H2 regression tests that need the database: the cross-instance cap on a
// user's PROCESSING submissions and duplicate-submission handling. CodeBox is
// mocked. Every row this test writes belongs to users tagged with RUN_TAG and
// is removed by cleanupTestUsers (see tests/helpers/dbCleanup.js).
import { cleanupTestUsers } from "./helpers/dbCleanup.js"; // keep first: snapshots the DB before this test writes
import "dotenv/config";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const RUN_TAG = `${process.pid.toString(36)}${Date.now().toString(36)}`;

process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
process.env.OAUTH_STATE_SECRET = "test-oauth-secret-key-at-least-32-chars";
process.env.CODEBOX_URL = "https://codebox.remediation.test";
process.env.CODEBOX_TOKEN = "remediation-test-token";
process.env.CODEBOX_MULTICASE_ENABLED = "false";
process.env.COMPLEXITY_PROFILING_ENABLED = "false";

// Mocked CodeBox batch API: answers after a delay, so a submission stays
// PROCESSING long enough to be submitted again.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return originalFetch(input, options);
  if (options.method === "DELETE") return new Response(null, { status: 204 });
  if (url.pathname === "/batches" && options.method === "POST") {
    const body = JSON.parse(options.body);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const results = body.testcases.map((tc, index) => ({ index, status: "completed", stdout: "wrong\n", stderr: "", exitCode: 0, timeMs: 1, memory: 1 }));
    return new Response(JSON.stringify({ batchId: "00000000-0000-4000-8000-000000000000", status: "completed", results }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const { default: app } = await import("../src/app.js");
const { default: prisma } = await import("../src/config/db.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const email = `remediation-limits-${RUN_TAG}@example.test`;

after(async () => {
  await cleanupTestUsers({ email });
  server.close();
  globalThis.fetch = originalFetch;
  await prisma.$disconnect();
});

const json = (res) => res.json();
const post = (path, body, token) =>
  originalFetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const registered = await json(await post("/api/auth/register", { email, password: "Remediation-Pass-123", name: "Remediation Test" }));
const token = registered.token;
const userId = registered.user?.id;
const code = `def twoSum(nums, target):\n    return [0, 1]  # ${RUN_TAG}\n`;

test("SA-H2: an identical submission that is still being judged is not judged twice", async () => {
  assert.ok(token, "test user registered");
  const first = await post("/api/problems/two-sum/submit", { language: "python", code }, token);
  assert.equal(first.status, 202);
  const firstBody = await json(first);
  const second = await post("/api/problems/two-sum/submit", { language: "python", code }, token);
  assert.equal(second.status, 202);
  const secondBody = await json(second);
  assert.equal(secondBody.deduplicated, true);
  assert.equal(secondBody.submissionId, firstBody.submissionId);
  const rows = await prisma.submission.count({ where: { userId } });
  assert.equal(rows, 1, "only one submission row was created");

  // Wait for the background job, so the next test starts with nothing in flight.
  for (let i = 0; i < 100; i++) {
    const status = await json(await originalFetch(`${base}/api/execution/submissions/${firstBody.submissionId}`, { headers: { Authorization: `Bearer ${token}` } }));
    if (status.submission?.status && status.submission.status !== "PROCESSING") break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});

test("SA-H2: PROCESSING submissions from other backend instances count against the user's cap", async () => {
  const problem = await prisma.problem.findUnique({ where: { slug: "two-sum" }, select: { id: true } });
  // Two jobs being judged elsewhere (rows only; no process here holds them).
  await prisma.submission.createMany({
    data: [1, 2].map((n) => ({ problemId: problem.id, userId, language: "python", code: `# other instance ${n} ${RUN_TAG}`, status: "PROCESSING", totalCount: 1 })),
  });
  const res = await post("/api/problems/two-sum/submit", { language: "python", code: `${code}# third\n` }, token);
  assert.equal(res.status, 429);
  assert.equal((await json(res)).code, "SUBMISSION_IN_PROGRESS");
});
