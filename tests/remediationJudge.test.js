// Regression tests for SECURITY_AUDIT.md SA-H1 (comparator ReDoS) and SA-H2
// (judge resource exhaustion). No database, no network: CodeBox is mocked.
import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.CODEBOX_URL = "https://codebox.test";
process.env.CODEBOX_TOKEN = "test-token";
process.env.COMPLEXITY_PROFILING_ENABLED = "false";

const { areOutputsEqual, normalizeOutput, exceedsOutputLimit, maxComparableOutputChars, DEFAULT_MAX_OUTPUT_CHARS } =
  await import("../src/utils/outputComparator.js");
const { acquireJudgeSlot, __resetJudgeAdmissionForTests } = await import("../src/utils/judgeAdmission.js");
// Loaded before any test is registered: importing it pulls in Prisma, whose
// synchronous load would otherwise overlap the event-loop measurements.
const { evaluateAllTestcases } = await import("../src/controllers/execution.controller.js");

// ---------------------------------------------------------------------------
// SA-H1: comparator
// ---------------------------------------------------------------------------

const OLD_DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/; // the vulnerable pattern, for reference

function timeMs(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

const N = 65_536;
const ADVERSARIAL = {
  "digits + non-digit": "1".repeat(N) + "x",
  "digits + CodeBox truncation marker": "1".repeat(N) + "\n[truncated]",
  "digits + dot + non-digit": "1".repeat(N / 2) + "." + "1".repeat(N / 2) + "x",
  "exponent run": "1e" + "1".repeat(N) + "x",
  "leading dot run": "." + "1".repeat(N) + "x",
  "signed digits": "-" + "1".repeat(N) + "e",
  "zeros": "0".repeat(N) + "x",
  "space-separated numbers": "1 ".repeat(N / 2) + "x",
  "comma-separated numbers": "1,".repeat(N / 2) + "x",
  "long JSON number array": "[" + "1,".repeat(N / 2) + "1]",
  "long JSON number": "[" + "1".repeat(N) + "]",
  "deep JSON nesting": "[".repeat(N / 2) + "]".repeat(N / 2),
  "unclosed JSON": "[".repeat(N),
  "whitespace run": " ".repeat(N) + "x",
  "CRLF lines": "1\r\n".repeat(N / 3),
};

test("SA-H1: the old pattern is quadratic (reference measurement)", () => {
  const t8 = timeMs(() => OLD_DECIMAL.test("1".repeat(8000) + "x"));
  const t16 = timeMs(() => OLD_DECIMAL.test("1".repeat(16000) + "x"));
  assert.ok(t16 > t8 * 2.5, `old pattern should scale super-linearly (8k: ${t8.toFixed(1)} ms, 16k: ${t16.toFixed(1)} ms)`);
});

test("SA-H1: every adversarial 64 KB output compares in linear time", () => {
  for (const [name, actual] of Object.entries(ADVERSARIAL)) {
    let result;
    // Median of 5 runs: measures the algorithm, not a GC pause.
    const runs = Array.from({ length: 5 }, () =>
      timeMs(() => {
        result = areOutputsEqual(actual, "42");
      }),
    ).sort((a, b) => a - b);
    assert.equal(typeof result, "boolean", `${name}: returns a boolean, never throws`);
    assert.ok(runs[2] < 100, `${name}: median ${runs[2].toFixed(1)} ms (must be < 100 ms; the old comparator needed ~8000 ms)`);
  }
});

test("SA-H1: comparing 50 adversarial outputs never blocks the event loop for long", async () => {
  areOutputsEqual(ADVERSARIAL["digits + CodeBox truncation marker"], "42"); // warm-up (JIT)
  let maxGap = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 5);
  for (let i = 0; i < 50; i++) {
    areOutputsEqual(ADVERSARIAL["digits + CodeBox truncation marker"], "42");
    await new Promise((resolve) => setImmediate(resolve));
  }
  clearInterval(timer);
  assert.ok(maxGap < 200, `max event-loop gap ${maxGap} ms`);
});

