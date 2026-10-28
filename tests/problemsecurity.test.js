import assert from "node:assert";
import app from "../src/app.js";

async function runTests() {
  console.log("Starting Calibr8 Execution & Function-Only Pipeline Tests...");
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // 1. Function-only enforcement: submitting main() should fail
    const forbiddenMainRes = await fetch(`${baseUrl}/api/execution/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "add-two-numbers",
        language: "cpp",
        code: "int main() { return 0; }"
      })
    });
    assert.strictEqual(forbiddenMainRes.status, 400, "Should reject main() submission");
    const forbiddenData = await forbiddenMainRes.json();
    assert.strictEqual(forbiddenData.code, "FUNCTION_ONLY_REQUIRED");
    console.log("✔ main() injection blocked with FUNCTION_ONLY_REQUIRED");

    // 2. Unsupported language rejected
    const unsupportedLangRes = await fetch(`${baseUrl}/api/execution/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "add-two-numbers",
        language: "ruby",
        code: "def solve; end"
      })
    });
    assert.strictEqual(unsupportedLangRes.status, 422, "Should reject unsupported language");
    console.log("✔ Unsupported language rejected with HTTP 422");

    // 3. Add Two Numbers in C++ (Run Visible Cases)
    const cppCode = `ListNode* addTwoNumbers(ListNode* l1, ListNode* l2) {
      ListNode dummy(0);
      ListNode* tail = &dummy;
      int carry = 0;
      while (l1 || l2 || carry) {
        int sum = carry;
        if (l1) { sum += l1->val; l1 = l1->next; }
        if (l2) { sum += l2->val; l2 = l2->next; }
        carry = sum / 10;
        tail->next = new ListNode(sum % 10);
        tail = tail->next;
      }
      return dummy.next;
    }`;

    const runCppRes = await fetch(`${baseUrl}/api/execution/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "add-two-numbers",
        language: "cpp",
        code: cppCode
      })
    });
    assert.strictEqual(runCppRes.status, 200);
    const runCppData = await runCppRes.json();
    assert.strictEqual(runCppData.status, "Accepted");
    assert.strictEqual(runCppData.passedCount, runCppData.totalCount);
    console.log(`✔ Add Two Numbers (C++) Run: ${runCppData.passedCount}/${runCppData.totalCount} passed`);

    // 4. Add Two Numbers in Python
    const pyCode = `class Solution:
    def addTwoNumbers(self, l1, l2):
        dummy = ListNode(0)
        curr = dummy
        carry = 0
        while l1 or l2 or carry:
            v1 = l1.val if l1 else 0
            v2 = l2.val if l2 else 0
            total = v1 + v2 + carry
            carry = total // 10
            curr.next = ListNode(total % 10)
            curr = curr.next
            l1 = l1.next if l1 else None
            l2 = l2.next if l2 else None
        return dummy.next
`;
    const runPyRes = await fetch(`${baseUrl}/api/execution/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "add-two-numbers",
        language: "python",
        code: pyCode
      })
    });
    assert.strictEqual(runPyRes.status, 200);
    const runPyData = await runPyRes.json();
    assert.strictEqual(runPyData.status, "Accepted");
    console.log(`✔ Add Two Numbers (Python) Run: ${runPyData.passedCount}/${runPyData.totalCount} passed`);

    // 5. C++ Compilation Error Diagnostics
    const syntaxErrRes = await fetch(`${baseUrl}/api/execution/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "add-two-numbers",
        language: "cpp",
        code: "ListNode* addTwoNumbers() { undeclared_variable = 1; return nullptr; }"
      })
    });
    const syntaxErrData = await syntaxErrRes.json();
    assert.strictEqual(syntaxErrData.cases[0].status, "Compilation Error");
    assert.ok(syntaxErrData.cases[0].errorText.includes("undeclared_variable"));
    console.log("✔ Compiler diagnostics captured and returned correctly for C++ syntax error");

    console.log("\nALL EXECUTION & REGRESSION TESTS PASSED! 🎉");
  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
