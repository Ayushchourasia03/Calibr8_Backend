// src/profiling/profileHarness.js
//
// Generic profiling harness for compiled languages (C/C++). It is appended to
// a program (problem header + user code + problem-specific profiling driver)
// and runs inside ONE CodeBox sandbox, so the program is compiled once.
//
// Input (stdin):
//   "C8PF1 <runCount> <timeLimitMs> <budgetMs> <stopAboveCpuMs> <payloadBytes>\n"
//   then per run: "<repetitions> <tag>\n<inputLength>\n<inputBytes>"
//   (inputLength -1 = reuse the previous run's input; no bytes follow)
// Each run's input is sent once and executed <repetitions> times, every time in
// a fresh fork()ed process (clean heap/RSS for each measurement). The tag is
// passed to the driver in the C8_TAG environment variable (e.g. "user" or
// "baseline") - the harness itself knows nothing about problems.
//
// Runs are expected in increasing input size. The harness stops after the
// first run in which an invocation fails (crash, non-zero exit, timeout) or
// uses more than <stopAboveCpuMs> CPU, because larger inputs would only be
// slower; and it stops before the sandbox's own limit would kill it.
//
// Output: "C8PF1 <runCount>\n", then per invocation
//   "#P <run> <rep> <exitCode> <signal> <cpuMs> <wallMs> <maxRssKb> <outLen> <errLen>\n<out><err>"
// and finally "#PEND <reason>\n" (reason: done | failed | slow | budget).
// Children run in their own process group, which is SIGKILLed afterwards, with
// both an in-child timer and a parent-side watchdog (same model as the judge's
// multi-case harness).

export const PROFILE_MAGIC = "C8PF1";

const WATCHDOG_GRACE_MS = 1000;

