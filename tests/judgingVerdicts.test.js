// Verdict classification and submission statistics through the real
// evaluateAllTestcases, with CodeBox mocked (no database, no network).
import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "a".repeat(40);
process.env.OAUTH_STATE_SECRET = "b".repeat(40);
process.env.CODEBOX_URL = "https://runner.invalid";
process.env.CODEBOX_TOKEN = "test-token";
process.env.CODEBOX_BATCH_EXECUTION_ENABLED = "true";
process.env.CODEBOX_MULTICASE_ENABLED = "true";

const originalFetch = globalThis.fetch;
let handler = null;
let requests = [];
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  const entry = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null };
  requests.push(entry);
  return handler(entry);
};
test.after(() => {
  globalThis.fetch = originalFetch;
});

const { evaluateAllTestcases, executeCodeBatch, verdictForFailure } = await import("../src/controllers/execution.controller.js");
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** Decodes the harness stdin -> { inputs, stopOnTimeout }. */
function harnessInputs(body) {
  const raw = Buffer.from(body.stdin, "base64").toString();
  const nl = raw.indexOf("\n");
  const [, , count, , flags] = raw.slice(0, nl).split(" ").map(Number);
  let rest = raw.slice(nl + 1);
  const inputs = [];
  for (let i = 0; i < count; i++) {
    const j = rest.indexOf("\n");
    const len = Number(rest.slice(0, j));
    inputs.push(rest.slice(j + 1, j + 1 + len));
    rest = rest.slice(j + 1 + len);
  }
  return { inputs, stopOnTimeout: (flags & 1) === 1 };
}

/**
 * Mock of the multi-case harness: behaviour(input) returns the raw outcome of
 * one testcase; the mock honours stop-on-timeout like the real harness.
 */
function harnessMock(behaviour) {
  return ({ url, method, body }) => {
    assert.equal(url.pathname, "/submissions");
    assert.equal(method, "POST");
    const { inputs, stopOnTimeout } = harnessInputs(body);
    let out = `C8MC1 ${inputs.length}\n`;
    let stopped = false;
    for (let i = 0; i < inputs.length; i++) {
      const r = { exitCode: 0, signal: 0, cpuMs: 1, wallMs: 1, memKb: 3000, stdout: "", ...behaviour(inputs[i]) };
      out += `#C8 ${i} ${r.exitCode} ${r.signal} ${r.cpuMs} ${r.wallMs} ${r.memKb} ${Buffer.byteLength(r.stdout)} 0\n${r.stdout}`;
      const timedOut = r.signal === 9 && r.wallMs >= 2000;
      if (stopOnTimeout && timedOut) { stopped = true; break; }
    }
    out += stopped ? "#C8END TLE\n" : "#C8END\n";
    return json({ token: "t", status: { id: 3 }, stdout: Buffer.from(out).toString("base64") });
  };
}

// 20 testcases: input "<i>", expected output "<i>". Tiers: 0-6, 7-13, 14-19.
const problem = {
  slug: "verdict-test",
  timeLimit: 1000,
  memoryLimit: 256,
  testcases: Array.from({ length: 20 }, (_, i) => ({
    testIndex: i, isVisible: i < 2, stdinSmall: String(i), expectedSmall: String(i),
  })),
};
const run = (behaviour, language = "cpp") => {
  requests = [];
  handler = harnessMock(behaviour);
  return evaluateAllTestcases(problem, language, "unused", "int main(){}");
};
const ok = (input) => ({ stdout: `${input}\n` });

test("verdictForFailure keeps every failure class distinct", () => {
  assert.equal(verdictForFailure("Time Limit Exceeded"), "TIME_LIMIT_EXCEEDED");
  assert.equal(verdictForFailure("Memory Limit Exceeded"), "MEMORY_LIMIT_EXCEEDED");
  assert.equal(verdictForFailure("Runtime Error"), "RUNTIME_ERROR");
  assert.equal(verdictForFailure("Output Limit Exceeded"), "RUNTIME_ERROR");
  assert.equal(verdictForFailure("Compilation Error"), "COMPILATION_ERROR");
  assert.equal(verdictForFailure("Wrong Answer"), "WRONG_ANSWER");
});

test("accepted: every case passes", async () => {
  const r = await run(ok);
  assert.equal(r.status, "ACCEPTED");
  assert.equal(r.passedCount, 20);
  assert.equal(r.results.length, 20);
  assert.equal(r.tierReached, "Tier 3 (Optimal)");
});

