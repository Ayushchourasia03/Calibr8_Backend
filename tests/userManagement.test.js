import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "test-jwt-secret-key-that-is-at-least-32-chars-long";

const { default: app } = await import("../src/app.js");
const { default: prisma } = await import("../src/config/db.js");

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

try {
  console.log("=== Running User & Profile Management Test Suite ===");

  // 1. Setup user
  const email = `user-mgr-${randomUUID()}@example.com`;
  const regRes = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Bob Developer",
      email,
      password: "BobPassword123",
    }),
  });
  const regData = await regRes.json();
  const token = regData.token;
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // 2. GET /api/users/me & alias GET /api/users
  const meRes = await fetch(`${baseUrl}/users/me`, { headers: authHeaders });
  assert.equal(meRes.status, 200);
  const meData = await meRes.json();
  assert.equal(meData.success, true);
  assert.equal(meData.user.name, "Bob Developer");
  assert.equal(meData.user.email, email);
  assert.equal(meData.user.preferredLanguage, "cpp");

  const aliasMeRes = await fetch(`${baseUrl}/users`, { headers: authHeaders });
  assert.equal(aliasMeRes.status, 200);
  assert.equal((await aliasMeRes.json()).user.id, meData.user.id);

  // 3. PUT /api/users/me (update name)
  const putRes = await fetch(`${baseUrl}/users/me`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ name: "Bob Senior Architect" }),
  });
  const putData = await putRes.json();
  assert.equal(putRes.status, 200);
  assert.equal(putData.success, true);
  assert.equal(putData.user.name, "Bob Senior Architect");

  // 3b. PUT with empty name should fail with 400
  const emptyPutRes = await fetch(`${baseUrl}/users/me`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ name: "   " }),
  });
  assert.equal(emptyPutRes.status, 400);

  // 4. PUT /api/users (root alias update)
  const aliasPutRes = await fetch(`${baseUrl}/users`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ name: "Bob Staff" }),
  });
  assert.equal(aliasPutRes.status, 200);
  assert.equal((await aliasPutRes.json()).user.name, "Bob Staff");

  // 5. PATCH /api/users/me (batch update profile fields)
  const patchRes = await fetch(`${baseUrl}/users/me`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({
      name: "Robert Developer",
      college: "IIT Bombay",
      branch: "Computer Science",
      batch: "2026",
      state: "Maharashtra",
      country: "India",
    }),
  });
  const patchData = await patchRes.json();
  assert.equal(patchRes.status, 200);
  assert.equal(patchData.user.name, "Robert Developer");
  assert.equal(patchData.user.college, "IIT Bombay");
  assert.equal(patchData.user.branch, "Computer Science");
  assert.equal(patchData.user.batch, "2026");
  assert.equal(patchData.user.state, "Maharashtra");
  assert.equal(patchData.user.country, "India");

  // 5b. PATCH with empty object should fail
  const emptyPatchRes = await fetch(`${baseUrl}/users/me`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(emptyPatchRes.status, 400);

  // 6. PATCH /api/users/me/language
  for (const lang of ["cpp", "c", "java", "python", "javascript"]) {
    const langRes = await fetch(`${baseUrl}/users/me/language`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ language: lang }),
    });
    const langData = await langRes.json();
    assert.equal(langRes.status, 200);
    assert.equal(langData.language, lang);
  }

  // 6b. Invalid language rejected
  const badLangRes = await fetch(`${baseUrl}/users/me/language`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({ language: "ruby" }),
  });
  assert.equal(badLangRes.status, 400);

  // 7. PATCH /api/users/me/academic and alias PATCH /api/users/academic
  const acadRes = await fetch(`${baseUrl}/users/me/academic`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({
      college: "BITS Pilani",
      branch: "ECE",
      batch: "2025",
      state: "Rajasthan",
      country: "India",
    }),
  });
  const acadData = await acadRes.json();
  assert.equal(acadRes.status, 200);
  assert.equal(acadData.user.college, "BITS Pilani");
  assert.equal(acadData.user.branch, "ECE");

  const aliasAcadRes = await fetch(`${baseUrl}/users/academic`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({
      college: "IIIT Hyderabad",
      branch: "CSE",
    }),
  });
  assert.equal(aliasAcadRes.status, 200);
  assert.equal((await aliasAcadRes.json()).user.college, "IIIT Hyderabad");

  // 7b. Empty academic patch rejected
  const badAcadRes = await fetch(`${baseUrl}/users/me/academic`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(badAcadRes.status, 400);

  // 8. GET /api/users/me/overview and GET /api/users/me/activity
  const overviewRes = await fetch(`${baseUrl}/users/me/overview`, {
    headers: authHeaders,
  });
  const overviewData = await overviewRes.json();
  assert.equal(overviewRes.status, 200);
  assert.equal(overviewData.success, true);
  assert.ok("activity" in overviewData);
  assert.equal(typeof overviewData.total, "number");
  assert.equal(typeof overviewData.activeDays, "number");

  const actRes = await fetch(`${baseUrl}/users/me/activity`, {
    headers: authHeaders,
  });
  const actData = await actRes.json();
  assert.equal(actRes.status, 200);
  assert.equal(actData.success, true);
  assert.ok("activity" in actData);

  // 9. GET /api/users/all (list problems formatted with user solve status)
  const allRes = await fetch(`${baseUrl}/users/all`, { headers: authHeaders });
  const allData = await allRes.json();
  assert.equal(allRes.status, 200);
  assert.equal(allData.success, true);
  assert.ok(Array.isArray(allData.data));
  if (allData.data.length > 0) {
    const item = allData.data[0];
    assert.ok("slug" in item);
    assert.ok("name" in item);
    assert.ok("level" in item);
    assert.ok("levelDisplay" in item);
    assert.ok("solvedPercentage" in item);
    assert.ok("isSolved" in item);
  }

  // 10. Unauthenticated access rejected with 401 across protected user routes
  for (const path of [
    "/users/me",
    "/users/me/overview",
    "/users/me/activity",
    "/users/all",
  ]) {
    const res = await fetch(`${baseUrl}${path}`);
    assert.equal(res.status, 401, `${path} should require authentication`);
  }

  console.log("✔ User & Profile Management tests passed successfully!");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
