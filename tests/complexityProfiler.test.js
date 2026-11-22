// Complexity profiler: classifier, generator, harness framing, analysis,
// CodeBox interaction (mocked) and the background queue (in-memory DB).
// No real database or CodeBox is used.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.CODEBOX_URL = "https://runner.invalid";
process.env.CODEBOX_TOKEN = "test-token";

const { classifyGrowth, classifyTimeWithReference } = await import("../src/profiling/complexityFit.js");
const { addTwoNumbersProfile, generateInput, validateInput } = await import("../src/profiling/problems/addTwoNumbers.js");
const { buildProfileStdin, parseProfileOutput, wrapWithProfileHarness } = await import("../src/profiling/profileHarness.js");
const profiler = await import("../src/profiling/profiler.js");
const queue = await import("../src/profiling/profilingQueue.js");

const SIZES = [1000, 2000, 4000, 8000, 16000, 32000, 64000];
let seed = 99;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const jitter = (x, p) => x * (1 + (rnd() * 2 - 1) * p);

// ---------------------------------------------------------------- classifier

test("classifier: correct class on clean data, never confidently wrong under noise", () => {
  const gen = {
    "O(1)": () => 50,
    "O(log n)": (n) => 20 * Math.log2(n),
    "O(√n)": (n) => 3 * Math.sqrt(n),
    "O(n)": (n) => 2 * n + 40,
    "O(n log n)": (n) => n * Math.log2(n),
    "O(n²)": (n) => (n * n) / 100,
    "O(n³)": (n) => n ** 3 / 1e6,
  };
  for (const [k, f] of Object.entries(gen)) {
    const exact = classifyGrowth(SIZES.map((n) => ({ n, cost: jitter(f(n), 0.02) })));
    // Clean data: the right class, possibly hedged with a neighbour ("A or B").
    assert.equal(exact.complexity, k, `clean ${k} (got ${exact.label})`);
    for (let trial = 0; trial < 15; trial++) {
      const r = classifyGrowth(SIZES.map((n) => ({ n, cost: jitter(f(n), 0.2) })));
      if (r.complexity) assert.ok(r.candidates.includes(k), `${k} must stay a candidate (got ${r.label})`);
      if (r.label === r.complexity && r.complexity) assert.equal(r.complexity, k, `single answer must be right for ${k}`);
    }
  }
});

test("classifier: exponential and factorial on small-n ladders", () => {
  const small = [4, 6, 8, 10, 12, 14, 16, 18, 20];
  const fact = (n) => Array.from({ length: n }, (_, i) => i + 1).reduce((a, b) => a * b, 1);
  assert.equal(classifyGrowth(small.map((n) => ({ n, cost: 2 ** n + 100 }))).complexity, "O(2ⁿ)");
  assert.equal(classifyGrowth(small.map((n) => ({ n, cost: fact(n) + 100 }))).complexity, "O(n!)");
});

test("classifier: one outlying size (cache boundary) cannot force a wrong class", () => {
  // Measured on CodeBox: an O(n²) pair count whose last size crossed the L1
  // cache boundary (local exponents 2.04, 2.00, 2.89). A plain fit says O(n³).
  const live = [[1000, 271362], [2000, 1120889], [4000, 4492993], [8000, 33279746]].map(([n, cost]) => ({ n, cost }));
  const r = classifyGrowth(live);
  assert.equal(r.complexity, "O(n²)");
  assert.equal(r.label, "O(n²) or O(n³)");
  assert.equal(r.confidence, "Low");
});

test("classifier: too few sizes or too narrow a range is Inconclusive", () => {
  assert.equal(classifyGrowth([1000, 2000, 4000].map((n) => ({ n, cost: n }))).confidence, "Inconclusive");
  assert.equal(classifyGrowth([1000, 1500, 2000, 3000].map((n) => ({ n, cost: n }))).confidence, "Inconclusive");
});

