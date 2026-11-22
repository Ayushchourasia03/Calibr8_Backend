// src/profiling/problems/selfTestArray.js
//
// Test-only profiling definition used to validate the profiler engine against
// implementations of known complexity (O(1), O(log n), O(n), O(n log n), O(n²)).
// User code defines:   long long c8solve(std::vector<int>& a);
// It is not linked to any real problem and is never offered to users.

import { CPP_ALLOC_COUNTER, CPP_TIMING_HELPERS } from "./cppDriverCommon.js";

export function generateInput(size, pattern = "random", seed = 777) {
  const n = Math.max(1, Math.floor(size));
  let s = (seed + n) >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  let values;
  if (pattern === "sorted") values = Array.from({ length: n }, (_, i) => i * 2);
  else values = Array.from({ length: n }, () => Math.floor(rnd() * 1e5)); // small numbers keep requests small
  return `${n}\n${values.join(" ")}\n`;
}

export function validateInput(stdin) {
  const [head, body = ""] = String(stdin).trim().split("\n");
  const n = Number(head);
  const vals = body.trim() ? body.trim().split(/\s+/) : [];
  if (!Number.isInteger(n) || n < 1 || vals.length !== n) return { ok: false, reason: "length mismatch" };
  return { ok: true, size: n };
}

const DRIVER_CPP = String.raw`
${CPP_ALLOC_COUNTER}
${CPP_TIMING_HELPERS}
static long long c8_baseline_solve(std::vector<int>& a) { (void)a; return 0; }
int main() {
  const char* tag = std::getenv("C8_TAG");
  const bool baseline = tag && std::strcmp(tag, "baseline") == 0;
  int n = 0;
  if (std::scanf("%d", &n) != 1 || n < 1) return 3;
  std::vector<int> input(n);
  for (int i = 0; i < n; i++) if (std::scanf("%d", &input[i]) != 1) return 3;
  const long long timerOverhead = c8_timer_overhead_ns();
  std::vector<int> work = input;
  unsigned char* const stackTop = c8_prepare_stack();
  unsigned char* const stackOrigin = static_cast<unsigned char*>(__builtin_frame_address(0));
  const long rssBefore = c8_peak_rss_kb();
  const std::size_t liveBefore = c8prof::live;
  c8prof::peak = liveBefore;
  const long long w0 = c8_now_ns(CLOCK_MONOTONIC);
  const long long cpu0 = c8_now_ns(CLOCK_PROCESS_CPUTIME_ID);
  volatile long long r = baseline ? c8_baseline_solve(work) : c8solve(work);
  const long long cpu1 = c8_now_ns(CLOCK_PROCESS_CPUTIME_ID);
  const long long w1 = c8_now_ns(CLOCK_MONOTONIC);
  const std::size_t heapPeak = c8prof::peak - liveBefore;
  const long rssAfter = c8_peak_rss_kb();
  const std::size_t stackUsed = c8_stack_used(stackTop, stackOrigin);
  (void)r;
  // Repeated calls get freshly perturbed data (outside the timer) so the branch
  // predictor cannot memorise one input; a linear reference pass is timed on
  // the same data for calibration.
  std::vector<long long> samples, refSamples;
  samples.push_back(w1 - w0);
  unsigned int mix = 2463534242u;
  auto perturb = [&](std::vector<int>& v) {
    v = input;
    mix ^= mix << 13; mix ^= mix >> 17; mix ^= mix << 5;
    if (!std::is_sorted(input.begin(), input.end())) {
      for (auto& x : v) x ^= static_cast<int>(mix & 0x3fffffffu);
    }
  };
  auto timeRef = [&]() {
    perturb(work);
    const long long r0 = c8_now_ns(CLOCK_MONOTONIC);
    long long sum = 0;
    for (int x : work) sum += x;
    __asm__ volatile("" : : "r"(sum) : "memory");
    refSamples.push_back(c8_now_ns(CLOCK_MONOTONIC) - r0);
  };
  if (!baseline) {
    for (int k = 0; k < 3; k++) timeRef();
    long long timed = w1 - w0;
    const long long loopStart = c8_now_ns(CLOCK_MONOTONIC);
    while (timed < 40000000LL && samples.size() < 51 && c8_now_ns(CLOCK_MONOTONIC) - loopStart < 250000000LL) {
      timeRef();
      perturb(work);
      const long long s0 = c8_now_ns(CLOCK_MONOTONIC);
      volatile long long rr = c8solve(work);
      const long long s1 = c8_now_ns(CLOCK_MONOTONIC);
      (void)rr;
      samples.push_back(s1 - s0);
      timed += s1 - s0;
    }
  }
  std::sort(refSamples.begin(), refSamples.end());
  const long long refMedianNs = refSamples.empty() ? 0 : refSamples[refSamples.size() / 2];
  std::vector<long long> sorted = samples;
  std::sort(sorted.begin(), sorted.end());
  std::printf(
    "C8M v=1 ok=1 n=%d m=0 first_ns=%lld cpu_ns=%lld median_ns=%lld min_ns=%lld calls=%zu timer_ns=%lld "
    "heap_peak=%zu out_nodes=0 new_out_nodes=0 node_bytes=0 rss_before_kb=%ld rss_after_kb=%ld stack_bytes=%zu ref_median_ns=%lld\n",
    n, w1 - w0, cpu1 - cpu0, sorted[sorted.size() / 2], sorted.front(), samples.size(), timerOverhead,
    heapPeak, rssBefore, rssAfter, stackUsed, refMedianNs);
  return 0;
}
`;

export const selfTestArrayProfile = {
  slug: "__profiler-selftest-array",
  title: "Profiler self-test (array)",
  header: "#include <bits/stdc++.h>\nusing namespace std;\n",
  sizes: [1000, 2000, 4000, 8000, 16000, 32000],
  pattern: "random",
  worstCase: false,
  referenceComplexity: "O(n)",
  generateInput,
  validateInput,
  drivers: { cpp: DRIVER_CPP },
  outputSpace: "O(1)",
};
