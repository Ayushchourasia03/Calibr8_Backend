// DB-free tests for the production-audit fixes (BACKEND_PRODUCTION_AUDIT.md).
import "./helpers/noDatabase.js"; // must stay first
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { areOutputsEqual, normalizeOutput } from "../src/utils/outputComparator.js";
import { isHarnessSafeUserCode } from "../src/utils/multiCaseHarness.js";
import { clientIpKey } from "../src/utils/clientIp.js";
import { requireText, optionalText, requireEmail, queryString } from "../src/utils/validation.js";
import { acquireJudgeSlot, __resetJudgeAdmissionForTests } from "../src/utils/judgeAdmission.js";
import { analyzeComplexitySafe, closeComplexityPool } from "../src/services/complexityPool.js";
import { signSessionToken, verifyToken, assertSessionWithinMaxAge } from "../src/utils/jwt.js";
import { comparePassword, hashPassword, needsRehash } from "../src/utils/bcrypt.js";
import { assertLoginAllowed, recordFailedLogin, clearFailedLogins } from "../src/middlewares/rateLimit.middleware.js";
import { tierForRating } from "../src/utils/userHeaderStats.js";
import jwt from "jsonwebtoken";

after(() => closeComplexityPool());

test("M4: comparator keeps exact integer precision", () => {
  assert.equal(areOutputsEqual("9007199254740993", "9007199254740992"), false);
  assert.equal(areOutputsEqual("[9007199254740993]", "[9007199254740992]"), false);
  assert.equal(areOutputsEqual("1 9007199254740993", "1 9007199254740992"), false);
  assert.equal(areOutputsEqual("9007199254740993", "9007199254740993"), true);
  assert.equal(areOutputsEqual("-9223372036854775808", "-9223372036854775808"), true);
});

test("M4: comparator no longer treats yes/no as booleans", () => {
  assert.equal(areOutputsEqual("yes", "true"), false);
  assert.equal(areOutputsEqual("no", "false"), false);
  assert.equal(areOutputsEqual("True", "true"), true); // Python bool printing
  assert.equal(areOutputsEqual("YES", "yes"), false); // plain strings stay case-sensitive
});

test("M4: comparator keeps the format bridges the drivers rely on", () => {
  assert.ok(areOutputsEqual("0", "[0]"));
  assert.ok(areOutputsEqual("[42]", "42"));
  assert.ok(areOutputsEqual("7 0 8\n", "[7, 0, 8]"));
  assert.ok(areOutputsEqual("7, 0, 8", "7 0 8"));
  assert.ok(areOutputsEqual("0.1 0.2", "0.10 0.20"));
  assert.ok(areOutputsEqual("  hello   world \n", "hello world"));
  assert.equal(areOutputsEqual("[[1,2],[3]]", "[[1],[2,3]]"), false);
  assert.equal(areOutputsEqual("1 2 3", "1 2 4"), false);
  assert.equal(normalizeOutput("  "), "");
});

test("M5: harness is skipped for code that could run in the harness parent", () => {
  const BS = String.fromCharCode(92);
  const unsafe = [
    "__attribute__((constructor(101))) static void x(){}",
    "[[gnu::constructor(101)]] void x(){}",
    "[[using gnu: constructor]] void x(){}",
    "struct A{A(){}}; A a __attribute__((init_priority(101)));",
    'extern "C" int fork(void){return 0;}',
    "long write(int fd, const void* b, unsigned long n){return n;}",
    'asm(".section .init_array");',
    "#define int long long\nint f(){return 1;}",
    "%:define X 1",
    "#" + BS + "\ndefine X 1",
    "_Pragma(\"GCC visibility push(default)\")",
    "int c8__harness;",
  ];
  for (const code of unsafe) assert.equal(isHarnessSafeUserCode(code), false, code);

  const safe = [
    "class Solution { public: vector<int> twoSum(vector<int>& a, int t){ return {}; } };",
    "#include <bits/stdc++.h>\n#pragma GCC optimize(\"O3\")\nint solve(int n){ return n; }",
    "int readInput(){ return 0; } // constructor in a comment is fine",
  ];
  for (const code of safe) assert.equal(isHarnessSafeUserCode(code), true, code);
});

test("M3: IPv6 clients share one bucket per /64, IPv4-mapped is IPv4", () => {
  assert.equal(clientIpKey({ ip: "2001:db8:1:2:aaaa::1" }), clientIpKey({ ip: "2001:db8:1:2:ffff:1:2:3" }));
  assert.notEqual(clientIpKey({ ip: "2001:db8:1:2::1" }), clientIpKey({ ip: "2001:db8:1:3::1" }));
  assert.equal(clientIpKey({ ip: "::ffff:203.0.113.7" }), "203.0.113.7");
  assert.equal(clientIpKey({ ip: "203.0.113.7" }), "203.0.113.7");
});