test("reference calibration separates O(n) from O(n log n) despite cache effects", () => {
  // Per-element cost that rises with the working set (cache misses), applied
  // to both the solution and the O(n) reference measured alongside it.
  const cache = (n) => 1 + 1.2 * Math.min(1, Math.max(0, Math.log2(n / 4000) / 4));
  const linear = SIZES.map((n) => ({ n, cost: jitter(50 * n * cache(n), 0.03), refCost: jitter(50 * n * cache(n), 0.03) }));
  const raw = classifyGrowth(linear.map(({ n, cost }) => ({ n, cost })));
  assert.notEqual(raw.label, "O(n)", "raw timings alone are misled by the cache effect");
  const fixed = classifyTimeWithReference(linear);
  assert.equal(fixed.label, "O(n)");
  assert.equal(fixed.method, "reference-normalized");

  const nlogn = SIZES.map((n) => ({ n, cost: jitter(5 * n * Math.log2(n) * cache(n), 0.03), refCost: jitter(50 * n * cache(n), 0.03) }));
  assert.equal(classifyTimeWithReference(nlogn).complexity, "O(n log n)");

  // Quadratic stays decided by raw timings.
  const quad = SIZES.map((n) => ({ n, cost: jitter(n * n, 0.03), refCost: 50 * n }));
  assert.equal(classifyTimeWithReference(quad).label, "O(n²)");
});

// ----------------------------------------------------------- generator & io

test("Add Two Numbers generator: valid inputs for every pattern, worst case is all 9s", () => {
  for (const pattern of ["max-carry", "random", "unequal"]) {
    for (const n of [1, 2, 1000, 64000]) {
      const input = generateInput(n, pattern);
      const v = validateInput(input);
      assert.ok(v.ok, `${pattern} n=${n}: ${v.reason}`);
      assert.equal(v.size, n);
    }
  }
  assert.equal(generateInput(5, "max-carry"), "5 5\n99999\n99999\n");
  assert.equal(generateInput(1000, "random"), generateInput(1000, "random"), "deterministic");
  assert.equal(validateInput("2 2\n90\n99\n").ok, false, "leading zero (reverse order) rejected");
  assert.equal(validateInput("2 2\n9a\n99\n").ok, false, "non-digit rejected");
  assert.equal(validateInput("3 2\n99\n99\n").ok, false, "length mismatch rejected");
  assert.throws(() => generateInput(10, "nope"));
});

test("profiling harness: inputs sent once and reused, report parsed", () => {
  const stdin = buildProfileStdin(
    [
      { input: "AB", repetitions: 1, tag: "baseline" },
      { reusePrevious: true, repetitions: 3, tag: "user" },
    ],
    { timeLimitMs: 3000, budgetMs: 13500, stopAboveCpuMs: 1200 },
  ).toString();
  const payload = "1 baseline\n2\nAB" + "3 user\n-1\n"; // second run reuses "AB" without resending it
  assert.equal(stdin, `C8PF1 2 3000 13500 1200 ${payload.length}\n${payload}`);
  assert.throws(() => buildProfileStdin([{ input: "x", repetitions: 1, tag: "bad tag" }], { timeLimitMs: 1, budgetMs: 1, stopAboveCpuMs: 1 }));
  const report = parseProfileOutput(Buffer.from("C8PF1 2\n#P 0 0 0 0 5 6 3000 3 0\nabc#P 1 0 139 11 1 1 2000 0 2\nxy#PEND failed\n"));
  assert.equal(report.invocations.length, 2);
  assert.equal(report.invocations[0].stdout, "abc");
  assert.equal(report.invocations[1].signal, 11);
  assert.equal(report.invocations[1].stderr, "xy");
  assert.equal(report.endReason, "failed");
  assert.equal(parseProfileOutput(Buffer.from("garbage")), null);
  const src = wrapWithProfileHarness("int main(){}", "cpp");
  assert.ok(src.includes("munmap(in, mapLen);") && src.includes("setpgid(0, 0);") && src.includes("kill(-pid, SIGKILL);"));
});

