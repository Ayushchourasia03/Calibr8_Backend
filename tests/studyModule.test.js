import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "test-jwt-secret-key-that-is-at-least-32-chars-long";

const { default: app } = await import("../src/app.js");

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

try {
  console.log("=== Running Study Module Curriculum & MCQ Test Suite ===");

  // 1. Setup authenticated user
  const email = `study-test-${randomUUID()}@example.com`;
  const regRes = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Diana Learner",
      email,
      password: "DianaPassword123",
    }),
  });
  const regData = await regRes.json();
  const token = regData.token;
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // 2. GET /api/study/subjects (list subjects with chapter counts)
  const subjectsRes = await fetch(`${baseUrl}/study/subjects`);
  assert.equal(subjectsRes.status, 200);
  const subjectsData = await subjectsRes.json();
  assert.ok(Array.isArray(subjectsData));
  assert.ok(subjectsData.length > 0, "Curriculum subjects should be loaded");

  const sampleSubject = subjectsData[0];
  assert.ok(sampleSubject.slug);
  assert.ok(sampleSubject.name);
  assert.ok("chapters" in sampleSubject || "_count" in sampleSubject);

  // 3. GET /api/study/subjects/:subjectSlug and /chapters alias
  const subjectSlug = sampleSubject.slug;
  const subDetailRes = await fetch(`${baseUrl}/study/subjects/${subjectSlug}`);
  assert.equal(subDetailRes.status, 200);
  const subDetailData = await subDetailRes.json();
  assert.equal(subDetailData.slug, subjectSlug);
  assert.ok(Array.isArray(subDetailData.chapters));
  assert.ok(subDetailData.chapters.length > 0);

  const chaptersAliasRes = await fetch(
    `${baseUrl}/study/subjects/${subjectSlug}/chapters`,
  );
  assert.equal(chaptersAliasRes.status, 200);
  assert.equal((await chaptersAliasRes.json()).slug, subjectSlug);

  // 3b. Non-existent subject returns 404
  const unknownSubRes = await fetch(`${baseUrl}/study/subjects/non-existent-subject`);
  assert.equal(unknownSubRes.status, 404);

  // 4. GET /api/study/chapters/:chapterId/topics
  const sampleChapter = subDetailData.chapters[0];
  const chapterId = sampleChapter.id;
  const topicsRes = await fetch(`${baseUrl}/study/chapters/${chapterId}/topics`);
  assert.equal(topicsRes.status, 200);
  const topicsData = await topicsRes.json();
  assert.ok(Array.isArray(topicsData));

  // 5. GET /api/study/topics/:topicSlug (content, MCQs, options, difficulty)
  const topicSlug = sampleChapter.topics?.[0]?.slug || topicsData[0]?.slug;
  assert.ok(topicSlug, "Must have a topic slug to inspect");

  const topicRes = await fetch(`${baseUrl}/study/topics/${topicSlug}`);
  assert.equal(topicRes.status, 200);
  const topicData = await topicRes.json();
  assert.equal(topicData.slug, topicSlug);
  assert.ok("content" in topicData);
  assert.ok(Array.isArray(topicData.mcqs));

  // 5b. Non-existent topic returns 404
  const unknownTopicRes = await fetch(`${baseUrl}/study/topics/non-existent-topic-slug`);
  assert.equal(unknownTopicRes.status, 404);

  // 6. POST /api/study/topics/:topicSlug/submit
  // 6a. Unauthenticated submission returns 401
  const unauthSubmitRes = await fetch(
    `${baseUrl}/study/topics/${topicSlug}/submit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: {} }),
    },
  );
  assert.equal(unauthSubmitRes.status, 401);
  assert.equal((await unauthSubmitRes.json()).code, "UNAUTHORIZED");

  // 6b. Authenticated quiz submission
  const mcqs = topicData.mcqs;
  if (mcqs && mcqs.length > 0) {
    // Submit 1 correct answer (if correctIndex is known from internal store) and 1 wrong answer
    const sampleMCQ = mcqs[0];
    const answers = {
      [sampleMCQ.id]: 0, // answer choice 0
    };

    const submitRes = await fetch(
      `${baseUrl}/study/topics/${topicSlug}/submit`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ answers }),
      },
    );
    assert.equal(submitRes.status, 200);
    const submitData = await submitRes.json();
    assert.equal(submitData.success, true);
    assert.equal(submitData.userId, regData.user.id);
    assert.equal(submitData.topicSlug, topicSlug);
    assert.equal(typeof submitData.score, "number");
    assert.equal(submitData.total, mcqs.length);
    assert.ok(Array.isArray(submitData.result));
    assert.equal(submitData.result.length, mcqs.length);
    assert.ok("isCorrect" in submitData.result[0]);
    assert.ok("correctIndex" in submitData.result[0]);
    assert.ok("explanation" in submitData.result[0]);
  }

  // 6c. Submitting to non-existent topic returns 404
  const badTopicSubmitRes = await fetch(
    `${baseUrl}/study/topics/non-existent-topic/submit`,
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ answers: {} }),
    },
  );
  assert.equal(badTopicSubmitRes.status, 404);

  console.log("✔ Study Module Curriculum & MCQ tests passed successfully!");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
