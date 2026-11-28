// SA-M6 regression test: every /api request counts against a per-IP ceiling
// (API_RATE_LIMIT_MAX), including public endpoints that have no limiter of
// their own; oversized identifiers never reach the database. No writes.
import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.API_RATE_LIMIT_MAX = "15"; // read when the limiter is created (app import)
process.env.JWT_SECRET = process.env.JWT_SECRET || "remediation-test-jwt-secret-0123456789";
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || "remediation-test-oauth-secret-0123456789";

const { default: app } = await import("../src/app.js");
const { resolveProblem } = await import("../src/utils/problemResolver.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test("SA-M6: a single client is throttled on public endpoints; health checks are not", async () => {
  const statuses = [];
  for (let i = 0; i < 20; i++) {
    statuses.push((await fetch(`${base}/api/execution/languages`)).status); // public, no limiter of its own
  }
  assert.deepEqual(statuses.slice(0, 15), Array(15).fill(200));
  assert.ok(statuses.slice(15).every((s) => s === 429), `requests 16-20: ${statuses.slice(15).join(",")}`);
  const limited = await fetch(`${base}/api/execution/languages`);
  assert.equal((await limited.json()).code, "RATE_LIMITED");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal((await fetch(`${base}/health`)).status, 200, "liveness probes outside /api are not throttled");
});

test("SA-M6: an oversized problem identifier never reaches the database", async () => {
  assert.equal(await resolveProblem("x".repeat(5000)), null);
});
