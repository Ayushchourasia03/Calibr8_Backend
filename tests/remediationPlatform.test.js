// Regression tests for SECURITY_AUDIT.md SA-H3, SA-M1, SA-M2, SA-M3, SA-L2,
// SA-L3, SA-L5, SA-L6, SA-L9. No database writes, no CodeBox, GitHub mocked.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

// Pool limits for the overflow test must be in place before first use.
process.env.PASSWORD_HASH_WORKERS = "1";
process.env.PASSWORD_HASH_MAX_QUEUE = "1";
process.env.OAUTH_CALLBACK_RATE_LIMIT_MAX = "3";
process.env.GITHUB_CLIENT_ID = "test-client";
process.env.GITHUB_CLIENT_SECRET = "test-secret";
process.env.FRONTEND_URL = "http://localhost:5173";
process.env.JWT_SECRET = process.env.JWT_SECRET || "remediation-test-jwt-secret-0123456789";
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || "remediation-test-oauth-secret-0123456789";

const { validateEnvironment, enforceEnvironment } = await import("../src/config/validateEnv.js");
const { getCodeboxUrl, fetchCodeboxJson } = await import("../src/utils/codeboxClient.js");
const { hashPassword, comparePassword } = await import("../src/utils/bcrypt.js");
const { closePasswordPool } = await import("../src/services/passwordPool.js");
const { recordFailedLogin } = await import("../src/middlewares/rateLimit.middleware.js");
const { securityEvent, __captureSecurityLog } = await import("../src/utils/securityLog.js");
const { OAUTH_STATE_SECRET } = await import("../src/config/jwt.js");
const bcrypt = (await import("bcryptjs")).default;

after(() => closePasswordPool());

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// SA-M2: password hashing off the event loop
// ---------------------------------------------------------------------------

test("SA-M2: a full password queue fails fast with 503 AUTH_BUSY", async () => {
  const hash = bcrypt.hashSync("correct horse", 4);
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => comparePassword("x", hash)));
  const busy = attempts.filter((a) => a.status === "rejected" && a.reason?.code === "AUTH_BUSY");
  assert.ok(busy.length >= 1, "1 worker + 1 queued place: at least one of 4 concurrent attempts is refused");
  assert.ok(attempts.some((a) => a.status === "fulfilled"));
  process.env.PASSWORD_HASH_WORKERS = "2";
  process.env.PASSWORD_HASH_MAX_QUEUE = "64";
});

test("SA-M2: existing bcryptjs hashes still verify; new hashes are cost 12", async () => {
  const legacy = bcrypt.hashSync("Sup3r-secret!", 12); // as stored by the previous in-thread code
  assert.equal(await comparePassword("Sup3r-secret!", legacy), true);
  assert.equal(await comparePassword("wrong", legacy), false);
  const fresh = await hashPassword("An0ther-secret!");
  assert.equal(bcrypt.getRounds(fresh), 12);
  assert.equal(bcrypt.compareSync("An0ther-secret!", fresh), true);
  assert.equal(await comparePassword("x", null), false, "unknown account: dummy compare, false");
  assert.equal(await comparePassword("a".repeat(5000), legacy), false, "oversized input is refused before bcrypt");
});

test("SA-M2: concurrent logins do not block the event loop", async () => {
  const hash = bcrypt.hashSync("pw", 12);
  let maxGap = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 10);
  await Promise.all(Array.from({ length: 6 }, () => comparePassword("pw", hash)));
  clearInterval(timer);
  // The previous in-thread bcryptjs showed ~800 ms gaps with 8 concurrent compares.
  assert.ok(maxGap < 150, `max event-loop gap ${maxGap} ms`);
});

// ---------------------------------------------------------------------------
// SA-M1: oversized login input
// ---------------------------------------------------------------------------

test("SA-M1: failed logins with huge emails do not retain memory", () => {
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 100; i++) recordFailedLogin(`${"a".repeat(1024 * 1024)}${i}@x.io`, `203.0.113.${i}`);
  global.gc?.();
  const grown = (process.memoryUsage().heapUsed - before) / 1048576;
  // The previous key kept the whole email: ~100 MB here.
  assert.ok(grown < 30, `heap grew ${grown.toFixed(1)} MB`);
});