// ---------------------------------------------------------------- analysis

/** Builds fake per-size measurements as collectMeasurements returns them. */
function fakeSizes({ time, ref = (n) => 50 * n, aux = () => 0, stack = () => 0, failFrom = Infinity, reps = 3 }) {
  return SIZES.map((n) => ({
    n,
    baseline: [{ exitCode: 0, signal: 0, ok: true, rssAfterKb: 20000 + n / 100 }],
    user: Array.from({ length: reps }, () =>
      n >= failFrom
        ? { exitCode: 139, signal: 11, ok: false }
        : {
            exitCode: 0, signal: 0, ok: true, medianNs: jitter(time(n), 0.02) + 30, timerNs: 30, refMedianNs: jitter(ref(n), 0.02) + 30,
            heapPeakBytes: aux(n) + 16 * (n + 1), newOutNodes: n + 1, nodeBytes: 16, stackBytes: stack(n), rssAfterKb: 20000 + n / 50,
          },
    ),
  }));
}

test("analysis: linear time, O(1) auxiliary space (output nodes are not auxiliary)", () => {
  const a = profiler.analyzeMeasurements(fakeSizes({ time: (n) => 50 * n }), { repetitions: 3, definition: addTwoNumbersProfile });
  assert.equal(a.time.label, "O(n)");
  assert.equal(a.space.label, "O(1)");
  assert.equal(a.space.confidence, "High");
  assert.equal(a.invalidReason, null);
});

test("analysis: recursion depth is O(n) auxiliary space", () => {
  const a = profiler.analyzeMeasurements(fakeSizes({ time: (n) => 50 * n, stack: (n) => 48 * n }), { repetitions: 3, definition: addTwoNumbersProfile });
  assert.equal(a.space.complexity, "O(n)");
});

test("analysis: a solution failing on oversized inputs is never classified from too little data", () => {
  const partial = profiler.analyzeMeasurements(fakeSizes({ time: (n) => 50 * n, failFrom: 4000 }), { repetitions: 3, definition: addTwoNumbersProfile });
  assert.equal(partial.time.confidence, "Inconclusive");
  assert.match(partial.invalidReason, /failed on a profiling input of size 4000/);
  const later = profiler.analyzeMeasurements(fakeSizes({ time: (n) => 50 * n, failFrom: 32000 }), { repetitions: 3, definition: addTwoNumbersProfile });
  assert.ok(["Low", "Medium"].includes(later.time.confidence), "partial curve lowers confidence");
});

// ------------------------------------------------- profiler + mocked CodeBox

function driverLine(n, { ns = 50 * n, ref = 50 * n } = {}) {
  return `C8M v=1 ok=1 n=${n} m=${n} first_ns=${ns} cpu_ns=${ns} median_ns=${ns} min_ns=${ns} calls=5 timer_ns=30 heap_peak=${16 * (n + 1)} out_nodes=${n + 1} new_out_nodes=${n + 1} node_bytes=16 rss_before_kb=20000 rss_after_kb=${20000 + n / 50} stack_bytes=0 ref_median_ns=${ref}\n`;
}

function mockCodebox(respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const entry = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null };
    calls.push(entry);
    return respond(entry);
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const problemJson = JSON.parse(fs.readFileSync(new URL("../problems/add-two-numbers.json", import.meta.url)));
const problem = { slug: "add-two-numbers", templates: problemJson.templates };
const userCode = "ListNode* addTwoNumbers(ListNode* a, ListNode* b) { return nullptr; }";
const config = { ...profiler.getProfilingConfig({}), enabled: true };
// Sizes the profiler actually uses with the default configuration.
const PROFILE_SIZES = addTwoNumbersProfile.sizes.filter((n) => n <= config.maxInputSize);