test("M3: per-account login lockout after repeated failures", () => {
  const email = `lock-${Date.now()}@example.test`;
  for (let i = 0; i < 10; i++) recordFailedLogin(email);
  assert.throws(() => assertLoginAllowed(email), (err) => err.code === "ACCOUNT_LOGIN_LOCKED");
  clearFailedLogins(email);
  assert.doesNotThrow(() => assertLoginAllowed(email));
});

test("M8: text fields are type-checked, cleaned and length-limited", () => {
  assert.equal(requireText("  Ada\u0000 Lovelace ", "name"), "Ada Lovelace");
  assert.throws(() => requireText("x".repeat(61), "name"), (err) => err.status === 400);
  assert.throws(() => requireText(42, "name"), (err) => err.status === 400);
  assert.throws(() => optionalText("y".repeat(121), "college"), (err) => err.status === 400);
  assert.equal(optionalText(undefined, "college"), undefined);
  assert.equal(optionalText(null, "college"), "");
  assert.equal(requireEmail(" A@B.co "), "a@b.co");
  assert.throws(() => requireEmail({ $ne: "" }), (err) => err.status === 400);
  assert.equal(queryString(["a", "b"]), "a");
  assert.equal(queryString({ nested: 1 }), undefined);
});

test("H3: judge admission caps concurrency and rejects when the queue is full", async () => {
  process.env.JUDGE_MAX_CONCURRENT = "1";
  process.env.JUDGE_MAX_QUEUE = "1";
  process.env.JUDGE_QUEUE_TIMEOUT_MS = "1000";
  __resetJudgeAdmissionForTests();
  try {
    const release1 = await acquireJudgeSlot();
    const second = acquireJudgeSlot(); // queued
    await assert.rejects(acquireJudgeSlot(), (err) => err.code === "JUDGE_BUSY");
    release1();
    const release2 = await second; // handed over
    release2();
    release2(); // idempotent
    const release3 = await acquireJudgeSlot();
    release3();
  } finally {
    delete process.env.JUDGE_MAX_CONCURRENT;
    delete process.env.JUDGE_MAX_QUEUE;
    delete process.env.JUDGE_QUEUE_TIMEOUT_MS;
    __resetJudgeAdmissionForTests();
  }
});

test("H1: adversarial analyzer input times out in a worker without blocking the event loop", async () => {
  const code = "[".repeat(64 * 1024); // ~6 s of synchronous analysis on the old path
  let ticks = 0;
  let maxGap = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, 20);
  const started = Date.now();
  const result = await analyzeComplexitySafe({ code, language: "javascript" }, { timeoutMs: 500 });
  clearInterval(timer);
  assert.equal(result.status, "unknown");
  assert.match(result.limitations.join(" "), /exceeded/);
  assert.ok(Date.now() - started < 3000, "returns promptly after the timeout");
  assert.ok(ticks > 5, "event loop kept running");
  assert.ok(maxGap < 400, `event loop gap ${maxGap} ms`);

  // The pool recovers and analyzes normal code afterwards.
  const ok = await analyzeComplexitySafe({
    code: "def f(n):\n    for i in range(n):\n        pass\n",
    language: "python",
  });
  assert.equal(ok.status, "completed");
  assert.equal((await analyzeComplexitySafe({ code: "x".repeat(70 * 1024), language: "cpp" })).status, "unknown");
});

test("M1/I1: session tokens carry tv/auth_time, no email, HS256 only", () => {
  const token = signSessionToken({ id: "user-1", tokenVersion: 3 });
  const decoded = verifyToken(token);
  assert.equal(decoded.id, "user-1");
  assert.equal(decoded.tv, 3);
  assert.ok(decoded.auth_time > 0);
  assert.ok(decoded.jti);
  assert.equal(decoded.email, undefined);

  // Carried-over auth_time beyond the max session age is rejected.
  const old = { auth_time: Math.floor(Date.now() / 1000) - 31 * 86400 };
  assert.throws(() => assertSessionWithinMaxAge(old), (err) => err.code === "SESSION_EXPIRED");
  assert.doesNotThrow(() => assertSessionWithinMaxAge({ auth_time: Math.floor(Date.now() / 1000) }));

  // A token signed with another algorithm is refused.
  const forged = jwt.sign({ id: "user-1" }, "calibr8_dev_jwt_secret_token_key_safe_fallback_string_32_chars", { algorithm: "HS512" });
  assert.throws(() => verifyToken(forged));
});

test("I2/L1: bcrypt cost 12, rehash detection, missing hash compares false", async () => {
  const hash = await hashPassword("CorrectHorse9");
  assert.equal(needsRehash(hash), false);
  assert.equal(needsRehash("$2a$10$abcdefghijklmnopqrstuuJ3m0H1nF0VY1bqk3xYB2c5mO0Cq9Qba"), true);
  assert.equal(await comparePassword("CorrectHorse9", hash), true);
  assert.equal(await comparePassword("CorrectHorse9", undefined), false);
  assert.equal(await comparePassword({}, hash), false);
});

test("M6: tier is derived from rating", () => {
  assert.equal(tierForRating(700), "Pulse I");
  assert.equal(tierForRating(800), "Pulse II");
  assert.equal(tierForRating(1600), "Eclipse II");
});
