import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";

process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "test-jwt-secret-key-that-is-at-least-32-chars-long";
process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret-key-at-least-32-chars-long";
process.env.FRONTEND_URL = "http://localhost:5173";

const { default: app } = await import("../src/app.js");

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

try {
  console.log("=== Running Social Account Linking & OAuth Test Suite ===");

  // 1. Setup user
  const email = `social-test-${randomUUID()}@example.com`;
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
  await new Promise((resolve) => server.close(resolve));
}
