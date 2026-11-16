import "dotenv/config";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "a".repeat(40);
process.env.OAUTH_STATE_SECRET = "b".repeat(40);
process.env.CODEBOX_URL = "https://runner.invalid";
process.env.CODEBOX_TOKEN = "test-token";
process.env.CODEBOX_BATCH_EXECUTION_ENABLED = "true";

const requests = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  requests.push({ url, options });

  if (url.pathname === "/batches" && options.method === "POST") {
    const payload = JSON.parse(options.body);
    assert.equal(payload.language_id, 54);
    assert.equal(Array.isArray(payload.testcases), true);
    assert.equal(payload.testcases.length, 2);
    return new Response(
      JSON.stringify({
        success: true,
        batchId: "batch-123",
        status: "queued",
      }),
      { status: 200 },
    );
  }

  if (
    url.pathname === "/batches" &&
    (!options.method || options.method === "GET")
  ) {
    const batchId =
      url.searchParams.get("batchId") || url.searchParams.get("id");
    assert.equal(batchId, "batch-123");
    return new Response(
      JSON.stringify({
        success: true,
        batchId: "batch-123",
        status: "completed",
        compiled: true,
        results: [
          {
            index: 0,
            status: "completed",
            stdout: "2\n",
            stderr: "",
            exitCode: 0,
            timeMs: 12,
            memory: 4096,
          },
          {
            index: 1,
            status: "completed",
            stdout: "4\n",
            stderr: "",
            exitCode: 0,
            timeMs: 10,
            memory: 2048,
          },
        ],
      }),
      { status: 200 },
    );
  }

  throw new Error(`Unexpected fetch ${url.toString()}`);
};

try {
  const { executeCodeBatch } =
    await import("../src/controllers/execution.controller.js");

  const results = await executeCodeBatch({
    language: "cpp",
    fullCode:
      "#include <iostream>\nint main(){int a,b; std::cin>>a>>b; std::cout<<a+b;}",
    testcases: [{ stdin: "1 1\n" }, { stdin: "2 2\n" }],
    timeLimit: 2000,
    memoryLimit: 256,
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].actual, "2");
  assert.equal(results[1].actual, "4");
  assert.equal(results[0].status, "OK");
  assert.equal(results[1].status, "OK");
  assert.equal(
    requests.filter(
      ({ url, options }) =>
        url.pathname === "/batches" && options.method === "POST",
    ).length,
    1,
  );

  console.log("CodeBox batch execution tests passed.");
} finally {
  globalThis.fetch = originalFetch;
}