test("SA-H1: integer canonicalization is identical to BigInt (fuzz)", () => {
  const digits = "0123456789";
  for (let i = 0; i < 3000; i++) {
    const sign = ["", "+", "-"][i % 3];
    const len = 1 + (i % 40);
    let body = "";
    for (let k = 0; k < len; k++) body += i % 7 === 0 && k < 3 ? "0" : digits[(i * 31 + k * 17) % 10];
    const lexeme = sign + body;
    assert.equal(normalizeOutput(lexeme), BigInt(lexeme).toString(), lexeme);
  }
});

test("SA-H1: existing comparison semantics are preserved", () => {
  // empty / whitespace
  assert.equal(areOutputsEqual("", ""), true);
  assert.equal(areOutputsEqual("   \n", ""), true);
  assert.equal(areOutputsEqual("", "0"), false);
  // single numbers, leading/trailing whitespace, signs, zeros
  assert.equal(areOutputsEqual("  42\n", "42"), true);
  assert.equal(areOutputsEqual("007", "7"), true);
  assert.equal(areOutputsEqual("-0", "0"), true);
  assert.equal(areOutputsEqual("+5", "5"), true);
  assert.equal(areOutputsEqual("1e3", "1000"), true);
  assert.equal(areOutputsEqual("0.10", "0.1"), true);
  assert.equal(areOutputsEqual("1.", "1"), true);
  assert.equal(areOutputsEqual(".5", "0.5"), true);
  // exact 64-bit integers, long numeric sequences, repeated digits
  assert.equal(areOutputsEqual("9007199254740993", "9007199254740992"), false);
  const big = "9".repeat(5000);
  assert.equal(areOutputsEqual(big, big), true);
  assert.equal(areOutputsEqual(big, `${"9".repeat(4999)}8`), false);
  assert.equal(areOutputsEqual("1".repeat(1000), "1".repeat(1000)), true);
  // multiple spaces, newline variants, carriage returns
  assert.equal(areOutputsEqual("1   2    3", "1 2 3"), true);
  assert.equal(areOutputsEqual("1\r\n2\r\n3\r\n", "1\n2\n3"), true);
  assert.equal(areOutputsEqual("a\r\nb", "a b"), true);
  assert.equal(areOutputsEqual("hello\r", "hello"), true);
  // lists and JSON
  assert.equal(areOutputsEqual("7 0 8\n", "[7, 0, 8]"), true);
  assert.equal(areOutputsEqual("[42]", "42"), true);
  assert.equal(areOutputsEqual("[[1,2],[3]]", "[[1],[2,3]]"), false);
  assert.equal(areOutputsEqual("True", "true"), true);
  assert.equal(areOutputsEqual("yes", "true"), false);
});

test("SA-H1: output size limit (maximum accepted vs exceeding)", () => {
  assert.equal(DEFAULT_MAX_OUTPUT_CHARS, 65_536);
  assert.equal(exceedsOutputLimit("1".repeat(65_536), "1"), false, "maximum accepted output");
  assert.equal(exceedsOutputLimit("1".repeat(65_536) + "\n[truncated]", "1"), true, "CodeBox-truncated output");
  // A problem whose expected output is large still compares outputs of that size.
  const expected = "x".repeat(100_000);
  assert.equal(maxComparableOutputChars(expected), 201_024);
  assert.equal(exceedsOutputLimit(expected, expected), false);
  process.env.JUDGE_MAX_OUTPUT_CHARS = "2048";
  try {
    assert.equal(exceedsOutputLimit("1".repeat(2049), "1"), true, "configured limit applies");
    assert.equal(exceedsOutputLimit("1".repeat(2048), "1"), false);
    const expected1k = "e".repeat(1024);
    assert.equal(exceedsOutputLimit("1".repeat(3072), expected1k), false, "limit is max(limit, 2*expected + 1024)");
    assert.equal(exceedsOutputLimit("1".repeat(3073), expected1k), true);
  } finally {
    delete process.env.JUDGE_MAX_OUTPUT_CHARS;
  }
});

// ---------------------------------------------------------------------------
// SA-H2: fair admission
// ---------------------------------------------------------------------------

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  __resetJudgeAdmissionForTests();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      __resetJudgeAdmissionForTests();
    });
}

