import { cleanupTestUsers } from "./helpers/dbCleanup.js"; // keep first: snapshots the DB before this test writes
// Unique per run: tests share the real database, so a run only creates and
// deletes rows carrying its own tag (concurrent runs cannot delete each other's).
const RUN_TAG = `${process.pid.toString(36)}${Date.now().toString(36)}`;
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.JWT_SECRET = "test-jwt-secret-key-that-is-at-least-32-chars-long";
process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret-key-at-least-32-chars-long";

const { default: app } = await import("../src/app.js");
const { default: prisma } = await import("../src/config/db.js");
const { signSessionToken } = await import("../src/utils/jwt.js");
const { recoverStaleSubmissions } = await import("../src/controllers/execution.controller.js");
const { closeComplexityPool } = await import("../src/services/complexityPool.js");

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
const json = (token) => ({
  "Content-Type": "application/json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});
const post = (path, body, token) =>
  fetch(`${baseUrl}${path}`, { method: "POST", headers: json(token), body: JSON.stringify(body ?? {}) });
const me = (token) => fetch(`${baseUrl}/auth/me`, { headers: json(token) });

try {
  const email = `session-sec-${RUN_TAG}-${randomUUID()}@example.com`;
  const password = "SessionPassword123";
  const reg = await (await post("/auth/register", { name: "Session Tester", email, password })).json();
  const tokenA = reg.token;
  const tokenB = (await (await post("/auth/login", { email, password })).json()).token;
  assert.equal((await me(tokenA)).status, 200);
  assert.equal((await me(tokenB)).status, 200);

  // M1: changing the password revokes every earlier token, keeps this session.
  const changeRes = await post("/auth/change-password", { currentPassword: password, newPassword: "NewSessionPass456" }, tokenA);
  assert.equal(changeRes.status, 200);
  const tokenC = (await changeRes.json()).token;
  assert.ok(tokenC);
  for (const old of [tokenA, tokenB]) {
    const res = await me(old);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, "TOKEN_REVOKED");
  }
  assert.equal((await me(tokenC)).status, 200);
  // oldPassword is still accepted as an alias.
  const aliasRes = await post("/auth/change-password", { oldPassword: "NewSessionPass456", newPassword: "ThirdSessionPass789" }, tokenC);
  assert.equal(aliasRes.status, 200);
  const tokenD = (await aliasRes.json()).token;

  // M1: log out everywhere.
  assert.equal((await post("/auth/logout-all", {}, tokenD)).status, 200);
  assert.equal((await me(tokenD)).status, 401);
  const tokenE = (await (await post("/auth/login", { email, password: "ThirdSessionPass789" })).json()).token;
  assert.equal((await me(tokenE)).status, 200);

  // M1: refresh cannot extend a session beyond SESSION_MAX_AGE_DAYS.
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, tokenVersion: true } });
  const ancient = signSessionToken(user, { authTime: Math.floor(Date.now() / 1000) - 31 * 86400 });
  const ancientRefresh = await post("/auth/refresh", {}, ancient);
  assert.equal(ancientRefresh.status, 401);
  assert.equal((await ancientRefresh.json()).code, "SESSION_EXPIRED");
  const refreshed = await post("/auth/refresh", {}, tokenE);
  assert.equal(refreshed.status, 200);
  const tokenF = (await refreshed.json()).token;
  assert.equal((await me(tokenF)).status, 200);

  // M3: per-account lockout after repeated failed logins (any IP).
  for (let i = 0; i < 10; i++) {
    assert.equal((await post("/auth/login", { email, password: "wrong-password" })).status, 401);
  }
  const locked = await post("/auth/login", { email, password: "ThirdSessionPass789" });
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).code, "ACCOUNT_LOGIN_LOCKED");

  // L4: non-string credentials are a 400, not a 500.
  assert.equal((await post("/auth/login", { email: { $ne: "" }, password: 1 })).status, 400);

  // M8: oversized profile fields are rejected.
  const longName = await fetch(`${baseUrl}/users/me`, {
    method: "PATCH",
    headers: json(tokenF),
    body: JSON.stringify({ college: "x".repeat(500) }),
  });
  assert.equal(longName.status, 400);

  // M6: calibration cannot overwrite an earned rating.
  const topic = await prisma.topic.findFirst({ where: { category: { equals: "DSA", mode: "insensitive" } } });
  const problem = await prisma.problem.findFirst({ select: { id: true } });
  if (topic && problem) {
    await prisma.user.update({ where: { id: user.id }, data: { rating: 1111 } });
    await prisma.userProblemProgress.create({ data: { userId: user.id, problemId: problem.id, points: 10 } });
    const onboard = await fetch(`${baseUrl}/onboarding/levels`, {
      method: "PUT",
      headers: json(tokenF),
      body: JSON.stringify({ difficulty: "hard", topicIds: [topic.id] }),
    });
    assert.equal(onboard.status, 200);
    const after = await prisma.user.findUnique({ where: { id: user.id }, select: { rating: true, difficulty: true } });
    assert.equal(after.rating, 1111, "earned rating is kept");
    assert.equal(after.difficulty, "hard", "difficulty preference still updates");

    const badLevel = await fetch(`${baseUrl}/onboarding/levels`, {
      method: "PUT",
      headers: json(tokenF),
      body: JSON.stringify({ topicSelections: [{ topicId: topic.id, difficulty: "<script>" }] }),
    });
    assert.equal(badLevel.status, 400);
  }

  // H1: analysis requires login and is size-capped.
  assert.equal((await post("/execution/analyze-complexity", { code: "x = 1", language: "python" })).status, 401);
  assert.equal((await post("/execution/analyze-complexity", { code: "x".repeat(70 * 1024), language: "python" }, tokenF)).status, 413);
  const analyzed = await post("/execution/analyze-complexity", { code: "def f(n):\n    return n\n", language: "python" }, tokenF);
  assert.equal(analyzed.status, 200);

  // H3: execution routes require login.
  assert.equal((await post("/problems/two-sum/run", { language: "python", code: "x" })).status, 401);
  assert.equal((await post("/problems/two-sum/submit", { language: "python", code: "x" })).status, 401);

  // M9: abandoned PROCESSING submissions are recovered as ERROR.
  if (problem) {
    const stale = await prisma.submission.create({
      data: {
        problemId: problem.id,
        userId: user.id,
        language: "python",
        code: "x",
        status: "PROCESSING",
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
      },
    });
    const fresh = await prisma.submission.create({
      data: { problemId: problem.id, userId: user.id, language: "python", code: "x", status: "PROCESSING" },
    });
    await recoverStaleSubmissions(Date.now(), { userId: user.id });
    assert.equal((await prisma.submission.findUnique({ where: { id: stale.id } })).status, "ERROR");
    assert.equal((await prisma.submission.findUnique({ where: { id: fresh.id } })).status, "PROCESSING");
  }

  // L2: account deletion requires the password and explicit confirmation.
  const del = (body) => fetch(`${baseUrl}/users/me`, { method: "DELETE", headers: json(tokenF), body: JSON.stringify(body) });
  assert.equal((await del({ password: "ThirdSessionPass789" })).status, 400);
  assert.equal((await del({ password: "wrong", confirm: "DELETE" })).status, 400);
  assert.equal((await del({ password: "ThirdSessionPass789", confirm: "DELETE" })).status, 200);
  assert.equal(await prisma.user.count({ where: { email } }), 0);
  assert.equal((await me(tokenF)).status, 401);

  console.log("✔ Session & data-integrity hardening tests passed");
} finally {
  await cleanupTestUsers({ email: { startsWith: `session-sec-${RUN_TAG}-` } });
  await closeComplexityPool();
  await prisma.$disconnect().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
