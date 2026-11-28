// SA-M2 follow-up: a password worker that keeps crashing must not make every
// login fail forever. No database, no network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

const { __setPasswordWorkerUrlForTests, passwordPoolStats, closePasswordPool } = await import("../src/services/passwordPool.js");
const { comparePassword } = await import("../src/utils/bcrypt.js");

after(() => closePasswordPool());

test("SA-M2: crashing password workers trip the breaker and hashing falls back to in-thread", async () => {
  __setPasswordWorkerUrlForTests(new URL("data:text/javascript,throw new Error('worker boom')"));
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  const hash = bcrypt.hashSync("pw-123456", 4);
  let result = null;
  try {
    for (let attempt = 0; attempt < 20 && result === null; attempt++) {
      try {
        result = await comparePassword("pw-123456", hash);
      } catch (err) {
        assert.equal(err.code, "AUTH_BUSY", "jobs lost to a crash fail as 503, never with a raw error");
      }
    }
  } finally {
    console.error = originalError;
  }
  assert.equal(result, true, "logins work again after the breaker trips");
  assert.equal(passwordPoolStats().workersUnavailable, true);
  assert.ok(errors.some((line) => line.includes("hashing in-thread")), "the fallback is logged");
  assert.equal(await comparePassword("wrong", hash), false, "in-thread verification is still correct");
});
