
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
        payload.submissions.map(() => ({
          token: `token-${tokenIndex++}`,
        })),
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
        stdout: `result-${token}`,
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

  const testcases = Array.from({ length: 50 }, (_, index) => ({
    stdin: String(index + 1),
  }));

  const results = await executeCodeBatch({
    language: "python",
    fullCode: "print(1)",
    testcases,
  });

  const postRequests = requests.filter(
    ({ options }) => options.method === "POST",
  );

  const batchSizes = postRequests.map(
    ({ options }) => JSON.parse(options.body).submissions.length,
  );

  assert.deepEqual(batchSizes, [20, 20, 10]);

  assert.equal(results.length, 50);

  assert.equal(results[0].actual, "result-token-0");
  assert.equal(results[19].actual, "result-token-19");
  assert.equal(results[20].actual, "result-token-20");
  assert.equal(results[39].actual, "result-token-39");
  assert.equal(results[40].actual, "result-token-40");
  assert.equal(results[49].actual, "result-token-49");

  assert.ok(
    postRequests.every(
      ({ options }) =>
        options.headers["X-Auth-Token"] === "test-token",
    ),
  );

  console.log("Execution batch tests passed.");
  console.log("Total test cases: 50");
  console.log("Batch requests: 3");
  console.log("Batch distribution:", batchSizes.join(" + "));
  console.log("Results collected: 50/50");
} finally {
  globalThis.fetch = originalFetch;
}
