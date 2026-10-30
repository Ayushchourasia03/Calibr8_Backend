import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/calibr8_test";

const { default: app } = await import("../src/app.js");
const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

try {
  const email = `profile-${randomUUID()}@example.com`;
  const registerResponse = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Profile Test",
      email,
      password: "profile-test-password",
      role: "admin",
    }),
  });
  const registration = await registerResponse.json();
  assert.equal(registerResponse.status, 201);
  assert.ok(registration.token);
  assert.equal("role" in registration.user, false);
  const tokenPayload = JSON.parse(
    Buffer.from(registration.token.split(".")[1], "base64url").toString("utf8"),
  );
  assert.equal("role" in tokenPayload, false);
  const headers = {
    Authorization: `Bearer ${registration.token}`,
    "Content-Type": "application/json",
  };

  assert.deepEqual(registration.stats, {
    rating: 800,
    tier: "Pulse II",
    score: 0,
    scoreUnits: 0,
    coins: 100,
    streak: 0,
    longestStreak: 0,
  });

  const authResponse = await fetch(`${baseUrl}/auth/me`, { headers });
  const auth = await authResponse.json();
  assert.equal(authResponse.status, 200);
  assert.deepEqual(auth.stats, registration.stats);

  const overviewResponse = await fetch(`${baseUrl}/users/me/overview`, {
    headers,
  });
  const overview = await overviewResponse.json();
  assert.equal(overviewResponse.status, 200);
  assert.equal(overview.success, true);
  assert.equal(overview.user.name, "Profile Test");
  assert.deepEqual(overview.activity, {});
  assert.equal(overview.total, 0);
  assert.equal(overview.activeDays, 0);

  const updateResponse = await fetch(`${baseUrl}/users/me`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      name: "Updated Profile",
      college: "AKGEC",
      branch: "CSE",
      batch: "2026",
      state: "UP",
      country: "India",
    }),
  });
  const update = await updateResponse.json();
  assert.equal(updateResponse.status, 200);
  assert.equal(update.success, true);
  assert.equal(update.user.name, "Updated Profile");
  assert.equal(update.user.college, "AKGEC");
  assert.equal(update.user.branch, "CSE");
  assert.equal(update.user.batch, "2026");
  assert.equal(update.user.state, "UP");
  assert.equal(update.user.country, "India");

  const invalidUpdateResponse = await fetch(`${baseUrl}/users/me`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: " " }),
  });
  assert.equal(invalidUpdateResponse.status, 400);

  const removedAdminEndpoint = await fetch(`${baseUrl}/admin/problems`, {
    method: "POST",
    headers,
    body: JSON.stringify({ slug: "should-not-exist", title: "Removed route" }),
  });
  assert.equal(removedAdminEndpoint.status, 404);

  const removedProblemCreationEndpoint = await fetch(`${baseUrl}/problems`, {
    method: "POST",
    headers,
    body: JSON.stringify({ slug: "should-not-exist", title: "Removed route" }),
  });
  assert.equal(removedProblemCreationEndpoint.status, 404);

  console.log("Profile API, role removal, and retired admin route tests passed.");
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
