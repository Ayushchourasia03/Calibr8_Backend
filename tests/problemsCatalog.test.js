import assert from "node:assert/strict";
import app from "../src/app.js";

const server = app.listen(0);
const apiBaseUrl = `http://127.0.0.1:${server.address().port}/api`;
const baseUrl = `${apiBaseUrl}/problems`;

async function fetchProblems(filters = {}) {
  const params = new URLSearchParams(filters);
  const query = params.toString();
  const response = await fetch(`${baseUrl}${query ? `?${query}` : ""}`);
  const body = await response.json();
  return { response, body };
}

try {
  const { response: allResponse, body: allBody } = await fetchProblems();
  assert.equal(allResponse.status, 200);
  assert.equal(allBody.success, true);
  assert.ok(allBody.data.length > 0, "The backend should return real catalog problems");

  const problems = allBody.data;
  assert.ok(
    problems.every((problem) => problem.topic && problem.topic !== "Other"),
    "The catalog should resolve problem topics from the database or bundled definitions",
  );
  for (const difficulty of new Set(problems.map((problem) => problem.difficulty))) {
    const { response, body } = await fetchProblems({ difficulty });
    assert.equal(response.status, 200);
    assert.ok(body.data.length > 0);
    assert.ok(body.data.every((problem) => problem.difficulty.toLowerCase() === difficulty.toLowerCase()));
  }

  for (const topic of new Set(problems.map((problem) => problem.topic))) {
    const { response, body } = await fetchProblems({ topic });
    assert.equal(response.status, 200);
    assert.ok(body.data.length > 0);
    assert.ok(body.data.every((problem) => problem.topic.toLowerCase() === topic.toLowerCase()));
  }

  const searchTerm = problems[0].title.slice(0, 3).toLowerCase();
  const { response: searchResponse, body: searchBody } = await fetchProblems({
    search: searchTerm,
  });
  assert.equal(searchResponse.status, 200);
  assert.ok(searchBody.data.length > 0);
  assert.ok(
    searchBody.data.every((problem) =>
      [
        problem.title,
        problem.slug,
        problem.problemNumber,
        problem.topic,
        problem.difficulty,
        ...(problem.tags || []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(searchTerm),
    ),
  );

  const categoryResponse = await fetch(`${apiBaseUrl}/topics/categories`);
  assert.equal(categoryResponse.status, 200);
  const categories = await categoryResponse.json();
  const populatedCategory = categories.find((category) => category.totalProblems > 0);
  assert.ok(populatedCategory, "At least one backend DSA category should have problems");

  const categoryProblemsResponse = await fetch(
    `${apiBaseUrl}/topics/dsa/${encodeURIComponent(populatedCategory.slug)}/problems`,
  );
  assert.equal(categoryProblemsResponse.status, 200);
  const categoryProblems = await categoryProblemsResponse.json();
  assert.ok(categoryProblems.count > 0);
  assert.equal(categoryProblems.count, populatedCategory.totalProblems);

  const { response: todoResponse, body: todoBody } = await fetchProblems({ status: "todo" });
  assert.equal(todoResponse.status, 200);
  assert.equal(todoBody.data.length, problems.length);
  assert.ok(todoBody.data.every((problem) => !problem.isSolved));

  const { response: solvedResponse, body: solvedBody } = await fetchProblems({
    status: "solved",
  });
  assert.equal(solvedResponse.status, 200);
  assert.deepEqual(solvedBody.data, []);

  const first = problems[0];
  const { response: combinedResponse, body: combinedBody } = await fetchProblems({
    difficulty: first.difficulty,
    topic: first.topic,
    search: first.slug,
    status: "todo",
  });
  assert.equal(combinedResponse.status, 200);
  assert.ok(combinedBody.data.length > 0);
  assert.ok(
    combinedBody.data.every(
      (problem) =>
        problem.difficulty.toLowerCase() === first.difficulty.toLowerCase() &&
        problem.topic.toLowerCase() === first.topic.toLowerCase() &&
        problem.slug.includes(first.slug) &&
        !problem.isSolved,
    ),
  );

  const { response: invalidStatusResponse, body: invalidStatusBody } =
    await fetchProblems({ status: "unknown" });
  assert.equal(invalidStatusResponse.status, 400);
  assert.equal(invalidStatusBody.code, "INVALID_STATUS");

  console.log("Problems catalog API filter tests passed.");
} finally {
  server.close();
}
