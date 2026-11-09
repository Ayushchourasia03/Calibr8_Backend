import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "test-jwt-secret-key-that-is-at-least-32-chars-long";

const { default: app } = await import("../src/app.js");
const { default: prisma } = await import("../src/config/db.js");

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

try {
  console.log("=== Running Topics & Calibration Catalog Test Suite ===");

  // 1. Setup authenticated user
  const email = `topics-test-${randomUUID()}@example.com`;
  const regRes = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Carol Coder",
      email,
      password: "CarolPassword123",
    }),
  });
  const regData = await regRes.json();
  const token = regData.token;
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // 2. GET /api/topics (all topics)
  const allTopicsRes = await fetch(`${baseUrl}/topics`);
  assert.equal(allTopicsRes.status, 200);
  const allTopicsData = await allTopicsRes.json();
  assert.equal(allTopicsData.success, true);
  assert.ok(allTopicsData.count > 0);
  assert.ok(Array.isArray(allTopicsData.topics));

  // 3. Category filtering: ?category=dsa vs ?category=core
  const dsaCategoryRes = await fetch(`${baseUrl}/topics?category=dsa`);
  const dsaCategoryData = await dsaCategoryRes.json();
  assert.equal(dsaCategoryRes.status, 200);
  assert.ok(dsaCategoryData.topics.every((t) => t.category.toUpperCase() === "DSA"));

  const coreCategoryRes = await fetch(`${baseUrl}/topics?category=core`);
  const coreCategoryData = await coreCategoryRes.json();
  assert.equal(coreCategoryRes.status, 200);
  assert.ok(coreCategoryData.topics.every((t) => !t.category || t.category.toUpperCase() !== "DSA"));

  // 4. GET /api/topics/dsa (dedicated DSA topics route)
  const dsaOnlyRes = await fetch(`${baseUrl}/topics/dsa`);
  const dsaOnlyData = await dsaOnlyRes.json();
  assert.equal(dsaOnlyRes.status, 200);
  assert.equal(dsaOnlyData.success, true);
  assert.ok(dsaOnlyData.count > 0);

  // 5. GET /api/topics/:identifier (by ID and by slug)
  const sampleTopic = dsaOnlyData.topics[0];
  const byIdRes = await fetch(`${baseUrl}/topics/${sampleTopic.id}`, {
    headers: authHeaders,
  });
  assert.equal(byIdRes.status, 200);
  const byIdData = await byIdRes.json();
  assert.equal(byIdData.topic.id, sampleTopic.id);
  assert.equal(byIdData.topic.slug, sampleTopic.slug);

  const bySlugRes = await fetch(`${baseUrl}/topics/${sampleTopic.slug}`, {
    headers: authHeaders,
  });
  assert.equal(bySlugRes.status, 200);
  assert.equal((await bySlugRes.json()).topic.slug, sampleTopic.slug);

  // 5b. Unknown topic identifier returns 404
  const unknownTopicRes = await fetch(`${baseUrl}/topics/non-existent-topic-xyz`, {
    headers: authHeaders,
  });
  assert.equal(unknownTopicRes.status, 404);

  // 6. GET /api/topics/dsa/categories and GET /api/topics/categories
  const catsProtectedRes = await fetch(`${baseUrl}/topics/dsa/categories`, {
    headers: authHeaders,
  });
  assert.equal(catsProtectedRes.status, 200);
  const catsProtectedData = await catsProtectedRes.json();
  assert.ok(Array.isArray(catsProtectedData));
  assert.ok(catsProtectedData.length > 0);
  assert.ok("totalProblems" in catsProtectedData[0]);

  const catsPublicRes = await fetch(`${baseUrl}/topics/categories`);
  assert.equal(catsPublicRes.status, 200);
  assert.ok(Array.isArray(await catsPublicRes.json()));

  // 7. GET /api/topics/dsa/:slug/problems (grouped problems by DSA category)
  const dsaSlug = catsProtectedData[0].slug;
  const problemsByDsaRes = await fetch(
    `${baseUrl}/topics/dsa/${dsaSlug}/problems`,
  );
  assert.equal(problemsByDsaRes.status, 200);
  const problemsByDsaData = await problemsByDsaRes.json();
  assert.ok(problemsByDsaData.topic);
  assert.ok(Array.isArray(problemsByDsaData.problems));

  // 7b. Filter by difficulty
  const easyProblemsRes = await fetch(
    `${baseUrl}/topics/dsa/${dsaSlug}/problems?difficulty=Easy`,
  );
  assert.equal(easyProblemsRes.status, 200);
  const easyProblemsData = await easyProblemsRes.json();
  assert.ok(
    easyProblemsData.problems.every(
      (p) => p.difficulty.toLowerCase() === "easy",
    ),
  );

  // 8. 1-Click Beginner Preset Onboarding (`beginner: true`)
  const beginnerOnboardRes = await fetch(`${baseUrl}/onboarding`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ beginner: true }),
  });
  const beginnerOnboardData = await beginnerOnboardRes.json();
  assert.equal(beginnerOnboardRes.status, 200);
  assert.equal(beginnerOnboardData.user.onboarded, true);
  assert.equal(beginnerOnboardData.user.difficulty, "easy");
  assert.equal(beginnerOnboardData.user.rating, 800);
  assert.ok(beginnerOnboardData.user.topics.length >= 1);

  // 9. PUT /api/onboarding/levels (calibration update alias)
  const levelsUpdateRes = await fetch(`${baseUrl}/onboarding/levels`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      topicLevels: [
        { topicId: sampleTopic.slug, level: "hard" },
      ],
    }),
  });
  const levelsUpdateData = await levelsUpdateRes.json();
  assert.equal(levelsUpdateRes.status, 200);
  assert.equal(levelsUpdateData.user.rating, 1600);
  assert.equal(levelsUpdateData.user.difficulty, "hard");

  console.log("✔ Topics & Calibration Catalog tests passed successfully!");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
