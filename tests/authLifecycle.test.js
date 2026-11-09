import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "test-jwt-secret-key-that-is-at-least-32-chars-long";

const { default: app } = await import("../src/app.js");
const { default: prisma } = await import("../src/config/db.js");

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

try {
  console.log("=== Running Authentication & Token Lifecycle Test Suite ===");

  // 1. Registration Success
  const email = `auth-test-${randomUUID()}@example.com`;
  const regRes = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Alice Engineer",
      email,
      password: "StrongPassword123",
    }),
  });
  const regData = await regRes.json();
  assert.equal(regRes.status, 201, "Registration should succeed with 201");
  assert.equal(regData.success, true);
  assert.equal(regData.isNewUser, true);
  assert.equal(regData.user.email, email);
  assert.equal(regData.user.name, "Alice Engineer");
  assert.equal("passwordHash" in regData.user, false, "passwordHash must never be exposed");
  assert.ok(regData.token, "JWT token must be returned");
  assert.equal(regData.stats.coins, 100);
  assert.equal(regData.stats.rating, 800);

  // 2. Duplicate Registration Rejection
  const dupRes = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Duplicate User",
      email,
      password: "StrongPassword123",
    }),
  });
  const dupData = await dupRes.json();
  assert.equal(dupRes.status, 409, "Duplicate email should be rejected with 409");
  assert.equal(dupData.code, "EMAIL_ALREADY_EXISTS");

  // 3. Password Strength Validations
  // 3a. Weak password (< 8 chars)
  const weakRes = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Short Pw",
      email: `short-${randomUUID()}@example.com`,
      password: "short",
    }),
  });
  const weakData = await weakRes.json();
  assert.equal(weakRes.status, 400);
  assert.equal(weakData.code, "WEAK_PASSWORD");

  // 3b. Password too long (> 72 bytes)
  const longRes = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Long Pw",
      email: `long-${randomUUID()}@example.com`,
      password: "a".repeat(73),
    }),
  });
  const longData = await longRes.json();
  assert.equal(longRes.status, 400);
  assert.equal(longData.code, "PASSWORD_TOO_LONG");

  // 3c. Password equals email
  const sameEmail = `same-${randomUUID()}@example.com`;
  const sameRes = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Same Email",
      email: sameEmail,
      password: sameEmail,
    }),
  });
  const sameData = await sameRes.json();
  assert.equal(sameRes.status, 400);
  assert.equal(sameData.code, "PASSWORD_EQUALS_EMAIL");

  // 3d. Invalid email format
  const invalidEmailRes = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Bad Email",
      email: "not-an-email",
      password: "ValidPassword123",
    }),
  });
  const invalidEmailData = await invalidEmailRes.json();
  assert.equal(invalidEmailRes.status, 400);
  assert.equal(invalidEmailData.code, "INVALID_EMAIL");

  // 4. Login Tests
  // 4a. Valid Login
  const loginRes = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: email.toUpperCase(), // Test case insensitivity
      password: "StrongPassword123",
    }),
  });
  const loginData = await loginRes.json();
  assert.equal(loginRes.status, 200);
  assert.equal(loginData.success, true);
  assert.equal(loginData.user.email, email);
  assert.equal("passwordHash" in loginData.user, false);
  assert.ok(loginData.token);
  assert.ok(loginData.rewards);

  // 4b. Missing credentials
  const missCredRes = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.equal(missCredRes.status, 400);
  assert.equal((await missCredRes.json()).code, "MISSING_CREDENTIALS");

  // 4c. Wrong password
  const wrongPwRes = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "WrongPassword999" }),
  });
  assert.equal(wrongPwRes.status, 401);
  assert.equal((await wrongPwRes.json()).code, "INVALID_CREDENTIALS");

  // 4d. Non-existent user
  const nonExistRes = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "doesnotexist@example.com",
      password: "ValidPassword123",
    }),
  });
  assert.equal(nonExistRes.status, 401);
  assert.equal((await nonExistRes.json()).code, "INVALID_CREDENTIALS");

  // 5. Auth Verification (/api/auth/me and /api/auth/verify)
  const token = loginData.token;
  const meRes = await fetch(`${baseUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const meData = await meRes.json();
  assert.equal(meRes.status, 200);
  assert.equal(meData.success, true);
  assert.equal(meData.user.email, email);
  assert.ok(meData.user.todayISTDate);

  const verifyRes = await fetch(`${baseUrl}/auth/verify`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(verifyRes.status, 200);
  assert.equal((await verifyRes.json()).user.email, email);

  // 5b. Unauthenticated access without token
  const unauthRes = await fetch(`${baseUrl}/auth/me`);
  assert.equal(unauthRes.status, 401);
  assert.equal((await unauthRes.json()).code, "UNAUTHORIZED");

  // 5c. Malformed token
  const malformedRes = await fetch(`${baseUrl}/auth/me`, {
    headers: { Authorization: "Bearer this.is.invalid" },
  });
  assert.equal(malformedRes.status, 401);
  assert.equal((await malformedRes.json()).code, "INVALID_TOKEN");

  // 6. Change Password Flow
  const changeRes = await fetch(`${baseUrl}/auth/change-password`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      oldPassword: "StrongPassword123",
      newPassword: "BrandNewPassword456",
    }),
  });
  assert.equal(changeRes.status, 200);
  assert.equal((await changeRes.json()).success, true);

  // 6b. Old password should now fail login
  const oldLoginRes = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "StrongPassword123",
    }),
  });
  assert.equal(oldLoginRes.status, 401);

  // 6c. New password should succeed login
  const newLoginRes = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "BrandNewPassword456",
    }),
  });
  assert.equal(newLoginRes.status, 200);
  const freshToken = (await newLoginRes.json()).token;

  // 6d. Change password with incorrect current password
  const badOldRes = await fetch(`${baseUrl}/auth/change-password`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${freshToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      oldPassword: "IncorrectPassword",
      newPassword: "AnotherPassword789",
    }),
  });
  assert.equal(badOldRes.status, 400);
  assert.equal((await badOldRes.json()).code, "INVALID_CURRENT_PASSWORD");

  // 7. Token Refresh Flow
  const refreshRes = await fetch(`${baseUrl}/auth/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  const refreshData = await refreshRes.json();
  assert.equal(refreshRes.status, 200);
  assert.ok(refreshData.token);
  assert.notEqual(refreshData.token, freshToken, "Refreshed token should be new");

  // 7b. Old token must be revoked
  const oldTokenCheck = await fetch(`${baseUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  assert.equal(oldTokenCheck.status, 401);
  assert.equal((await oldTokenCheck.json()).code, "TOKEN_REVOKED");

  // 8. Logout & Blacklist Flow
  const activeToken = refreshData.token;
  const logoutRes = await fetch(`${baseUrl}/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${activeToken}` },
  });
  assert.equal(logoutRes.status, 200);

  // 8b. Logged-out token must now be revoked
  const postLogoutRes = await fetch(`${baseUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${activeToken}` },
  });
  assert.equal(postLogoutRes.status, 401);
  assert.equal((await postLogoutRes.json()).code, "TOKEN_REVOKED");

  console.log("✔ Authentication & Token Lifecycle tests passed successfully!");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
