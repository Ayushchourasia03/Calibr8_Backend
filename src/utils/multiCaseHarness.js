// src/utils/multiCaseHarness.js
//
// Runs many testcases in ONE CodeBox submission for compiled languages (C/C++),
// so the program is compiled once and only one sandbox is started.
//
// How it works: a constructor function (runs before main) reads all testcases
// from stdin, then for each case fork()s a child. The child gets that case's
// input as stdin and a fresh buffer as stdout, returns from the constructor and
// runs the problem's real main() unchanged. The parent waits, records
// status/time/memory/output, and finally prints a framed report.
//
// Isolation guarantees per case (each case behaves like a separate run):
//   - Own process: fresh globals, heap and stdio buffers.
//   - Inputs: all testcase inputs live in an unmapped memfd that every child
//     closes before user code runs, and the stack buffer used to copy them is
//     zeroed before each fork. The parent is non-dumpable, so its /proc entries
//     (fd, mem, ...) are not readable by the children. A program can only ever
//     see its own input.
//   - Memory: the parent's footprint stays constant (inputs are not mapped,
//     output is relayed through a fixed buffer). Every child inherits the
//     parent's resident memory as its starting peak, so this keeps each case's
//     max-RSS independent of earlier cases and of the total input size.
//   - Files: anything a case creates in the working directory or /tmp is
//     deleted after the case, so no case sees files from an earlier one.
//   - Processes: the child runs in its own process group, SIGKILLed after the
//     case; the parent is a child-subreaper and reaps leftovers.
//   - Time: enforced twice - inside the child (RLIMIT_CPU + a real-time itimer)
//     and by a parent-side watchdog that SIGKILLs the process group, so code
//     that blocks or ignores SIGALRM still cannot outlive its limit.
//
// With HARNESS_FLAG_STOP_ON_TIMEOUT the harness stops after the first case that
// exceeds its time limit (definitive TLE) instead of running the rest.

export const HARNESS_MAGIC = "C8MC1"; // report header magic (output)
export const HARNESS_INPUT_MAGIC = "C8MC2"; // stdin framing version (input)
export const HARNESS_FLAG_STOP_ON_TIMEOUT = 1;

// Parent-side watchdog grace on top of the per-case time limit.
const WATCHDOG_GRACE_MS = 1000;