// Round 2: per-user limits are explicit here (defaults: 2 concurrent
// requests, 2 sessions per user).
test("SA-H2: one user can never hold more than their share of judge slots", () =>
  withEnv({ JUDGE_MAX_CONCURRENT: "3", JUDGE_MAX_QUEUE: "10", JUDGE_MAX_ACTIVE_PER_USER: "1", JUDGE_MAX_SESSIONS_PER_USER: "2" }, async () => {
    const a1 = await acquireJudgeSlot({ userId: "A" });
    let a2Granted = false;
    const a2 = acquireJudgeSlot({ userId: "A" }).then((r) => {
      a2Granted = true;
      return r;
    });
    await assert.rejects(acquireJudgeSlot({ userId: "A" }), (err) => err.code === "JUDGE_USER_BUSY" && err.status === 429);
    await new Promise((r) => setImmediate(r));
    assert.equal(a2Granted, false, "A's second job waits although two slots are free");
    const b1 = await acquireJudgeSlot({ userId: "B" }); // B is not blocked by A
    const c1 = await acquireJudgeSlot({ userId: "C" });
    a1();
    const a2Release = await a2;
    assert.equal(a2Granted, true);
    a2Release();
    b1();
    c1();
  }));

test("SA-H2: waiting users are served in turn and the queue is bounded", () =>
  withEnv({ JUDGE_MAX_CONCURRENT: "1", JUDGE_MAX_QUEUE: "2", JUDGE_QUEUE_TIMEOUT_MS: "5000" }, async () => {
    const order = [];
    const first = await acquireJudgeSlot({ userId: "A" });
    const b = acquireJudgeSlot({ userId: "B" }).then((r) => (order.push("B"), r));
    const c = acquireJudgeSlot({ userId: "C" }).then((r) => (order.push("C"), r));
    await assert.rejects(acquireJudgeSlot({ userId: "D" }), (err) => err.code === "JUDGE_BUSY" && err.status === 503);
    first();
    (await b)();
    (await c)();
    assert.deepEqual(order, ["B", "C"]);
  }));

test("SA-H2: a queued job that waits too long is rejected and frees its queue place", () =>
  withEnv({ JUDGE_MAX_CONCURRENT: "1", JUDGE_MAX_QUEUE: "1", JUDGE_QUEUE_TIMEOUT_MS: "1000" }, async () => {
    const holder = await acquireJudgeSlot({ userId: "A" });
    // The admission timer is unref'd (it must never keep a server alive), so
    // keep the test's event loop busy while waiting for it.
    const keepAlive = setTimeout(() => {}, 3000);
    await assert.rejects(acquireJudgeSlot({ userId: "B" }), (err) => err.code === "JUDGE_BUSY");
    clearTimeout(keepAlive);
    const again = acquireJudgeSlot({ userId: "C" }); // the place is free again
    holder();
    (await again)();
  }));

