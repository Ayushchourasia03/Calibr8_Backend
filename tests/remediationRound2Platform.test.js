// Round 2: identity-aware API limits (FV-5), polling budget, readiness probe
// (SA-M6 / FV-3), bounded request logging (SA-L9 / FV-4), FV-7, FV-9 and the
// leaderboard switch (SA-L10). In-process app on a loopback port; no
// database writes (DATABASE_URL may be unreachable).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.JWT_SECRET ||= crypto.randomBytes(32).toString("hex");
process.env.OAUTH_STATE_SECRET ||= crypto.randomBytes(32).toString("hex");
process.env.API_RATE_LIMIT_MAX = "1200";
process.env.API_USER_RATE_LIMIT_MAX = "900";
process.env.LOG_HTTP_4XX_MAX_PER_MINUTE = "50";

const { default: app } = await import("../src/app.js");
const { signSessionToken, verifyToken } = await import("../src/utils/jwt.js");
const { pollLimiter } = await import("../src/middlewares/rateLimit.middleware.js");
const { createReadinessProbe } = await import("../src/utils/readiness.js");
const { __resetLogLimiterForTests, __flushLogLimiterForTests, __setLogSinkForTests, __setHttpLogSinkForTests } = await import("../src/utils/logLimiter.js");
const { visibleRegionalFields } = await import("../src/controllers/ranking.controller.js");
const { JWT_SECRET } = await import("../src/config/jwt.js");
const { createRequire } = await import("node:module");
const jwt = createRequire(import.meta.url)("jsonwebtoken");

const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

async function statuses(requests, concurrency = 100) {
  const out = [];
  for (let i = 0; i < requests.length; i += concurrency) {
    out.push(...(await Promise.all(requests.slice(i, i + concurrency).map((fn) => fn()))));
  }
  return out;
}
const count = (list, status) => list.filter((s) => s === status).length;

test("FV-5 campus NAT: 300 signed-in users behind one IP are not throttled by each other", async () => {
  const tokens = Array.from({ length: 300 }, (_, i) => signSessionToken({ id: `campus-user-${i}`, tokenVersion: 0 }));
  // 300 users x 6 requests = 1,800 from one IP; round 1 answered 429 after 1,200.
  const reqs = tokens.flatMap((token) => Array.from({ length: 6 }, () => () =>
    fetch(`${base}/api/execution/languages`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status)));
  const result = await statuses(reqs);
  assert.equal(count(result, 429), 0, `429s: ${count(result, 429)}`);
});

test("FV-5: one signed-in user is still limited per user; unauthenticated and forged-token traffic per IP", async () => {
  const token = signSessionToken({ id: "greedy-user", tokenVersion: 0 });
  const own = await statuses(Array.from({ length: 950 }, () => () =>
    fetch(`${base}/api/execution/languages`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status)));
  assert.equal(count(own, 429), 50, "per-user budget (900) applies");

  const anonymous = await statuses(Array.from({ length: 1300 }, () => () => fetch(`${base}/api/execution/languages`).then((r) => r.status)));
  assert.equal(count(anonymous, 429), 100, "unauthenticated budget per IP (1200) applies");
  const forged = jwt.sign({ id: "someone-else", tv: 0, iss: "calibr8", aud: "calibr8-api" }, "not-the-secret", { expiresIn: "1h" });
  const withForged = await fetch(`${base}/api/execution/languages`, { headers: { authorization: `Bearer ${forged}` } });
  assert.equal(withForged.status, 429, "a forged token does not escape the per-IP budget");
});

test("polling has its own per-user budget", async () => {
  const run = (userId) => new Promise((resolve) => {
    const res = { setHeader() {} };
    pollLimiter({ user: { id: userId }, headers: {}, ip: "127.0.0.1", socket: {} }, res, (err) => resolve(err?.status || 200));
  });
  const results = [];
  for (let i = 0; i < 245; i++) results.push(await run("poller"));
  assert.equal(count(results, 429), 5, "240 polls per minute per user");
  assert.equal(await run("other-poller"), 200, "other users are not affected");
});

test("SA-M6: a readiness flood makes at most one database check per interval (single flight)", async () => {
  let dbChecks = 0;
  let t = 0;
  const probe = createReadinessProbe({
    checkDatabase: async () => { dbChecks++; await new Promise((r) => setTimeout(r, 20)); },
    checkCodebox: async () => true,
    now: () => t,
  });
  const results = await Promise.all(Array.from({ length: 2000 }, () => probe()));
  assert.equal(dbChecks, 1, "2,000 concurrent probes, one query");
  assert.ok(results.every((r) => r.ready));
  t += 1000;
  await Promise.all(Array.from({ length: 500 }, () => probe()));
  assert.equal(dbChecks, 1, "cached within READINESS_CACHE_MS (5 s)");
  t += 5000;
  await probe();
  assert.equal(dbChecks, 2, "refreshed after the interval");
});