const HARNESS_C = String.raw`
/* ---- Calibr8 multi-testcase harness v3 (compile once, fork per case) ---- */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <dirent.h>
#include <ftw.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <sys/types.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <errno.h>
#include <time.h>

#ifndef PR_SET_CHILD_SUBREAPER
#define PR_SET_CHILD_SUBREAPER 36
#endif
#ifndef PR_SET_DUMPABLE
#define PR_SET_DUMPABLE 4
#endif

#define C8_BUF 65536
#define C8_MAX_SNAP 1024

static volatile sig_atomic_t c8__alarm = 0;
static void c8__onalarm(int s) { (void)s; c8__alarm = 1; }

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

/* Copies n bytes of fd (from offset 0) to stdout through a fixed buffer. */
static void c8__relay(int fd, size_t n, char* buf) {
  off_t off = 0;
  while (n > 0) {
    ssize_t r = pread(fd, buf, n < C8_BUF ? n : C8_BUF, off);
    if (r <= 0) { memset(buf, 0, C8_BUF); r = (ssize_t)(n < C8_BUF ? n : C8_BUF); } /* keep framing */
    c8__wall(1, buf, (size_t)r);
    off += r;
    n -= (size_t)r;
  }
}

static size_t c8__size(int fd, size_t cap) {
  off_t len = lseek(fd, 0, SEEK_END);
  if (len < 0) len = 0;
  return (size_t)len < cap ? (size_t)len : cap;
}

static void c8__arm(long ms) {
  struct itimerval it;
  memset(&it, 0, sizeof it);
  it.it_value.tv_sec = ms / 1000;
  it.it_value.tv_usec = (ms % 1000) * 1000;
  setitimer(ITIMER_REAL, &it, NULL);
}

static void c8__close_from(int lowfd) {
#ifdef SYS_close_range
  if (syscall(SYS_close_range, (unsigned int)lowfd, ~0U, 0) == 0) return;
#endif
  for (int fd = lowfd; fd < 4096; fd++) close(fd);
}

/* Descendants that left the case's process group (setsid/setpgid) survive
   kill(-pid). The harness is a child-subreaper, so they become its children:
   kill every remaining child before the next case starts, so nothing started
   by one case can observe or influence a later one (SA-L1). */
static void c8__kill_strays(void) {
  pid_t self = getpid();
  for (int round = 0; round < 64; round++) {
    int found = 0;
    DIR* dp = opendir("/proc");
    if (!dp) return;
    struct dirent* e;
    char path[64], line[512];
    while ((e = readdir(dp)) != NULL) {
      char* end = NULL;
      long pid = strtol(e->d_name, &end, 10);
      if (!end || *end || pid <= 0 || pid == (long)self) continue;
      snprintf(path, sizeof path, "/proc/%ld/stat", pid);
      int fd = open(path, O_RDONLY | O_CLOEXEC);
      if (fd < 0) continue;
      ssize_t n = read(fd, line, sizeof line - 1);
      close(fd);
      if (n <= 0) continue;
      line[n] = 0;
      char* rp = NULL; /* "pid (comm) S ppid ...": comm may contain ')' */
      for (char* q = line; *q; q++) if (*q == ')') rp = q;
      if (!rp || rp[1] == 0 || rp[2] == 0 || rp[3] == 0) continue;
      if (strtol(rp + 3, NULL, 10) == (long)self) { kill((pid_t)pid, SIGKILL); found = 1; }
    }
    closedir(dp);
    while (waitpid(-1, NULL, WNOHANG) > 0) {}
    if (!found) return;
    struct timespec ts = { 0, 1000000 };
    nanosleep(&ts, NULL);
  }
}

/* Per-case filesystem isolation: entries present before the first case are
   kept; anything created during a case (in the working directory or /tmp) is
   removed after it. */
static const char* const c8__dirs[2] = { ".", "/tmp" };
static char* c8__snap[2][C8_MAX_SNAP];
static int c8__snapN[2] = { -1, -1 };

static void c8__snapshot(void) {
  for (int d = 0; d < 2; d++) {
    DIR* dp = opendir(c8__dirs[d]);
    if (!dp) continue;
    c8__snapN[d] = 0;
    struct dirent* e;
    while ((e = readdir(dp)) != NULL) {
      if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
      if (c8__snapN[d] < C8_MAX_SNAP) c8__snap[d][c8__snapN[d]++] = strdup(e->d_name);
    }
    closedir(dp);
  }
}

static int c8__known(int d, const char* name) {
  for (int i = 0; i < c8__snapN[d]; i++) if (c8__snap[d][i] && !strcmp(c8__snap[d][i], name)) return 1;
  return 0;
}

static int c8__rm(const char* p, const struct stat* sb, int flag, struct FTW* f) {
  (void)sb; (void)f;
  if (flag == FTW_DP || flag == FTW_DNR) rmdir(p); else unlink(p);
  return 0;
}

static void c8__cleanup_fs(void) {
  char path[4096];
  for (int d = 0; d < 2; d++) {
    if (c8__snapN[d] < 0) continue;
    for (int pass = 0; pass < 4; pass++) {
      DIR* dp = opendir(c8__dirs[d]);
      if (!dp) break;
      int removed = 0;
      struct dirent* e;
      while ((e = readdir(dp)) != NULL) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..") || c8__known(d, e->d_name)) continue;
        snprintf(path, sizeof path, "%s/%s", c8__dirs[d], e->d_name);
        nftw(path, c8__rm, 16, FTW_DEPTH | FTW_PHYS);
        removed++;
      }
      closedir(dp);
      if (!removed) break;
    }
  }
}

__attribute__((constructor(101))) static void c8__harness(void) {
  prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);       /* /proc/<pid>/{fd,mem,...} -> root only */
  prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);

  /* Header line: "C8MC2 <timeLimitMs> <count> <budgetMs> <flags> <payloadBytes>\n",
     then per case "<len>\n<bytes>". Read byte by byte so nothing past it is consumed. */
  char line[256];
  size_t ll = 0;
  while (ll < sizeof line - 1) {
    char ch;
    ssize_t r = read(0, &ch, 1);
    if (r <= 0 || ch == '\n') break;
    line[ll++] = ch;
  }
  line[ll] = 0;
  if (strncmp(line, "C8MC2 ", 6) != 0) _exit(97);
  char* p = line + 6;
  long tl = strtol(p, &p, 10);
  long count = strtol(p, &p, 10);
  long budget = strtol(p, &p, 10); /* total wall ms allowed; 0 = unlimited */
  long flags = strtol(p, &p, 10);
  long total = strtol(p, &p, 10);
  if (tl <= 0) tl = 2000;
  if (total < 0) total = 0;

  static char buf[C8_BUF];
  int pfd = c8__memfd();
  if (pfd < 0) _exit(98);
  off_t payloadLen = 0;
  while (payloadLen < (off_t)total) {
    size_t want = (size_t)((off_t)total - payloadLen);
    ssize_t r = read(0, buf, want < C8_BUF ? want : C8_BUF);
    if (r <= 0) break;
    c8__wall(pfd, buf, (size_t)r);
    payloadLen += r;
  }

  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = c8__onalarm;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = 0; /* no SA_RESTART: the watchdog must interrupt wait4() */
  sigaction(SIGALRM, &sa, NULL);

  c8__snapshot();

  char hdr[192];
  int n0 = snprintf(hdr, sizeof hdr, "C8MC1 %ld\n", count);
  c8__wall(1, hdr, (size_t)n0);

  struct timeval start;
  gettimeofday(&start, NULL);
  int stoppedOnTimeout = 0;
  off_t off = 0;

  for (long i = 0; i < count; i++) {
    if (budget > 0) {
      struct timeval now;
      gettimeofday(&now, NULL);
      long elapsed = (now.tv_sec - start.tv_sec) * 1000 + (now.tv_usec - start.tv_usec) / 1000;
      /* Stop cleanly before the sandbox kills us; unreported cases are re-run. */
      if (elapsed + tl + 400 > budget) break;
    }
    char lb[32];
    ssize_t g = pread(pfd, lb, sizeof lb - 1, off);
    if (g < 0) g = 0;
    lb[g] = 0;
    char* ep = lb;
    long clen = strtol(lb, &ep, 10);
    if (ep < lb + g && *ep == '\n') ep++;
    off += (off_t)(ep - lb);
    if (clen < 0 || off + clen > payloadLen) clen = 0;
    int inFd = c8__memfd(), outFd = c8__memfd(), errFd = c8__memfd();
    for (off_t done = 0; done < clen;) {
      size_t want = (size_t)(clen - done);
      ssize_t r = pread(pfd, buf, want < C8_BUF ? want : C8_BUF, off + done);
      if (r <= 0) break;
      c8__wall(inFd, buf, (size_t)r);
      done += r;
    }
    off += clen;
    lseek(inFd, 0, SEEK_SET);

    while (waitpid(-1, NULL, WNOHANG) > 0) {} /* reap leftovers of earlier cases */

    struct timeval t0, t1;
    memset(buf, 0, sizeof buf); /* no input bytes left in memory the child inherits */
    gettimeofday(&t0, NULL);
    fflush(NULL);
    pid_t pid = fork();
    if (pid == 0) {
      setpgid(0, 0);
      signal(SIGALRM, SIG_DFL);
      dup2(inFd, 0); dup2(outFd, 1); dup2(errFd, 2);
      c8__close_from(3); /* incl. the memfd holding every testcase input */
      prctl(PR_SET_DUMPABLE, 1, 0, 0, 0); /* normal process for user code; the parent stays protected */
      struct rlimit rl;
      rl.rlim_cur = (rlim_t)((tl + 999) / 1000 + 1);
      rl.rlim_max = rl.rlim_cur + 1;
      setrlimit(RLIMIT_CPU, &rl);
      c8__arm(tl + 300);
      return; /* continue into static initializers and the real main() */
    }

    int status = 0, killed = 0;
    struct rusage ru;
    memset(&ru, 0, sizeof ru);
    if (pid < 0) {
      status = -1;
    } else {
      setpgid(pid, pid); /* also set from the parent: no race with the child */
      c8__alarm = 0;
      c8__arm(tl + ${WATCHDOG_GRACE_MS});
      for (;;) {
        pid_t w = wait4(pid, &status, 0, &ru);
        if (w == pid) break;
        if (w < 0 && errno == EINTR) {
          if (c8__alarm && !killed) { kill(-pid, SIGKILL); kill(pid, SIGKILL); killed = 1; }
          continue;
        }
        status = -1;
        break;
      }
      c8__arm(0);
      kill(-pid, SIGKILL); /* anything the case left running in its group */
    }
    gettimeofday(&t1, NULL);
    c8__kill_strays();
    c8__cleanup_fs();

    long cpuMs = ru.ru_utime.tv_sec * 1000 + ru.ru_utime.tv_usec / 1000
               + ru.ru_stime.tv_sec * 1000 + ru.ru_stime.tv_usec / 1000;
    long wallMs = (t1.tv_sec - t0.tv_sec) * 1000 + (t1.tv_usec - t0.tv_usec) / 1000;
    long memKb = ru.ru_maxrss;
    int exitCode = 0, sig = 0;
    if (pid < 0 || status == -1) { exitCode = 1; }
    else if (WIFEXITED(status)) exitCode = WEXITSTATUS(status);
    else if (WIFSIGNALED(status)) { sig = WTERMSIG(status); exitCode = 128 + sig; }
    if (killed && sig == 0) { sig = SIGKILL; exitCode = 128 + SIGKILL; }

    size_t olen = c8__size(outFd, 8u << 20);
    size_t elen = c8__size(errFd, 4096);
    n0 = snprintf(hdr, sizeof hdr, "#C8 %ld %d %d %ld %ld %ld %zu %zu\n",
                  i, exitCode, sig, cpuMs, wallMs, memKb, olen, elen);
    c8__wall(1, hdr, (size_t)n0);
    c8__relay(outFd, olen, buf);
    c8__relay(errFd, elen, buf);
    close(inFd); close(outFd); close(errFd);

    int timedOut = killed || sig == SIGXCPU || sig == SIGALRM
                || (sig == SIGKILL && cpuMs >= tl) || cpuMs > tl;
    if ((flags & 1) && timedOut) { stoppedOnTimeout = 1; break; }
  }
  while (waitpid(-1, NULL, WNOHANG) > 0) {}
  if (stoppedOnTimeout) c8__wall(1, "#C8END TLE\n", 11);
  else c8__wall(1, "#C8END\n", 7);
  close(pfd);
  _exit(0);
}
/* ---- end harness ---- */
`;

