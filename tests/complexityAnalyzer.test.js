import assert from "node:assert/strict";
import { analyzeComplexity } from "../src/services/complexityAnalyzer.service.js";

async function runTests() {
  console.log("Starting Calibr8 High-Accuracy Complexity Analyzer v2.0.0 Tests...");

  // 1. Critical Regression: C++ addTwoNumbers()
  const cppAddTwoNumbers = `
    ListNode* addTwoNumbers(ListNode* l1, ListNode* l2) {
      ListNode dummy(0);
      ListNode* curr = &dummy;
      int carry = 0;

      while (l1 || l2 || carry) {
        int sum = carry;

        if (l1) {
          sum += l1->val;
          l1 = l1->next;
        }

        if (l2) {
          sum += l2->val;
          l2 = l2->next;
        }

        carry = sum / 10;

        curr->next = new ListNode(sum % 10);
        curr = curr->next;
      }

      return dummy.next;
    }
  `;
  const resCppAdd = await analyzeComplexity({ code: cppAddTwoNumbers, language: "cpp" });
  assert.equal(resCppAdd.time.bestEstimate, "O(max(n, m))", "addTwoNumbers C++ time should be O(max(n, m))");
  assert.equal(resCppAdd.space.bestEstimate, "O(1)", "addTwoNumbers C++ auxiliary space should be O(1)");
  assert.equal(resCppAdd.space.output, "O(max(n, m))", "addTwoNumbers C++ output space should be O(max(n, m))");
  assert.equal(resCppAdd.space.total, "O(max(n, m))", "addTwoNumbers C++ total space should be O(max(n, m))");
  assert.equal(resCppAdd.time.confidence, "high");
  console.log("✔ Critical Regression: C++ addTwoNumbers classified as Time: O(max(n, m)), Aux: O(1), Output: O(max(n, m)), Total: O(max(n, m))");

  // 2. Critical Regression: Python addTwoNumbers()
  const pyAddTwoNumbers = `
class Solution:
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
  const resPyAdd = await analyzeComplexity({ code: pyAddTwoNumbers, language: "python" });
  assert.equal(resPyAdd.time.bestEstimate, "O(max(n, m))", "addTwoNumbers Python time should be O(max(n, m))");
  assert.equal(resPyAdd.space.bestEstimate, "O(1)", "addTwoNumbers Python auxiliary space should be O(1)");
  assert.equal(resPyAdd.space.output, "O(max(n, m))", "addTwoNumbers Python output space should be O(max(n, m))");
  assert.equal(resPyAdd.space.total, "O(max(n, m))", "addTwoNumbers Python total space should be O(max(n, m))");
  console.log("✔ Critical Regression: Python addTwoNumbers classified as Time: O(max(n, m)), Aux: O(1), Output: O(max(n, m))");

  // 3. Branching Regression: Multiple independent if statements (not exponential!)
  const branchingCode = `
    function processConditions(a, b, c, d) {
      let count = 0;
      if (a > 0) count++;
      if (b > 0) count++;
      if (c > 0) count++;
      if (d > 0) count++;
      return count;
    }
  `;
  const resBranch = await analyzeComplexity({ code: branchingCode, language: "javascript" });
  assert.equal(resBranch.time.bestEstimate, "O(1)", "Independent sequential ifs must be O(1)");
  assert.equal(resBranch.space.bestEstimate, "O(1)");
  console.log("✔ Branching Regression: 4 independent if-statements classified as O(1) time (not 2^4)");

  // 4. Single traversal O(n) & O(1) aux
  const singleLoopCode = `
    int sumArray(vector<int>& arr) {
      int s = 0;
      for (int i = 0; i < arr.size(); i++) {
        s += arr[i];
      }
      return s;
    }
  `;
  const resSingle = await analyzeComplexity({ code: singleLoopCode, language: "cpp" });
  assert.equal(resSingle.time.bestEstimate, "O(n)");
  assert.equal(resSingle.space.bestEstimate, "O(1)");
  console.log("✔ Single traversal: O(n) time, O(1) auxiliary space");

  // 5. Two sequential loops O(n) & O(1) aux
  const seqLoopsCode = `
    def twoPasses(arr):
      total = 0
      for x in arr:
        total += x
      max_val = 0
      for x in arr:
        if x > max_val:
          max_val = x
      return total + max_val
  `;
  const resSeq = await analyzeComplexity({ code: seqLoopsCode, language: "python" });
  assert.equal(resSeq.time.bestEstimate, "O(n)");
  assert.equal(resSeq.space.bestEstimate, "O(1)");
  console.log("✔ Two sequential loops: O(n) time, O(1) auxiliary space");

  // 6. Nested loops O(n^2) & O(1) aux
  const nestedLoopsCode = `
    void printPairs(vector<int>& nums) {
      int n = nums.size();
      for (int i = 0; i < n; i++) {
        for (int j = 0; j < n; j++) {
          cout << nums[i] << nums[j];
        }
      }
    }
  `;
  const resNested = await analyzeComplexity({ code: nestedLoopsCode, language: "cpp" });
  assert.equal(resNested.time.bestEstimate, "O(n^2)");
  assert.equal(resNested.space.bestEstimate, "O(1)");
  console.log("✔ Nested loops: O(n^2) time, O(1) auxiliary space");

  // 7. Nested independent dimensions n and m: O(n × m)
  const nestedNMCode = `
    int countGrid(int n, int m) {
      int count = 0;
      for (int i = 0; i < n; i++) {
        for (int j = 0; j < m; j++) {
          count++;
        }
      }
      return count;
    }
  `;
  const resNM = await analyzeComplexity({ code: nestedNMCode, language: "cpp" });
  assert.equal(resNM.time.bestEstimate, "O(n × m)");
  assert.equal(resNM.space.bestEstimate, "O(1)");
  console.log("✔ Nested independent dimensions: O(n × m) time, O(1) auxiliary space");

  // 8. Binary search O(log n) & O(1) aux
  const binarySearchCode = `
    int binarySearch(vector<int>& arr, int target) {
      int l = 0, r = arr.size() - 1;
      while (l <= r) {
        int mid = l + (r - l) / 2;
        if (arr[mid] == target) return mid;
        if (arr[mid] < target) l = mid + 1;
        else r = mid - 1;
      }
      return -1;
    }
  `;
  const resBs = await analyzeComplexity({ code: binarySearchCode, language: "cpp" });
  assert.equal(resBs.time.bestEstimate, "O(log n)");
  assert.equal(resBs.space.bestEstimate, "O(1)");
  console.log("✔ Binary search: O(log n) time, O(1) auxiliary space");

  // 9. Sorting O(n log n)
  const sortCode = `
    function sortList(items) {
      items.sort((a, b) => a - b);
      return items;
    }
  `;
  const resSort = await analyzeComplexity({ code: sortCode, language: "javascript" });
  assert.equal(resSort.time.bestEstimate, "O(n log n)");
  console.log("✔ Sorting: O(n log n) time");

  // 10. Hash map Two Sum: O(n) time & O(n) auxiliary space
  const twoSumCode = `
    class Solution {
      twoSum(nums, target) {
        const seen = new Map();
        for (let i = 0; i < nums.length; i++) {
          const diff = target - nums[i];
          if (seen.has(diff)) return [seen.get(diff), i];
          seen.set(nums[i], i);
        }
        return [];
      }
    }
  `;
  const resTwoSum = await analyzeComplexity({ code: twoSumCode, language: "javascript" });
  assert.equal(resTwoSum.time.bestEstimate, "O(n)");
  assert.equal(resTwoSum.space.bestEstimate, "O(n)");
  assert.equal(resTwoSum.space.auxiliary, "O(n)");
  console.log("✔ Hash map Two Sum: O(n) time, O(n) auxiliary space");

  // 11. Recursive Factorial: O(n) time & O(n) auxiliary space
  const factCode = `
    int factorial(int n) {
      if (n <= 1) return 1;
      return n * factorial(n - 1);
    }
  `;
  const resFact = await analyzeComplexity({ code: factCode, language: "cpp" });
  assert.equal(resFact.time.bestEstimate, "O(n)");
  assert.equal(resFact.space.bestEstimate, "O(n)");
  console.log("✔ Recursive factorial: O(n) time, O(n) auxiliary call stack space");

  // 12. Naive branching Fibonacci: O(2^n) time & O(n) aux call stack space
  const naiveFibCode = `
    int fib(int n) {
      if (n <= 1) return n;
      return fib(n - 1) + fib(n - 2);
    }
  `;
  const resFib = await analyzeComplexity({ code: naiveFibCode, language: "cpp" });
  assert.equal(resFib.time.bestEstimate, "O(2^n)");
  assert.equal(resFib.space.bestEstimate, "O(n)");
  console.log("✔ Naive Fibonacci: O(2^n) time, O(n) auxiliary call stack space");

  // 13. Memoized Fibonacci: O(n) time & O(n) auxiliary space
  const memoFibCode = `
    int fib(int n, vector<int>& memo) {
      if (n <= 1) return n;
      if (memo[n] != -1) return memo[n];
      return memo[n] = fib(n - 1, memo) + fib(n - 2, memo);
    }
  `;
  const resMemoFib = await analyzeComplexity({ code: memoFibCode, language: "cpp" });
  assert.equal(resMemoFib.time.bestEstimate, "O(n)");
  assert.equal(resMemoFib.space.bestEstimate, "O(n)");
  console.log("✔ Memoized Fibonacci: O(n) time, O(n) auxiliary space");

  // 14. Merge sort: O(n log n) time & O(n) auxiliary space
  const mergeSortCode = `
    void merge(vector<int>& arr, int l, int m, int r);
    void mergeSort(vector<int>& arr, int l, int r) {
      if (l >= r) return;
      int m = l + (r - l) / 2;
      mergeSort(arr, l, m);
      mergeSort(arr, m + 1, r);
      merge(arr, l, m, r);
    }
  `;
  const resMergeSort = await analyzeComplexity({ code: mergeSortCode, language: "cpp" });
  assert.equal(resMergeSort.time.bestEstimate, "O(n log n)");
  assert.equal(resMergeSort.space.bestEstimate, "O(n)");
  console.log("✔ Merge sort: O(n log n) time, O(n) auxiliary space");

  // 15. BFS: O(V + E) time & O(V) auxiliary space
  const bfsCode = `
    void bfs(int start, vector<vector<int>>& adj) {
      vector<bool> visited(adj.size(), false);
      queue<int> q;
      q.push(start);
      visited[start] = true;
      while (!q.empty()) {
        int u = q.front(); q.pop();
        for (int v : adj[u]) {
          if (!visited[v]) {
            visited[v] = true;
            q.push(v);
          }
        }
      }
    }
  `;
  const resBfs = await analyzeComplexity({ code: bfsCode, language: "cpp" });
  assert.equal(resBfs.time.bestEstimate, "O(V + E)");
  assert.equal(resBfs.space.bestEstimate, "O(V)");
  console.log("✔ BFS Graph Traversal: O(V + E) time, O(V) auxiliary space");

  // 16. DFS: O(V + E) time & O(V) auxiliary space
  const dfsCode = `
    void dfs(int u, vector<vector<int>>& graph, vector<bool>& visited) {
      visited[u] = true;
      for (int v : graph[u]) {
        if (!visited[v]) {
          dfs(v, graph, visited);
        }
      }
    }
  `;
  const resDfs = await analyzeComplexity({ code: dfsCode, language: "cpp" });
  assert.equal(resDfs.time.bestEstimate, "O(V + E)");
  assert.equal(resDfs.space.bestEstimate, "O(V)");
  console.log("✔ DFS Graph Traversal: O(V + E) time, O(V) auxiliary space");

  // 17. Backtracking subsets: O(2^n) time
  const subsetsCode = `
    void generateSubsets(int idx, vector<int>& nums, vector<int>& curr, vector<vector<int>>& res) {
      res.push_back(curr);
      for (int i = idx; i < nums.size(); i++) {
        curr.push_back(nums[i]);
        generateSubsets(i + 1, nums, curr, res);
        curr.pop_back();
      }
    }
  `;
  const resSubsets = await analyzeComplexity({ code: subsetsCode, language: "cpp" });
  assert.equal(resSubsets.time.bestEstimate, "O(2^n)");
  console.log("✔ Backtracking subsets: O(2^n) time");

  // 18. Constant time O(1) & space O(1)
  const o1Code = `
    function add(a, b) {
      return a + b;
    }
  `;
  const resO1 = await analyzeComplexity({ code: o1Code, language: "javascript" });
  assert.equal(resO1.time.bestEstimate, "O(1)");
  assert.equal(resO1.space.bestEstimate, "O(1)");
  console.log("✔ Constant time: O(1) time, O(1) auxiliary space");

  // 19. Caching & Deterministic Hash
  const first = await analyzeComplexity({ code: o1Code, language: "javascript" });
  const second = await analyzeComplexity({ code: o1Code, language: "javascript" });
  assert.strictEqual(first, second, "Should return cached reference for identical input");
  console.log("✔ Caching: Identical input returns cached reference");

  console.log("\nALL COMPLEXITY ANALYZER REGRESSION TESTS PASSED! 🎉");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});