const PROFILE_HARNESS_C = String.raw`
/* ---- Calibr8 profiling harness (compile once, fork per measurement) ---- */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/time.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <sys/types.h>
#include <sys/syscall.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <errno.h>

#ifndef PR_SET_CHILD_SUBREAPER
#define PR_SET_CHILD_SUBREAPER 36
#endif
#ifndef MAP_ANONYMOUS
#define MAP_ANONYMOUS 0x20
#endif

static volatile sig_atomic_t c8p__alarm = 0;
static void c8p__onalarm(int s) { (void)s; c8p__alarm = 1; }

static int c8p__memfd(void) {
#ifdef SYS_memfd_create
  int fd = (int)syscall(SYS_memfd_create, "c8p", 0);
  if (fd >= 0) return fd;
#endif
  FILE* f = tmpfile();
  return f ? dup(fileno(f)) : -1;
}

static void c8p__wall(int fd, const void* buf, size_t n) {
  const char* p = (const char*)buf;
  while (n > 0) { ssize_t w = write(fd, p, n); if (w <= 0) return; p += w; n -= (size_t)w; }
}

static char* c8p__slurp(int fd, size_t* outLen, size_t cap) {
  off_t len = lseek(fd, 0, SEEK_END);
  if (len < 0) len = 0;
  size_t n = (size_t)len < cap ? (size_t)len : cap;
  char* buf = (char*)malloc(n + 1);
  lseek(fd, 0, SEEK_SET);
  size_t got = 0;
  while (got < n) { ssize_t r = read(fd, buf + got, n - got); if (r <= 0) break; got += (size_t)r; }
  *outLen = got;
  return buf;
}

static void c8p__arm(long ms) {
  struct itimerval it;
  memset(&it, 0, sizeof it);
  it.it_value.tv_sec = ms / 1000;
  it.it_value.tv_usec = (ms % 1000) * 1000;
  setitimer(ITIMER_REAL, &it, NULL);
}

static long c8p__since(const struct timeval* a) {
  struct timeval now;
  gettimeofday(&now, NULL);
  return (now.tv_sec - a->tv_sec) * 1000 + (now.tv_usec - a->tv_usec) / 1000;
}

__attribute__((constructor(101))) static void c8p__harness(void) {
  char line[256];
  size_t ll = 0;
  while (ll < sizeof line - 1) {
    char ch;
    ssize_t r = read(0, &ch, 1);
    if (r <= 0 || ch == '\n') break;
    line[ll++] = ch;
  }
  line[ll] = 0;
  if (strncmp(line, "C8PF1 ", 6) != 0) _exit(97);
  char* p = line + 6;
  long runs = strtol(p, &p, 10);
  long tl = strtol(p, &p, 10);
  long budget = strtol(p, &p, 10);
  long stopAbove = strtol(p, &p, 10);
  long total = strtol(p, &p, 10);
  if (tl <= 0) tl = 2000;
  if (total < 0) total = 0;

  size_t mapLen = (size_t)total + 1;
  char* in = (char*)mmap(NULL, mapLen, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (in == (char*)MAP_FAILED) _exit(98);
  size_t len = 0;
  while (len < (size_t)total) {
    ssize_t r = read(0, in + len, (size_t)total - len);
    if (r <= 0) break;
    len += (size_t)r;
  }
  char* cur = in;
  char* end = in + len;

  prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = c8p__onalarm;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = 0;
  sigaction(SIGALRM, &sa, NULL);

  char hdr[256];
  int n0 = snprintf(hdr, sizeof hdr, "C8PF1 %ld\n", runs);
  c8p__wall(1, hdr, (size_t)n0);

  struct timeval start;
  gettimeofday(&start, NULL);
  const char* reason = "done";
  char* prevInput = in;
  long prevLen = 0;

  for (long run = 0; run < runs; run++) {
    long reps = strtol(cur, &cur, 10);
    while (cur < end && *cur == ' ') cur++;
    char tag[64];
    size_t tl2 = 0;
    while (cur < end && *cur != '\n' && tl2 < sizeof tag - 1) tag[tl2++] = *cur++;
    tag[tl2] = 0;
    while (cur < end && *cur != '\n') cur++;
    if (cur < end) cur++;
    long clen = strtol(cur, &cur, 10);
    if (cur < end && *cur == '\n') cur++;
    char* input;
    if (clen == -1) {
      /* Reuse the previous run's input (sent once, saves request size). */
      input = prevInput;
      clen = prevLen;
    } else {
      if (clen < 0 || cur + clen > end) clen = 0;
      input = cur;
      cur += clen;
    }
    prevInput = input;
    prevLen = clen;
    if (reps < 1) reps = 1;

    int stop = 0;
    for (long rep = 0; rep < reps; rep++) {
      if (budget > 0 && c8p__since(&start) + tl + WATCHDOG_MS_PLACEHOLDER + 400 > budget) { reason = "budget"; stop = 1; break; }
      int inFd = c8p__memfd(), outFd = c8p__memfd(), errFd = c8p__memfd();
      c8p__wall(inFd, input, (size_t)clen);
      lseek(inFd, 0, SEEK_SET);
      while (waitpid(-1, NULL, WNOHANG) > 0) {}

      struct timeval t0, t1;
      gettimeofday(&t0, NULL);
      fflush(NULL);
      pid_t pid = fork();
      if (pid == 0) {
        setpgid(0, 0);
        signal(SIGALRM, SIG_DFL);
        setenv("C8_TAG", tag, 1);
        dup2(inFd, 0); dup2(outFd, 1); dup2(errFd, 2);
        close(inFd); close(outFd); close(errFd);
        munmap(in, mapLen);
        struct rlimit rl;
        rl.rlim_cur = (rlim_t)((tl + 999) / 1000 + 1);
        rl.rlim_max = rl.rlim_cur + 1;
        setrlimit(RLIMIT_CPU, &rl);
        c8p__arm(tl + 300);
        return; /* run the profiling driver's main() */
      }

      int status = 0, killed = 0;
      struct rusage ru;
      memset(&ru, 0, sizeof ru);
      if (pid < 0) {
        status = -1;
      } else {
        setpgid(pid, pid);
        c8p__alarm = 0;
        c8p__arm(tl + WATCHDOG_MS_PLACEHOLDER);
        for (;;) {
          pid_t w = wait4(pid, &status, 0, &ru);
          if (w == pid) break;
          if (w < 0 && errno == EINTR) {
            if (c8p__alarm && !killed) { kill(-pid, SIGKILL); kill(pid, SIGKILL); killed = 1; }
            continue;
          }
          status = -1;
          break;
        }
        c8p__arm(0);
        kill(-pid, SIGKILL);
      }
      gettimeofday(&t1, NULL);

      long cpuMs = ru.ru_utime.tv_sec * 1000 + ru.ru_utime.tv_usec / 1000
                 + ru.ru_stime.tv_sec * 1000 + ru.ru_stime.tv_usec / 1000;
      long wallMs = (t1.tv_sec - t0.tv_sec) * 1000 + (t1.tv_usec - t0.tv_usec) / 1000;
      int exitCode = 0, sig = 0;
      if (pid < 0 || status == -1) exitCode = 1;
      else if (WIFEXITED(status)) exitCode = WEXITSTATUS(status);
      else if (WIFSIGNALED(status)) { sig = WTERMSIG(status); exitCode = 128 + sig; }
      if (killed && sig == 0) { sig = SIGKILL; exitCode = 128 + SIGKILL; }

      size_t olen = 0, elen = 0;
      char* out = c8p__slurp(outFd, &olen, 1u << 16);
      char* err = c8p__slurp(errFd, &elen, 2048);
      close(inFd); close(outFd); close(errFd);
      n0 = snprintf(hdr, sizeof hdr, "#P %ld %ld %d %d %ld %ld %ld %zu %zu\n",
                    run, rep, exitCode, sig, cpuMs, wallMs, (long)ru.ru_maxrss, olen, elen);
      c8p__wall(1, hdr, (size_t)n0);
      c8p__wall(1, out, olen);
      c8p__wall(1, err, elen);
      free(out); free(err);

      if (exitCode != 0 || sig != 0 || killed || cpuMs > tl) { reason = "failed"; stop = 1; break; }
      if (stopAbove > 0 && cpuMs > stopAbove) { reason = "slow"; stop = 1; }
    }
    if (stop) break;
  }
  while (waitpid(-1, NULL, WNOHANG) > 0) {}
  n0 = snprintf(hdr, sizeof hdr, "#PEND %s\n", reason);
  c8p__wall(1, hdr, (size_t)n0);
  munmap(in, mapLen);
  _exit(0);
}
/* ---- end profiling harness ---- */
`.replaceAll("WATCHDOG_MS_PLACEHOLDER", String(WATCHDOG_GRACE_MS));