const { default: app } = await import("../src/app.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test("SA-M1: login rejects oversized email/password before any database work", async () => {
  for (const body of [
    { email: `${"a".repeat(300)}@example.com`, password: "whatever123" },
    { email: "user@example.com", password: "p".repeat(2000) },
  ]) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "INVALID_CREDENTIALS_FORMAT");
  }
});

// ---------------------------------------------------------------------------
// SA-L2: requests without a JSON body
// ---------------------------------------------------------------------------

test("SA-L2: handlers that read req.body answer 4xx, never 500, without a body", async () => {
  const { updateLanguage } = await import("../src/controllers/user.controller.js");
  const { applyTheme } = await import("../src/controllers/theme.controller.js");
  const { runCode, submitSolution, getComplexityAnalysis } = await import("../src/controllers/execution.controller.js");
  const { updateLanguage: onboardingLanguage, onboard } = await import("../src/controllers/onboarding.controller.js");
  const call = async (handler) => {
    let error = null;
    await handler({ user: { id: "u1" }, params: {}, query: {}, body: undefined, path: "/x" }, {}, (err) => {
      error = err;
    });
    return error;
  };
  for (const handler of [updateLanguage, applyTheme, runCode, submitSolution, getComplexityAnalysis, onboardingLanguage]) {
    const err = await call(handler);
    assert.ok(err, `${handler.name} reports an error`);
    assert.ok(err.status >= 400 && err.status < 500, `${handler.name}: ${err.status} ${err.name}`);
  }
  // SA-L5: oversized topic lists are refused before any query.
  let error = null;
  await onboard({ user: { id: "u1" }, body: { topicIds: Array.from({ length: 101 }, (_, i) => `t${i}`) } }, {}, (err) => {
    error = err;
  });
  assert.equal(error?.code, "TOO_MANY_TOPICS");
});

// ---------------------------------------------------------------------------
// SA-L6: OAuth callback state is single-use and the callback is rate limited
// ---------------------------------------------------------------------------

