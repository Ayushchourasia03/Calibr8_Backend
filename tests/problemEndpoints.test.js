import assert from "node:assert/strict";

process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "test-jwt-secret-key-that-is-at-least-32-chars-long";
process.env.CODEBOX_URL = "https://codebox.internal";
process.env.CODEBOX_TOKEN = "test-token";

const { default: app } = await import("../src/app.js");
const { default: prisma } = await import("../src/config/db.js");

// Mock CodeBox fetch for run & submit
const originalFetch = globalThis.fetch;
let lastBatch = [];
globalThis.fetch = async (input, options = {}) => {
  const urlStr = typeof input === "string" ? input : input.toString();
  if (urlStr.startsWith("https://codebox.internal")) {
    const url = new URL(urlStr);
    if (options.method === "POST") {
      const payload = JSON.parse(options.body || "{}");
      lastBatch = payload.submissions || [];
      return new Response(
        JSON.stringify(
          lastBatch.map((_, idx) => ({ token: `sub-tok-${idx}` })),
        ),
        { status: 201 },
      );
    }
    const tokens = (url.searchParams.get("tokens") || "").split(",");
    return new Response(
      JSON.stringify({
        submissions: tokens.map((token, idx) => {
          const sub = lastBatch[idx] || {};
          const stdin = String(sub.stdin || "");
          let stdout = "0 1";
          if (stdin.includes("3 6") || stdin.includes("4 10")) stdout = "1 2";
          return {
            token,
            status: { id: 3 },
            stdout,
            time: "0.01",
            memory: 1024,
          };
        }),
      }),
      { status: 200 },
    );
  }
  return originalFetch(input, options);
};

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

try {
  console.log("=== Running Problem Endpoints & Templates Test Suite ===");

  // 1. GET /api/problems with various filters
  const listRes = await fetch(`${baseUrl}/problems`);
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  assert.equal(listData.success, true);
  assert.ok(listData.count > 0);
  assert.ok(Array.isArray(listData.data));

  // 1b. Search filter
  const searchRes = await fetch(`${baseUrl}/problems?search=two`);
  const searchData = await searchRes.json();
  assert.equal(searchRes.status, 200);
  assert.ok(
    searchData.data.some((p) => p.slug.includes("two") || p.title.toLowerCase().includes("two")),
  );

  // 1c. Difficulty filter
  const diffRes = await fetch(`${baseUrl}/problems?difficulty=Easy`);
  assert.equal(diffRes.status, 200);
  assert.ok(
    (await diffRes.json()).data.every((p) => p.difficulty.toLowerCase() === "easy"),
  );

  // 1d. Invalid status filter rejected
  const badStatusRes = await fetch(`${baseUrl}/problems?status=invalid_status`);
  assert.equal(badStatusRes.status, 400);
  assert.equal((await badStatusRes.json()).code, "INVALID_STATUS");

  // 2. GET /api/problems/:slug
  const slug = listData.data[0].slug;
  const detailRes = await fetch(`${baseUrl}/problems/${slug}`);
  assert.equal(detailRes.status, 200);
  const detailData = await detailRes.json();
  assert.equal(detailData.success, true);
  assert.equal(detailData.data.slug, slug);
  assert.ok("testcases" in detailData.data);
  assert.ok("templates" in detailData.data);
  // Ensure hidden testcases are NOT exposed
  assert.ok(detailData.data.testcases.every((tc) => tc.isVisible === true));

  // 2b. Unknown problem slug returns 404
  const unknownProblemRes = await fetch(`${baseUrl}/problems/this-slug-does-not-exist`);
  assert.equal(unknownProblemRes.status, 404);
  assert.equal((await unknownProblemRes.json()).code, "NOT_FOUND");

  // 3. GET /api/problems/:slug/starter and /template aliases
  const starterRes = await fetch(`${baseUrl}/problems/${slug}/starter`);
  assert.equal(starterRes.status, 200);
  const starterData = await starterRes.json();
  assert.ok(starterData.data.templates);

  const langStarterRes = await fetch(`${baseUrl}/problems/${slug}/starter?language=python`);
  assert.equal(langStarterRes.status, 200);
  const langStarterData = await langStarterRes.json();
  assert.equal(langStarterData.data.language, "python");
  assert.ok(typeof langStarterData.data.template === "string");

  const templateAliasRes = await fetch(`${baseUrl}/problems/${slug}/template?language=cpp`);
  assert.equal(templateAliasRes.status, 200);
  assert.equal((await templateAliasRes.json()).data.language, "cpp");

  // 3b. Unsupported language for starter template returns 404
  const badLangStarterRes = await fetch(`${baseUrl}/problems/${slug}/starter?language=haskell`);
  assert.equal(badLangStarterRes.status, 404);

  // 4. POST /api/problems/:slug/run (optional auth playground execution)
  const runRes = await fetch(`${baseUrl}/problems/${slug}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      language: "python",
      code: "class Solution:\n    def solve(self):\n        pass",
    }),
  });
  assert.equal(runRes.status, 200);
  const runData = await runRes.json();
  assert.equal(runData.success, true);
  assert.ok("verdict" in runData);
  assert.ok("results" in runData);
  assert.ok(runData.results.every((r) => r.isVisible === true));

  // 5. POST /api/problems/:slug/submit (optional auth submission execution)
  const submitRes = await fetch(`${baseUrl}/problems/${slug}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      language: "python",
      code: "class Solution:\n    def solve(self):\n        pass",
      wait: true,
    }),
  });
  assert.equal(submitRes.status, 200);
  const submitData = await submitRes.json();
  assert.equal(submitData.success, true);
  assert.ok("verdict" in submitData);
  assert.ok("tierReached" in submitData);

  console.log("✔ Problem Endpoints & Templates tests passed successfully!");
} finally {
  globalThis.fetch = originalFetch;
  await new Promise((resolve) => server.close(resolve));
}
