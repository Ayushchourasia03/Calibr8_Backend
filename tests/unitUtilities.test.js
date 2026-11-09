import test from "node:test";
import assert from "node:assert/strict";

import { ApiError } from "../src/utils/ApiError.js";
import { normalizeOutput, areOutputsEqual } from "../src/utils/outputComparator.js";
import {
  normalizeLanguage,
  getUserTemplate,
  buildFinalCode,
  SUPPORTED_LANGUAGES,
} from "../src/utils/codeBuilder.js";
import { signToken, verifyToken, decodeToken } from "../src/utils/jwt.js";
import { hashPassword, comparePassword } from "../src/utils/bcrypt.js";
import { getUserHeaderStats } from "../src/utils/userHeaderStats.js";
import { getSuccessfulSubmissionActivity } from "../src/utils/successfulSubmissionActivity.js";

test("Unit Utilities: ApiError constructor and defaults", () => {
  const err400 = new ApiError(400, "Bad request message");
  assert.equal(err400.status, 400);
  assert.equal(err400.message, "Bad request message");
  assert.equal(err400.code, "BAD_REQUEST");
  assert.ok(err400 instanceof Error);

  const err401 = new ApiError(401, "Unauthorized");
  assert.equal(err401.code, "UNAUTHORIZED");

  const err403 = new ApiError(403, "Forbidden");
  assert.equal(err403.code, "FORBIDDEN");

  const err404 = new ApiError(404, "Not Found");
  assert.equal(err404.code, "NOT_FOUND");

  const err409 = new ApiError(409, "Conflict");
  assert.equal(err409.code, "CONFLICT");

  const err422 = new ApiError(422, "Validation failed", "CUSTOM_CODE", { field: "email" });
  assert.equal(err422.code, "CUSTOM_CODE");
  assert.deepEqual(err422.details, { field: "email" });

  const err500 = new ApiError(500, "Internal Server Error");
  assert.equal(err500.code, "INTERNAL_ERROR");

  const errUnknown = new ApiError(418, "I'm a teapot");
  assert.equal(errUnknown.code, "INTERNAL_ERROR");
});

test("Unit Utilities: outputComparator normalizeOutput and areOutputsEqual", () => {
  // normalizeOutput edge cases
  assert.equal(normalizeOutput(null), "");
  assert.equal(normalizeOutput(undefined), "");
  assert.equal(normalizeOutput("   "), "");

  // Numbers and booleans
  assert.equal(normalizeOutput(123), "123");
  assert.equal(normalizeOutput(true), "true");
  assert.equal(normalizeOutput("true"), "true");
  assert.equal(normalizeOutput("TRUE"), "true");
  assert.equal(normalizeOutput("yes"), "true");
  assert.equal(normalizeOutput("false"), "false");
  assert.equal(normalizeOutput("no"), "false");

  // Space-separated & Comma-separated numbers
  assert.equal(normalizeOutput("7 0 8"), JSON.stringify([7, 0, 8]));
  assert.equal(normalizeOutput("7, 0, 8"), JSON.stringify([7, 0, 8]));
  assert.equal(normalizeOutput("[7, 0, 8]"), JSON.stringify([7, 0, 8]));

  // areOutputsEqual comparisons
  assert.ok(areOutputsEqual("7 0 8\n", "7 0 8"));
  assert.ok(areOutputsEqual("7, 0, 8", "[7, 0, 8]"));
  assert.ok(areOutputsEqual("true", "True"));
  assert.ok(areOutputsEqual("YES", "true"));
  assert.ok(areOutputsEqual("no", "false"));
  assert.ok(areOutputsEqual("[42]", "42"));
  assert.ok(areOutputsEqual("42", "[42]"));
  assert.ok(areOutputsEqual("  hello world  \n", "hello world"));

  // Mismatches
  assert.equal(areOutputsEqual("1 2 3", "1 2 4"), false);
  assert.equal(areOutputsEqual("true", "false"), false);
  assert.equal(areOutputsEqual("apple", "orange"), false);
});

test("Unit Utilities: codeBuilder normalization and template generation", () => {
  // Normalization
  assert.equal(normalizeLanguage("python"), "python");
  assert.equal(normalizeLanguage("py"), "python");
  assert.equal(normalizeLanguage("python3"), "python");
  assert.equal(normalizeLanguage("javascript"), "javascript");
  assert.equal(normalizeLanguage("js"), "javascript");
  assert.equal(normalizeLanguage("nodejs"), "javascript");
  assert.equal(normalizeLanguage("cpp"), "cpp");
  assert.equal(normalizeLanguage("c++"), "cpp");
  assert.equal(normalizeLanguage("c"), "c");
  assert.equal(normalizeLanguage("java"), "java");
  assert.equal(normalizeLanguage("rust"), null);
  assert.equal(normalizeLanguage(null), null);

  // Template generation
  const mockProblem = {
    title: "Two Sum",
    difficulty: "Easy",
    templates: {
      python: {
        userTemplate: "def twoSum(nums, target):\n    pass\n",
        header: "# header\n",
        footer: "# footer\n",
      },
      cpp: {
        userTemplate: "vector<int> twoSum(vector<int>& nums, int target) {\n}\n",
        header: "#include <iostream>\n",
        footer: "int main() {}\n",
      },
    },
  };

  const pyTemplate = getUserTemplate(mockProblem, "python");
  assert.ok(pyTemplate.includes("def twoSum"));

  const unsupportedTemplate = getUserTemplate(mockProblem, "ruby");
  assert.equal(unsupportedTemplate, null);

  // Function-only validation: rejecting main()
  assert.throws(
    () => buildFinalCode(mockProblem, "int main() { return 0; }", "cpp"),
    (err) => err.status === 400 && err.code === "FUNCTION_ONLY_REQUIRED"
  );
  assert.throws(
    () => buildFinalCode(mockProblem, "def main(): pass", "python"),
    (err) => err.status === 400 && err.code === "FUNCTION_ONLY_REQUIRED"
  );

  // Successful build
  const fullPy = buildFinalCode(mockProblem, "return [0, 1]", "python");
  assert.ok(fullPy.includes("return [0, 1]"));
  assert.ok(fullPy.includes("# header"));
});

