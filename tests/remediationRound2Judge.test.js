// Round 2 (FV-1 / SA-H2): judging cost counts wall time, every evaluation has
// a total sandbox-time budget, chunks shrink for slow code, and the scheduler
// serves light users first so sleeping submissions cannot hold the judge.
// CodeBox is mocked here (its responses carry the CPU and wall times a real
// sandbox reports); tests/judgeDos.e2e.js runs the same attacks against a
// real sandbox. No database.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.CODEBOX_URL = "https://codebox.mock.test";
process.env.CODEBOX_ALLOW_INSECURE_HTTP = "true";
process.env.CODEBOX_TOKEN = "t".repeat(40);
process.env.CODEBOX_MULTICASE_ENABLED = "false";

const { evaluateAllTestcases } = await import("../src/controllers/execution.controller.js");
const admission = await import("../src/utils/judgeAdmission.js");
const { openJudgeSession, runWithJudgeSession, __resetJudgeAdmissionForTests, judgeUserUsage, codeboxTenantFor } = admission;

const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- mocked CodeBox -------------------------------------------------------
const originalFetch = globalThis.fetch;
let requests = [];
let caseBehaviour = () => ({});
let requestDelayMs = () => 0;
let nextStatus = null;
// Mocked CodeBox duration cap: which cases of a request come back "skipped"
// (as CodeBox does once max_duration_ms is reached).
let skipCase = () => false;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (options.method === "DELETE") return new Response(null, { status: 204 });
  if (url.pathname === "/batches" && options.method === "POST") {
    if (nextStatus) {
      const { status, body } = nextStatus;
      nextStatus = null;
      return new Response(JSON.stringify(body), { status, headers: { "retry-after": "7" } });
    }
    const body = JSON.parse(options.body);
    requests.push({
      cases: body.testcases.length,
      tenant: options.headers?.["X-Codebox-Tenant"] ?? null,
      maxDurationMs: body.max_duration_ms,
      oneShot: body.stop_on_failure === true,
    });
    const results = body.testcases.map((tc, index) => (skipCase(body, index)
      ? { index, status: "skipped", stdout: "", stderr: "", exitCode: null, timeMs: 0, wallTimeMs: 0, memory: 0 }
      : {
        index, status: "completed", stdout: `${tc.stdin}\n`, stderr: "", exitCode: 0, timeMs: 5, wallTimeMs: 8, memory: 1000,
        ...caseBehaviour(tc.stdin),
      }));
    await sleep(requestDelayMs(body.testcases.length));
    return new Response(JSON.stringify({ batchId: `b${requests.length}`, status: "completed", results }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${options.method || "GET"} ${url}`);
};
after(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(() => {
  requests = [];
  caseBehaviour = () => ({});
  skipCase = () => false;
  requestDelayMs = () => 0;
  nextStatus = null;
  __resetJudgeAdmissionForTests();
});

test("duration caps: the blind one-shot is short; a capped one-shot is re-run per tier with the same verdict", async () => {
  // 5 cases x 2 s = 10 s <= JUDGE_ONE_SHOT_MAX_COST_MS: the one-shot path.
  skipCase = (body, index) => body.stop_on_failure === true && index >= 3; // CodeBox reached its cap
  const session = openJudgeSession({ userId: "cap-user" });
  const r = await runWithJudgeSession(session, () => evaluateAllTestcases(problemWith(5), "python", "unused", "x"));
  session.close();
  const oneShot = requests.find((q) => q.oneShot);
  assert.equal(oneShot.maxDurationMs, 2000, "one-shot (always blind) is capped at JUDGE_BLIND_REQUEST_MAX_MS");
  const later = requests.filter((q) => !q.oneShot);
  assert.ok(later.length > 0, "the capped one-shot was followed by per-tier requests");
  assert.ok(later.every((q) => q.maxDurationMs === 16000), "once the session has run something: 2 x JUDGE_TARGET_CHUNK_MS");
  assert.equal(r.status, "ACCEPTED", "fast correct code: same verdict as without the cap");
  assert.equal(r.passedCount, 5);
});

test("cap-skipped cases in a chunk are re-run in a later request, never reported or judged as skipped", async () => {
  skipCase = (body, index) => !body.stop_on_failure && body.testcases.length > 1 && index === body.testcases.length - 1;
  const r = await evaluateAllTestcases(problemWith(100), "python", "unused", "x");
  assert.equal(r.status, "ACCEPTED");
  assert.equal(r.passedCount, 100, "every case ran exactly once with a real verdict");
});

test("a tier can never pass with unexecuted cases (a CodeBox that makes no progress)", async () => {
  skipCase = (body) => !body.stop_on_failure; // every case of every chunk skipped
  const r = await evaluateAllTestcases(problemWith(100), "python", "unused", "x");
  assert.equal(r.status, "TIME_LIMIT_EXCEEDED");
  assert.equal(r.firstFailure.budgetExceeded, false);
  assert.match(r.firstFailure.message, /too slowly/);
});

const problemWith = (count) => ({
  slug: "round2", timeLimit: 2000, memoryLimit: 256,
  testcases: Array.from({ length: count }, (_, i) => ({ testIndex: i, isVisible: i < 2, stdinSmall: String(i), expectedSmall: String(i) })),
});
const executed = () => requests.reduce((a, r) => a + r.cases, 0);
// What a real sandbox reports for `time.sleep(3.5)`: almost no CPU, 3.5 s wall.
const SLEEPING_WRONG = () => ({ stdout: "wrong\n", timeMs: 20, wallTimeMs: 3500 });
const SLEEPING_CORRECT = (stdin) => ({ stdout: `${stdin}\n`, timeMs: 20, wallTimeMs: 3500 });

test("FV-1: a sleeping wrong answer is cut off by the post-failure budget (wall time counts)", async () => {
  caseBehaviour = SLEEPING_WRONG;
  const r = await evaluateAllTestcases(problemWith(100), "python", "unused", "x");
  assert.equal(r.status, "WRONG_ANSWER");
  // Round 1 ran all 35 tier-1 cases (123 s of sandbox time for 0.8 s of CPU).
  assert.ok(executed() <= 10, `ran ${executed()} of 35 tier-1 cases`);
  assert.ok(r.sandboxTimeMs <= 40_000, `sandbox time ${r.sandboxTimeMs} ms`);
});

test("FV-1: a sleeping CORRECT answer cannot run every case: total budget, then Time Limit Exceeded", async () => {
  caseBehaviour = SLEEPING_CORRECT;
  const r = await withEnv({ JUDGE_EVALUATION_BUDGET_MS: "60000" }, () => evaluateAllTestcases(problemWith(100), "python", "unused", "x"));
  assert.equal(r.status, "TIME_LIMIT_EXCEEDED");
  assert.equal(r.budgetExceeded, true);
  assert.equal(r.firstFailure.budgetExceeded, true);
  // 60 s / 3.5 s = 17 cases, plus at most one in-flight chunk per lane
  // (2 lanes x 2 cases) when the budget runs out.
  assert.ok(executed() <= 22, `ran ${executed()} of 100 cases (60 s budget / 3.5 s per case)`);
  assert.ok(r.sandboxTimeMs >= 60_000 && r.sandboxTimeMs <= 60_000 + 2 * 8_000, `sandbox time ${r.sandboxTimeMs} ms`);
  assert.notEqual(r.status, "ACCEPTED", "unexecuted cases never let a tier pass");
});

test("chunks shrink for slow code so one CodeBox request stays near the target duration", async () => {
  caseBehaviour = SLEEPING_CORRECT;
  await withEnv({ JUDGE_EVALUATION_BUDGET_MS: "60000", JUDGE_TARGET_CHUNK_MS: "8000" }, () => evaluateAllTestcases(problemWith(100), "python", "unused", "x"));
  assert.equal(requests[0].cases, 2, "first chunk is small (JUDGE_FIRST_CHUNK_CASES)");
  for (const r of requests.slice(1)) assert.ok(r.cases <= 2, `later chunk of ${r.cases} cases x 3.5 s`);
});

test("fast accepted code is unaffected: every case runs, verdict ACCEPTED", async () => {
  const r = await evaluateAllTestcases(problemWith(100), "python", "unused", "x");
  assert.equal(r.status, "ACCEPTED");
  assert.equal(r.passedCount, 100);
  assert.equal(r.budgetExceeded, false);
});

test("fast wrong answers are still judged across the whole tier (passedCount keeps its meaning)", async () => {
  caseBehaviour = (stdin) => (stdin === "3" ? { stdout: "wrong\n" } : {});
  const r = await evaluateAllTestcases(problemWith(100), "python", "unused", "x");
  assert.equal(r.status, "WRONG_ANSWER");
  assert.equal(r.results.length, 35);
  assert.equal(r.passedCount, 34);
});

test("scheduler: a light user gets the next slot before a heavy user who queued earlier", () =>
  withEnv({ JUDGE_MAX_CONCURRENT: "1", JUDGE_MAX_ACTIVE_PER_USER: "1" }, async () => {
    const heavy = openJudgeSession({ userId: "heavy" });
    await heavy.run(async () => [{ cpuTimeMs: 10, wallTimeMs: 60_000 }]); // 60 s of recent usage
    const blocker = openJudgeSession({ userId: "blocker" });
    let releaseBlocker;
    const blocking = blocker.run(() => new Promise((r) => { releaseBlocker = r; }));
    await sleep(10);
    const order = [];
    const h = heavy.run(async () => { order.push("heavy"); return []; });
    await sleep(5);
    const light = openJudgeSession({ userId: "newcomer" });
    const l = light.run(async () => { order.push("newcomer"); return []; });
    await sleep(5);
    releaseBlocker([]);
    await Promise.all([blocking, h, l]);
    assert.deepEqual(order, ["newcomer", "heavy"]);
    for (const s of [heavy, blocker, light]) s.close();
  }));

test("FV-1 reproduction: 4 accounts with sleeping submissions + a 5th user's Run is served, not 503", () =>
  withEnv({ JUDGE_EVALUATION_BUDGET_MS: "60000" }, async () => {
    // Each mocked request takes 40 ms per case: a scaled-down sandbox.
    requestDelayMs = (n) => n * 40;
    caseBehaviour = (stdin) => (stdin === "victim" ? { stdout: "victim\n", wallTimeMs: 30 } : SLEEPING_WRONG());
    const attackers = [1, 2, 3, 4].map((i) => {
      const session = openJudgeSession({ userId: `attacker-${i}` });
      return runWithJudgeSession(session, () => evaluateAllTestcases(problemWith(100), "python", "unused", "x")).finally(() => session.close());
    });
    await sleep(150); // every slot is taken by an attacker now
    assert.equal(admission.judgeAdmissionStats().active, 4);
    const started = Date.now();
    const victim = openJudgeSession({ userId: "victim" });
    const { executeCodeBatch } = await import("../src/controllers/execution.controller.js");
    const [result] = await runWithJudgeSession(victim, () => executeCodeBatch({ language: "python", fullCode: "x", testcases: [{ stdin: "victim" }], timeLimit: 2000 }));
    const waited = Date.now() - started;
    victim.close();
    assert.equal(result.status, "OK");
    // Round 1: the victim waited 30 s and got 503 JUDGE_BUSY.
    assert.ok(waited < 1500, `victim waited ${waited} ms`);
    const outcomes = await Promise.all(attackers);
    for (const o of outcomes) assert.equal(o.status, "WRONG_ANSWER");
  }));

test("a session's later slots wait longer than the first-slot timeout; new sessions still get 503 in time", () =>
  withEnv({ JUDGE_MAX_CONCURRENT: "1", JUDGE_QUEUE_TIMEOUT_MS: "1000", JUDGE_CONTINUATION_TIMEOUT_MS: "10000" }, async () => {
    const running = openJudgeSession({ userId: "running" });
    await running.run(async () => []); // started
    const blocker = openJudgeSession({ userId: "blocker" });
    const blocking = blocker.run(() => sleep(1500).then(() => []));
    await sleep(10);
    const continuation = running.run(async () => "continued");
    const fresh = openJudgeSession({ userId: "fresh" });
    const keepAlive = setTimeout(() => {}, 3000);
    await assert.rejects(fresh.run(async () => []), (e) => e.code === "JUDGE_BUSY" && e.status === 503);
    assert.equal(await continuation, "continued");
    clearTimeout(keepAlive);
    await blocking;
    for (const s of [running, blocker, fresh]) s.close();
  }));

test("per-user session cap and execution budget (new accounts get less)", () =>
  withEnv({ JUDGE_MAX_SESSIONS_PER_USER: "2", JUDGE_USER_BUDGET_MS: "10000", JUDGE_NEW_ACCOUNT_BUDGET_MS: "3000" }, async () => {
    const a = openJudgeSession({ userId: "u1" });
    const b = openJudgeSession({ userId: "u1" });
    assert.throws(() => openJudgeSession({ userId: "u1" }), (e) => e.status === 429 && e.code === "JUDGE_USER_BUSY");
    await a.run(async () => [{ cpuTimeMs: 100, wallTimeMs: 10_000 }]);
    a.close();
    b.close();
    assert.throws(() => openJudgeSession({ userId: "u1" }), (e) => e.status === 429 && e.code === "EXECUTION_BUDGET_EXHAUSTED" && e.details.retryAfterSeconds > 0);
    assert.equal(judgeUserUsage("u1").used, 10_000);

    const fresh = openJudgeSession({ userId: "new-user", accountCreatedAt: new Date() });
    await fresh.run(async () => [{ cpuTimeMs: 10, wallTimeMs: 3000 }]);
    fresh.close();
    assert.throws(() => openJudgeSession({ userId: "new-user", accountCreatedAt: new Date() }), (e) => e.code === "EXECUTION_BUDGET_EXHAUSTED");
    const old = openJudgeSession({ userId: "old-user", accountCreatedAt: new Date(Date.now() - 30 * 86_400_000) });
    await old.run(async () => [{ cpuTimeMs: 10, wallTimeMs: 3000 }]);
    old.close();
    assert.doesNotThrow(() => openJudgeSession({ userId: "old-user", accountCreatedAt: new Date(Date.now() - 30 * 86_400_000) }).close());
  }));

test("CodeBox requests carry an opaque per-user tenant id inside a session, none outside", async () => {
  const session = openJudgeSession({ userId: "tenant-user" });
  await runWithJudgeSession(session, () => evaluateAllTestcases(problemWith(5), "python", "unused", "x"));
  session.close();
  const tenant = requests[0].tenant;
  assert.equal(tenant, codeboxTenantFor("tenant-user"));
  assert.ok(/^u\.[A-Za-z0-9_-]{32}$/.test(tenant) && !tenant.includes("tenant-user"), "never the real user id");
  requests = [];
  await evaluateAllTestcases(problemWith(5), "python", "unused", "x");
  assert.equal(requests[0].tenant, null);
});

test("CodeBox per-user budget answer becomes 429 EXECUTION_BUDGET_EXHAUSTED (no fallback path)", async () => {
  nextStatus = { status: 429, body: { code: "TENANT_BUDGET_EXHAUSTED", retryAfter: 120 } };
  const session = openJudgeSession({ userId: "over-budget" });
  await assert.rejects(
    runWithJudgeSession(session, () => evaluateAllTestcases(problemWith(5), "python", "unused", "x")),
    (e) => e.status === 429 && e.code === "EXECUTION_BUDGET_EXHAUSTED" && e.details.retryAfterSeconds === 120,
  );
  session.close();
});