export function supportsMultiCase(language) {
  return language === "cpp" || language === "c";
}

// libc functions the harness parent calls. A user definition with C linkage
// would be called by the harness itself, i.e. user code running in the parent.
const HARNESS_LIBC_FUNCTIONS = [
  "_exit", "close", "closedir", "dup", "dup2", "fflush", "fileno", "fork",
  "gettimeofday", "kill", "lseek", "memset", "nftw", "opendir", "prctl",
  "pread", "read", "readdir", "rmdir", "setitimer", "setpgid", "setrlimit",
  "sigaction", "sigemptyset", "signal", "snprintf", "strcmp", "strdup",
  "strncmp", "strtol", "syscall", "tmpfile", "unlink", "wait4", "waitpid",
  "write", "exit", "abort", "malloc", "free", "calloc", "realloc",
  // c8__kill_strays (SA-L1)
  "getpid", "open", "nanosleep",
];
const LIBC_CALL_START = new RegExp(
  `\\b(?:${HARNESS_LIBC_FUNCTIONS.join("|")})\\s*\\(`,
  "g",
);

/**
 * Strips C/C++ comments and optionally string/char/raw-string literals so
 * attackers cannot hide directives or split tokens with comments, nor trigger
 * false positives inside comments.
 */
function stripCppCommentsAndLiterals(src, { stripLiterals = false } = {}) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    // Line comment
    if (ch === "/" && next === "/") {
      out += " ";
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // Block comment
    if (ch === "/" && next === "*") {
      out += " ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // C++ raw string literal: R"delim(...)delim"
    if ((ch === "R" || ((ch === "u" || ch === "U" || ch === "L") && src[i + 1] === "R") || (ch === "u" && src[i + 1] === "8" && src[i + 2] === "R"))) {
      const rIdx = ch === "R" ? i : (src[i + 1] === "R" ? i + 1 : i + 2);
      if (src[rIdx + 1] === "\"") {
        const parenIdx = src.indexOf("(", rIdx + 2);
        if (parenIdx !== -1 && parenIdx - (rIdx + 2) <= 16) {
          const delim = src.slice(rIdx + 2, parenIdx);
          if (!/[\s()\\]/.test(delim)) {
            const endMarker = `)${delim}"`;
            const closeIdx = src.indexOf(endMarker, parenIdx + 1);
            if (closeIdx !== -1) {
              const endPos = closeIdx + endMarker.length;
              out += stripLiterals ? ' "" ' : src.slice(i, endPos);
              i = endPos;
              continue;
            }
          }
        }
      }
    }
    // pp-number (C++14 / C23): `'` followed by an identifier char is a digit
    // separator (1'000'000, 0xFF'FF), not a char literal. Treating it as a
    // literal would hide the code up to the next `'` from every check below.
    const prevIsIdent = i > 0 && /[A-Za-z0-9_]/.test(src[i - 1]);
    if (!prevIsIdent && (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(next || "")))) {
      const start = i;
      i++;
      while (i < n) {
        const c = src[i];
        if (/[A-Za-z0-9_.]/.test(c)) i++;
        else if (c === "'" && /[A-Za-z0-9_]/.test(src[i + 1] || "")) i += 2;
        else if ((c === "+" || c === "-") && /[eEpP]/.test(src[i - 1])) i++;
        else break;
      }
      out += src.slice(start, i);
      continue;
    }
    // Normal string or char literal
    if (ch === "\"" || ch === "'") {
      const quote = ch;
      const start = i;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += stripLiterals ? (quote === "\"" ? ' "" ' : " '' ") : src.slice(start, i);
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Checks whether any libc function name appears as a function definition
 * (matching balanced parameter parentheses followed by optional qualifiers
 * and `{` or `try {`).
 */
function hasLibcDefinition(codeOnly) {
  LIBC_CALL_START.lastIndex = 0;
  let match;
  while ((match = LIBC_CALL_START.exec(codeOnly)) !== null) {
    let idx = match.index + match[0].length;
    let depth = 1;
    while (idx < codeOnly.length && depth > 0) {
      const c = codeOnly[idx];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      idx++;
    }
    if (depth !== 0) return true; // unbalanced -> fail closed
    // Skip trailing qualifiers: noexcept(...), throw(...), const, volatile, __attribute__((...)), [[...]]
    while (idx < codeOnly.length) {
      while (idx < codeOnly.length && /\s/.test(codeOnly[idx])) idx++;
      if (codeOnly.startsWith("noexcept", idx) && !/[A-Za-z0-9_]/.test(codeOnly[idx + 8] || "")) {
        idx += 8;
      } else if (codeOnly.startsWith("throw", idx) && !/[A-Za-z0-9_]/.test(codeOnly[idx + 5] || "")) {
        idx += 5;
      } else if (codeOnly.startsWith("const", idx) && !/[A-Za-z0-9_]/.test(codeOnly[idx + 5] || "")) {
        idx += 5;
      } else if (codeOnly.startsWith("volatile", idx) && !/[A-Za-z0-9_]/.test(codeOnly[idx + 8] || "")) {
        idx += 8;
      } else if (codeOnly[idx] === "(") {
        let qd = 1;
        idx++;
        while (idx < codeOnly.length && qd > 0) {
          if (codeOnly[idx] === "(") qd++;
          else if (codeOnly[idx] === ")") qd--;
          idx++;
        }
      } else if (codeOnly[idx] === "[") {
        let bd = 1;
        idx++;
        while (idx < codeOnly.length && bd > 0) {
          if (codeOnly[idx] === "[") bd++;
          else if (codeOnly[idx] === "]") bd--;
          idx++;
        }
      } else {
        break;
      }
    }
    while (idx < codeOnly.length && /\s/.test(codeOnly[idx])) idx++;
    if (codeOnly[idx] === "{") return true;
    if (codeOnly.startsWith("try", idx) && /\s*\{/.test(codeOnly.slice(idx + 3, idx + 16))) {
      return true;
    }
  }
  return false;
}

const SAFE_INCLUDE_REST = /^<(?:bits\/stdc\+\+\.h|[A-Za-z0-9_+-]+(?:\.h)?)>\s*$/;

/**
 * The harness is compiled into the same binary as the user's code, after it.
 * Anything that lets user code run in the harness parent process (before or
 * instead of the harness) could read every testcase input and forge the
 * per-case report: constructors / init priorities / ifunc via attributes,
 * inline assembly, C-linkage overrides of the libc calls the harness makes,
 * or macros that rewrite the harness source that follows the user's code.
 * Submissions using any of these are judged on the batch path instead, where
 * every testcase runs in its own sandbox without the harness. This only
 * affects speed, never verdicts.
 *
 * @param {string} userCode the user's submitted code (not the full template)
 * @returns {boolean} true when the multi-case harness may be used
 */
export function isHarnessSafeUserCode(userCode) {
  if (typeof userCode !== "string") return false;
  // Trigraphs (ISO modes) change how quotes, braces and directives tokenize
  // ('??'' is '^'), and whether they apply depends on the -std flag. Fail
  // closed instead of guessing.
  if (/\?\?[=/'()!<>-]/.test(userCode)) return false;
  // Translation phase 2: line splicing.
  const spliced = userCode.replace(/\\\r?\n/g, "");

  // Strip comments first (preserving strings for #include / extern "C" inspection).
  const noComments = stripCppCommentsAndLiterals(spliced, { stripLiterals: false });

  // Any preprocessor directive except allowlisted #include and "#pragma GCC optimize/target"
  // (digraph %: is '#').
  const directive = /^[ \t]*(?:#|%:)[ \t]*([A-Za-z_]+)(.*)$/gm;
  for (const [, name, rest] of noComments.matchAll(directive)) {
    if (name === "include") {
      if (!SAFE_INCLUDE_REST.test(rest.trim())) return false;
      continue;
    }
    if (name === "pragma" && /^\s*GCC\s+(?:optimize|target)\b/.test(rest)) continue;
    return false;
  }

  if (/\bextern\s*"C"/.test(noComments)) return false;

  // Strip comments AND literals before keyword / definition checks so strings
  // do not cause false positives and nested tokens cannot evade detection.
  const codeOnly = stripCppCommentsAndLiterals(spliced, { stripLiterals: true });

  const forbidden = [
    /__attribute/, // constructor, init_priority, ifunc, alias, section, ...
    /\b(?:__)?gnu(?:__)?\s*::/, // [[gnu::constructor]]
    /\busing\s+(?:__)?gnu(?:__)?\b/, // [[using gnu: constructor]]
    /\b(?:__)?asm(?:__)?\b/,
    /\b_Pragma\b/,
    /\boperator\s+(?:new|delete)\b/, // global allocation hooks
    /\\[uU][0-9a-fA-F]{4}/, // universal character names in identifiers
    /\bc8__/, // multi-case harness namespace
    /\bc8p__/, // profiling harness namespace
    /\bc8prof\b/, // profiling driver helpers
    /\.(?:pre)?init_array|\.ctors\b/,
  ];
  if (forbidden.some((pattern) => pattern.test(codeOnly))) return false;
  return !hasLibcDefinition(codeOnly);
}

/**
 * Appends the harness to fully built source code. Strict C (-std=c17) hides
 * the POSIX/GNU declarations the harness needs, so C sources get _GNU_SOURCE
 * (g++ always defines it, and adding it for C++ would defeat the PCH).
 */
export function wrapWithHarness(fullCode, language = "cpp") {
  const prefix = language === "c" ? "#define _GNU_SOURCE 1\n" : "";
  return `${prefix}${fullCode}\n${HARNESS_C}\n`;
}

/** Packs all testcase inputs into the harness stdin format. */
export function buildHarnessStdin(stdins, timeLimitMs, budgetMs = 0, { stopOnTimeout = false } = {}) {
  const body = [];
  for (const s of stdins) {
    const b = Buffer.from(String(s ?? ""), "utf-8");
    body.push(Buffer.from(`${b.length}\n`), b);
  }
  const payload = Buffer.concat(body);
  const flags = stopOnTimeout ? HARNESS_FLAG_STOP_ON_TIMEOUT : 0;
  const header = Buffer.from(
    `${HARNESS_INPUT_MAGIC} ${Math.round(timeLimitMs)} ${stdins.length} ${Math.max(0, Math.round(budgetMs))} ${flags} ${payload.length}\n`,
  );
  return Buffer.concat([header, payload]);
}

/**
 * Parses the harness report. Returns an array (index -> raw case result or undefined
 * for cases that never reported, e.g. the whole run was killed), or null when the
 * report is missing. `results.stoppedOnTimeout` is true when the harness stopped
 * early after a definitive TLE (unreported cases were intentionally not run).
 */
export function parseHarnessOutput(stdoutBuf, count) {
  const buf = Buffer.isBuffer(stdoutBuf) ? stdoutBuf : Buffer.from(stdoutBuf || "", "utf-8");
  const results = new Array(count);
  results.stoppedOnTimeout = false;
  const head = `${HARNESS_MAGIC} `;
  if (buf.subarray(0, head.length).toString() !== head) return null;
  let pos = buf.indexOf(0x0a);
  if (pos < 0) return null;
  pos += 1;

  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const line = buf.subarray(pos, nl).toString();
    if (line === "#C8END" || line === "#C8END TLE") {
      results.stoppedOnTimeout = line === "#C8END TLE";
      break;
    }
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
    (raw.signal === SIGKILL && (raw.cpuMs >= timeLimitMs || raw.wallMs >= timeLimitMs + WATCHDOG_GRACE_MS)) ||
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
