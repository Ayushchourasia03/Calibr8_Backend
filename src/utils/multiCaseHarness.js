// src/utils/multiCaseHarness.js
//
// Runs many testcases in ONE CodeBox submission for compiled languages (C/C++),
// so the program is compiled once instead of once per testcase.
//
// How it works: a constructor function (runs before main) reads all testcases
// from stdin, then for each case fork()s a child. The child gets that case's
// input as stdin and a fresh buffer as stdout, returns from the constructor and
// runs the problem's real main() unchanged. The parent waits, records
// status/time/memory/output, and finally prints a framed report.
// Each case still runs in its own process, so crashes, timeouts and global state
// stay isolated exactly like separate submissions.

export const HARNESS_MAGIC = "C8MC1";

const HARNESS_C = String.raw`
/* ---- Calibr8 multi-testcase harness (compile once, fork per case) ---- */
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
#include <errno.h>

static int c8__memfd(void) {
#ifdef SYS_memfd_create
  int fd = (int)syscall(SYS_memfd_create, "c8", 0);
  if (fd >= 0) return fd;
#endif
  FILE* f = tmpfile();
  return f ? dup(fileno(f)) : -1;
}

static void c8__wall(int fd, const void* buf, size_t n) {
  const char* p = (const char*)buf;
  while (n > 0) { ssize_t w = write(fd, p, n); if (w <= 0) return; p += w; n -= (size_t)w; }
}

static char* c8__slurp(int fd, size_t* outLen, size_t cap) {
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

__attribute__((constructor(101))) static void c8__harness(void) {
  /* Read all of stdin: "C8MC1 <timeLimitMs> <count>\n" then per case "<len>\n<bytes>" */
  size_t cap = 1 << 16, len = 0;
  char* in = (char*)malloc(cap);
  for (;;) {
    if (len == cap) { cap *= 2; in = (char*)realloc(in, cap); }
    ssize_t r = read(0, in + len, cap - len);
    if (r <= 0) break;
    len += (size_t)r;
  }
  if (len < 6 || memcmp(in, "C8MC1 ", 6) != 0) { free(in); _exit(97); }
  char* p = in + 6;
  long tl = strtol(p, &p, 10);
  long count = strtol(p, &p, 10);
  long budget = strtol(p, &p, 10); /* total wall ms allowed; 0 = unlimited */
  if (*p == '\n') p++;
  if (tl <= 0) tl = 2000;

  char hdr[160];
  int n0 = snprintf(hdr, sizeof hdr, "C8MC1 %ld\n", count);
  c8__wall(1, hdr, (size_t)n0);

  struct timeval start;
  gettimeofday(&start, NULL);

  for (long i = 0; i < count; i++) {
    if (budget > 0) {
      struct timeval now;
      gettimeofday(&now, NULL);
      long elapsed = (now.tv_sec - start.tv_sec) * 1000 + (now.tv_usec - start.tv_usec) / 1000;
      /* Stop cleanly before the sandbox kills us; unreported cases are re-run. */
      if (elapsed + tl + 400 > budget) break;
    }
    long clen = strtol(p, &p, 10);
    if (*p == '\n') p++;
    if (clen < 0 || p + clen > in + len) clen = 0;
    int inFd = c8__memfd(), outFd = c8__memfd(), errFd = c8__memfd();
    c8__wall(inFd, p, (size_t)clen);
    lseek(inFd, 0, SEEK_SET);
    p += clen;

    struct timeval t0, t1;
    gettimeofday(&t0, NULL);
    fflush(NULL);
    pid_t pid = fork();
    if (pid == 0) {
      dup2(inFd, 0); dup2(outFd, 1); dup2(errFd, 2);
      close(inFd); close(outFd); close(errFd);
      struct rlimit rl;
      rl.rlim_cur = (rlim_t)((tl + 999) / 1000 + 1);
      rl.rlim_max = rl.rlim_cur + 1;
      setrlimit(RLIMIT_CPU, &rl);
      struct itimerval it;
      memset(&it, 0, sizeof it);
      long wall = tl + 300;
      it.it_value.tv_sec = wall / 1000;
      it.it_value.tv_usec = (wall % 1000) * 1000;
      setitimer(ITIMER_REAL, &it, NULL);
      free(in);
      return; /* continue into static initializers and the real main() */
    }

    int status = 0;
    struct rusage ru;
    memset(&ru, 0, sizeof ru);
    if (pid < 0) { status = -1; }
    else { while (wait4(pid, &status, 0, &ru) < 0 && errno == EINTR) {} }
    gettimeofday(&t1, NULL);

    long cpuMs = ru.ru_utime.tv_sec * 1000 + ru.ru_utime.tv_usec / 1000
               + ru.ru_stime.tv_sec * 1000 + ru.ru_stime.tv_usec / 1000;
    long wallMs = (t1.tv_sec - t0.tv_sec) * 1000 + (t1.tv_usec - t0.tv_usec) / 1000;
    long memKb = ru.ru_maxrss;
    int exitCode = 0, sig = 0;
    if (pid < 0) { exitCode = 1; }
    else if (WIFEXITED(status)) exitCode = WEXITSTATUS(status);
    else if (WIFSIGNALED(status)) { sig = WTERMSIG(status); exitCode = 128 + sig; }

    size_t olen = 0, elen = 0;
    char* out = c8__slurp(outFd, &olen, 8u << 20);
    char* err = c8__slurp(errFd, &elen, 4096);
    close(inFd); close(outFd); close(errFd);

    n0 = snprintf(hdr, sizeof hdr, "#C8 %ld %d %d %ld %ld %ld %zu %zu\n",
                  i, exitCode, sig, cpuMs, wallMs, memKb, olen, elen);
    c8__wall(1, hdr, (size_t)n0);
    c8__wall(1, out, olen);
    c8__wall(1, err, elen);
    free(out); free(err);
  }
  c8__wall(1, "#C8END\n", 7);
  free(in);
  _exit(0);
}
/* ---- end harness ---- */
`;

