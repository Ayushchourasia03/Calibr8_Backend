import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.FRONTEND_URL = "http://localhost:5173";

const { default: app } = await import("../src/app.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  for (const origin of [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ]) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.match(
      response.headers.get("access-control-allow-methods") || "",
      /\bPOST\b/,
    );
  }

  const rejectedOriginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://example.invalid",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(
    rejectedOriginResponse.headers.get("access-control-allow-origin"),
    null,
  );
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
