// Routing tests for C/C++ multi-case execution (mocked CodeBox, no database).
import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "a".repeat(40);
process.env.OAUTH_STATE_SECRET = "b".repeat(40);
process.env.CODEBOX_URL = "https://runner.invalid";
process.env.CODEBOX_TOKEN = "test-token";
process.env.CODEBOX_BATCH_EXECUTION_ENABLED = "true";
process.env.CODEBOX_MULTICASE_ENABLED = "true";

const originalFetch = globalThis.fetch;
let requests = [];
let handler = null;

// Result cleanup (DELETE /submissions/:token after reading) is recorded
// separately so request counts only cover execution traffic.
const cleanupDeletes = [];
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (options.method === "DELETE") {
    cleanupDeletes.push(url.pathname);
    return new Response(null, { status: 204 });
  }
  const entry = { url, options, body: options.body ? JSON.parse(options.body) : null };
  requests.push(entry);
  return handler(entry);
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const b64 = (s) => Buffer.from(s).toString("base64");

/** Builds a harness report: cases = [{ stdout, exitCode?, signal?, cpuMs?, wallMs? }]. */
function harnessReport(cases, { stoppedOnTimeout = false, total = cases.length } = {}) {
  let out = `C8MC1 ${total}\n`;
  cases.forEach((c, i) => {
    const stdout = c.stdout ?? "";
    out += `#C8 ${i} ${c.exitCode ?? 0} ${c.signal ?? 0} ${c.cpuMs ?? 1} ${c.wallMs ?? 1} 3000 ${Buffer.byteLength(stdout)} 0\n${stdout}`;
  });
  out += stoppedOnTimeout ? "#C8END TLE\n" : "#C8END\n";
  return out;
}

/** Decodes the harness stdin sent to CodeBox and returns the per-case inputs. */
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
  return { inputs, flags };
}

const batchApiOk = ({ url, options, body }) => {
  if (url.pathname === "/batches" && options.method === "POST") {
    return json({
      batchId: "b1",
      status: "completed",
      results: body.testcases.map((tc, index) => ({
        index, status: "completed", stdout: `${tc.stdin.trim()}!\n`, stderr: "", exitCode: 0, timeMs: 5, memory: 1000,
      })),
    });
  }
  throw new Error(`Unexpected fetch ${url}`);
};

const { executeCodeBatch } = await import("../src/controllers/execution.controller.js");
const run = (language, testcases, extra = {}) =>
  executeCodeBatch({ language, fullCode: "int main(){}", testcases, timeLimit: 1000, memoryLimit: 256, ...extra });

test.after(() => {
  globalThis.fetch = originalFetch;
});

test("C++ runs every testcase in ONE harness submission (wait=true), in order", async () => {
  requests = [];
  handler = ({ url, body }) => {
    assert.equal(url.pathname, "/submissions");
    assert.equal(url.searchParams.get("wait"), "true");
    const { inputs } = harnessInputs(body);
    return json({ token: "t1", status: { id: 3 }, stdout: b64(harnessReport(inputs.map((s) => ({ stdout: `${s}#\n` })))) });
  };
  const tcs = ["a", "b", "b", "c"].map((stdin) => ({ stdin })); // includes a duplicate
  const results = await run("cpp", tcs);
  assert.equal(requests.length, 1, "one compile, one sandbox");
  assert.deepEqual(results.map((r) => r.actual), ["a#", "b#", "b#", "c#"]);
  assert.ok(results.every((r) => r.status === "OK"));
});

test("C uses the harness too and prepends _GNU_SOURCE", async () => {
  requests = [];
  handler = ({ body }) => {
    const src = Buffer.from(body.source_code, "base64").toString();
    assert.ok(src.startsWith("#define _GNU_SOURCE 1\n"));
    return json({ token: "t", status: { id: 3 }, stdout: b64(harnessReport([{ stdout: "1\n" }])) });
  };
  const results = await run("c", [{ stdin: "x" }]);
  assert.equal(results[0].actual, "1");
});

test("empty testcase list makes no CodeBox request", async () => {
  requests = [];
  handler = () => { throw new Error("should not be called"); };
  assert.deepEqual(await run("cpp", []), []);
  assert.equal(requests.length, 0);
});

test("infrastructure failure on the harness falls back to the batch API", async () => {
  requests = [];
  handler = (entry) => {
    if (entry.url.pathname === "/submissions") return json({ error: "down" }, 503);
    return batchApiOk(entry);
  };
  const results = await run("cpp", [{ stdin: "1" }, { stdin: "2" }]);
  assert.deepEqual(results.map((r) => r.actual), ["1!", "2!"]);
  assert.deepEqual(requests.map((r) => r.url.pathname), ["/submissions", "/batches"]);
});

