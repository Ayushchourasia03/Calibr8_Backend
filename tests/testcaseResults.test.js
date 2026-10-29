import assert from "node:assert/strict";
import { publicTestResults } from "../src/utils/testcaseResults.js";

const results = publicTestResults([
  {
    testIndex: 0,
    isVisible: true,
    passed: true,
    status: "Accepted",
    input: "visible input",
    expected: "visible output",
    actual: "visible output",
  },
  {
    testIndex: 1,
    isVisible: false,
    passed: false,
    status: "Wrong Answer",
    input: "secret input",
    expected: "secret expected",
    actual: "secret actual",
    errorText: "secret diagnostics",
  },
]);

assert.deepEqual(results[0], {
  testIndex: 0,
  isVisible: true,
  passed: true,
  status: "Accepted",
  input: "visible input",
  expected: "visible output",
  actual: "visible output",
});
assert.equal(results[1].testIndex, 1);
assert.equal(results[1].isVisible, false);
assert.equal(results[1].passed, false);
assert.equal(results[1].status, "Wrong Answer");
assert.equal("input" in results[1], false);
assert.equal("expected" in results[1], false);
assert.equal("actual" in results[1], false);
assert.equal("errorText" in results[1], false);

console.log("Testcase result visibility tests passed.");