export function supportsMultiCase(language) {
  return language === "cpp" || language === "c";
}

/** Appends the harness to fully built source code. */
export function wrapWithHarness(fullCode) {
  return `${fullCode}\n${HARNESS_C}\n`;
}

/** Packs all testcase inputs into the harness stdin format. */
export function buildHarnessStdin(stdins, timeLimitMs, budgetMs = 0) {
  const parts = [
    Buffer.from(
      `${HARNESS_MAGIC} ${Math.round(timeLimitMs)} ${stdins.length} ${Math.max(0, Math.round(budgetMs))}\n`,
    ),
  ];
  for (const s of stdins) {
    const b = Buffer.from(String(s ?? ""), "utf-8");
    parts.push(Buffer.from(`${b.length}\n`), b);
  }
  return Buffer.concat(parts);
}

/**
 * Parses the harness report. Returns an array (index -> raw case result or undefined
 * for cases that never reported, e.g. the whole run was killed).
 */
export function parseHarnessOutput(stdoutBuf, count) {
  const buf = Buffer.isBuffer(stdoutBuf) ? stdoutBuf : Buffer.from(stdoutBuf || "", "utf-8");
  const results = new Array(count);
  const head = `${HARNESS_MAGIC} `;
  if (buf.subarray(0, head.length).toString() !== head) return null;
  let pos = buf.indexOf(0x0a);
  if (pos < 0) return null;
  pos += 1;

  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const line = buf.subarray(pos, nl).toString();
    if (line === "#C8END") break;
    const m = /^#C8 (\d+) (-?\d+) (\d+) (-?\d+) (-?\d+) (-?\d+) (\d+) (\d+)$/.exec(line);
    if (!m) break;
    const [, idx, exitCode, sig, cpuMs, wallMs, memKb, olen, elen] = m.map(Number);
    const outStart = nl + 1;
    const errStart = outStart + olen;
    const end = errStart + elen;
    if (end > buf.length) break;
    if (idx >= 0 && idx < count) {
      results[idx] = {
        exitCode,
        signal: sig,
        cpuMs,
        wallMs,
        memKb,
        stdout: buf.subarray(outStart, errStart).toString("utf-8"),
        stderr: buf.subarray(errStart, end).toString("utf-8"),
      };
    }
    pos = end;
  }
  return results;
}

const SIGKILL = 9;
const SIGSEGV = 11;
const SIGXCPU = 24;
const SIGALRM = 14;

/** Converts one harness case result into the controller's normalized result shape. */
export function normalizeHarnessCase(raw, { timeLimitMs, memoryLimitMb, inputBytes }) {
  const timedOut =
    raw.signal === SIGXCPU ||
    raw.signal === SIGALRM ||
    (raw.signal === SIGKILL && raw.cpuMs >= timeLimitMs) ||
    raw.cpuMs > timeLimitMs;
  const memExceeded = memoryLimitMb > 0 && raw.memKb > memoryLimitMb * 1024;

  let status = "OK";
  if (timedOut) status = "Time Limit Exceeded";
  else if (memExceeded) status = "Memory Limit Exceeded";
  else if (raw.signal || raw.exitCode !== 0) status = "Runtime Error";

  let errorText = raw.stderr || null;
  if (status === "Runtime Error" && !errorText) {
    errorText = raw.signal === SIGSEGV
      ? "Segmentation fault"
      : raw.signal
        ? `Process terminated by signal ${raw.signal}`
        : `Process exited with code ${raw.exitCode}`;
  }

  return {
    status,
    studentStdout: "",
    actual: raw.stdout.trim(),
    errorText,
    timeMs: raw.cpuMs,
    cpuTimeMs: raw.cpuMs,
    wallTimeMs: raw.wallMs,
    memoryKb: raw.memKb,
    memorySource: "max-rss",
    exitCode: raw.exitCode,
    inputBytes,
  };
}