test("a harness compile failure is re-judged with the plain source, never reported as-is", async () => {
  requests = [];
  handler = (entry) => {
    if (entry.url.pathname === "/submissions") {
      return json({ token: "t", status: { id: 6 }, compile_output: b64("harness: error"), stdout: null });
    }
    if (entry.url.pathname === "/batches") {
      // Same shape CodeBox's executeBatch returns for a compile failure.
      return json({ batchId: "b", status: "compile_failed", compileError: "main.cpp:1: real error", message: "main.cpp:1: real error", results: [] });
    }
    throw new Error("unexpected");
  };
  const results = await run("cpp", [{ stdin: "1" }, { stdin: "2" }]);
  assert.equal(results[0].status, "Compilation Error");
  assert.match(results[0].errorText, /real error/, "the verdict comes from compiling the unmodified source");
});

test("a definitive TLE stops execution: later cases are Skipped and never re-run", async () => {
  requests = [];
  handler = ({ url, body }) => {
    assert.equal(url.pathname, "/submissions");
    const { inputs, flags } = harnessInputs(body);
    assert.equal(flags, 1, "stop-on-timeout flag sent to the harness");
    // Case 1 times out; the harness stops and never runs cases 2..4.
    const report = harnessReport([{ stdout: "ok\n" }, { exitCode: 137, signal: 9, cpuMs: 1001, wallMs: 2001 }], {
      stoppedOnTimeout: true,
      total: inputs.length,
    });
    return json({ token: "t", status: { id: 3 }, stdout: b64(report) });
  };
  const results = await run("cpp", [1, 2, 3, 4, 5].map((n) => ({ stdin: String(n) })), { stopOnTimeout: true });
  assert.equal(requests.length, 1, "no re-run of the unreported cases");
  assert.deepEqual(results.map((r) => r.status), ["OK", "Time Limit Exceeded", "Skipped", "Skipped", "Skipped"]);
});

test("without stopOnTimeout, unreported cases are re-run (budget exhaustion is not a verdict)", async () => {
  requests = [];
  handler = ({ body }) => {
    const { inputs } = harnessInputs(body);
    // Report only the first case of each submission (as if the budget ran out).
    const report = harnessReport([{ stdout: `${inputs[0]}\n` }], { total: inputs.length });
    return json({ token: "t", status: { id: 3 }, stdout: b64(report) });
  };
  const results = await run("cpp", [{ stdin: "a" }, { stdin: "b" }, { stdin: "c" }]);
  assert.deepEqual(results.map((r) => r.actual), ["a", "b", "c"]);
  assert.equal(requests.length, 3, "one round per unreported remainder");
});

test("the batch API path also stops starting chunks after a TLE", async () => {
  process.env.CODEBOX_MULTICASE_ENABLED = "false";
  try {
    requests = [];
    handler = ({ url, options, body }) => {
      assert.equal(url.pathname, "/batches");
      assert.equal(options.method, "POST");
      return json({
        batchId: "b",
        status: "completed",
        results: body.testcases.map((tc, index) => ({
          index, status: tc.stdin === "3" ? "time_limit_exceeded" : "completed", stdout: "x\n", stderr: "", exitCode: 0, timeMs: 5, memory: 1,
        })),
      });
    };
    // 45 cases -> 3 chunks of <= 20; the TLE is in chunk 0, so with two
    // workers at most chunk 1 may already be running and chunk 2 never starts.
    const tcs = Array.from({ length: 45 }, (_, i) => ({ stdin: String(i + 1) }));
    const results = await run("python", tcs, { stopOnTimeout: true });
    assert.ok(requests.length <= 2, `started ${requests.length} chunks`);
    assert.equal(results[2].status, "Time Limit Exceeded");
    assert.ok(results.slice(3).every((r) => r.status === "Skipped"));
  } finally {
    process.env.CODEBOX_MULTICASE_ENABLED = "true";
  }
});

test("Python never uses the harness", async () => {
  requests = [];
  handler = batchApiOk;
  const results = await run("python", [{ stdin: "7" }]);
  assert.equal(results[0].actual, "7!");
  assert.deepEqual(requests.map((r) => r.url.pathname), ["/batches"]);
});

test("harness results are deleted from CodeBox after they are read", () => {
  assert.ok(cleanupDeletes.length > 0, "at least one DELETE /submissions/:token was sent");
  assert.ok(cleanupDeletes.every((path) => path.startsWith("/submissions/")));
});
