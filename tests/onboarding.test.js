import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgresql://localhost:5432/calibr8_test";

const { default: app } = await import("../src/app.js");
const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

try {
  const topicsResponse = await fetch(`${baseUrl}/topics/dsa`);
  const topicsResult = await topicsResponse.json();
  assert.equal(topicsResponse.status, 200);
  assert.equal(topicsResult.success, true);
  assert.ok(topicsResult.count > 0, "DSA calibration topics should be available");

  const registerResponse = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Onboarding Test",
      email: `onboarding-${randomUUID()}@example.com`,
      password: "onboarding-test-password",
    }),
  });
  const registration = await registerResponse.json();
  assert.equal(registerResponse.status, 201);
  assert.equal(registration.user.onboarded, false);

  const headers = {
    Authorization: `Bearer ${registration.token}`,
    "Content-Type": "application/json",
  };
  const topicSelections = [
    { topicId: topicsResult.topics[0].slug, difficulty: "medium" },
    { topicId: topicsResult.topics[1].slug, difficulty: "hard" },
  ];
  const onboardingResponse = await fetch(`${baseUrl}/onboarding`, {
    method: "POST",
    headers,
    body: JSON.stringify({ topicSelections }),
  });
  const onboardingResult = await onboardingResponse.json();
  assert.equal(onboardingResponse.status, 200);
  assert.equal(onboardingResult.success, true);
  assert.equal(onboardingResult.user.onboarded, true);
  assert.equal(onboardingResult.user.rating, 1400);
  assert.deepEqual(
    onboardingResult.user.topics.map(({ topic, level }) => [
      topic.slug,
      level,
    ]),
    [
      [topicsResult.topics[0].slug, "medium"],
      [topicsResult.topics[1].slug, "hard"],
    ],
  );

  const invalidSelectionResponse = await fetch(`${baseUrl}/onboarding`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      topicSelections: [{ topicId: "unknown-topic", difficulty: "easy" }],
    }),
  });
  assert.equal(invalidSelectionResponse.status, 400);

  const languageResponse = await fetch(`${baseUrl}/onboarding/language`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ language: "python" }),
  });
  const languageResult = await languageResponse.json();
  assert.equal(languageResponse.status, 200);
  assert.equal(languageResult.language, "python");

  const statusResponse = await fetch(`${baseUrl}/onboarding/status`, {
    headers,
  });
  const statusResult = await statusResponse.json();
  assert.equal(statusResponse.status, 200);
  assert.equal(statusResult.user.onboarded, true);
  assert.equal(statusResult.user.preferredLanguage, "python");
  assert.equal(statusResult.user.topics.length, 2);

  console.log("Onboarding topics, calibration, and language APIs passed.");
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