test("wrong answer: whole tier is judged, later tiers not run", async () => {
  const r = await run((input) => (input === "3" || input === "5" ? { stdout: "nope\n" } : ok(input)));
  assert.equal(r.status, "WRONG_ANSWER");
  assert.equal(r.results.length, 7, "tier 1 only");
  assert.equal(r.passedCount, 5);
  assert.equal(r.firstFailure.testIndex, 3);
  assert.equal(r.tierReached, "Tier 0 (Failed)");
});

test("runtime error and output-limit are RUNTIME_ERROR", async () => {
  assert.equal((await run((i) => (i === "4" ? { exitCode: 139, signal: 11 } : ok(i)))).status, "RUNTIME_ERROR");
  assert.equal((await run((i) => (i === "4" ? { exitCode: 153, signal: 25 } : ok(i)))).status, "RUNTIME_ERROR");
});

test("memory limit is MEMORY_LIMIT_EXCEEDED (not WRONG_ANSWER), other cases unaffected", async () => {
  const r = await run((i) => (i === "2" ? { exitCode: 137, signal: 9, memKb: 270000, cpuMs: 150, wallMs: 200 } : ok(i)));
  assert.equal(r.status, "MEMORY_LIMIT_EXCEEDED");
  assert.equal(r.passedCount, 6, "every other tier-1 case keeps its own verdict");
  assert.equal(r.firstFailure.testIndex, 2);
});

test("TLE mid-tier: execution stops and the statistics stay consistent", async () => {
  // Tier 1 passes; testcase 9 (tier 2) times out; 10..19 never run.
  const r = await run((i) => (i === "9" ? { exitCode: 137, signal: 9, cpuMs: 0, wallMs: 2005 } : ok(i)));
  assert.equal(r.status, "TIME_LIMIT_EXCEEDED");
  assert.equal(r.totalCount, 20);
  assert.equal(r.passedCount, 9, "7 (tier 1) + 7 and 8 (tier 2, before the TLE)");
  assert.equal(r.results.length, 10, "executed cases only: 0..9");
  assert.ok(r.results.every((x) => x.status !== "Skipped"), "skipped cases never appear as results");
  assert.equal(r.results.filter((x) => x.passed).length, r.passedCount);
  assert.equal(r.firstFailure.testIndex, 9);
  assert.equal(r.tierReached, "Tier 1 (Brute Force)");
  assert.ok(Number.isFinite(r.maxTimeMs) && Number.isFinite(r.maxMemoryKb));
});

test("TLE in the very first case: nothing passed, one case ran", async () => {
  const r = await run(() => ({ exitCode: 137, signal: 9, cpuMs: 1001, wallMs: 2001 }));
  assert.equal(r.status, "TIME_LIMIT_EXCEEDED");
  assert.equal(r.passedCount, 0);
  assert.equal(r.results.length, 1);
  assert.equal(r.tierReached, "Tier 0 (Failed)");
});

test("batch path: a memory-limit kill does not leak into later testcases", async () => {
  process.env.CODEBOX_MULTICASE_ENABLED = "false";
  try {
    requests = [];
    // What the deployed CodeBox returns once a lane's cgroup recorded an OOM
    // kill: every later case is "memory_limit_exceeded" (sticky flag).
    handler = ({ url, method, body }) => {
      assert.equal(url.pathname, "/batches");
      assert.equal(method, "POST");
      const results = body.testcases.map((tc, index) => {
        const base = { index, stdout: `${tc.stdin}\n`, stderr: "", timeMs: 5, memory: 3000, exitCode: 0, exitSignal: null };
        if (tc.stdin === "a") return { ...base, status: "memory_limit_exceeded", stdout: "", stderr: "Killed\n", exitCode: 137, memory: 262000 };
        if (tc.stdin === "loop") return { ...base, status: "memory_limit_exceeded", stdout: "", exitCode: 137, timeMs: 1000 };
        if (tc.stdin === "crash") return { ...base, status: "memory_limit_exceeded", stdout: "", exitCode: 139, exitSignal: 11 };
        return { ...base, status: "memory_limit_exceeded" };
      });
      return json({ batchId: "b", status: "completed", results });
    };
    const r = await executeCodeBatch({
      language: "python", fullCode: "x", timeLimit: 1000, memoryLimit: 256,
      testcases: [{ stdin: "a" }, { stdin: "b" }, { stdin: "loop" }, { stdin: "crash" }, { stdin: "c" }],
    });
    assert.deepEqual(r.map((x) => x.status), [
      "Memory Limit Exceeded", "OK", "Time Limit Exceeded", "Runtime Error", "OK",
    ]);
    assert.equal(r[1].actual, "b");
  } finally {
    process.env.CODEBOX_MULTICASE_ENABLED = "true";
  }
});
