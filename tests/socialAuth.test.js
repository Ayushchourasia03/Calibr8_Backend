import { cleanupTestUsers } from "./helpers/dbCleanup.js"; // keep first: snapshots the DB before this test writes
// Unique per run: tests share the real database, so a run only creates and
// deletes rows carrying its own tag (concurrent runs cannot delete each other's).
const RUN_TAG = `${process.pid.toString(36)}${Date.now().toString(36)}`;
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-jwt-secret-key-that-is-at-least-32-chars-long";
process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret-key-at-least-32-chars-long";
process.env.FRONTEND_URL = "http://localhost:5173";
process.env.GITHUB_CLIENT_ID = "test-client-id";
process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
process.env.BACKEND_URL = "http://localhost:3000";

// Mock GitHub (token exchange, profile, emails); every other request is real.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = String(typeof input === "string" ? input : input.url ?? input);
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.startsWith("https://github.com/login/oauth/access_token")) return json({ access_token: "gh-test-token" });
  if (url.startsWith("https://api.github.com/user/emails")) return json([{ email: "eve-private@example.com", primary: true, verified: true }]);
  if (url.startsWith("https://api.github.com/user")) {
    return json({ id: Math.floor(Math.random() * 1e9), login: "eve-gh", name: "Eve GH", email: null, avatar_url: "https://a.example/x.png", html_url: "https://github.com/eve-gh", bio: null, public_repos: 1, followers: 2, following: 3 });
  }
  return realFetch(input, options);
};

const { default: app } = await import("../src/app.js");
const { default: prisma } = await import("../src/config/db.js");

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