test("SA-L6: an OAuth state starts one GitHub exchange; replays and floods are refused", async () => {
  const realFetch = globalThis.fetch;
  let githubCalls = 0;
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    if (url.startsWith("https://github.com/") || url.startsWith("https://api.github.com/")) {
      githubCalls++;
      return new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 200 });
    }
    return realFetch(input, options);
  };
  try {
    const state = jwt.sign({ userId: "u1", provider: "github", nonce: "n-123" }, OAUTH_STATE_SECRET, { expiresIn: "10m", algorithm: "HS256" });
    const callback = () => realFetch(`${base}/api/social/github/callback?code=c&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    const first = await callback();
    const replay = await callback();
    assert.match(first.headers.get("location"), /link_error=AUTH_FAILED/, "first use reaches GitHub");
    assert.match(replay.headers.get("location"), /link_error=EXPIRED/, "the replay is refused");
    assert.equal(githubCalls, 1, "only one outbound exchange");
    const third = await callback();
    const flooded = await callback();
    assert.ok([third.status, flooded.status].includes(429), "callback limiter (OAUTH_CALLBACK_RATE_LIMIT_MAX=3)");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// SA-H3: CodeBox transport policy
// ---------------------------------------------------------------------------

test("SA-H3: plain HTTP to CodeBox only on loopback/private networks, never to public hosts", () => {
  const url = (value, extra = {}) =>
    withEnv({ CODEBOX_URL: value, CODEBOX_TOKEN: "t", CODEBOX_ALLOW_INSECURE_HTTP: "true", NODE_ENV: "development", ...extra }, () =>
      getCodeboxUrl(false),
    );
  assert.equal(url("http://203.0.113.10"), null, "public IP over HTTP is refused, even in development");
  assert.equal(url("http://codebox.example.com"), null, "public name over HTTP is refused");
  assert.ok(url("http://127.0.0.1:2358"), "loopback");
  assert.ok(url("http://10.0.0.5:3000"), "private network (development)");
  assert.ok(url("http://codebox:3000"), "Docker service name (development)");
  assert.ok(url("http://[fd00::5]:3000"), "IPv6 ULA (development)");
  assert.equal(url("http://10.0.0.5:3000", { NODE_ENV: "production" }), null, "production: loopback only");
  assert.ok(url("http://127.0.0.1:2358", { NODE_ENV: "production" }));
  assert.equal(url("http://127.0.0.1:2358", { CODEBOX_ALLOW_INSECURE_HTTP: "false" }), null, "the flag is still required");
  assert.ok(url("https://codebox.example.com"));
  assert.equal(url("https://user:pass@codebox.example.com"), null, "no credentials in the URL");
});

test("SA-H3: oversized CodeBox responses are refused", async () => {
  const realFetch = globalThis.fetch;
  process.env.CODEBOX_TOKEN = "t";
  process.env.CODEBOX_MAX_RESPONSE_BYTES = String(64 * 1024);
  globalThis.fetch = async () => new Response(JSON.stringify({ x: "y".repeat(200 * 1024) }), { status: 200 });
  try {
    await assert.rejects(fetchCodeboxJson(new URL("https://codebox.test/x")), (err) => err.code === "EXECUTION_UNAVAILABLE");
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    assert.deepEqual(await fetchCodeboxJson(new URL("https://codebox.test/x")), { ok: true });
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.CODEBOX_MAX_RESPONSE_BYTES;
  }
});

// ---------------------------------------------------------------------------
// SA-M3 / SA-L3: startup validation
// ---------------------------------------------------------------------------

test("SA-M3/SA-L3: unsafe production settings are fatal; secrets are never printed", () => {
  const secret = "S3CRET-VALUE-THAT-MUST-NOT-BE-PRINTED-0123456789";
  const prod = { NODE_ENV: "production", TRUST_PROXY: "1", JWT_SECRET: secret, CODEBOX_TOKEN: secret, CODEBOX_URL: "https://codebox.example.com" };
  assert.deepEqual(validateEnvironment(prod).fatal, []);
  assert.equal(validateEnvironment({ ...prod, NODE_TLS_REJECT_UNAUTHORIZED: "0" }).fatal.length, 1);
  assert.equal(validateEnvironment({ ...prod, TRUST_PROXY: "true" }).fatal.length, 1);
  assert.equal(validateEnvironment({ ...prod, JWT_EXPIRES_IN: "banana" }).fatal.length, 1);
  assert.equal(validateEnvironment({ ...prod, JWT_EXPIRES_IN: "30d" }).fatal.length, 1);
  assert.equal(validateEnvironment({ ...prod, JWT_EXPIRES_IN: "1d" }).fatal.length, 0);
  assert.equal(validateEnvironment({ ...prod, JUDGE_MAX_CONCURRENT: "-5" }).fatal.length, 1);
  assert.ok(validateEnvironment({ ...prod, TRUST_PROXY: undefined }).warnings.some((w) => w.includes("TRUST_PROXY")));
  assert.ok(validateEnvironment({ ...prod, CODEBOX_URL: "http://203.0.113.10" }).errors.length >= 1, "plain HTTP CodeBox is reported");

  const output = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args) => output.push(args.join(" "));
  console.warn = (...args) => output.push(args.join(" "));
  try {
    assert.throws(() => enforceEnvironment({ ...prod, NODE_TLS_REJECT_UNAUTHORIZED: "0" }), (err) => !err.message.includes(secret));
    enforceEnvironment({ ...prod, NODE_ENV: "development", TRUST_PROXY: "true", NODE_TLS_REJECT_UNAUTHORIZED: "0" }); // never throws outside production
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.ok(output.every((line) => !line.includes(secret)), "no secret value in any log line");
});

// ---------------------------------------------------------------------------
// SA-L9: security event log
// ---------------------------------------------------------------------------

test("SA-L9: security events carry no credentials and cannot flood the log", () => {
  const lines = [];
  const restore = __captureSecurityLog((line) => lines.push(line));
  process.env.SECURITY_LOG_MAX_PER_MINUTE = "5";
  try {
    for (let i = 0; i < 20; i++) {
      securityEvent("login_failed", { account: "hash123", password: "hunter2-ignored", extra: { nested: true } });
    }
  } finally {
    delete process.env.SECURITY_LOG_MAX_PER_MINUTE;
    restore();
  }
  assert.equal(lines.length, 5, "only 5 lines per type per minute");
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.security, "login_failed");
  assert.equal(entry.account, "hash123");
  assert.equal(entry.extra, undefined, "non-primitive fields are dropped");
  assert.equal(entry.password, undefined, "credential-like fields are dropped even when a caller passes them");
  assert.ok(lines.every((line) => !line.includes("hunter2")));
});
