import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHarnessStdin,
  parseHarnessOutput,
  normalizeHarnessCase,
  supportsMultiCase,
  wrapWithHarness,
} from "../src/utils/multiCaseHarness.js";

test("multi-case harness: stdin framing", () => {
  const buf = buildHarnessStdin(["1 2", "héllo\n"], 1000, 13500);
  assert.equal(buf.toString(), "C8MC1 1000 2 13500\n3\n1 2" + "7\nhéllo\n");
});

test("multi-case harness: parses framed report incl. partial runs", () => {
  const report = Buffer.concat([
    Buffer.from("C8MC1 3\n"),
    Buffer.from("#C8 0 0 0 4 5 3200 4 0\n"), Buffer.from("100\n"),
    Buffer.from("#C8 1 139 11 1 1 2800 0 3\n"), Buffer.from("err"),
  ]);
  const parsed = parseHarnessOutput(report, 3);
  assert.equal(parsed[0].stdout, "100\n");
  assert.equal(parsed[1].signal, 11);
  assert.equal(parsed[1].stderr, "err");
  assert.equal(parsed[2], undefined, "unreported case stays undefined for re-run");
  assert.equal(parseHarnessOutput(Buffer.from("garbage"), 1), null);
});

test("multi-case harness: verdict normalization", () => {
  const base = { exitCode: 0, signal: 0, cpuMs: 3, wallMs: 4, memKb: 3000, stdout: "42\n", stderr: "" };
  const opts = { timeLimitMs: 1000, memoryLimitMb: 256, inputBytes: 2 };
  assert.equal(normalizeHarnessCase(base, opts).status, "OK");
  assert.equal(normalizeHarnessCase(base, opts).actual, "42");
  assert.equal(normalizeHarnessCase({ ...base, signal: 14, exitCode: 142 }, opts).status, "Time Limit Exceeded");
  assert.equal(normalizeHarnessCase({ ...base, cpuMs: 1200 }, opts).status, "Time Limit Exceeded");
  assert.equal(normalizeHarnessCase({ ...base, memKb: 300 * 1024 }, opts).status, "Memory Limit Exceeded");
  const seg = normalizeHarnessCase({ ...base, signal: 11, exitCode: 139 }, opts);
  assert.equal(seg.status, "Runtime Error");
  assert.equal(seg.errorText, "Segmentation fault");
  assert.equal(normalizeHarnessCase({ ...base, exitCode: 1 }, opts).status, "Runtime Error");
});

test("multi-case harness: only compiled languages, source appended", () => {
  assert.equal(supportsMultiCase("cpp"), true);
  assert.equal(supportsMultiCase("c"), true);
  assert.equal(supportsMultiCase("python"), false);
  assert.ok(wrapWithHarness("int main(){}").startsWith("int main(){}"));
});
