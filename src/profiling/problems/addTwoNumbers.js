// src/profiling/problems/addTwoNumbers.js
//
// Complexity-profiling definition for "Add Two Numbers" (linked lists of
// digits in reverse order). Provides the input generator/validator and the
// C++ profiling driver that replaces the judge's main().

import { CPP_ALLOC_COUNTER, CPP_TIMING_HELPERS } from "./cppDriverCommon.js";

/** Deterministic PRNG so profiling inputs are reproducible. */
function makeRng(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Profiling inputs use a compact form of the problem's input format - the
// digits of each list without separators - to keep CodeBox requests small.
function digitsToLine(digits) {
  return digits.join("");
}

/**
 * Input patterns (compact format: "n m\n<l1 digits>\n<l2 digits>", one char per digit).
 *   max-carry: both lists all 9s -> a carry at every position and an output of
 *              n+1 nodes. This is the worst case for this problem: every
 *              correct algorithm must read every digit and write n+1 nodes.
 *   random:    random digits, equal lengths.
 *   unequal:   l2 is half as long (exercises the "one list ended" branch).
 */
export function generateInput(size, pattern = "max-carry", seed = 12345) {
  const n = Math.max(1, Math.floor(size));
  const rng = makeRng(seed + n);
  const randomDigits = (len) => {
    const d = Array.from({ length: len }, () => Math.floor(rng() * 10));
    if (len > 1 && d[len - 1] === 0) d[len - 1] = 1 + Math.floor(rng() * 9);
    return d;
  };
  let l1;
  let l2;
  switch (pattern) {
    case "max-carry":
      l1 = "9".repeat(n);
      l2 = l1;
      return `${n} ${n}\n${l1}\n${l2}\n`;
    case "random":
      l1 = randomDigits(n);
      l2 = randomDigits(n);
      return `${n} ${n}\n${digitsToLine(l1)}\n${digitsToLine(l2)}\n`;
    case "unequal": {
      const m = Math.max(1, Math.ceil(n / 2));
      l1 = randomDigits(n);
      l2 = randomDigits(m);
      return `${n} ${m}\n${digitsToLine(l1)}\n${digitsToLine(l2)}\n`;
    }
    default:
      throw new Error(`Unknown Add Two Numbers pattern: ${pattern}`);
  }
}

/** Validates an input against the problem's format and digit constraints. */
export function validateInput(stdin) {
  const lines = String(stdin).trim().split("\n");
  if (lines.length !== 3) return { ok: false, reason: "expected 3 lines" };
  const [n, m] = lines[0].trim().split(/\s+/).map(Number);
  if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < 1) {
    return { ok: false, reason: "invalid list lengths" };
  }
  const lists = [lines[1].trim(), lines[2].trim()];
  for (const [i, list] of lists.entries()) {
    const expected = i === 0 ? n : m;
    if (list.length !== expected) return { ok: false, reason: `list ${i + 1} has ${list.length} digits, header says ${expected}` };
    if (!/^[0-9]+$/.test(list)) return { ok: false, reason: `list ${i + 1} contains a non-digit` };
    // Reverse order: the last digit is the most significant one.
    if (list.length > 1 && list[list.length - 1] === "0") return { ok: false, reason: `list ${i + 1} has a leading zero` };
  }
  return { ok: true, size: Math.max(n, m) };
}

