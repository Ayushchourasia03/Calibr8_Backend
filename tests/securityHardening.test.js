// DB-free tests for the production-audit fixes (BACKEND_PRODUCTION_AUDIT.md).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { areOutputsEqual, normalizeOutput } from "../src/utils/outputComparator.js";
import { isHarnessSafeUserCode } from "../src/utils/multiCaseHarness.js";
import { clientIpKey } from "../src/utils/clientIp.js";
import { requireText, optionalText, requireEmail, queryString } from "../src/utils/validation.js";
import { acquireJudgeSlot, __resetJudgeAdmissionForTests } from "../src/utils/judgeAdmission.js";
import { analyzeComplexitySafe, closeComplexityPool } from "../src/services/complexityPool.js";
import { signSessionToken, verifyToken, assertSessionWithinMaxAge } from "../src/utils/jwt.js";
import { JWT_SECRET } from "../src/config/jwt.js";
import { getCodeboxUrl } from "../src/utils/codeboxClient.js";
import { buildFinalCode } from "../src/utils/codeBuilder.js";
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
    // Distinct users (round 2: each user also has a session cap).
    const release1 = await acquireJudgeSlot({ userId: "h3-a" });
    const second = acquireJudgeSlot({ userId: "h3-b" }); // queued
    await assert.rejects(acquireJudgeSlot({ userId: "h3-c" }), (err) => err.code === "JUDGE_BUSY");
    release1();
    const release2 = await second; // handed over
    release2();
    release2(); // idempotent
    const release3 = await acquireJudgeSlot({ userId: "h3-c" });
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

test("H2/M5: harness blocks includes outside allowlist, operator new, qualified libc hooks, and raw/trigraph tricks", () => {
  const bypasses = [
    '#include </etc/passwd>\nint f(){return 1;}',
    '#include "secret.h"\nint f(){return 1;}',
    'void* operator new(unsigned long n){return nullptr;}',
    'long read(int fd, void* b, unsigned long n) noexcept { return 0; }',
    'int c8p__leak = 1;',
    '??=define X 1',
    'R"delim( // )delim"\n__attribute__((constructor)) void evil(){}',
  ];
  for (const code of bypasses) {
    assert.equal(isHarnessSafeUserCode(code), false, code);
  }
  // Tokenizer desync: digit separators / trigraphs must not open a fake char
  // literal that hides the rest of the code from the checks.
  const desync = [
    "int a = 1'0; __attribute__((constructor)) void pwn(){} int b = 2'0;",
    "int a = 1'0; long read(int fd, void* b, unsigned long n) { return 0; } int b = 2'0;",
    "double d = .5'0; __attribute__((constructor)) void pwn(){} int e = 0x1'F;",
    "char c = '??''; __attribute__((constructor)) void pwn(){} char d = 'x';",
  ];
  for (const code of desync) {
    assert.equal(isHarnessSafeUserCode(code), false, code);
  }
  const allowed = [
    'const char* msg = "__attribute__((constructor)) int fork()";\nint solve(int n){ return n; }',
    '#include <vector>\n#include <algorithm>\nclass Solution { public: int solve(int x){ return x; } };',
    "const long long MOD = 1'000'000'007;\nint f(char c){ switch(c){ case'a': return 1; case ' ': return 2; } return (int)(MOD % 7); }",
  ];
  for (const code of allowed) {
    assert.equal(isHarnessSafeUserCode(code), true, code);
  }
});

test("M3: login failure throttle is scoped per (email, IP)", () => {
  const email = `scoped-${Date.now()}@example.test`;
  for (let i = 0; i < 10; i++) recordFailedLogin(email, "198.51.100.1");
  assert.throws(() => assertLoginAllowed(email, "198.51.100.1"), (err) => err.code === "ACCOUNT_LOGIN_LOCKED");
  assert.doesNotThrow(() => assertLoginAllowed(email, "198.51.100.2"));
  clearFailedLogins(email, "198.51.100.1");
  assert.doesNotThrow(() => assertLoginAllowed(email, "198.51.100.1"));
});

test("H4: getCodeboxUrl rejects remote HTTP in production even with CODEBOX_ALLOW_INSECURE_HTTP=true", () => {
  const prevEnv = process.env.NODE_ENV;
  const prevUrl = process.env.CODEBOX_URL;
  const prevTok = process.env.CODEBOX_TOKEN;
  const prevInsecure = process.env.CODEBOX_ALLOW_INSECURE_HTTP;
  try {
    process.env.NODE_ENV = "production";
    process.env.CODEBOX_TOKEN = "tok";
    process.env.CODEBOX_ALLOW_INSECURE_HTTP = "true";
    process.env.CODEBOX_URL = "http://codebox.internal:2358";
    assert.throws(() => getCodeboxUrl(true), (err) => err.code === "EXECUTION_UNAVAILABLE");
    process.env.CODEBOX_URL = "http://127.0.0.1:2358";
    assert.equal(getCodeboxUrl(true).hostname, "127.0.0.1");
    process.env.CODEBOX_URL = "https://codebox.example.com";
    assert.equal(getCodeboxUrl(true).protocol, "https:");
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
    if (prevUrl === undefined) delete process.env.CODEBOX_URL; else process.env.CODEBOX_URL = prevUrl;
    if (prevTok === undefined) delete process.env.CODEBOX_TOKEN; else process.env.CODEBOX_TOKEN = prevTok;
    if (prevInsecure === undefined) delete process.env.CODEBOX_ALLOW_INSECURE_HTTP; else process.env.CODEBOX_ALLOW_INSECURE_HTTP = prevInsecure;
  }
});

test("M1/M2: verifyToken requires calibr8 issuer & audience and uses random non-static secret", () => {
  assert.ok(JWT_SECRET.length >= 24);
  assert.equal(JWT_SECRET.includes("calibr8_dev"), false);
  const wrongAud = jwt.sign({ id: "user-1" }, JWT_SECRET, { algorithm: "HS256", issuer: "other", audience: "other" });
  assert.throws(() => verifyToken(wrongAud));
  const valid = signSessionToken({ id: "user-1", tokenVersion: 0 });
  const decoded = verifyToken(valid);
  assert.equal(decoded.iss, "calibr8");
  assert.equal(decoded.aud, "calibr8-api");
});

test("codeBuilder ignores comments for main() checks and scopes Python driver locals", () => {
  const problem = { slug: "two-sum", templates: {} };
  const pyCommented = "# Do not write main() here\nclass Solution:\n    def twoSum(self, nums, target):\n        return []";
  const builtPy = buildFinalCode(problem, pyCommented, "python");
  assert.ok(builtPy.includes("def _c8_run():"));
  const cppCommented = "// Do not write main() here\nclass Solution {\npublic:\n    int f() { return 1; }\n};";
  assert.ok(buildFinalCode(problem, cppCommented, "cpp").includes("class Solution"));
  assert.throws(
    () => buildFinalCode(problem, "int main() { return 0; }", "cpp"),
    (err) => err.code === "FUNCTION_ONLY_REQUIRED",
  );
  // A digit separator must not hide a later main() from the check.
  assert.throws(
    () => buildFinalCode(problem, "const int K = 1'000;\nint main() { return K; }", "cpp"),
    (err) => err.code === "FUNCTION_ONLY_REQUIRED",
  );
  // The JS driver IIFE must start with ';' so ASI cannot turn it into a call
  // on user code that ends without a semicolon.
  const builtJs = buildFinalCode(problem, "const solve = (a) => a\nmodule.exports = { solve }", "javascript");
  assert.match(builtJs, /\n;\(\(\) => \{/);
});