test("profiler: one small CodeBox submission (compile once), payload deleted afterwards, O(n) result", async () => {
  const mock = mockCodebox(({ url, method, body }) => {
    if (method === "POST") {
      const report = [`C8PF1 ${PROFILE_SIZES.length * 2}\n`];
      PROFILE_SIZES.forEach((n, i) => {
        const base = driverLine(n);
        report.push(`#P ${2 * i} 0 0 0 1 1 3000 ${base.length} 0\n${base}`);
        for (let rep = 0; rep < 3; rep++) {
          const line = driverLine(n, { ns: Math.round(jitter(50 * n, 0.02)) });
          report.push(`#P ${2 * i + 1} ${rep} 0 0 1 1 3000 ${line.length} 0\n${line}`);
        }
      });
      report.push("#PEND done\n");
      return new Response(JSON.stringify({ token: "tok1", status: { id: 3, description: "Accepted" }, stdout: Buffer.from(report.join("")).toString("base64") }), { status: 201 });
    }
    if (method === "DELETE") return new Response("{}", { status: 200 });
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const r = await profiler.runComplexityProfile({ definition: addTwoNumbersProfile, problem, language: "cpp", userCode, config });
    await new Promise((res) => setImmediate(res));
    const post = mock.calls.find((c) => c.method === "POST");
    const source = Buffer.from(post.body.source_code, "base64").toString();
    assert.ok(source.includes(userCode) && source.includes("c8_reference_addTwoNumbers") && source.includes("C8PF1"));
    assert.ok(post.body.memory_limit <= 512000, "within CodeBox's max memory limit");
    assert.ok(Buffer.from(post.body.stdin, "base64").length < 400 * 1024, "small request");
    assert.equal(mock.calls.filter((c) => c.method === "POST").length, 1, "compiled and run once");
    assert.ok(mock.calls.some((c) => c.method === "DELETE" && c.url.pathname === "/submissions/tok1"));
    assert.equal(r.status, "COMPLETED");
    assert.equal(r.timeComplexity, "O(n)");
    assert.equal(r.spaceComplexity, "O(1)");
    assert.deepEqual(r.inputSizes, PROFILE_SIZES);
  } finally {
    mock.restore();
  }
});

test("profiler: CodeBox outage is retryable, a driver compile failure is not", async () => {
  let mock = mockCodebox(() => new Response("{}", { status: 503 }));
  try {
    await assert.rejects(
      profiler.runComplexityProfile({ definition: addTwoNumbersProfile, problem, language: "cpp", userCode, config }),
      (e) => e.retryable === true && e.code === "EXECUTION_UNAVAILABLE",
    );
  } finally {
    mock.restore();
  }
  mock = mockCodebox(({ method }) =>
    method === "DELETE"
      ? new Response("{}")
      : new Response(JSON.stringify({ token: "t", status: { id: 6 }, compile_output: Buffer.from("err").toString("base64") }), { status: 201 }),
  );
  try {
    await assert.rejects(
      profiler.runComplexityProfile({ definition: addTwoNumbersProfile, problem, language: "cpp", userCode, config }),
      (e) => e.retryable === false && e.code === "PROFILE_COMPILE_FAILED",
    );
  } finally {
    mock.restore();
  }
});

test("profiler: unsupported language is rejected up front", async () => {
  await assert.rejects(
    profiler.runComplexityProfile({ definition: addTwoNumbersProfile, problem, language: "python", userCode: "x", config }),
    (e) => e.code === "UNSUPPORTED",
  );
});

// ------------------------------------------------------- queue (in-memory DB)

function fakeDb() {
  const rows = [];
  const submissions = new Map();
  let id = 0;
  const match = (row, where = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && !(v instanceof Date)) {
        if ("in" in v) return v.in.includes(row[k]);
        if ("lt" in v) return row[k] < v.lt;
      }
      return row[k] === v;
    });
  const db = {
    rows,
    submissions,
    complexityProfile: {
      count: async ({ where }) => rows.filter((r) => match(r, where)).length,
      create: async ({ data }) => {
        if (rows.some((r) => r.submissionId === data.submissionId)) {
          const e = new Error("unique");
          e.code = "P2002";
          throw e;
        }
        const row = { id: `p${++id}`, attempts: 0, nextAttemptAt: new Date(), createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      },
      findUnique: async ({ where }) => rows.find((r) => match(r, where)) || null,
      findFirst: async ({ where }) => rows.filter((r) => match(r, where)).sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)[0] || null,
      update: async ({ where, data }) => Object.assign(rows.find((r) => match(r, where)), data),
      updateMany: async ({ where, data }) => {
        const hit = rows.filter((r) => match(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    },
    submission: { findUnique: async ({ where }) => submissions.get(where.id) || null },
    $queryRaw: async () => {
      const job = rows.filter((r) => r.status === "PENDING" && r.nextAttemptAt <= new Date()).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!job) return [];
      Object.assign(job, { status: "RUNNING", startedAt: new Date(), attempts: job.attempts + 1 });
      return [{ ...job }];
    },
  };
  return db;
}

const acceptedSubmission = { code: userCode, language: "cpp", status: "ACCEPTED", problem };

test("queue: one job per submission, bounded backlog, disabled/unsupported never queue", async () => {
  const db = fakeDb();
  queue.__setPrismaForTests(db);
  ["s1", "s2", "s3"].forEach((id) => db.submissions.set(id, acceptedSubmission));
  queue.__setProfileRunnerForTests(() => new Promise(() => {})); // claimed jobs stay RUNNING
  process.env.COMPLEXITY_PROFILING_TIMEOUT_MS = "500";
  process.env.COMPLEXITY_PROFILING_ENABLED = "false";
  assert.equal((await queue.enqueueComplexityProfile({ submissionId: "s0", problemSlug: "add-two-numbers", language: "cpp" })).status, "UNAVAILABLE");
  process.env.COMPLEXITY_PROFILING_ENABLED = "true";
  process.env.COMPLEXITY_PROFILING_MAX_PENDING = "2";
  process.env.COMPLEXITY_PROFILING_CONCURRENCY = "1";
  try {
    assert.equal((await queue.enqueueComplexityProfile({ submissionId: "s1", problemSlug: "two-sum", language: "cpp" })).status, "UNAVAILABLE");
    assert.equal((await queue.enqueueComplexityProfile({ submissionId: "s1", problemSlug: "add-two-numbers", language: "python" })).status, "UNAVAILABLE");
    assert.equal((await queue.enqueueComplexityProfile({ submissionId: "s1", problemSlug: "add-two-numbers", language: "cpp" })).status, "PENDING");
    await queue.enqueueComplexityProfile({ submissionId: "s1", problemSlug: "add-two-numbers", language: "cpp" });
    assert.equal(db.rows.filter((r) => r.submissionId === "s1").length, 1, "duplicate enqueue creates no second job");
    await queue.enqueueComplexityProfile({ submissionId: "s2", problemSlug: "add-two-numbers", language: "cpp" });
    const full = await queue.enqueueComplexityProfile({ submissionId: "s3", problemSlug: "add-two-numbers", language: "cpp" });
    assert.equal(full.status, "FAILED");
    assert.match(db.rows.find((r) => r.submissionId === "s3").failureReason, /queue is full/);
  } finally {
    process.env.COMPLEXITY_PROFILING_ENABLED = "false";
    delete process.env.COMPLEXITY_PROFILING_MAX_PENDING;
    queue.__resetQueueStateForTests();
  }
});

test("queue: results stored; infra errors retried with backoff; user-code outcomes not retried", async () => {
  const db = fakeDb();
  queue.__setPrismaForTests(db);
  db.submissions.set("s1", acceptedSubmission);
  const job = async (submissionId) => {
    const row = await db.complexityProfile.create({ data: { submissionId, language: "cpp", problemSlug: "add-two-numbers", status: "PENDING" } });
    const [claimed] = await db.$queryRaw();
    assert.equal(claimed.id, row.id);
    return { row, claimed };
  };

  queue.__setProfileRunnerForTests(async () => ({
    status: "COMPLETED", timeComplexity: "O(n)", timeConfidence: "High", spaceComplexity: "O(1)", spaceConfidence: "High",
    confidence: "High", inputSizes: SIZES, measurements: [], baseline: [], analysis: { notes: [] }, durationMs: 5, failureReason: null,
  }));
  let { row, claimed } = await job("s1");
  await queue.processJob(claimed);
  assert.equal(row.status, "COMPLETED");
  assert.equal(row.timeComplexity, "O(n)");
  assert.equal(acceptedSubmission.status, "ACCEPTED", "the submission is never modified");

  db.submissions.set("s2", acceptedSubmission);
  queue.__setProfileRunnerForTests(async () => {
    throw new profiler.ProfilingError("CodeBox down", { code: "EXECUTION_UNAVAILABLE", retryable: true });
  });
  ({ row, claimed } = await job("s2"));
  const before = Date.now();
  await queue.processJob(claimed);
  assert.equal(row.status, "PENDING", "retry scheduled");
  assert.ok(row.nextAttemptAt.getTime() >= before + 29_000, "with backoff");
  row.attempts = 3; // retries exhausted
  await queue.processJob({ ...claimed, attempts: 3 });
  assert.equal(row.status, "FAILED");

  db.submissions.set("s3", acceptedSubmission);
  queue.__setProfileRunnerForTests(async () => {
    throw new profiler.ProfilingError("sandbox killed it", { code: "PROFILE_NO_REPORT" });
  });
  ({ row, claimed } = await job("s3"));
  await queue.processJob(claimed);
  assert.equal(row.status, "INCONCLUSIVE", "solution-caused failure -> inconclusive, not retried");
  assert.equal(row.attempts, 1);
  queue.__resetQueueStateForTests();
});

test("queue: a job waits while normal judging is running", async () => {
  const db = fakeDb();
  queue.__setPrismaForTests(db);
  db.submissions.set("s1", acceptedSubmission);
  let ranAt = 0;
  queue.__setProfileRunnerForTests(async () => {
    ranAt = Date.now();
    return { status: "INCONCLUSIVE", analysis: {}, failureReason: "x" };
  });
  await db.complexityProfile.create({ data: { submissionId: "s1", language: "cpp", problemSlug: "add-two-numbers", status: "PENDING" } });
  const [claimed] = await db.$queryRaw();
  queue.markJudgingStart();
  const release = Date.now() + 600;
  setTimeout(() => queue.markJudgingEnd(), 600);
  await queue.processJob(claimed);
  assert.ok(ranAt >= release - 20, "profiling started only after judging finished");
  queue.__resetQueueStateForTests();
});

test("queue: stale RUNNING jobs from a dead worker are recovered at startup", async () => {
  const db = fakeDb();
  queue.__setPrismaForTests(db);
  queue.__setProfileRunnerForTests(() => new Promise(() => {}));
  const old = new Date(Date.now() - 10 * 60 * 1000);
  db.submissions.set("x", acceptedSubmission);
  db.rows.push({ id: "a", submissionId: "x", status: "RUNNING", startedAt: old, attempts: 1, nextAttemptAt: old, createdAt: old });
  db.rows.push({ id: "b", submissionId: "y", status: "RUNNING", startedAt: old, attempts: 3, nextAttemptAt: old, createdAt: old });
  process.env.COMPLEXITY_PROFILING_ENABLED = "true";
  try {
    await queue.startProfilingWorker();
    await new Promise((r) => setTimeout(r, 300)); // let the worker claim its job against the fake DB
    assert.equal(db.rows.find((r) => r.id === "b").status, "FAILED", "attempts exhausted");
    assert.ok(["PENDING", "RUNNING"].includes(db.rows.find((r) => r.id === "a").status), "re-queued");
  } finally {
    process.env.COMPLEXITY_PROFILING_ENABLED = "false";
    queue.__resetQueueStateForTests();
    queue.__setProfileRunnerForTests(null);
    queue.__setPrismaForTests(null);
  }
});
