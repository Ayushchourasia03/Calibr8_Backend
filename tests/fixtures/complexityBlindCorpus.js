// tests/fixtures/complexityBlindCorpus.js
//
// Blind accuracy set for the static complexity analyzer: written after the
// analyzer fixes and measured once, without tuning the analyzer to it. Same
// conventions as complexityCorpus.js (worst-case time; auxiliary space
// excluding input and returned output; recursion stack counts).

export const blindCorpus = [
  { id: "valid-parens-cpp", lang: "cpp", time: "O(n)", space: "O(n)", code: `
bool isValid(string s) {
    stack<char> st;
    for (char c : s) {
        if (c == '(' || c == '[' || c == '{') st.push(c);
        else {
            if (st.empty()) return false;
            char t = st.top(); st.pop();
            if ((c == ')' && t != '(') || (c == ']' && t != '[') || (c == '}' && t != '{')) return false;
        }
    }
    return st.empty();
}` },
  { id: "merge-lists-py", lang: "python", time: "O(n + m)", space: "O(1)", code: `
def mergeTwoLists(l1, l2):
    dummy = tail = ListNode(0)
    while l1 and l2:
        if l1.val <= l2.val:
            tail.next, l1 = l1, l1.next
        else:
            tail.next, l2 = l2, l2.next
        tail = tail.next
    tail.next = l1 or l2
    return dummy.next
` },
  { id: "reverse-list-recursive-java", lang: "java", time: "O(n)", space: "O(n)", code: `
class Solution {
    public ListNode reverseList(ListNode head) {
        if (head == null || head.next == null) return head;
        ListNode rest = reverseList(head.next);
        head.next.next = head;
        head.next = null;
        return rest;
    }
}` },
  { id: "rotate-reverse-cpp", lang: "cpp", time: "O(n)", space: "O(1)", code: `
void rotate(vector<int>& nums, int k) {
    k %= nums.size();
    reverse(nums.begin(), nums.end());
    reverse(nums.begin(), nums.begin() + k);
    reverse(nums.begin() + k, nums.end());
}` },
  { id: "majority-js", lang: "javascript", time: "O(n)", space: "O(1)", code: `
function majorityElement(nums) {
  let cand = null, count = 0;
  for (const x of nums) {
    if (count === 0) cand = x;
    count += x === cand ? 1 : -1;
  }
  return cand;
}` },
  { id: "product-except-self-py", lang: "python", time: "O(n)", space: "O(1)", code: `
def productExceptSelf(nums):
    n = len(nums)
    res = [1] * n
    left = 1
    for i in range(n):
        res[i] = left
        left *= nums[i]
    right = 1
    for i in range(n - 1, -1, -1):
        res[i] *= right
        right *= nums[i]
    return res
` },
  { id: "move-zeroes-c", lang: "c", time: "O(n)", space: "O(1)", code: `
void moveZeroes(int* nums, int numsSize) {
    int w = 0;
    for (int i = 0; i < numsSize; i++)
        if (nums[i] != 0) { int t = nums[w]; nums[w] = nums[i]; nums[i] = t; w++; }
}` },
  { id: "longest-prefix-py", lang: "python", time: "O(n × m)", space: "O(1)", code: `
def longestCommonPrefix(strs):
    if not strs:
        return ""
    for i in range(len(strs[0])):
        ch = strs[0][i]
        for s in strs[1:]:
            if i >= len(s) or s[i] != ch:
                return strs[0][:i]
    return strs[0]
` },
  { id: "search-insert-java", lang: "java", time: "O(log n)", space: "O(1)", code: `
class Solution {
    public int searchInsert(int[] nums, int target) {
        int lo = 0, hi = nums.length;
        while (lo < hi) {
            int mid = (lo + hi) >>> 1;
            if (nums[mid] < target) lo = mid + 1; else hi = mid;
        }
        return lo;
    }
}` },
  { id: "sqrt-binsearch-cpp", lang: "cpp", time: "O(log n)", space: "O(1)", code: `
int mySqrt(int x) {
    long long lo = 0, hi = x, ans = 0;
    while (lo <= hi) {
        long long mid = (lo + hi) / 2;
        if (mid * mid <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
}` },
  { id: "pascal-py", lang: "python", time: "O(n^2)", space: "O(1)", code: `
def generate(numRows):
    rows = []
    for r in range(numRows):
        row = [1] * (r + 1)
        for c in range(1, r):
            row[c] = rows[r - 1][c - 1] + rows[r - 1][c]
        rows.append(row)
    return rows
` },
  { id: "coin-change-cpp", lang: "cpp", time: "O(n × m)", space: "O(n)", code: `
int coinChange(vector<int>& coins, int amount) {
    vector<int> dp(amount + 1, INT_MAX);
    dp[0] = 0;
    for (int a = 1; a <= amount; a++)
        for (int c : coins)
            if (c <= a && dp[a - c] != INT_MAX) dp[a] = min(dp[a], dp[a - c] + 1);
    return dp[amount] == INT_MAX ? -1 : dp[amount];
}` },
  { id: "house-robber-js", lang: "javascript", time: "O(n)", space: "O(1)", code: `
function rob(nums) {
  let prev = 0, cur = 0;
  for (const x of nums) {
    const next = Math.max(cur, prev + x);
    prev = cur;
    cur = next;
  }
  return cur;
}` },
  { id: "min-path-sum-java", lang: "java", time: "O(n × m)", space: "O(n × m)", code: `
class Solution {
    public int minPathSum(int[][] grid) {
        int n = grid.length, m = grid[0].length;
        int[][] dp = new int[n][m];
        for (int i = 0; i < n; i++)
            for (int j = 0; j < m; j++) {
                if (i == 0 && j == 0) dp[i][j] = grid[i][j];
                else if (i == 0) dp[i][j] = dp[i][j - 1] + grid[i][j];
                else if (j == 0) dp[i][j] = dp[i - 1][j] + grid[i][j];
                else dp[i][j] = Math.min(dp[i - 1][j], dp[i][j - 1]) + grid[i][j];
            }
        return dp[n - 1][m - 1];
    }
}` },
  { id: "combination-sum-py", lang: "python", time: "O(2^n)", space: "O(n)", code: `
def combinationSum(candidates, target):
    res = []
    def bt(start, remain, path):
        if remain == 0:
            res.append(path[:])
            return
        for i in range(start, len(candidates)):
            if candidates[i] <= remain:
                path.append(candidates[i])
                bt(i, remain - candidates[i], path)
                path.pop()
    bt(0, target, [])
    return res
` },
  { id: "generate-parens-cpp", lang: "cpp", time: "O(2^n)", space: "O(n)", code: `
void gen(int open, int close, int n, string& cur, vector<string>& out) {
    if (cur.size() == 2 * n) { out.push_back(cur); return; }
    if (open < n) { cur.push_back('('); gen(open + 1, close, n, cur, out); cur.pop_back(); }
    if (close < open) { cur.push_back(')'); gen(open, close + 1, n, cur, out); cur.pop_back(); }
}
vector<string> generateParenthesis(int n) {
    vector<string> out;
    string cur;
    gen(0, 0, n, cur, out);
    return out;
}` },
  { id: "letter-combos-py", lang: "python", time: "O(4^n)", timeAlt: ["O(n × 4^n)", "O(2^n)"], space: "O(n)", code: `
def letterCombinations(digits):
    if not digits:
        return []
    phone = {'2': 'abc', '3': 'def', '4': 'ghi', '5': 'jkl', '6': 'mno', '7': 'pqrs', '8': 'tuv', '9': 'wxyz'}
    res = []
    def bt(i, path):
        if i == len(digits):
            res.append(''.join(path))
            return
        for ch in phone[digits[i]]:
            path.append(ch)
            bt(i + 1, path)
            path.pop()
    bt(0, [])
    return res
` },
  { id: "word-search-cpp", lang: "cpp", time: "O(n × m × 4^L)", timeAlt: ["O(4^n)", "O(3^n)", "O(2^n)"], space: "O(n)", spaceAlt: ["O(L)"], code: `
bool dfs(vector<vector<char>>& b, const string& w, int i, int r, int c) {
    if (i == w.size()) return true;
    if (r < 0 || c < 0 || r >= b.size() || c >= b[0].size() || b[r][c] != w[i]) return false;
    char saved = b[r][c];
    b[r][c] = '#';
    bool found = dfs(b, w, i + 1, r + 1, c) || dfs(b, w, i + 1, r - 1, c) ||
                 dfs(b, w, i + 1, r, c + 1) || dfs(b, w, i + 1, r, c - 1);
    b[r][c] = saved;
    return found;
}
bool exist(vector<vector<char>>& board, string word) {
    for (int r = 0; r < board.size(); r++)
        for (int c = 0; c < board[0].size(); c++)
            if (dfs(board, word, 0, r, c)) return true;
    return false;
}` },
  { id: "topo-kahn-java", lang: "java", time: "O(V + E)", space: "O(n)", code: `
class Solution {
    public boolean canFinish(int n, int[][] prereq) {
        List<List<Integer>> adj = new ArrayList<>();
        for (int i = 0; i < n; i++) adj.add(new ArrayList<>());
        int[] indeg = new int[n];
        for (int[] p : prereq) { adj.get(p[1]).add(p[0]); indeg[p[0]]++; }
        Queue<Integer> q = new LinkedList<>();
        for (int i = 0; i < n; i++) if (indeg[i] == 0) q.offer(i);
        int done = 0;
        while (!q.isEmpty()) {
            int u = q.poll();
            done++;
            for (int v : adj.get(u)) if (--indeg[v] == 0) q.offer(v);
        }
        return done == n;
    }
}` },
  { id: "kth-smallest-sorted-py", lang: "python", time: "O(n log n)", space: "O(n)", code: `
def kthSmallest(nums, k):
    return sorted(nums)[k - 1]
` },
  { id: "top-k-frequent-py", lang: "python", time: "O(n log n)", timeAlt: ["O(n log k)", "O(n)"], space: "O(n)", code: `
import heapq
from collections import Counter
def topKFrequent(nums, k):
    counts = Counter(nums)
    return heapq.nlargest(k, counts.keys(), key=counts.get)
` },
  { id: "transpose-inplace-cpp", lang: "cpp", time: "O(n^2)", space: "O(1)", code: `
void transpose(vector<vector<int>>& m) {
    int n = m.size();
    for (int i = 0; i < n; i++)
        for (int j = i + 1; j < n; j++)
            swap(m[i][j], m[j][i]);
}` },
  { id: "remove-dups-java", lang: "java", time: "O(n)", space: "O(1)", code: `
class Solution {
    public int removeDuplicates(int[] nums) {
        if (nums.length == 0) return 0;
        int w = 1;
        for (int i = 1; i < nums.length; i++)
            if (nums[i] != nums[i - 1]) nums[w++] = nums[i];
        return w;
    }
}` },
  { id: "fib-dp-array-py", lang: "python", time: "O(n)", space: "O(n)", code: `
def fib(n):
    if n < 2:
        return n
    dp = [0] * (n + 1)
    dp[1] = 1
    for i in range(2, n + 1):
        dp[i] = dp[i - 1] + dp[i - 2]
    return dp[n]
` },
  { id: "power-of-two-c", lang: "c", time: "O(log n)", space: "O(1)", code: `
int isPowerOfTwo(int n) {
    if (n <= 0) return 0;
    while (n % 2 == 0) n /= 2;
    return n == 1;
}` },
  { id: "reverse-words-py", lang: "python", time: "O(n)", space: "O(n)", code: `
def reverseWords(s):
    words = s.split()
    words.reverse()
    return ' '.join(words)
` },
  { id: "cycle-floyd-cpp", lang: "cpp", time: "O(n)", space: "O(1)", code: `
bool hasCycle(ListNode* head) {
    ListNode *slow = head, *fast = head;
    while (fast && fast->next) {
        slow = slow->next;
        fast = fast->next->next;
        if (slow == fast) return true;
    }
    return false;
}` },
  { id: "merge-intervals-cpp", lang: "cpp", time: "O(n log n)", space: "O(1)", spaceAlt: ["O(log n)", "O(n)"], code: `
vector<vector<int>> merge(vector<vector<int>>& iv) {
    sort(iv.begin(), iv.end());
    vector<vector<int>> res;
    for (auto& cur : iv) {
        if (res.empty() || res.back()[1] < cur[0]) res.push_back(cur);
        else res.back()[1] = max(res.back()[1], cur[1]);
    }
    return res;
}` },
  { id: "count-inversions-mergesort-py", lang: "python", time: "O(n log n)", space: "O(n)", code: `
def count_inversions(a):
    if len(a) <= 1:
        return a, 0
    mid = len(a) // 2
    left, x = count_inversions(a[:mid])
    right, y = count_inversions(a[mid:])
    merged, inv, i, j = [], x + y, 0, 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            merged.append(left[i]); i += 1
        else:
            merged.append(right[j]); j += 1
            inv += len(left) - i
    merged += left[i:] + right[j:]
    return merged, inv
` },
  { id: "compress-java", lang: "java", time: "O(n)", space: "O(1)", code: `
class Solution {
    public int compress(char[] chars) {
        int w = 0, i = 0;
        while (i < chars.length) {
            char c = chars[i];
            int j = i;
            while (j < chars.length && chars[j] == c) j++;
            chars[w++] = c;
            if (j - i > 1) for (char d : Integer.toString(j - i).toCharArray()) chars[w++] = d;
            i = j;
        }
        return w;
    }
}` },
  { id: "find-peak-js", lang: "javascript", time: "O(log n)", space: "O(1)", code: `
function findPeakElement(nums) {
  let lo = 0, hi = nums.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (nums[mid] < nums[mid + 1]) lo = mid + 1; else hi = mid;
  }
  return lo;
}` },
  { id: "rotting-oranges-py", lang: "python", time: "O(n × m)", space: "O(n × m)", code: `
from collections import deque
def orangesRotting(grid):
    rows, cols = len(grid), len(grid[0])
    q = deque()
    fresh = 0
    for r in range(rows):
        for c in range(cols):
            if grid[r][c] == 2:
                q.append((r, c, 0))
            elif grid[r][c] == 1:
                fresh += 1
    minutes = 0
    while q:
        r, c, t = q.popleft()
        minutes = max(minutes, t)
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nr, nc = r + dr, c + dc
            if 0 <= nr < rows and 0 <= nc < cols and grid[nr][nc] == 1:
                grid[nr][nc] = 2
                fresh -= 1
                q.append((nr, nc, t + 1))
    return minutes if fresh == 0 else -1
` },
  { id: "climb-naive-js", lang: "javascript", time: "O(2^n)", space: "O(n)", code: `
function climbStairs(n) {
  if (n <= 2) return n;
  return climbStairs(n - 1) + climbStairs(n - 2);
}` },
  { id: "hanoi-cpp", lang: "cpp", time: "O(2^n)", space: "O(n)", code: `
void hanoi(int n, char from, char to, char via, vector<string>& moves) {
    if (n == 0) return;
    hanoi(n - 1, from, via, to, moves);
    moves.push_back(string(1, from) + "->" + to);
    hanoi(n - 1, via, to, from, moves);
}` },
  { id: "string-builder-loop-java", lang: "java", time: "O(n)", space: "O(n)", code: `
class Solution {
    public String toLowerCase(String s) {
        StringBuilder sb = new StringBuilder();
        for (char c : s.toCharArray()) sb.append(Character.toLowerCase(c));
        return sb.toString();
    }
}` },
];