// ---------------------------------------------------------------------------
// SA-H2: judging cost (CodeBox batch API mocked)
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let batchRequests = [];
let caseBehaviour = () => ({});
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (options.method === "DELETE") return new Response(null, { status: 204 });
  if (url.pathname === "/batches" && options.method === "POST") {
    const body = JSON.parse(options.body);
    batchRequests.push(body.testcases.length);
    const results = body.testcases.map((tc, index) => ({
      index, status: "completed", stdout: `${tc.stdin}\n`, stderr: "", exitCode: 0, timeMs: 1, memory: 1000,
      ...caseBehaviour(tc.stdin),
    }));
    return new Response(JSON.stringify({ batchId: `b${batchRequests.length}`, status: "completed", results }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${options.method || "GET"} ${url}`);
};
after(() => {
  globalThis.fetch = originalFetch;
});

function problemWith(count) {
  return {
    slug: "cost-test",
    timeLimit: 1000,
    memoryLimit: 256,
    testcases: Array.from({ length: count }, (_, i) => ({
      testIndex: i, isVisible: i < 2, stdinSmall: String(i), expectedSmall: String(i),
    })),
  };
}

test("SA-H2: slow wrong answers stop after the post-failure CPU budget", async () => {
  process.env.CODEBOX_MULTICASE_ENABLED = "false";
  try {
    batchRequests = [];
    caseBehaviour = () => ({ stdout: "wrong\n", timeMs: 900 }); // every case: wrong, 0.9 s CPU
    const r = await evaluateAllTestcases(problemWith(100), "python", "unused", "x");
    const executed = batchRequests.reduce((a, b) => a + b, 0);
    assert.equal(r.status, "WRONG_ANSWER");
    assert.equal(r.tierReached, "Tier 0 (Failed)");
    assert.equal(r.firstFailure.testIndex, 0);
    assert.ok(executed <= 20, `ran ${executed} of 35 tier-1 cases (budget 10 s after the first failure)`);
    assert.equal(r.results.length, executed);
    assert.ok(r.results.every((x) => x.status !== "Skipped"));
  } finally {
    process.env.CODEBOX_MULTICASE_ENABLED = "true";
    caseBehaviour = () => ({});
  }
});

test("SA-H2: fast wrong answers are still judged across the whole tier (unchanged semantics)", async () => {
  process.env.CODEBOX_MULTICASE_ENABLED = "false";
  try {
    batchRequests = [];
    caseBehaviour = (stdin) => (stdin === "3" || stdin === "10" ? { stdout: "wrong\n" } : {});
    const r = await evaluateAllTestcases(problemWith(100), "python", "unused", "x");
    assert.equal(r.status, "WRONG_ANSWER");
    assert.equal(r.results.length, 35, "all of tier 1");
    assert.equal(r.passedCount, 33);
    assert.equal(r.firstFailure.testIndex, 3);
  } finally {
    process.env.CODEBOX_MULTICASE_ENABLED = "true";
    caseBehaviour = () => ({});
  }
});

test("SA-H2: accepted submissions run every case; large problems skip the one-shot batch", async () => {
  process.env.CODEBOX_MULTICASE_ENABLED = "false";
  try {
    batchRequests = [];
    const r = await evaluateAllTestcases(problemWith(100), "python", "unused", "x");
    assert.equal(r.status, "ACCEPTED");
    assert.equal(r.passedCount, 100);
    assert.ok(batchRequests.every((n) => n <= 20), "per-tier chunks, no 100-case one-shot batch");
    batchRequests = [];
    const small = await evaluateAllTestcases(problemWith(5), "python", "unused", "x");
    assert.equal(small.status, "ACCEPTED");
    assert.deepEqual(batchRequests, [5], "small problems keep the single one-shot request");
  } finally {
    process.env.CODEBOX_MULTICASE_ENABLED = "true";
  }
});

test("SA-H1/SA-H2: judging a tier of adversarial 64 KB outputs keeps the event loop responsive", async () => {
  process.env.CODEBOX_MULTICASE_ENABLED = "false";
  const big = "[" + "1,".repeat(32_766) + "1]"; // 65,535 chars: the most expensive comparable shape (~45 ms)
  assert.ok(big.length <= 65_536);
  let maxGap = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 5);
  try {
    batchRequests = [];
    caseBehaviour = () => ({ stdout: big }); // fast, wrong: the whole tier is judged
    const r = await evaluateAllTestcases(problemWith(100), "python", "unused", "x");
    assert.equal(r.status, "WRONG_ANSWER");
    assert.equal(r.results.length, 35, "whole tier judged (semantics unchanged)");
  } finally {
    clearInterval(timer);
    process.env.CODEBOX_MULTICASE_ENABLED = "true";
    caseBehaviour = () => ({});
  }
  // 35 comparisons x ~45 ms used to run back to back on the main thread.
  assert.ok(maxGap < 250, `max event-loop gap ${maxGap} ms during judging`);
});

test("SA-H1 via the judge: a truncated (oversized) output is Output Limit Exceeded, not compared", async () => {
  process.env.CODEBOX_MULTICASE_ENABLED = "false";
  try {
    batchRequests = [];
    caseBehaviour = (stdin) => (stdin === "1" ? { stdout: `${"1".repeat(65_536)}\n[truncated]` } : {});
    let r;
    const ms = timeMs(() => {});
    const start = Date.now();
    r = await evaluateAllTestcases(problemWith(5), "python", "unused", "x");
    assert.ok(Date.now() - start < 2000 + ms);
    assert.equal(r.status, "RUNTIME_ERROR", "Output Limit Exceeded maps to RUNTIME_ERROR like CodeBox's own OLE");
    assert.equal(r.firstFailure.status, "Output Limit Exceeded");
  } finally {
    process.env.CODEBOX_MULTICASE_ENABLED = "true";
    caseBehaviour = () => ({});
  }
});