test("SA-M6: a database outage is reported within the cache interval plus the timeout, never hidden", async () => {
  let up = true;
  let t = 0;
  const probe = createReadinessProbe({
    checkDatabase: async () => { if (!up) throw new Error("down"); },
    checkCodebox: async () => true,
    timeoutMs: 100,
    now: () => t,
  });
  assert.equal((await probe()).ready, true);
  up = false;
  t += 5000;
  const down = await probe();
  assert.equal(down.ready, false);
  assert.equal(down.checks.database, false);
  // A hanging database counts as down after the timeout.
  const hanging = createReadinessProbe({ checkDatabase: () => new Promise(() => {}), checkCodebox: async () => null, timeoutMs: 100 });
  const started = Date.now();
  assert.equal((await hanging()).ready, false);
  assert.ok(Date.now() - started < 1000);
});

test("SA-M6: /health/ready is rate-limited per IP; /health (liveness) is not", async () => {
  const ready = await statuses(Array.from({ length: 150 }, () => () => fetch(`${base}/health/ready`).then((r) => r.status)));
  assert.ok(count(ready, 429) >= 30, `429s: ${count(ready, 429)}`);
  const live = await statuses(Array.from({ length: 150 }, () => () => fetch(`${base}/health`).then((r) => r.status)));
  assert.equal(count(live, 200), 150);
});

test("SA-L9: thousands of rejected requests produce a bounded number of log lines", async () => {
  __resetLogLimiterForTests();
  const lines = [];
  const capture = (...args) => lines.push(args.join(" "));
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = capture;
  __setHttpLogSinkForTests(capture); // the request log stream (morgan)
  __setLogSinkForTests(capture);
  try {
    const bad = await statuses(Array.from({ length: 3000 }, (_, i) => () =>
      fetch(`${base}/api/no-such-route-${i}`, { headers: { authorization: "Bearer forged.token.value" } }).then((r) => r.status)));
    assert.ok(bad.every((s) => s === 404 || s === 429));
    __flushLogLimiterForTests();
  } finally {
    Object.assign(console, { log: original.log, warn: original.warn, error: original.error });
    __setHttpLogSinkForTests(null);
    __setLogSinkForTests(null);
  }
  const requestLines = lines.filter((l) => /\/api\/no-such-route/.test(l));
  const summaries = lines.filter((l) => l.startsWith("[log] suppressed"));
  // Round 1: one or two lines per request (about 3,000-6,000 here).
  assert.ok(requestLines.length <= 50, `request lines: ${requestLines.length}`);
  assert.ok(summaries.length >= 1 && summaries.length <= 2, `summaries: ${summaries.length}`);
  assert.ok(lines.length <= 50 + 2 + 70, `total lines: ${lines.length}`); // + rate_limited security events (own budget)
  assert.equal(lines.filter((l) => l.startsWith("[API 4")).length, 0, "a rejected request is logged once, not twice");
});

test("FV-7: a correctly signed token without exp is rejected", () => {
  const noExp = jwt.sign({ id: "u", tv: 0, iss: "calibr8", aud: "calibr8-api" }, JWT_SECRET, { algorithm: "HS256" });
  assert.throws(() => verifyToken(noExp), /exp claim required/);
  assert.equal(verifyToken(signSessionToken({ id: "u", tokenVersion: 0 })).id, "u");
});

test("FV-9: too many urlencoded parameters answer TOO_MANY_PARAMETERS, not CODE_TOO_LARGE", async () => {
  const body = Array.from({ length: 5000 }, (_, i) => `k${i}=v`).join("&");
  const token = signSessionToken({ id: "params-user", tokenVersion: 0 });
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${token}` }, body,
  });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, "TOO_MANY_PARAMETERS");
});

test("SA-L10: leaderboard regional fields are configurable (default unchanged)", () => {
  assert.deepEqual(visibleRegionalFields(undefined), ["college", "branch", "batch", "state", "country"]);
  assert.deepEqual(visibleRegionalFields("none"), []);
  assert.deepEqual(visibleRegionalFields("state, country, password"), ["state", "country"]);
});
