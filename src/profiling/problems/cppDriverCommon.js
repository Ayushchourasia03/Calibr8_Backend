// src/profiling/problems/cppDriverCommon.js
//
// C++ snippets shared by profiling drivers.

// Counts live/peak heap bytes allocated through operator new/delete. Only
// C++ allocations are visible here (malloc() and the stack are not); the
// driver also reports peak RSS so those show up in the estimate.
export const CPP_ALLOC_COUNTER = String.raw`
#include <new>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <sys/resource.h>
namespace c8prof {
  static std::size_t live = 0;
  static std::size_t peak = 0;
}
static const std::size_t C8_ALLOC_HEADER = 16; // keeps 16-byte alignment
void* operator new(std::size_t n) {
  void* p = std::malloc(n + C8_ALLOC_HEADER);
  if (!p) throw std::bad_alloc();
  *static_cast<std::size_t*>(p) = n;
  c8prof::live += n;
  if (c8prof::live > c8prof::peak) c8prof::peak = c8prof::live;
  return static_cast<char*>(p) + C8_ALLOC_HEADER;
}
void* operator new[](std::size_t n) { return ::operator new(n); }
void* operator new(std::size_t n, const std::nothrow_t&) noexcept {
  try { return ::operator new(n); } catch (...) { return nullptr; }
}
void* operator new[](std::size_t n, const std::nothrow_t&) noexcept {
  try { return ::operator new(n); } catch (...) { return nullptr; }
}
void operator delete(void* p) noexcept {
  if (!p) return;
  char* base = static_cast<char*>(p) - C8_ALLOC_HEADER;
  c8prof::live -= *reinterpret_cast<std::size_t*>(base);
  std::free(base);
}
void operator delete[](void* p) noexcept { ::operator delete(p); }
void operator delete(void* p, std::size_t) noexcept { ::operator delete(p); }
void operator delete[](void* p, std::size_t) noexcept { ::operator delete(p); }
void operator delete(void* p, const std::nothrow_t&) noexcept { ::operator delete(p); }
void operator delete[](void* p, const std::nothrow_t&) noexcept { ::operator delete(p); }
`;

export const CPP_TIMING_HELPERS = String.raw`
static long long c8_now_ns(clockid_t clk) {
  timespec ts;
  clock_gettime(clk, &ts);
  return (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}
static long c8_peak_rss_kb() {
  rusage ru;
  getrusage(RUSAGE_SELF, &ru);
  return ru.ru_maxrss;
}
// Stack high-water mark: paint the stack below the caller with a pattern, run
// the measured call, then find the deepest byte that changed. Painting uses a
// chain of non-tail-recursive frames so the stack grows the normal way.
static const unsigned char C8_PAINT = 0xA5;
static const std::size_t C8_PAINT_FRAME = 65536;
static const std::size_t C8_PAINT_TOTAL = 16u << 20;
static unsigned char* c8_paint_low = nullptr;
__attribute__((noinline)) static void c8_paint_stack(std::size_t remaining) {
  unsigned char buf[C8_PAINT_FRAME];
  std::memset(buf, C8_PAINT, sizeof buf);
  __asm__ volatile("" : : "r"(buf) : "memory");
  if (!c8_paint_low || buf < c8_paint_low) c8_paint_low = buf;
  if (remaining > sizeof buf) c8_paint_stack(remaining - sizeof buf);
  __asm__ volatile("" : : "r"(buf) : "memory"); // keeps the recursion non-tail
}
// Maps C8_PAINT_TOTAL bytes of stack (frame chain), then paints the whole
// region contiguously - the chain alone leaves return addresses between
// frames. Returns the region's upper bound; it lies below the caller's frame.
__attribute__((noinline)) static unsigned char* c8_prepare_stack() {
  // Paint at most the stack limit minus a 2 MB safety margin.
  std::size_t total = C8_PAINT_TOTAL;
  rlimit rl;
  if (getrlimit(RLIMIT_STACK, &rl) == 0 && rl.rlim_cur != RLIM_INFINITY) {
    const std::size_t lim = static_cast<std::size_t>(rl.rlim_cur);
    total = lim > (3u << 20) ? std::min(total, lim - (2u << 20)) : C8_PAINT_FRAME;
  }
  c8_paint_stack(total);
  // Below this function's frame with room for memset's own frame. (Returning
  // the address of a local instead would be folded to NULL by GCC at -O2.)
  unsigned char* top = static_cast<unsigned char*>(__builtin_frame_address(0)) - 8192;
  if (c8_paint_low && top > c8_paint_low) std::memset(c8_paint_low, C8_PAINT, static_cast<std::size_t>(top - c8_paint_low));
  return top;
}
// Stack depth reached by the measured call, counted from 'origin' (the
// caller's frame) down to the deepest byte that changed below 'top'. Usage
// that never reached the painted region (a few KB) reports 0.
static std::size_t c8_stack_used(unsigned char* top, unsigned char* origin) {
  if (!c8_paint_low || top <= c8_paint_low) return 0;
  unsigned char* p = c8_paint_low;
  while (p < top && *p == C8_PAINT) p++;
  return (p < top && origin > p) ? static_cast<std::size_t>(origin - p) : 0;
}

// Median cost of one back-to-back pair of clock reads (subtracted from timings).
static long long c8_timer_overhead_ns() {
  long long d[101];
  for (int i = 0; i < 101; i++) {
    long long a = c8_now_ns(CLOCK_MONOTONIC);
    long long b = c8_now_ns(CLOCK_MONOTONIC);
    d[i] = b - a;
  }
  std::sort(d, d + 101);
  return d[50];
}
`;
