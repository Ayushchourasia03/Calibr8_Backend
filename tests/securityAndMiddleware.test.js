import assert from "node:assert/strict";
import { createRateLimiter, inFlightLimiter } from "../src/middlewares/rateLimit.middleware.js";
import { errorHandler } from "../src/middlewares/error.middleware.js";
import { ApiError } from "../src/utils/ApiError.js";

process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "test-jwt-secret-key-that-is-at-least-32-chars-long";

const { default: app } = await import("../src/app.js");

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  console.log("=== Running Security & Middleware Test Suite ===");

  // 1. Health & Utility Endpoints
  const pingRes = await fetch(`${baseUrl}/ping`);
  assert.equal(pingRes.status, 200);
  assert.equal(await pingRes.text(), "pong");

  const apiPingRes = await fetch(`${baseUrl}/api/ping`);
  assert.equal(apiPingRes.status, 200);
  assert.equal(await apiPingRes.text(), "pong");

  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  const healthData = await healthRes.json();
  assert.equal(healthData.status, "ok");
  assert.equal(healthData.service, "Calibr8 Backend");

  const apiHealthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(apiHealthRes.status, 200);
  assert.equal((await apiHealthRes.json()).status, "ok");

  // Root docs endpoint
  const rootJsonRes = await fetch(`${baseUrl}/`, {
    headers: { Accept: "application/json" },
  });
  assert.equal(rootJsonRes.status, 200);
  const rootData = await rootJsonRes.json();
  assert.equal(rootData.service, "Calibr8 Backend API");
  assert.ok(rootData.endpoints);

  // 2. Security Headers (CSP, nosniff, Referrer-Policy)
  assert.ok(pingRes.headers.get("content-security-policy"));
  assert.equal(pingRes.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    pingRes.headers.get("referrer-policy"),
    "strict-origin-when-cross-origin",
  );

  // 3. Unmapped / 404 Route handling
  const notFoundRes = await fetch(`${baseUrl}/api/non-existent-route-404`);
  assert.equal(notFoundRes.status, 404);

  // 4. Rate Limiter Unit Tests
  const limiter = createRateLimiter({
    windowMs: 1000,
    max: 3,
    keyGenerator: () => "test-client",
  });

  const mockReq = { ip: "127.0.0.1" };
  const mockHeaders = {};
  const mockRes = {
    setHeader: (k, v) => { mockHeaders[k] = v; },
  };

  let nextCalledCount = 0;
  let rateLimitErr = null;
  const mockNext = (err) => {
    if (err) rateLimitErr = err;
    else nextCalledCount++;
  };

  // Call 3 times within limit
  limiter(mockReq, mockRes, mockNext);
  assert.equal(mockHeaders["X-RateLimit-Remaining"], 2);
  limiter(mockReq, mockRes, mockNext);
  assert.equal(mockHeaders["X-RateLimit-Remaining"], 1);
  limiter(mockReq, mockRes, mockNext);
  assert.equal(mockHeaders["X-RateLimit-Remaining"], 0);
  assert.equal(nextCalledCount, 3);

  // 4th call should trigger rate limit error
  limiter(mockReq, mockRes, mockNext);
  assert.ok(rateLimitErr instanceof ApiError);
  assert.equal(rateLimitErr.status, 429);
  assert.equal(rateLimitErr.code, "RATE_LIMITED");

  // 5. In-flight execution limiter unit test (max 2 concurrent)
  const listeners = [];
  const reqA = { user: { id: "user-flight-test" } };
  const resA = {
    once: (event, cb) => { listeners.push(cb); },
  };

  let inFlightA = null;
  inFlightLimiter(reqA, resA, (err) => { inFlightA = err; });
  assert.equal(inFlightA, undefined, "1st in-flight job should be accepted");

  let inFlightB = null;
  inFlightLimiter(reqA, resA, (err) => { inFlightB = err; });
  assert.equal(inFlightB, undefined, "2nd in-flight job should be accepted");

  let inFlightC = null;
  inFlightLimiter(reqA, resA, (err) => { inFlightC = err; });
  assert.ok(inFlightC instanceof ApiError, "3rd in-flight job should be rejected");
  assert.equal(inFlightC.status, 429);

  // Release slots
  for (const cb of listeners) cb();

  // 6. Global error middleware unit tests
  let errStatus = null;
  let errJson = null;
  const errRes = {
    status: (s) => { errStatus = s; return { json: (j) => { errJson = j; } }; },
  };

  // 6a. ApiError with details
  const apiErr = new ApiError(403, "Forbidden action", "FORBIDDEN", { field: "role" });
  errorHandler(apiErr, { method: "POST", path: "/test" }, errRes, () => {});
  assert.equal(errStatus, 403);
  assert.deepEqual(errJson, {
    success: false,
    code: "FORBIDDEN",
    message: "Forbidden action",
    details: { field: "role" },
  });

  // 6b. Prisma unique constraint violation (P2002)
  const p2002Err = new Error("Unique constraint failed");
  p2002Err.code = "P2002";
  p2002Err.meta = { target: ["email"] };
  errorHandler(p2002Err, { method: "POST", path: "/test" }, errRes, () => {});
  assert.equal(errStatus, 409);
  assert.equal(errJson.code, "CONFLICT");

  // 6c. Generic error handling (no stack leaks)
  const genericErr = new Error("Unexpected crash");
  errorHandler(genericErr, { method: "GET", path: "/test" }, errRes, () => {});
  assert.equal(errStatus, 500);
  assert.equal(errJson.message, "Internal server error.");
  assert.equal("stack" in errJson, false, "Stack trace must never be leaked");

  console.log("✔ Security & Middleware tests passed successfully!");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
