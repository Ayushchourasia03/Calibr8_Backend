import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "test-jwt-secret-key-that-is-at-least-32-chars-long";

const { default: app } = await import("../src/app.js");
const { default: prisma } = await import("../src/config/db.js");

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

try {
  console.log("=== Running Rankings & Leaderboard Test Suite ===");

  // 1. Seed users with distinct scores and academic profiles
  const users = [
    {
      id: `usr_rank_1_${randomUUID()}`,
      email: `rank1-${randomUUID()}@example.com`,
      name: "Top Scorer",
      score: 5000,
      rating: 1800,
      college: "IIT Delhi",
      batch: "2024",
      state: "Delhi",
      country: "India",
    },
    {
      id: `usr_rank_2_${randomUUID()}`,
      email: `rank2-${randomUUID()}@example.com`,
      name: "Mid Scorer",
      score: 3000,
      rating: 1400,
      college: "IIT Delhi",
      batch: "2025",
      state: "Delhi",
      country: "India",
    },
    {
      id: `usr_rank_3_${randomUUID()}`,
      email: `rank3-${randomUUID()}@example.com`,
      name: "Other College Scorer",
      score: 4000,
      rating: 1600,
      college: "IIT Bombay",
      batch: "2024",
      state: "Maharashtra",
      country: "India",
    },
  ];

  for (const u of users) {
    await prisma.user.create({
      data: {
        id: u.id,
        email: u.email,
        name: u.name,
        score: u.score,
        rating: u.rating,
        college: u.college,
        batch: u.batch,
        state: u.state,
        country: u.country,
        passwordHash: "hash-not-for-login",
      },
    });
  }

  // 2. GET /api/rankings (all, global)
  const allRankRes = await fetch(`${baseUrl}/rankings`);
  assert.equal(allRankRes.status, 200);
  const allRankData = await allRankRes.json();
  assert.equal(allRankData.success, true);
  assert.ok(Array.isArray(allRankData.data));
  assert.ok(allRankData.count >= 3);

  // Check that passwordHash is never returned
  for (const row of allRankData.data) {
    assert.equal("passwordHash" in row, false, "passwordHash must never be exposed");
    assert.ok("name" in row);
    assert.ok("score" in row);
    assert.ok("rating" in row);
    assert.ok("tier" in row);
  }

  // 3. College scope filter
  const collegeRes = await fetch(
    `${baseUrl}/rankings?scope=college&college=IIT%20Delhi`,
  );
  assert.equal(collegeRes.status, 200);
  const collegeData = await collegeRes.json();
  assert.ok(collegeData.data.every((u) => u.college === "IIT Delhi"));

  // 4. Batch scope filter
  const batchRes = await fetch(`${baseUrl}/rankings?scope=batch&batch=2024`);
  assert.equal(batchRes.status, 200);
  const batchData = await batchRes.json();
  assert.ok(batchData.data.every((u) => u.batch === "2024"));

  // 5. State scope filter
  const stateRes = await fetch(
    `${baseUrl}/rankings?scope=state&state=Maharashtra`,
  );
  assert.equal(stateRes.status, 200);
  const stateData = await stateRes.json();
  assert.ok(stateData.data.every((u) => u.state === "Maharashtra"));

  // 6. Country scope filter
  const countryRes = await fetch(
    `${baseUrl}/rankings?scope=country&country=India`,
  );
  assert.equal(countryRes.status, 200);
  const countryData = await countryRes.json();
  assert.ok(countryData.data.every((u) => u.country === "India"));

  // 7. Limit clamping (min 1, max 100)
  const minLimitRes = await fetch(`${baseUrl}/rankings?limit=0`);
  assert.equal(minLimitRes.status, 200);
  const minLimitData = await minLimitRes.json();
  assert.equal(minLimitData.data.length, 1, "Limit 0 should clamp to 1");

  console.log("✔ Rankings & Leaderboard tests passed successfully!");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
