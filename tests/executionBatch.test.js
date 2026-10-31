import assert from "node:assert/strict";

process.env.JWT_SECRET = "a".repeat(40);
process.env.OAUTH_STATE_SECRET = "b".repeat(40);
process.env.DATABASE_URL = "";
process.env.CODEBOX_URL = "https://runner.invalid";
process.env.CODEBOX_TOKEN = "test-token";

const requests = [];
let tokenIndex = 0;
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  requests.push({ url, options });

  if (options.method === "POST") {
    const payload = JSON.parse(options.body);
    assert.ok(payload.submissions.length <= 20);
    return new Response(
      JSON.stringify(
        payload.submissions.map(() => ({ token: `token-${tokenIndex++}` })),
      ),
      { status: 201 },
    );
  }

  const tokens = url.searchParams.get("tokens").split(",");
  return new Response(
    JSON.stringify({
      submissions: tokens.map((token) => ({
        token,
        status: { id: 3 },
        stdout: ` result-${token} `,
        time: "0.01",
        memory: 120,
      })),
    }),
    { status: 200 },
  );
};

try {
  const { executeCodeBatch } =
    await import("../src/controllers/execution.controller.js");
  const testcases = Array.from({ length: 21 }, (_, index) => ({
    stdin: String(index),
  }));
  const results = await executeCodeBatch({
    language: "python",
    fullCode: "print(1)",
    testcases,
  });

  const postRequests = requests.filter(
    ({ options }) => options.method === "POST",
  );
  assert.deepEqual(
    postRequests.map(
      ({ options }) => JSON.parse(options.body).submissions.length,
    ),
    [20, 1],
  );
  assert.equal(results.length, 21);
  assert.equal(results[0].actual, "result-token-0");
  assert.equal(results[20].actual, "result-token-20");
  assert.ok(
    postRequests.every(
      ({ options }) => options.headers["X-Auth-Token"] === "test-token",
    ),
  );

  console.log("Execution batch tests passed.");
} finally {
  globalThis.fetch = originalFetch;
}