/** Appends the profiling harness to a complete program (C sources get _GNU_SOURCE). */
export function wrapWithProfileHarness(fullCode, language = "cpp") {
  const prefix = language === "c" ? "#define _GNU_SOURCE 1\n" : "";
  return `${prefix}${fullCode}\n${PROFILE_HARNESS_C}\n`;
}

/**
 * Builds the harness stdin.
 * @param {Array<{ input?: string, reusePrevious?: boolean, repetitions: number, tag: string }>} runs
 *   in increasing size order; reusePrevious sends the previous run's input again
 *   without repeating its bytes.
 */
export function buildProfileStdin(runs, { timeLimitMs, budgetMs, stopAboveCpuMs }) {
  const body = [];
  runs.forEach((run, i) => {
    if (!/^[A-Za-z0-9_.:-]{1,63}$/.test(run.tag)) throw new Error(`Invalid profiling tag: ${run.tag}`);
    const head = `${Math.max(1, run.repetitions | 0)} ${run.tag}\n`;
    if (run.reusePrevious && i > 0) {
      body.push(Buffer.from(`${head}-1\n`));
      return;
    }
    const b = Buffer.from(String(run.input ?? ""), "utf-8");
    body.push(Buffer.from(`${head}${b.length}\n`), b);
  });
  const payload = Buffer.concat(body);
  const header = Buffer.from(
    `${PROFILE_MAGIC} ${runs.length} ${Math.round(timeLimitMs)} ${Math.round(budgetMs)} ${Math.round(stopAboveCpuMs)} ${payload.length}\n`,
  );
  return Buffer.concat([header, payload]);
}

/**
 * Parses the harness report.
 * @returns {{ invocations: Array<object>, endReason: string|null } | null}
 */
export function parseProfileOutput(stdoutBuf) {
  const buf = Buffer.isBuffer(stdoutBuf) ? stdoutBuf : Buffer.from(stdoutBuf || "", "utf-8");
  const head = `${PROFILE_MAGIC} `;
  if (buf.subarray(0, head.length).toString() !== head) return null;
  let pos = buf.indexOf(0x0a);
  if (pos < 0) return null;
  pos += 1;
  const invocations = [];
  let endReason = null;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const line = buf.subarray(pos, nl).toString();
    const endMatch = /^#PEND (\w+)$/.exec(line);
    if (endMatch) {
      endReason = endMatch[1];
      break;
    }
    const m = /^#P (\d+) (\d+) (-?\d+) (\d+) (-?\d+) (-?\d+) (-?\d+) (\d+) (\d+)$/.exec(line);
    if (!m) break;
    const [, run, rep, exitCode, signal, cpuMs, wallMs, maxRssKb, olen, elen] = m.map(Number);
    const outStart = nl + 1;
    const errStart = outStart + olen;
    const end = errStart + elen;
    if (end > buf.length) break;
    invocations.push({
      run,
      rep,
      exitCode,
      signal,
      cpuMs,
      wallMs,
      maxRssKb,
      stdout: buf.subarray(outStart, errStart).toString("utf-8"),
      stderr: buf.subarray(errStart, end).toString("utf-8"),
    });
    pos = end;
  }
  return { invocations, endReason };
}
