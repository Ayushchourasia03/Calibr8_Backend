import assert from "node:assert";

process.env.CODEBOX_URL = "https://codebox.internal";
process.env.CODEBOX_TOKEN = "test-token";

let lastSubmittedSubmissions = [];
const originalFetch = globalThis.fetch;

// Intercept fetch calls to CodeBox VPS Judge0 endpoint
globalThis.fetch = async (input, options = {}) => {
  const urlStr = typeof input === "string" ? input : input.toString();

  if (urlStr.startsWith("https://codebox.internal")) {
    const url = new URL(urlStr);

    if (options.method === "POST") {
      const payload = JSON.parse(options.body || "{}");
      lastSubmittedSubmissions = payload.submissions || [];

      // Verify batch constraint: never exceeds 20 testcases
      assert.ok(lastSubmittedSubmissions.length <= 20, "Batch size must not exceed 20");
      assert.strictEqual(options.headers["X-Auth-Token"], "test-token", "Must pass auth token");

      return new Response(
        JSON.stringify(
          lastSubmittedSubmissions.map((_, idx) => ({
            token: `token-${idx}-${Date.now()}`,
          })),
        ),
        { status: 201 },
      );
    }

    // GET /submissions/batch?tokens=...
    const tokens = (url.searchParams.get("tokens") || "").split(",");

    return new Response(
      JSON.stringify({
        submissions: tokens.map((token, idx) => {
          const sub = lastSubmittedSubmissions[idx] || {};
          const source = sub.source_code || "";
          const stdin = sub.stdin || "";

          // Simulate C++ compilation error diagnostic
          if (source.includes("undeclared_variable")) {
            return {
              token,
              status: { id: 6 }, // Compilation Error
              compile_output: "error: 'undeclared_variable' was not declared in this scope",
              stdout: "",
              time: "0.00",
              memory: 0,
            };
          }

          // Return expected output based on testcase stdin for add-two-numbers
          let stdout = "7 0 8";
          if (stdin.includes("1 1\n0\n0") || stdin.startsWith("1 1")) {
            stdout = "0";
          } else if (stdin.includes("9 9 9 9 9 9 9")) {
            stdout = "8 9 9 9 0 0 0 1";
          } else if (stdin.includes("5 5\n5 5")) {
            stdout = "0 1 1";
          } else if (stdin.includes("1 2 3\n9")) {
            stdout = "0 3 3";
          }

          return {
            token,
            status: { id: 3 }, // Accepted
            stdout,
            time: "0.02",
            memory: 1420,
          };
        }),
      }),
      { status: 200 },
    );
  }

  return originalFetch(input, options);
};

const app = (await import("../src/app.js")).default;

async function runTests() {
  console.log("Starting Calibr8 Execution & Function-Only Pipeline Tests (CodeBox Exclusive)...");
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // 1. Function-only enforcement: submitting main() should fail
    const forbiddenMainRes = await fetch(`${baseUrl}/api/problems/add-two-numbers/run`, {
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
    const unsupportedLangRes = await fetch(`${baseUrl}/api/problems/add-two-numbers/run`, {
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

    // 3. Add Two Numbers in C++ (Run Visible Cases via CodeBox)
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

    const runCppRes = await fetch(`${baseUrl}/api/problems/add-two-numbers/run`, {
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
    assert.ok(runCppData.complexity, "Complexity analysis should be attached");
    assert.strictEqual(runCppData.complexity.time.bestEstimate, "O(max(n, m))");
    assert.strictEqual(runCppData.complexity.space.bestEstimate, "O(1)");
    console.log(`✔ Add Two Numbers (C++) Run via CodeBox: ${runCppData.passedCount}/${runCppData.totalCount} passed`);

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
    const runPyRes = await fetch(`${baseUrl}/api/problems/add-two-numbers/run`, {
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
    console.log(`✔ Add Two Numbers (Python) Run via CodeBox: ${runPyData.passedCount}/${runPyData.totalCount} passed`);

    // 5. C++ Compilation Error Diagnostics
    const syntaxErrRes = await fetch(`${baseUrl}/api/problems/add-two-numbers/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "add-two-numbers",
        language: "cpp",
        code: "ListNode* addTwoNumbers() { undeclared_variable = 1; return nullptr; }"
      })
    });
    const syntaxErrData = await syntaxErrRes.json();
    const firstCase = (syntaxErrData.results || syntaxErrData.cases)[0];
    assert.strictEqual(firstCase.status, "Compilation Error");
    assert.ok(firstCase.errorText.includes("undeclared_variable"));
    console.log("✔ Compiler diagnostics captured and returned correctly for C++ syntax error");

    // 6. Objective A Verification: When CodeBox is unavailable (unset URL), fails with 503 EXECUTION_UNAVAILABLE
    const savedUrl = process.env.CODEBOX_URL;
    try {
      delete process.env.CODEBOX_URL;
      const unavailRes = await fetch(`${baseUrl}/api/problems/add-two-numbers/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "add-two-numbers",
          language: "cpp",
          code: cppCode
        })
      });
      assert.strictEqual(unavailRes.status, 503, "Should return 503 when CodeBox is unavailable");
      const unavailData = await unavailRes.json();
      assert.strictEqual(unavailData.code, "EXECUTION_UNAVAILABLE");
      console.log("✔ CodeBox unavailable produces controlled 503 EXECUTION_UNAVAILABLE without local fallback");
    } finally {
      process.env.CODEBOX_URL = savedUrl;
    }

    console.log("\nALL EXECUTION & REGRESSION TESTS PASSED! 🎉");
  } finally {
    server.close();
    globalThis.fetch = originalFetch;
  }
}

runTests().catch(err => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
