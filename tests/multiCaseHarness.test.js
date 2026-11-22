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
  const payload = "3\n1 2" + "7\nhéllo\n";
  const bytes = Buffer.byteLength(payload);
  const buf = buildHarnessStdin(["1 2", "héllo\n"], 1000, 13500);
  assert.equal(buf.toString(), `C8MC2 1000 2 13500 0 ${bytes}\n` + payload);
  const stop = buildHarnessStdin(["1 2", "héllo\n"], 1000, 13500, { stopOnTimeout: true });
  assert.equal(stop.toString(), `C8MC2 1000 2 13500 1 ${bytes}\n` + payload);
});

test("multi-case harness: early stop after a definitive TLE is reported", () => {
  const report = Buffer.concat([
    Buffer.from("C8MC1 3\n"),
    Buffer.from("#C8 0 0 0 4 5 3200 2 0\n"), Buffer.from("1\n"),
    Buffer.from("#C8 1 137 9 1003 2010 2800 0 0\n"),
    Buffer.from("#C8END TLE\n"),
  ]);
  const parsed = parseHarnessOutput(report, 3);
  assert.equal(parsed.stoppedOnTimeout, true);
  assert.equal(parsed[1].signal, 9);
  assert.equal(parsed[2], undefined, "cases after the TLE were never run");
  const full = parseHarnessOutput(Buffer.from("C8MC1 1\n#C8 0 0 0 1 1 100 0 0\n#C8END\n"), 1);
  assert.equal(full.stoppedOnTimeout, false);
});

test("multi-case harness: watchdog kill after the wall limit is a TLE, an instant kill is not", () => {
  const opts = { timeLimitMs: 1000, memoryLimitMb: 256, inputBytes: 0 };
  const sleeper = { exitCode: 137, signal: 9, cpuMs: 0, wallMs: 2005, memKb: 1000, stdout: "", stderr: "" };
  assert.equal(normalizeHarnessCase(sleeper, opts).status, "Time Limit Exceeded");
  assert.equal(normalizeHarnessCase({ ...sleeper, wallMs: 40 }, opts).status, "Runtime Error");
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
  assert.ok(wrapWithHarness("int main(){}", "cpp").startsWith("int main(){}"), "C++ keeps the PCH-compatible first line");
  assert.ok(wrapWithHarness("int main(){}", "c").startsWith("#define _GNU_SOURCE 1\n"), "strict C needs POSIX declarations");
  const src = wrapWithHarness("x", "cpp");
  assert.ok(src.includes("c8__close_from(3); /* incl. the memfd holding every testcase input */"), "children close the input memfd");
  assert.ok(src.includes("memset(buf, 0, sizeof buf); /* no input bytes left in memory the child inherits */"), "copy buffer zeroed before fork");
  assert.ok(src.includes("prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);"), "parent /proc entries not readable by children");
  assert.ok(src.includes("c8__cleanup_fs();"), "files created by a case are removed after it");
});
