// tests/fixtures/complexityCorpus.js
//
// Accuracy benchmark for the static complexity analyzer: realistic solutions
// with known (hand-verified) complexity. Two sets:
//   dev     - used while improving the analyzer
//   holdout - only measured, never used to tune it (honest accuracy figure)
//
// Ground-truth conventions:
//   time  : worst case, in terms of the input size(s); n + m / max(n, m) / V + E
//           all count as linear.
//   space : auxiliary space - excludes the input and the returned output;
//           recursion stack depth counts.
//   *Alt  : other answers that are also correct (e.g. in-place sort O(1) vs O(log n)).

export const corpus = [
  // ───────────────────────── platform problems ─────────────────────────
  // Two Sum
  { id: "twosum-hash-cpp", set: "dev", lang: "cpp", time: "O(n)", space: "O(n)", code: `
vector<int> twoSum(vector<int>& nums, int target) {
    unordered_map<int, int> seen;
    for (int i = 0; i < nums.size(); i++) {
        int need = target - nums[i];
        if (seen.count(need)) return {seen[need], i};
        seen[nums[i]] = i;
    }
    return {};
}` },
  { id: "twosum-brute-cpp", set: "dev", lang: "cpp", time: "O(n^2)", space: "O(1)", code: `
vector<int> twoSum(vector<int>& nums, int target) {
    int n = nums.size();
    for (int i = 0; i < n; i++)
        for (int j = i + 1; j < n; j++)
            if (nums[i] + nums[j] == target) return {i, j};
    return {};
}` },
  { id: "twosum-hash-py", set: "dev", lang: "python", time: "O(n)", space: "O(n)", code: `
def twoSum(nums, target):
    seen = {}
    for i, x in enumerate(nums):
        if target - x in seen:
            return [seen[target - x], i]
        seen[x] = i
    return []
` },
  { id: "twosum-brute-py", set: "holdout", lang: "python", time: "O(n^2)", space: "O(1)", code: `
def twoSum(nums, target):
    for i in range(len(nums)):
        for j in range(i + 1, len(nums)):
            if nums[i] + nums[j] == target:
                return [i, j]
    return []
` },
  { id: "twosum-hash-java", set: "holdout", lang: "java", time: "O(n)", space: "O(n)", code: `
class Solution {
    public int[] twoSum(int[] nums, int target) {
        Map<Integer, Integer> seen = new HashMap<>();
        for (int i = 0; i < nums.length; i++) {
            Integer j = seen.get(target - nums[i]);
            if (j != null) return new int[]{j, i};
            seen.put(nums[i], i);
        }
        return new int[0];
    }
}` },
  { id: "twosum-hash-js", set: "dev", lang: "javascript", time: "O(n)", space: "O(n)", code: `
function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const need = target - nums[i];
    if (seen.has(need)) return [seen.get(need), i];
    seen.set(nums[i], i);
  }
  return [];
}` },
  { id: "twosum-brute-c", set: "holdout", lang: "c", time: "O(n^2)", space: "O(1)", code: `
int* twoSum(int* nums, int numsSize, int target, int* returnSize) {
    int* res = (int*)malloc(2 * sizeof(int));
    *returnSize = 2;
    for (int i = 0; i < numsSize; i++) {
        for (int j = i + 1; j < numsSize; j++) {
            if (nums[i] + nums[j] == target) { res[0] = i; res[1] = j; return res; }
        }
    }
    *returnSize = 0;
    return res;
}` },
  { id: "twosum-sort-pointers-cpp", set: "holdout", lang: "cpp", time: "O(n log n)", space: "O(n)", code: `
vector<int> twoSum(vector<int>& nums, int target) {
    vector<pair<int,int>> v;
    for (int i = 0; i < nums.size(); i++) v.push_back({nums[i], i});
    sort(v.begin(), v.end());
    int l = 0, r = v.size() - 1;
    while (l < r) {
        int s = v[l].first + v[r].first;
        if (s == target) return {v[l].second, v[r].second};
        if (s < target) l++; else r--;
    }
    return {};
}` },

  // Add Two Numbers
  { id: "addtwo-iter-java", set: "dev", lang: "java", time: "O(n)", space: "O(1)", code: `
class Solution {
    public ListNode addTwoNumbers(ListNode l1, ListNode l2) {
        ListNode dummy = new ListNode(0), cur = dummy;
        int carry = 0;
        while (l1 != null || l2 != null || carry != 0) {
            int s = carry;
            if (l1 != null) { s += l1.val; l1 = l1.next; }
            if (l2 != null) { s += l2.val; l2 = l2.next; }
            cur.next = new ListNode(s % 10);
            cur = cur.next;
            carry = s / 10;
        }
        return dummy.next;
    }
}` },
  { id: "addtwo-iter-js", set: "holdout", lang: "javascript", time: "O(n)", space: "O(1)", code: `
function addTwoNumbers(l1, l2) {
  const dummy = new ListNode(0);
  let cur = dummy, carry = 0;
  while (l1 || l2 || carry) {
    let s = carry;
    if (l1) { s += l1.val; l1 = l1.next; }
    if (l2) { s += l2.val; l2 = l2.next; }
    cur.next = new ListNode(s % 10);
    cur = cur.next;
    carry = Math.floor(s / 10);
  }
  return dummy.next;
}` },
  { id: "addtwo-recursive-cpp", set: "dev", lang: "cpp", time: "O(n)", space: "O(n)", code: `
ListNode* helper(ListNode* a, ListNode* b, int carry) {
    if (!a && !b && !carry) return nullptr;
    int s = carry + (a ? a->val : 0) + (b ? b->val : 0);
    ListNode* node = new ListNode(s % 10);
    node->next = helper(a ? a->next : nullptr, b ? b->next : nullptr, s / 10);
    return node;
}
ListNode* addTwoNumbers(ListNode* l1, ListNode* l2) {
    return helper(l1, l2, 0);
}` },

  // 3Sum / 3Sum Closest / 4Sum
  { id: "threesum-sort-cpp", set: "dev", lang: "cpp", time: "O(n^2)", space: "O(1)", spaceAlt: ["O(log n)"], code: `
vector<vector<int>> threeSum(vector<int>& nums) {
    sort(nums.begin(), nums.end());
    vector<vector<int>> res;
    int n = nums.size();
    for (int i = 0; i < n - 2; i++) {
        if (i > 0 && nums[i] == nums[i - 1]) continue;
        int l = i + 1, r = n - 1;
        while (l < r) {
            int s = nums[i] + nums[l] + nums[r];
            if (s == 0) {
                res.push_back({nums[i], nums[l], nums[r]});
                while (l < r && nums[l] == nums[l + 1]) l++;
                while (l < r && nums[r] == nums[r - 1]) r--;
                l++; r--;
            } else if (s < 0) l++;
            else r--;
        }
    }
    return res;
}` },
  { id: "threesum-sort-py", set: "holdout", lang: "python", time: "O(n^2)", space: "O(1)", spaceAlt: ["O(log n)", "O(n)"], code: `
def threeSum(nums):
    nums.sort()
    res = []
    n = len(nums)
    for i in range(n - 2):
        if i > 0 and nums[i] == nums[i - 1]:
            continue
        l, r = i + 1, n - 1
        while l < r:
            s = nums[i] + nums[l] + nums[r]
            if s == 0:
                res.append([nums[i], nums[l], nums[r]])
                while l < r and nums[l] == nums[l + 1]:
                    l += 1
                l += 1
                r -= 1
            elif s < 0:
                l += 1
            else:
                r -= 1
    return res
` },
  { id: "threesum-hashset-py", set: "dev", lang: "python", time: "O(n^2)", space: "O(n)", code: `
def threeSum(nums):
    res = set()
    for i in range(len(nums)):
        seen = set()
        for j in range(i + 1, len(nums)):
            need = -nums[i] - nums[j]
            if need in seen:
                res.add(tuple(sorted((nums[i], nums[j], need))))
            seen.add(nums[j])
    return [list(t) for t in res]
` },
  { id: "threesum-closest-java", set: "dev", lang: "java", time: "O(n^2)", space: "O(1)", spaceAlt: ["O(log n)"], code: `
class Solution {
    public int threeSumClosest(int[] nums, int target) {
        Arrays.sort(nums);
        int best = nums[0] + nums[1] + nums[2];
        for (int i = 0; i < nums.length - 2; i++) {
            int l = i + 1, r = nums.length - 1;
            while (l < r) {
                int s = nums[i] + nums[l] + nums[r];
                if (Math.abs(s - target) < Math.abs(best - target)) best = s;
                if (s < target) l++;
                else if (s > target) r--;
                else return s;
            }
        }
        return best;
    }
}` },
  { id: "fourSum-sort-cpp", set: "holdout", lang: "cpp", time: "O(n^3)", space: "O(1)", spaceAlt: ["O(log n)"], code: `
vector<vector<int>> fourSum(vector<int>& nums, int target) {
    sort(nums.begin(), nums.end());
    vector<vector<int>> res;
    int n = nums.size();
    for (int a = 0; a < n; a++) {
        if (a > 0 && nums[a] == nums[a - 1]) continue;
        for (int b = a + 1; b < n; b++) {
            if (b > a + 1 && nums[b] == nums[b - 1]) continue;
            int l = b + 1, r = n - 1;
            while (l < r) {
                long long s = (long long)nums[a] + nums[b] + nums[l] + nums[r];
                if (s == target) {
                    res.push_back({nums[a], nums[b], nums[l], nums[r]});
                    l++; r--;
                    while (l < r && nums[l] == nums[l - 1]) l++;
                } else if (s < target) l++;
                else r--;
            }
        }
    }
    return res;
}` },
  { id: "threesum-brute-cpp", set: "dev", lang: "cpp", time: "O(n^3)", space: "O(1)", code: `
int countZeroTriplets(vector<int>& a) {
    int n = a.size(), cnt = 0;
    for (int i = 0; i < n; i++)
        for (int j = i + 1; j < n; j++)
            for (int k = j + 1; k < n; k++)
                if (a[i] + a[j] + a[k] == 0) cnt++;
    return cnt;
}` },

  // Add Binary
  { id: "addbinary-cpp", set: "dev", lang: "cpp", time: "O(n)", space: "O(1)", code: `
string addBinary(string a, string b) {
    string res;
    int i = a.size() - 1, j = b.size() - 1, carry = 0;
    while (i >= 0 || j >= 0 || carry) {
        int s = carry;
        if (i >= 0) s += a[i--] - '0';
        if (j >= 0) s += b[j--] - '0';
        res.push_back('0' + s % 2);
        carry = s / 2;
    }
    reverse(res.begin(), res.end());
    return res;
}` },
  { id: "addbinary-py", set: "holdout", lang: "python", time: "O(n)", space: "O(1)", spaceAlt: ["O(n)"], code: `
def addBinary(a, b):
    i, j, carry = len(a) - 1, len(b) - 1, 0
    out = []
    while i >= 0 or j >= 0 or carry:
        s = carry
        if i >= 0:
            s += int(a[i])
            i -= 1
        if j >= 0:
            s += int(b[j])
            j -= 1
        out.append(str(s % 2))
        carry = s // 2
    return ''.join(reversed(out))
` },

  // Array Partition
  { id: "arraypartition-cpp", set: "dev", lang: "cpp", time: "O(n log n)", space: "O(1)", spaceAlt: ["O(log n)"], code: `
int arrayPairSum(vector<int>& nums) {
    sort(nums.begin(), nums.end());
    int sum = 0;
    for (int i = 0; i < nums.size(); i += 2) sum += nums[i];
    return sum;
}` },
  { id: "arraypartition-py", set: "holdout", lang: "python", time: "O(n log n)", space: "O(n)", spaceAlt: ["O(1)", "O(log n)"], code: `
def arrayPairSum(nums):
    return sum(sorted(nums)[::2])
` },

  // Backspace String Compare
  { id: "backspace-stack-py", set: "dev", lang: "python", time: "O(n)", space: "O(n)", code: `
def backspaceCompare(s, t):
    def build(x):
        st = []
        for c in x:
            if c == '#':
                if st:
                    st.pop()
            else:
                st.append(c)
        return st
    return build(s) == build(t)
` },
  { id: "backspace-pointers-cpp", set: "dev", lang: "cpp", time: "O(n)", space: "O(1)", code: `
bool backspaceCompare(string s, string t) {
    int i = s.size() - 1, j = t.size() - 1;
    while (i >= 0 || j >= 0) {
        int skip = 0;
        while (i >= 0 && (s[i] == '#' || skip > 0)) { skip += s[i] == '#' ? 1 : -1; i--; }
        skip = 0;
        while (j >= 0 && (t[j] == '#' || skip > 0)) { skip += t[j] == '#' ? 1 : -1; j--; }
        if (i >= 0 && j >= 0 && s[i] != t[j]) return false;
        if ((i >= 0) != (j >= 0)) return false;
        i--; j--;
    }
    return true;
}` },
  { id: "backspace-stack-java", set: "holdout", lang: "java", time: "O(n)", space: "O(n)", code: `
class Solution {
    private String build(String s) {
        StringBuilder sb = new StringBuilder();
        for (char c : s.toCharArray()) {
            if (c == '#') { if (sb.length() > 0) sb.deleteCharAt(sb.length() - 1); }
            else sb.append(c);
        }
        return sb.toString();
    }
    public boolean backspaceCompare(String s, String t) {
        return build(s).equals(build(t));
    }
}` },

  // Best Time to Buy and Sell Stock
  { id: "stock-onepass-cpp", set: "dev", lang: "cpp", time: "O(n)", space: "O(1)", code: `
int maxProfit(vector<int>& prices) {
    int lo = INT_MAX, best = 0;
    for (int p : prices) {
        lo = min(lo, p);
        best = max(best, p - lo);
    }
    return best;
}` },
  { id: "stock-onepass-c", set: "dev", lang: "c", time: "O(n)", space: "O(1)", code: `
int maxProfit(int* prices, int pricesSize) {
    int lo = prices[0], best = 0;
    for (int i = 1; i < pricesSize; i++) {
        if (prices[i] < lo) lo = prices[i];
        else if (prices[i] - lo > best) best = prices[i] - lo;
    }
    return best;
}` },
  { id: "stock-onepass-js", set: "holdout", lang: "javascript", time: "O(n)", space: "O(1)", code: `
function maxProfit(prices) {
  let lo = Infinity, best = 0;
  for (const p of prices) {
    lo = Math.min(lo, p);
    best = Math.max(best, p - lo);
  }
  return best;
}` },
  { id: "stock-brute-py", set: "dev", lang: "python", time: "O(n^2)", space: "O(1)", code: `
def maxProfit(prices):
    best = 0
    for i in range(len(prices)):
        for j in range(i + 1, len(prices)):
            best = max(best, prices[j] - prices[i])
    return best
` },

  // Add 1 to a number represented as linked list
  { id: "addone-reverse-cpp", set: "dev", lang: "cpp", time: "O(n)", space: "O(1)", code: `
ListNode* reverseList(ListNode* head) {
    ListNode* prev = nullptr;
    while (head) { ListNode* nx = head->next; head->next = prev; prev = head; head = nx; }
    return prev;
}
ListNode* addOne(ListNode* head) {
    head = reverseList(head);
    ListNode* cur = head;
    int carry = 1;
    while (cur && carry) {
        int s = cur->val + carry;
        cur->val = s % 10;
        carry = s / 10;
        if (!cur->next && carry) { cur->next = new ListNode(carry); carry = 0; }
        cur = cur->next;
    }
    return reverseList(head);
}` },
  { id: "addone-recursive-py", set: "holdout", lang: "python", time: "O(n)", space: "O(n)", code: `
def addOne(head):
    def carry_of(node):
        if node is None:
            return 1
        s = node.val + carry_of(node.next)
        node.val = s % 10
        return s // 10
    c = carry_of(head)
    if c:
        node = ListNode(c)
        node.next = head
        head = node
    return head
` },

  // ───────────────────────── classic patterns ─────────────────────────
  { id: "binsearch-cpp", set: "dev", lang: "cpp", time: "O(log n)", space: "O(1)", code: `
int search(vector<int>& nums, int target) {
    int lo = 0, hi = nums.size() - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (nums[mid] == target) return mid;
        if (nums[mid] < target) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
}` },
  { id: "binsearch-py", set: "holdout", lang: "python", time: "O(log n)", space: "O(1)", code: `
def search(nums, target):
    lo, hi = 0, len(nums) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if nums[mid] == target:
            return mid
        if nums[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1
` },
  { id: "binsearch-recursive-cpp", set: "dev", lang: "cpp", time: "O(log n)", space: "O(log n)", code: `
int bs(vector<int>& a, int lo, int hi, int t) {
    if (lo > hi) return -1;
    int mid = (lo + hi) / 2;
    if (a[mid] == t) return mid;
    if (a[mid] < t) return bs(a, mid + 1, hi, t);
    return bs(a, lo, mid - 1, t);
}
int search(vector<int>& nums, int target) { return bs(nums, 0, nums.size() - 1, target); }` },
  { id: "mergesort-cpp", set: "dev", lang: "cpp", time: "O(n log n)", space: "O(n)", code: `
void merge(vector<int>& a, int l, int m, int r) {
    vector<int> tmp;
    int i = l, j = m + 1;
    while (i <= m && j <= r) tmp.push_back(a[i] <= a[j] ? a[i++] : a[j++]);
    while (i <= m) tmp.push_back(a[i++]);
    while (j <= r) tmp.push_back(a[j++]);
    for (int k = 0; k < tmp.size(); k++) a[l + k] = tmp[k];
}
void mergeSort(vector<int>& a, int l, int r) {
    if (l >= r) return;
    int m = (l + r) / 2;
    mergeSort(a, l, m);
    mergeSort(a, m + 1, r);
    merge(a, l, m, r);
}` },
  { id: "mergesort-py", set: "holdout", lang: "python", time: "O(n log n)", space: "O(n)", code: `
def merge_sort(a):
    if len(a) <= 1:
        return a
    mid = len(a) // 2
    left = merge_sort(a[:mid])
    right = merge_sort(a[mid:])
    out = []
    i = j = 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            out.append(left[i]); i += 1
        else:
            out.append(right[j]); j += 1
    out.extend(left[i:])
    out.extend(right[j:])
    return out
` },
  { id: "fib-naive-py", set: "dev", lang: "python", time: "O(2^n)", space: "O(n)", code: `
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)
` },
  { id: "fib-naive-cpp", set: "holdout", lang: "cpp", time: "O(2^n)", space: "O(n)", code: `
int fib(int n) {
    if (n < 2) return n;
    return fib(n - 1) + fib(n - 2);
}` },
  { id: "fib-memo-py", set: "dev", lang: "python", time: "O(n)", space: "O(n)", code: `
from functools import lru_cache
@lru_cache(None)
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)
` },
  { id: "fib-memo-cpp", set: "holdout", lang: "cpp", time: "O(n)", space: "O(n)", code: `
long long memo[100];
long long fib(int n) {
    if (n < 2) return n;
    if (memo[n]) return memo[n];
    return memo[n] = fib(n - 1) + fib(n - 2);
}` },
  { id: "fib-iter-cpp", set: "dev", lang: "cpp", time: "O(n)", space: "O(1)", code: `
long long fib(int n) {
    long long a = 0, b = 1;
    for (int i = 0; i < n; i++) { long long c = a + b; a = b; b = c; }
    return a;
}` },
  { id: "climb-dp-java", set: "dev", lang: "java", time: "O(n)", space: "O(n)", code: `
class Solution {
    public int climbStairs(int n) {
        int[] dp = new int[n + 2];
        dp[0] = 1; dp[1] = 1;
        for (int i = 2; i <= n; i++) dp[i] = dp[i - 1] + dp[i - 2];
        return dp[n];
    }
}` },
  { id: "lcs-dp-cpp", set: "dev", lang: "cpp", time: "O(n × m)", space: "O(n × m)", code: `
int longestCommonSubsequence(string a, string b) {
    int n = a.size(), m = b.size();
    vector<vector<int>> dp(n + 1, vector<int>(m + 1, 0));
    for (int i = 1; i <= n; i++)
        for (int j = 1; j <= m; j++)
            dp[i][j] = a[i - 1] == b[j - 1] ? dp[i - 1][j - 1] + 1 : max(dp[i - 1][j], dp[i][j - 1]);
    return dp[n][m];
}` },
  { id: "lcs-dp-py", set: "holdout", lang: "python", time: "O(n × m)", space: "O(n × m)", code: `
def lcs(a, b):
    n, m = len(a), len(b)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            if a[i - 1] == b[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
            else:
                dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
    return dp[n][m]
` },
  { id: "knapsack-1d-cpp", set: "holdout", lang: "cpp", time: "O(n × m)", space: "O(n)", code: `
int knapsack(vector<int>& wt, vector<int>& val, int W) {
    vector<int> dp(W + 1, 0);
    for (int i = 0; i < wt.size(); i++)
        for (int w = W; w >= wt[i]; w--)
            dp[w] = max(dp[w], dp[w - wt[i]] + val[i]);
    return dp[W];
}` },
  { id: "subsets-backtrack-py", set: "dev", lang: "python", time: "O(n × 2^n)", timeAlt: ["O(2^n)"], space: "O(n)", code: `
def subsets(nums):
    res = []
    def bt(i, cur):
        if i == len(nums):
            res.append(cur[:])
            return
        bt(i + 1, cur)
        cur.append(nums[i])
        bt(i + 1, cur)
        cur.pop()
    bt(0, [])
    return res
` },
  { id: "subsets-bitmask-cpp", set: "holdout", lang: "cpp", time: "O(n × 2^n)", timeAlt: ["O(2^n)"], space: "O(1)", spaceAlt: ["O(n)"], code: `
vector<vector<int>> subsets(vector<int>& nums) {
    int n = nums.size();
    vector<vector<int>> res;
    for (int mask = 0; mask < (1 << n); mask++) {
        vector<int> cur;
        for (int i = 0; i < n; i++) if (mask & (1 << i)) cur.push_back(nums[i]);
        res.push_back(cur);
    }
    return res;
}` },
  { id: "permutations-cpp", set: "dev", lang: "cpp", time: "O(n × n!)", timeAlt: ["O(n!)"], space: "O(n)", code: `
void permute(vector<int>& a, int k, vector<vector<int>>& res) {
    if (k == a.size()) { res.push_back(a); return; }
    for (int i = k; i < a.size(); i++) {
        swap(a[k], a[i]);
        permute(a, k + 1, res);
        swap(a[k], a[i]);
    }
}
vector<vector<int>> permuteAll(vector<int>& nums) {
    vector<vector<int>> res;
    permute(nums, 0, res);
    return res;
}` },
  { id: "permutations-py", set: "holdout", lang: "python", time: "O(n × n!)", timeAlt: ["O(n!)"], space: "O(n)", code: `
def permute(nums):
    res = []
    used = [False] * len(nums)
    def bt(cur):
        if len(cur) == len(nums):
            res.append(cur[:])
            return
        for i in range(len(nums)):
            if not used[i]:
                used[i] = True
                cur.append(nums[i])
                bt(cur)
                cur.pop()
                used[i] = False
    bt([])
    return res
` },
  { id: "islands-dfs-cpp", set: "dev", lang: "cpp", time: "O(n × m)", space: "O(n × m)", code: `
void dfs(vector<vector<char>>& g, int r, int c) {
    if (r < 0 || c < 0 || r >= g.size() || c >= g[0].size() || g[r][c] != '1') return;
    g[r][c] = '0';
    dfs(g, r + 1, c); dfs(g, r - 1, c); dfs(g, r, c + 1); dfs(g, r, c - 1);
}
int numIslands(vector<vector<char>>& grid) {
    int cnt = 0;
    for (int i = 0; i < grid.size(); i++)
        for (int j = 0; j < grid[0].size(); j++)
            if (grid[i][j] == '1') { cnt++; dfs(grid, i, j); }
    return cnt;
}` },
  { id: "islands-bfs-py", set: "holdout", lang: "python", time: "O(n × m)", space: "O(n × m)", spaceAlt: ["O(n)"], code: `
from collections import deque
def numIslands(grid):
    rows, cols = len(grid), len(grid[0])
    count = 0
    for r in range(rows):
        for c in range(cols):
            if grid[r][c] == '1':
                count += 1
                q = deque([(r, c)])
                grid[r][c] = '0'
                while q:
                    x, y = q.popleft()
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < rows and 0 <= ny < cols and grid[nx][ny] == '1':
                            grid[nx][ny] = '0'
                            q.append((nx, ny))
    return count
` },
  { id: "graph-bfs-py", set: "dev", lang: "python", time: "O(V + E)", space: "O(n)", code: `
from collections import deque
def shortest(n, edges, src):
    adj = [[] for _ in range(n)]
    for u, v in edges:
        adj[u].append(v)
        adj[v].append(u)
    dist = [-1] * n
    dist[src] = 0
    q = deque([src])
    while q:
        u = q.popleft()
        for v in adj[u]:
            if dist[v] == -1:
                dist[v] = dist[u] + 1
                q.append(v)
    return dist
` },
  { id: "graph-dfs-java", set: "holdout", lang: "java", time: "O(V + E)", space: "O(n)", code: `
class Solution {
    private void dfs(int u, List<List<Integer>> adj, boolean[] seen) {
        seen[u] = true;
        for (int v : adj.get(u)) if (!seen[v]) dfs(v, adj, seen);
    }
    public int countComponents(int n, int[][] edges) {
        List<List<Integer>> adj = new ArrayList<>();
        for (int i = 0; i < n; i++) adj.add(new ArrayList<>());
        for (int[] e : edges) { adj.get(e[0]).add(e[1]); adj.get(e[1]).add(e[0]); }
        boolean[] seen = new boolean[n];
        int comps = 0;
        for (int i = 0; i < n; i++) if (!seen[i]) { comps++; dfs(i, adj, seen); }
        return comps;
    }
}` },
  { id: "tree-depth-cpp", set: "dev", lang: "cpp", time: "O(n)", space: "O(n)", code: `
int maxDepth(TreeNode* root) {
    if (!root) return 0;
    return 1 + max(maxDepth(root->left), maxDepth(root->right));
}` },
  { id: "tree-inorder-py", set: "holdout", lang: "python", time: "O(n)", space: "O(n)", code: `
def inorderTraversal(root):
    res, stack, cur = [], [], root
    while cur or stack:
        while cur:
            stack.append(cur)
            cur = cur.left
        cur = stack.pop()
        res.append(cur.val)
        cur = cur.right
    return res
` },
  { id: "window-longest-substring-cpp", set: "dev", lang: "cpp", time: "O(n)", space: "O(1)", spaceAlt: ["O(n)"], code: `
int lengthOfLongestSubstring(string s) {
    vector<int> last(256, -1);
    int best = 0, start = 0;
    for (int i = 0; i < s.size(); i++) {
        if (last[s[i]] >= start) start = last[s[i]] + 1;
        last[s[i]] = i;
        best = max(best, i - start + 1);
    }
    return best;
}` },
  { id: "window-min-subarray-py", set: "holdout", lang: "python", time: "O(n)", space: "O(1)", code: `
def minSubArrayLen(target, nums):
    left = total = 0
    best = float('inf')
    for right in range(len(nums)):
        total += nums[right]
        while total >= target:
            best = min(best, right - left + 1)
            total -= nums[left]
            left += 1
    return 0 if best == float('inf') else best
` },
  { id: "container-water-js", set: "dev", lang: "javascript", time: "O(n)", space: "O(1)", code: `
function maxArea(height) {
  let l = 0, r = height.length - 1, best = 0;
  while (l < r) {
    best = Math.max(best, Math.min(height[l], height[r]) * (r - l));
    if (height[l] < height[r]) l++; else r--;
  }
  return best;
}` },
  { id: "monostack-next-greater-cpp", set: "dev", lang: "cpp", time: "O(n)", space: "O(n)", code: `
vector<int> nextGreater(vector<int>& a) {
    int n = a.size();
    vector<int> res(n, -1);
    stack<int> st;
    for (int i = 0; i < n; i++) {
        while (!st.empty() && a[st.top()] < a[i]) { res[st.top()] = a[i]; st.pop(); }
        st.push(i);
    }
    return res;
}` },
  { id: "monostack-temps-py", set: "holdout", lang: "python", time: "O(n)", space: "O(n)", code: `
def dailyTemperatures(t):
    res = [0] * len(t)
    stack = []
    for i, x in enumerate(t):
        while stack and t[stack[-1]] < x:
            j = stack.pop()
            res[j] = i - j
        stack.append(i)
    return res
` },
  { id: "kadane-c", set: "holdout", lang: "c", time: "O(n)", space: "O(1)", code: `
int maxSubArray(int* nums, int n) {
    int best = nums[0], cur = nums[0];
    for (int i = 1; i < n; i++) {
        cur = cur + nums[i] > nums[i] ? cur + nums[i] : nums[i];
        if (cur > best) best = cur;
    }
    return best;
}` },
  { id: "kadane-py", set: "dev", lang: "python", time: "O(n)", space: "O(1)", code: `
def maxSubArray(nums):
    best = cur = nums[0]
    for x in nums[1:]:
        cur = max(x, cur + x)
        best = max(best, cur)
    return best
` },
  { id: "prefix-sum-cpp", set: "dev", lang: "cpp", time: "O(n)", space: "O(n)", code: `
vector<long long> rangeSums(vector<int>& a, vector<pair<int,int>>& queries) {
    vector<long long> pre(a.size() + 1, 0);
    for (int i = 0; i < a.size(); i++) pre[i + 1] = pre[i] + a[i];
    vector<long long> out;
    for (auto& q : queries) out.push_back(pre[q.second + 1] - pre[q.first]);
    return out;
}` },
  { id: "heap-topk-py", set: "dev", lang: "python", time: "O(n log n)", timeAlt: ["O(n log k)"], space: "O(n)", spaceAlt: ["O(k)"], code: `
import heapq
def findKthLargest(nums, k):
    heap = []
    for x in nums:
        heapq.heappush(heap, x)
        if len(heap) > k:
            heapq.heappop(heap)
    return heap[0]
` },
  { id: "heap-topk-cpp", set: "holdout", lang: "cpp", time: "O(n log n)", timeAlt: ["O(n log k)"], space: "O(n)", spaceAlt: ["O(k)"], code: `
int findKthLargest(vector<int>& nums, int k) {
    priority_queue<int, vector<int>, greater<int>> pq;
    for (int x : nums) {
        pq.push(x);
        if (pq.size() > k) pq.pop();
    }
    return pq.top();
}` },
  { id: "sqrt-loop-cpp", set: "dev", lang: "cpp", time: "O(√n)", space: "O(1)", code: `
bool isPrime(int n) {
    if (n < 2) return false;
    for (int i = 2; (long long)i * i <= n; i++)
        if (n % i == 0) return false;
    return true;
}` },
  { id: "sqrt-loop-py", set: "holdout", lang: "python", time: "O(√n)", space: "O(1)", code: `
def is_prime(n):
    if n < 2:
        return False
    i = 2
    while i * i <= n:
        if n % i == 0:
            return False
        i += 1
    return True
` },
  { id: "halving-loop-java", set: "dev", lang: "java", time: "O(log n)", space: "O(1)", code: `
class Solution {
    public int countBits(int n) {
        int bits = 0;
        while (n > 0) {
            bits += n & 1;
            n >>= 1;
        }
        return bits;
    }
}` },
  { id: "gcd-c", set: "holdout", lang: "c", time: "O(log n)", space: "O(1)", code: `
int gcd(int a, int b) {
    while (b != 0) {
        int t = a % b;
        a = b;
        b = t;
    }
    return a;
}` },
  { id: "fast-pow-cpp", set: "dev", lang: "cpp", time: "O(log n)", space: "O(log n)", code: `
double myPow(double x, long long n) {
    if (n == 0) return 1;
    if (n < 0) return 1 / myPow(x, -n);
    double half = myPow(x, n / 2);
    return n % 2 ? half * half * x : half * half;
}` },
  { id: "nlogn-doubling-inner-cpp", set: "dev", lang: "cpp", time: "O(n log n)", space: "O(1)", code: `
long long work(int n) {
    long long total = 0;
    for (int i = 0; i < n; i++)
        for (int j = 1; j < n; j *= 2)
            total += i ^ j;
    return total;
}` },
  { id: "triangle-loops-js", set: "dev", lang: "javascript", time: "O(n^2)", space: "O(1)", code: `
function countInversions(a) {
  let inv = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      if (a[i] > a[j]) inv++;
    }
  }
  return inv;
}` },
  { id: "matmul-cpp", set: "holdout", lang: "cpp", time: "O(n^3)", space: "O(1)", spaceAlt: ["O(n^2)"], code: `
vector<vector<int>> multiply(vector<vector<int>>& A, vector<vector<int>>& B) {
    int n = A.size();
    vector<vector<int>> C(n, vector<int>(n, 0));
    for (int i = 0; i < n; i++)
        for (int j = 0; j < n; j++)
            for (int k = 0; k < n; k++)
                C[i][j] += A[i][k] * B[k][j];
    return C;
}` },
  { id: "anagram-count26-cpp", set: "dev", lang: "cpp", time: "O(n)", space: "O(1)", code: `
bool isAnagram(string s, string t) {
    if (s.size() != t.size()) return false;
    int cnt[26] = {0};
    for (char c : s) cnt[c - 'a']++;
    for (char c : t) if (--cnt[c - 'a'] < 0) return false;
    return true;
}` },
  { id: "dup-set-js", set: "holdout", lang: "javascript", time: "O(n)", space: "O(n)", code: `
function containsDuplicate(nums) {
  const seen = new Set();
  for (const x of nums) {
    if (seen.has(x)) return true;
    seen.add(x);
  }
  return false;
}` },
  { id: "dup-sort-cpp", set: "dev", lang: "cpp", time: "O(n log n)", space: "O(1)", spaceAlt: ["O(log n)"], code: `
bool containsDuplicate(vector<int>& nums) {
    sort(nums.begin(), nums.end());
    for (int i = 1; i < nums.size(); i++) if (nums[i] == nums[i - 1]) return true;
    return false;
}` },
  { id: "spiral-java", set: "holdout", lang: "java", time: "O(n × m)", space: "O(1)", code: `
class Solution {
    public List<Integer> spiralOrder(int[][] mat) {
        List<Integer> res = new ArrayList<>();
        int top = 0, bottom = mat.length - 1, left = 0, right = mat[0].length - 1;
        while (top <= bottom && left <= right) {
            for (int j = left; j <= right; j++) res.add(mat[top][j]);
            top++;
            for (int i = top; i <= bottom; i++) res.add(mat[i][right]);
            right--;
            if (top <= bottom) { for (int j = right; j >= left; j--) res.add(mat[bottom][j]); bottom--; }
            if (left <= right) { for (int i = bottom; i >= top; i--) res.add(mat[i][left]); left++; }
        }
        return res;
    }
}` },
  { id: "binsearch-answer-cpp", set: "dev", lang: "cpp", time: "O(n log n)", timeAlt: ["O(n log m)"], space: "O(1)", code: `
int minEatingSpeed(vector<int>& piles, int h) {
    int lo = 1, hi = *max_element(piles.begin(), piles.end());
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        long long hours = 0;
        for (int p : piles) hours += (p + mid - 1) / mid;
        if (hours <= h) hi = mid; else lo = mid + 1;
    }
    return lo;
}` },
  { id: "dijkstra-cpp", set: "holdout", lang: "cpp", time: "O(n log n)", timeAlt: ["O((V + E) log V)", "O(E log V)"], space: "O(n)", code: `
vector<int> dijkstra(int n, vector<vector<pair<int,int>>>& adj, int src) {
    vector<int> dist(n, INT_MAX);
    priority_queue<pair<int,int>, vector<pair<int,int>>, greater<pair<int,int>>> pq;
    dist[src] = 0;
    pq.push({0, src});
    while (!pq.empty()) {
        auto [d, u] = pq.top(); pq.pop();
        if (d > dist[u]) continue;
        for (auto& [v, w] : adj[u]) {
            if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; pq.push({dist[v], v}); }
        }
    }
    return dist;
}` },
  { id: "unique-paths-memo-py", set: "dev", lang: "python", time: "O(n × m)", space: "O(n × m)", code: `
def uniquePaths(m, n):
    memo = {}
    def go(r, c):
        if r == m - 1 or c == n - 1:
            return 1
        if (r, c) in memo:
            return memo[(r, c)]
        memo[(r, c)] = go(r + 1, c) + go(r, c + 1)
        return memo[(r, c)]
    return go(0, 0)
` },
  { id: "bubble-sort-c", set: "dev", lang: "c", time: "O(n^2)", space: "O(1)", code: `
void bubbleSort(int* a, int n) {
    for (int i = 0; i < n - 1; i++)
        for (int j = 0; j < n - 1 - i; j++)
            if (a[j] > a[j + 1]) { int t = a[j]; a[j] = a[j + 1]; a[j + 1] = t; }
}` },
  { id: "insertion-sort-java", set: "holdout", lang: "java", time: "O(n^2)", space: "O(1)", code: `
class Solution {
    public void insertionSort(int[] a) {
        for (int i = 1; i < a.length; i++) {
            int key = a[i], j = i - 1;
            while (j >= 0 && a[j] > key) { a[j + 1] = a[j]; j--; }
            a[j + 1] = key;
        }
    }
}` },
  { id: "all-substrings-py", set: "holdout", lang: "python", time: "O(n^3)", space: "O(n)", code: `
def countPalindromes(s):
    count = 0
    for i in range(len(s)):
        for j in range(i + 1, len(s) + 1):
            sub = s[i:j]
            if sub == sub[::-1]:
                count += 1
    return count
` },
  { id: "nqueens-cpp", set: "holdout", lang: "cpp", time: "O(n!)", timeAlt: ["O(n × n!)"], space: "O(n)", code: `
int solve(int row, int n, vector<bool>& cols, vector<bool>& d1, vector<bool>& d2) {
    if (row == n) return 1;
    int count = 0;
    for (int c = 0; c < n; c++) {
        if (cols[c] || d1[row + c] || d2[row - c + n - 1]) continue;
        cols[c] = d1[row + c] = d2[row - c + n - 1] = true;
        count += solve(row + 1, n, cols, d1, d2);
        cols[c] = d1[row + c] = d2[row - c + n - 1] = false;
    }
    return count;
}
int totalNQueens(int n) {
    vector<bool> cols(n), d1(2 * n), d2(2 * n);
    return solve(0, n, cols, d1, d2);
}` },
  { id: "reverse-inplace-js", set: "dev", lang: "javascript", time: "O(n)", space: "O(1)", code: `
function reverseString(s) {
  let i = 0, j = s.length - 1;
  while (i < j) {
    const t = s[i]; s[i] = s[j]; s[j] = t;
    i++; j--;
  }
}` },
  { id: "group-anagrams-py", set: "holdout", lang: "python", time: "O(n × m log m)", timeAlt: ["O(n log n)", "O(n × m)"], space: "O(n)", spaceAlt: ["O(n × m)"], code: `
from collections import defaultdict
def groupAnagrams(strs):
    groups = defaultdict(list)
    for s in strs:
        groups[''.join(sorted(s))].append(s)
    return list(groups.values())
` },
];