// Replaces the judge footer. Input building, reference computation, output
// verification and printing all happen outside the timed interval.
const DRIVER_CPP = String.raw`
/* ---- Calibr8 complexity-profiling driver: Add Two Numbers ---- */
${CPP_ALLOC_COUNTER}
${CPP_TIMING_HELPERS}

static ListNode* c8_baseline_addTwoNumbers(ListNode* a, ListNode* b) { (void)a; (void)b; return nullptr; }

// Reference O(n) implementation, timed on the same inputs as the solution. It
// has the same memory behaviour as a typical solution (reads both lists,
// allocates n+1 nodes), so cache and page-fault effects cancel in the ratio.
__attribute__((noinline)) static ListNode* c8_reference_addTwoNumbers(ListNode* l1, ListNode* l2) {
  ListNode d(0);
  ListNode* t = &d;
  int c = 0;
  while (l1 || l2 || c) {
    int s = c;
    if (l1) { s += l1->val; l1 = l1->next; }
    if (l2) { s += l2->val; l2 = l2->next; }
    t->next = new ListNode(s % 10);
    t = t->next;
    c = s / 10;
  }
  return d.next;
}

static ListNode* c8_build(const std::vector<int>& digits, std::vector<ListNode*>* nodes) {
  ListNode* head = nullptr;
  ListNode* tail = nullptr;
  for (int d : digits) {
    ListNode* x = new ListNode(d);
    if (nodes) nodes->push_back(x);
    if (tail) tail->next = x; else head = x;
    tail = x;
  }
  return head;
}

int main() {
  const char* tag = std::getenv("C8_TAG");
  const bool baseline = tag && std::strcmp(tag, "baseline") == 0;
  int n = 0, m = 0;
  if (std::scanf("%d %d", &n, &m) != 2 || n < 1 || m < 1) return 3;
  std::vector<int> a(n), b(m);
  auto readDigits = [](std::vector<int>& v) {
    int ch = std::getchar();
    while (ch == '\n' || ch == '\r' || ch == ' ') ch = std::getchar();
    for (std::size_t i = 0; i < v.size(); i++, ch = std::getchar()) {
      if (ch < '0' || ch > '9') return false;
      v[i] = ch - '0';
    }
    return true;
  };
  if (!readDigits(a) || !readDigits(b)) return 3;

  std::vector<int> ref;
  ref.reserve((size_t)std::max(n, m) + 1);
  for (int i = 0, c = 0; i < std::max(n, m) || c; i++) {
    int s = c + (i < n ? a[i] : 0) + (i < m ? b[i] : 0);
    ref.push_back(s % 10);
    c = s / 10;
  }

  std::vector<ListNode*> inputNodes;
  inputNodes.reserve((size_t)n + (size_t)m);
  ListNode* l1 = c8_build(a, &inputNodes);
  ListNode* l2 = c8_build(b, &inputNodes);
  const long long timerOverhead = c8_timer_overhead_ns();

  // --- measured call ---
  unsigned char* const stackTop = c8_prepare_stack();
  unsigned char* const stackOrigin = static_cast<unsigned char*>(__builtin_frame_address(0));
  const long rssBefore = c8_peak_rss_kb();
  const std::size_t liveBefore = c8prof::live;
  c8prof::peak = liveBefore;
  const long long w0 = c8_now_ns(CLOCK_MONOTONIC);
  const long long cpu0 = c8_now_ns(CLOCK_PROCESS_CPUTIME_ID);
  ListNode* res = baseline ? c8_baseline_addTwoNumbers(l1, l2) : addTwoNumbers(l1, l2);
  const long long cpu1 = c8_now_ns(CLOCK_PROCESS_CPUTIME_ID);
  const long long w1 = c8_now_ns(CLOCK_MONOTONIC);
  const std::size_t heapPeak = c8prof::peak - liveBefore;
  const long rssAfter = c8_peak_rss_kb();
  const std::size_t stackUsed = c8_stack_used(stackTop, stackOrigin);
  // --- end measured call ---

  // Verify the result and split output nodes into reused input nodes and new ones.
  std::sort(inputNodes.begin(), inputNodes.end());
  std::size_t outNodes = 0, newOutNodes = 0;
  bool ok = true;
  const std::size_t cap = ref.size() + 2;
  for (ListNode* q = res; q && outNodes < cap; q = q->next, outNodes++) {
    if (outNodes >= ref.size() || q->val != ref[outNodes]) ok = false;
    if (!std::binary_search(inputNodes.begin(), inputNodes.end(), q)) newOutNodes++;
  }
  if (outNodes != ref.size()) ok = false;
  if (baseline) ok = true;

  // More calls on freshly built inputs (built outside the timer), alternating
  // solution and reference so both see the same machine conditions. The
  // median per-call time of each is reported.
  std::vector<long long> samples, refSamples;
  samples.push_back(w1 - w0);
  if (!baseline) {
    for (int k = 0; k < 3; k++) { // the reference is O(n): always cheap
      ListNode* y1 = c8_build(a, nullptr);
      ListNode* y2 = c8_build(b, nullptr);
      const long long r0 = c8_now_ns(CLOCK_MONOTONIC);
      ListNode* volatile rr = c8_reference_addTwoNumbers(y1, y2);
      const long long r1 = c8_now_ns(CLOCK_MONOTONIC);
      (void)rr;
      refSamples.push_back(r1 - r0);
    }
    long long timed = w1 - w0;
    const long long loopStart = c8_now_ns(CLOCK_MONOTONIC);
    while (timed < 40000000LL && samples.size() < 51 && c8_now_ns(CLOCK_MONOTONIC) - loopStart < 250000000LL) {
      ListNode* y1 = c8_build(a, nullptr);
      ListNode* y2 = c8_build(b, nullptr);
      const long long r0 = c8_now_ns(CLOCK_MONOTONIC);
      ListNode* volatile rr = c8_reference_addTwoNumbers(y1, y2);
      const long long r1 = c8_now_ns(CLOCK_MONOTONIC);
      (void)rr;
      refSamples.push_back(r1 - r0);
      ListNode* x1 = c8_build(a, nullptr);
      ListNode* x2 = c8_build(b, nullptr);
      const long long s0 = c8_now_ns(CLOCK_MONOTONIC);
      ListNode* volatile r = addTwoNumbers(x1, x2);
      const long long s1 = c8_now_ns(CLOCK_MONOTONIC);
      (void)r;
      samples.push_back(s1 - s0);
      timed += (s1 - s0) + (r1 - r0);
    }
  }
  std::vector<long long> sorted = samples;
  std::sort(sorted.begin(), sorted.end());
  const long long medianNs = sorted[sorted.size() / 2];
  std::sort(refSamples.begin(), refSamples.end());
  const long long refMedianNs = refSamples.empty() ? 0 : refSamples[refSamples.size() / 2];

  std::printf(
    "C8M v=1 ok=%d n=%d m=%d first_ns=%lld cpu_ns=%lld median_ns=%lld min_ns=%lld calls=%zu timer_ns=%lld "
    "heap_peak=%zu out_nodes=%zu new_out_nodes=%zu node_bytes=%zu rss_before_kb=%ld rss_after_kb=%ld stack_bytes=%zu ref_median_ns=%lld\n",
    ok ? 1 : 0, n, m, w1 - w0, cpu1 - cpu0, medianNs, sorted.front(), samples.size(), timerOverhead,
    heapPeak, outNodes, newOutNodes, sizeof(ListNode), rssBefore, rssAfter, stackUsed, refMedianNs);
  return 0;
}
/* ---- end profiling driver ---- */
`;

export const addTwoNumbersProfile = {
  slug: "add-two-numbers",
  title: "Add Two Numbers",
  // Doubling sizes (they stay aligned with allocation-doubling patterns such
  // as std::vector growth; non-doubling ladders turn those into steps).
  // Filtered by COMPLEXITY_PROFILING_MAX_INPUT_SIZE: the default 16000 gives
  // 7 sizes over a 64x range while keeping the working set (cache effects)
  // and the CodeBox request small.
  sizes: [250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000],
  pattern: "max-carry",
  worstCase: true,
  worstCaseNote: "All-9 digit lists: a carry at every position and an n+1 node result.",
  // The driver times a reference implementation of this class on the same inputs.
  referenceComplexity: "O(n)",
  generateInput,
  validateInput,
  drivers: { cpp: DRIVER_CPP },
  // Output nodes created by the solution are reported as output space, not auxiliary.
  outputSpace: "O(n)",
};
