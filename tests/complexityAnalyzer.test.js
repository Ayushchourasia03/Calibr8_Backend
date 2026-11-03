import assert from "node:assert/strict";
import { analyzeComplexity } from "../src/services/complexityAnalyzer.service.js";

async function runTests() {
  console.log("Starting Complexity Analyzer Tests...");

  // 1. Constant time O(1) & space O(1)
  const o1Code = `
    function add(a, b) {
      return a + b;
    }
  `;
  const resO1 = await analyzeComplexity({ code: o1Code, language: "javascript" });
  assert.equal(resO1.time.bestEstimate, "O(1)");
  assert.equal(resO1.space.bestEstimate, "O(1)");
  assert.equal(resO1.time.confidence, "high");
  console.log("✔ O(1) time and O(1) space classified correctly");

  // 2. Linear time O(n) & O(n) auxiliary space (hash map)
  const onCode = `
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
  const resOn = await analyzeComplexity({ code: onCode, language: "javascript" });
  assert.equal(resOn.time.bestEstimate, "O(n)");
  assert.equal(resOn.space.bestEstimate, "O(n)");
  assert.equal(resOn.time.confidence, "high");
  console.log("✔ O(n) time and O(n) space classified correctly");

  // 3. Quadratic time O(n^2) & O(1) auxiliary space (nested loops)
  const on2Code = `
    class Solution:
        def twoSum(self, nums, target):
            for i in range(len(nums)):
                for j in range(i + 1, len(nums)):
                    if nums[i] + nums[j] == target:
                        return [i, j]
            return []
  `;
  const resOn2 = await analyzeComplexity({ code: on2Code, language: "python" });
  assert.equal(resOn2.time.bestEstimate, "O(n^2)");
  assert.equal(resOn2.space.bestEstimate, "O(1)");
  assert.equal(resOn2.time.confidence, "high");
  console.log("✔ O(n^2) time and O(1) space classified correctly");

  // 4. Logarithmic time O(log n) (binary search step)
  const oLogNCode = `
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
  const resLogN = await analyzeComplexity({ code: oLogNCode, language: "cpp" });
  assert.equal(resLogN.time.bestEstimate, "O(log n)");
  assert.equal(resLogN.space.bestEstimate, "O(1)");
  assert.equal(resLogN.time.confidence, "high");
  console.log("✔ O(log n) time classified correctly");

  // 5. Exponential time O(2^n) (branching recursion)
  const o2nCode = `
    int fib(int n) {
      if (n <= 1) return n;
      return fib(n - 1) + fib(n - 2);
    }
  `;
  const res2n = await analyzeComplexity({ code: o2nCode, language: "cpp" });
  assert.equal(res2n.time.bestEstimate, "O(2^n)");
  console.log("✔ O(2^n) exponential recursion classified correctly");

  // 6. Sorting O(n log n)
  const oNlogNCode = `
    function sortedMerge(nums) {
      nums.sort((a, b) => a - b);
      return nums;
    }
  `;
  const resNlogN = await analyzeComplexity({ code: oNlogNCode, language: "javascript" });
  assert.equal(resNlogN.time.bestEstimate, "O(n log n)");
  console.log("✔ O(n log n) sort classified correctly");

  // 7. Caching test
  const first = await analyzeComplexity({ code: o1Code, language: "javascript" });
  const second = await analyzeComplexity({ code: o1Code, language: "javascript" });
  assert.strictEqual(first, second, "Should return cached reference");
  console.log("✔ Caching verified");

  console.log("\nALL COMPLEXITY ANALYZER TESTS PASSED! 🎉");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