try {
  console.log("=== Running Social Account Linking & OAuth Test Suite ===");

  // 1. Setup user
  const email = `social-test-${RUN_TAG}-${randomUUID()}@example.com`;
  const regRes = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Eve Developer",
      email,
      password: "EvePassword123",
    }),
  });
  const regData = await regRes.json();
  const token = regData.token;
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // 2. GET /api/social/:provider/link-url
  const linkUrlRes = await fetch(`${baseUrl}/social/github/link-url`, {
    headers: authHeaders,
  });
  assert.equal(linkUrlRes.status, 200);
  const linkUrlData = await linkUrlRes.json();
  assert.ok(linkUrlData.url);
  assert.ok(linkUrlData.url.startsWith("https://github.com/login/oauth/authorize"));

  // Check state inside the returned link URL
  const stateParam = new URL(linkUrlData.url).searchParams.get("state");
  assert.ok(stateParam);
  const decodedState = jwt.verify(stateParam, process.env.OAUTH_STATE_SECRET);
  assert.equal(decodedState.userId, regData.user.id);
  assert.equal(decodedState.provider, "github");

  // 2b. Unknown provider returns 404
  const badProviderRes = await fetch(`${baseUrl}/social/twitter/link-url`, {
    headers: authHeaders,
  });
  assert.equal(badProviderRes.status, 404);
  assert.equal((await badProviderRes.json()).code, "UNKNOWN_PROVIDER");

  // 3. GET /api/social/:provider/callback
  // 3a. Missing code or state redirects with CANCELLED
  const cancelRes = await fetch(`${baseUrl}/social/github/callback`, {
    redirect: "manual",
  });
  assert.equal(cancelRes.status, 302);
  const cancelLoc = cancelRes.headers.get("location");
  assert.ok(cancelLoc.includes("link_error=CANCELLED"));

  // 3b. Expired or forged state redirects with EXPIRED
  const forgedRes = await fetch(
    `${baseUrl}/social/github/callback?code=abc&state=forged-state`,
    { redirect: "manual" },
  );
  assert.equal(forgedRes.status, 302);
  const forgedLoc = forgedRes.headers.get("location");
  assert.ok(forgedLoc.includes("link_error=EXPIRED"));

  // 3c. Unknown provider in callback redirects with UNKNOWN_PROVIDER
  const validStateForUnknown = jwt.sign(
    { userId: regData.user.id, provider: "gitlab" },
    process.env.OAUTH_STATE_SECRET,
  );
  const unknownCbRes = await fetch(
    `${baseUrl}/social/gitlab/callback?code=abc&state=${validStateForUnknown}`,
    { redirect: "manual" },
  );
  assert.equal(unknownCbRes.status, 302);
  assert.ok(unknownCbRes.headers.get("location").includes("link_error=UNKNOWN_PROVIDER"));

  // 3d. Open redirect attack defense: redirect_uri pointing to evil.com
  const openRedirectRes = await fetch(
    `${baseUrl}/social/github/callback?redirect_uri=https://evil.com`,
    { redirect: "manual" },
  );
  assert.equal(openRedirectRes.status, 302);
  const safeLoc = openRedirectRes.headers.get("location");
  assert.ok(
    !safeLoc.startsWith("https://evil.com"),
    "Must not redirect to unallowed evil.com origin",
  );
  assert.ok(safeLoc.startsWith("http://localhost:5173"));

  // 3e. Full flow: the callback never links by itself; it hands the frontend
  // a one-time link_code that only the account that started the flow can use.
  const flowCb = await fetch(
    `${baseUrl}/social/github/callback?code=gh-code&state=${encodeURIComponent(stateParam)}`,
    { redirect: "manual" },
  );
  assert.equal(flowCb.status, 302);
  const flowLoc = new URL(flowCb.headers.get("location"));
  assert.equal(flowLoc.origin, "http://localhost:5173");
  const linkCode = flowLoc.searchParams.get("link_code");
  assert.ok(linkCode, "callback returns a link_code");
  assert.equal(flowLoc.searchParams.get("provider"), "github");
  assert.equal(await prisma.socialAccount.count({ where: { userId: regData.user.id } }), 0, "not linked by the callback");
  assert.ok(!flowLoc.search.includes("eve-private"), "profile data is encrypted in the code");

  // Link CSRF: a different signed-in user cannot complete someone else's flow.
  const otherReg = await (await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Mallory", email: `social-test-${RUN_TAG}-${randomUUID()}@example.com`, password: "MalloryPassword123" }),
  })).json();
  const mismatch = await fetch(`${baseUrl}/social/github/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${otherReg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code: linkCode }),
  });
  assert.equal(mismatch.status, 403);
  assert.equal((await mismatch.json()).code, "LINK_ACCOUNT_MISMATCH");

  // Tampered codes are rejected.
  const flipped = linkCode.slice(0, 20) + (linkCode[20] === "A" ? "B" : "A") + linkCode.slice(21);
  const tampered = await fetch(`${baseUrl}/social/github/complete`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ code: flipped }),
  });
  assert.equal(tampered.status, 400);

  // The owner completes the link.
  const completeRes = await fetch(`${baseUrl}/social/github/complete`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ code: linkCode }),
  });
  assert.equal(completeRes.status, 200);
  const completeData = await completeRes.json();
  assert.equal(completeData.linked, "github");
  assert.equal(completeData.account.username, "eve-gh");
  assert.equal(completeData.account.email, "eve-private@example.com");

  // Single use.
  const replay = await fetch(`${baseUrl}/social/github/complete`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ code: linkCode }),
  });
  assert.equal(replay.status, 400);

  // 4. DELETE /api/social/:provider (unlink provider)
  const unlinkRes = await fetch(`${baseUrl}/social/github`, {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.equal(unlinkRes.status, 200);
  const unlinkData = await unlinkRes.json();
  assert.equal(unlinkData.success, true);

  // 4b. Unauthenticated unlink rejected with 401
  const unauthUnlinkRes = await fetch(`${baseUrl}/social/github`, {
    method: "DELETE",
  });
  assert.equal(unauthUnlinkRes.status, 401);

  console.log("✔ Social Account Linking & OAuth tests passed successfully!");
} finally {
  await cleanupTestUsers({ email: { startsWith: `social-test-${RUN_TAG}-` } });
  await prisma.$disconnect().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