/**
 * Canonical asymptotic class of a label, so equivalent spellings compare
 * equal: O(n + m) / O(max(n, m)) / O(V + E) are linear, O(n × m) is
 * quadratic, O(n log k) is n-log-n, k^n and n·2^n are exponential, …
 */
export function canon(label) {
  if (!label || typeof label !== "string") return "unknown";
  const m = label.replace(/\s+/g, " ").trim().match(/^O\((.*)\)$/);
  if (!m) return "unknown";
  let t = m[1];
  if (/!/.test(t)) return "factorial";
  if (/\^\s*\(?\s*[a-zA-Z]/.test(t)) return "exponential";
  t = t
    .replace(/max\([^)]*\)/g, "n")
    .replace(/\(\s*[A-Za-z]\s*\+\s*[A-Za-z]\s*\)/g, "n")
    .replace(/\b[A-Za-z]\s*\+\s*[A-Za-z]\b/g, "n");
  let log = 0;
  for (const l of t.match(/log(\^\d+)?\s*\(?\s*[A-Za-z]\s*\)?/g) || []) {
    const p = l.match(/\^(\d+)/);
    log += p ? Number(p[1]) : 1;
  }
  t = t.replace(/log(\^\d+)?\s*\(?\s*[A-Za-z]\s*\)?/g, " ");
  let deg = 0;
  t = t.replace(/√\s*[A-Za-z]/g, () => {
    deg += 0.5;
    return " ";
  });
  for (const v of t.matchAll(/\b([A-Za-z])(?:\s*\^\s*(\d+))?\b/g)) deg += v[2] ? Number(v[2]) : 1;
  return `poly${deg}${log ? `-log${log}` : ""}`;
}

export function isCorrect(predicted, expected, alternatives = []) {
  const c = canon(predicted);
  return c !== "unknown" && [expected, ...alternatives].some((e) => canon(e) === c);
}