test("Unit Utilities: JWT token generation, verification, and decoding", () => {
  const payload = { userId: "user-123", email: "coder@calibr8.test" };
  const token = signToken(payload, "1h");
  assert.ok(typeof token === "string" && token.split(".").length === 3);

  const decoded = verifyToken(token);
  assert.equal(decoded.userId, "user-123");
  assert.equal(decoded.email, "coder@calibr8.test");
  assert.ok(decoded.jti);

  const parsed = decodeToken(token);
  assert.equal(parsed.userId, "user-123");

  assert.throws(() => verifyToken("invalid.token.signature"), (err) => err instanceof Error);
});

test("Unit Utilities: bcrypt hashing and password verification", async () => {
  const plain = "SuperSecretPassword123!";
  const hash = await hashPassword(plain);

  assert.ok(typeof hash === "string");
  assert.notEqual(hash, plain);

  const match = await comparePassword(plain, hash);
  assert.equal(match, true);

  const wrongMatch = await comparePassword("WrongPassword123!", hash);
  assert.equal(wrongMatch, false);
});

test("Unit Utilities: userHeaderStats tier and division calculation", () => {
  // Default values
  const defaultStats = getUserHeaderStats({});
  assert.equal(defaultStats.rating, 800);
  assert.equal(defaultStats.tier, "Pulse II");
  assert.equal(defaultStats.coins, 100);
  assert.equal(defaultStats.streak, 0);

  // Tier boundaries
  // 700-899: Pulse (I: 700-766, II: 767-833, III: 834-899)
  const pulse1 = getUserHeaderStats({ rating: 720 });
  assert.equal(pulse1.tier, "Pulse I");

  const pulse3 = getUserHeaderStats({ rating: 880 });
  assert.equal(pulse3.tier, "Pulse III");

  // 900-1099: Flux
  const flux1 = getUserHeaderStats({ rating: 910 });
  assert.equal(flux1.tier, "Flux I");

  // 1100-1299: Prism
  const prism1 = getUserHeaderStats({ rating: 1150 });
  assert.equal(prism1.tier, "Prism I");

  // 1300-1499: Aurora
  const aurora1 = getUserHeaderStats({ rating: 1350 });
  assert.equal(aurora1.tier, "Aurora I");

  // 1500-1699: Eclipse
  const eclipse1 = getUserHeaderStats({ rating: 1550 });
  assert.equal(eclipse1.tier, "Eclipse I");

  // >=1700: Zenith
  const zenith = getUserHeaderStats({ rating: 1800 });
  assert.equal(zenith.tier.startsWith("Zenith"), true);

  // Score division
  const scoreStats = getUserHeaderStats({ score: 255 });
  assert.equal(scoreStats.score, 25);
  assert.equal(scoreStats.scoreUnits, 255);
});

test("Unit Utilities: successfulSubmissionActivity aggregation", () => {
  const submissions = [
    { status: "ACCEPTED", totalCount: 5, passedCount: 5, createdAt: "2026-11-08T10:00:00Z" },
    { status: "ACCEPTED", totalCount: 3, passedCount: 3, createdAt: "2026-11-08T14:30:00Z" },
    { status: "WRONG_ANSWER", totalCount: 5, passedCount: 4, createdAt: "2026-11-08T15:00:00Z" },
    { status: "ACCEPTED", totalCount: 4, passedCount: 3, createdAt: "2026-11-09T08:00:00Z" }, // partially passed
    { status: "ACCEPTED", totalCount: 2, passedCount: 2, createdAt: "2026-11-09T09:00:00Z" },
    { status: "ACCEPTED", totalCount: 0, passedCount: 0, createdAt: "2026-11-09T10:00:00Z" }, // 0 testcases
    { status: "ACCEPTED", totalCount: 1, passedCount: 1, createdAt: "invalid-date" },
  ];

  const activity = getSuccessfulSubmissionActivity(submissions);
  assert.equal(activity["2026-11-08"], 2);
  assert.equal(activity["2026-11-09"], 1);
  assert.equal(activity["invalid-date"], undefined);
});
