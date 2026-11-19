// CodeBox comparison: runs the SAME code through the SAME backend execution
// path against two CodeBox servers (VPS and local) and reports every result.
//
//   npm run test:codebox-compare
//   node --test tests/codeboxComparison.e2e.js
//
// Targets
//   VPS   : CODEBOX_URL / CODEBOX_TOKEN from .env
//   Local : LOCAL_CODEBOX_URL (default http://localhost:2358)
//           LOCAL_CODEBOX_TOKEN (default local-dev-token)
//           start it with: cd ../codebox && docker compose -f docker-compose.local.yml up -d
//
// Options (env)
//   COMPARE_LANGS=cpp,java        only these languages (default: all five)
//   COMPARE_TARGETS=vps,local     only these targets (default: both)
//
// Not part of `npm test` on purpose: it sends ~140 executions to real servers.
//
// What is covered, for C++, C, Java, Python and JavaScript:
//   Run path (executeCodeBatch, what the Run button uses)
//     accepted, wrong answer, compile/syntax error, runtime error,
//     time limit exceeded, memory limit exceeded, stderr output (must not
//     affect the verdict), large input, 20 testcases, identical code re-run
//   Submit path (evaluateAllTestcases, what the Submit button uses, 3 tiers)
//     accepted, TLE in tier 1, crash in tier 2, wrong answer in tier 3
// For every scenario: verdict per testcase, expected verdict, output check,
// max CPU time / memory per testcase, end-to-end latency.
import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const BACKEND_DIR = path.resolve(path.dirname(THIS_FILE), "..");
const RESULT_MARKER = "__CODEBOX_COMPARE_RESULT__";

const ALL_LANGS = ["cpp", "c", "java", "python", "javascript"];
const LANG_NAMES = { cpp: "C++", c: "C", java: "Java", python: "Python", javascript: "JavaScript" };

// ─────────────────────────────────────────────────────────────────────────────
// Solutions. Each scenario injects a snippet at the start of the function
// (PRE) or replaces the whole solution (FULL), so every scenario has its own
// source code (no accidental build-cache sharing between scenarios).
// ─────────────────────────────────────────────────────────────────────────────
const SOLUTIONS = {
  cpp: {
    wrap: (pre) => `class Solution {
public:
    string addBinary(string a, string b) {
        ${pre}
        string r; int i = a.size() - 1, j = b.size() - 1, c = 0;
        while (i >= 0 || j >= 0 || c) { int s = c; if (i >= 0) s += a[i--] - '0'; if (j >= 0) s += b[j--] - '0'; r += char('0' + s % 2); c = s / 2; }
        reverse(r.begin(), r.end()); return r;
    }
};`,
    pre: {
      wrong: 'return "x" + a;',
      runtime: 'volatile int* p = nullptr; if (*p == 1) return "";',
      tle: "volatile long long s = 0; while (s >= 0) s++;",
      mle: 'vector<long long> big(400000000, 1); if (big[a.size()] == 7) return "";',
      stderr: 'cerr << "debug: a=" << a << endl;',
    },
    compileError: "class Solution {\npublic:\n    string addBinary(string a, string b) { return a + ; }\n};",
    comment: "//",
  },
  c: {
    wrap: (pre) => `char* addBinary(char* a, char* b) {
    ${pre}
    int la = strlen(a), lb = strlen(b), n = (la > lb ? la : lb) + 2; char* r = malloc(n); r[n - 1] = 0;
    int k = n - 2, i = la - 1, j = lb - 1, cy = 0;
    while (i >= 0 || j >= 0 || cy) { int s = cy; if (i >= 0) s += a[i--] - '0'; if (j >= 0) s += b[j--] - '0'; r[k--] = '0' + s % 2; cy = s / 2; }
    return r + k + 1;
}`,
    pre: {
      wrong: 'return "x";',
      runtime: 'volatile int* p = NULL; if (*p == 1) return "";',
      tle: "volatile long long s = 0; while (s >= 0) s++;",
      mle: 'long long* big = malloc(3200000000LL); if (!big) { volatile int* p = NULL; if (*p) return ""; } for (long long t = 0; t < 400000000LL; t++) big[t] = t; if (big[7] == 3) return "";',
      stderr: 'fprintf(stderr, "debug: a=%s\\n", a);',
    },
    compileError: "char* addBinary(char* a, char* b) { return a + ; }",
    comment: "//",
  },
  java: {
    wrap: (pre) => `class Solution {
    public String addBinary(String a, String b) {
        ${pre}
        StringBuilder r = new StringBuilder(); int i = a.length() - 1, j = b.length() - 1, c = 0;
        while (i >= 0 || j >= 0 || c > 0) { int s = c; if (i >= 0) s += a.charAt(i--) - '0'; if (j >= 0) s += b.charAt(j--) - '0'; r.append(s % 2); c = s / 2; }
        return r.reverse().toString();
    }
}`,
    pre: {
      wrong: 'if (a != null) return "x" + a;',
      runtime: 'int[] arr = new int[1]; if (arr[a.length() + 5] == 1) return "";',
      tle: "java.util.concurrent.atomic.AtomicLong q = new java.util.concurrent.atomic.AtomicLong(); while (q.incrementAndGet() > 0) {}",
      mle: 'long[][] big = new long[64][]; for (int t = 0; t < 64; t++) big[t] = new long[8_000_000]; if (big[3][5] == 7) return "";',
      stderr: 'System.err.println("debug: a=" + a);',
    },
    compileError: "class Solution {\n    public String addBinary(String a, String b) { return a + ; }\n}",
    comment: "//",
  },
  python: {
    wrap: (pre) => `class Solution:
    def addBinary(self, a: str, b: str) -> str:
        ${pre}
        return bin(int(a, 2) + int(b, 2))[2:]`,
    pre: {
      wrong: 'return "x" + a',
      runtime: 'raise ValueError("boom")',
      tle: "while True: pass",
      mle: "big = [0] * 400000000",
      stderr: 'import sys; print("debug: a=" + a, file=sys.stderr)',
    },
    compileError: "class Solution:\n    def addBinary(self, a: str, b: str) -> str\n        return a",
    comment: "#",
  },
  javascript: {
    wrap: (pre) => `class Solution {
    addBinary(a, b) {
        ${pre}
        return (BigInt('0b' + a) + BigInt('0b' + b)).toString(2);
    }
}`,
    pre: {
      wrong: "return 'x' + a;",
      runtime: "throw new Error('boom');",
      tle: "while (true) {}",
      // fill() touches every page; an untouched typed array is only reserved, not used
      mle: "const big = new Float64Array(400000000).fill(1); if (big[a.length] === 7) return '';",
      stderr: "process.stderr.write('debug: a=' + a + '\\n');",
    },
    compileError: "class Solution {\n    addBinary(a, b) { return a + ; }\n}",
    comment: "//",
  },
};

// Interpreted languages report a syntax error at run time, not as a compile error.
const SYNTAX_ERROR_VERDICT = {
  cpp: "Compilation Error", c: "Compilation Error", java: "Compilation Error",
  python: "Runtime Error", javascript: "Runtime Error",
};

// ─────────────────────────────────────────────────────────────────────────────
// Worker: runs every scenario against ONE CodeBox (fresh process per target, so
// module state such as the batch-API detection starts clean, as in production).
// ─────────────────────────────────────────────────────────────────────────────
async function runWorker() {
  const { executeCodeBatch, evaluateAllTestcases } = await import("../src/controllers/execution.controller.js");
  const { buildFinalCode } = await import("../src/utils/codeBuilder.js");
  const { areOutputsEqual } = await import("../src/utils/outputComparator.js");

  const problem = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, "problems/add-binary.json"), "utf8"));
  const timeLimit = problem.timeLimit || 1000;
  const memoryLimit = problem.memoryLimit || 256;
  const langs = (process.env.COMPARE_LANGS || ALL_LANGS.join(",")).split(",").filter((l) => SOLUTIONS[l]);
  const log = (msg) => process.stderr.write(`  [${process.env.COMPARE_LABEL}] ${msg}\n`);

  const sampleCases = problem.testcases.map((t) => ({ stdin: t.input, expected: t.output }));
  const binary = (bits, seed) => {
    let x = seed, s = "1";
    for (let i = 1; i < bits; i++) { x = (x * 1103515245 + 12345) % 2147483648; s += (x >> 16) & 1; }
    return s;
  };
  const addBin = (a, b) => (BigInt("0b" + a) + BigInt("0b" + b)).toString(2);
  const largeCases = [[5000, 4000, 7], [4999, 4999, 99]].map(([la, lb, seed]) => {
    const a = binary(la, seed), b = binary(lb, seed + 1);
    return { stdin: `${a}\n${b}`, expected: addBin(a, b) };
  });
  const manyCases = Array.from({ length: 20 }, (_, i) => {
    const a = (i + 1).toString(2);
    return { stdin: `${a}\n1`, expected: addBin(a, "1") };
  });
  const two = sampleCases.slice(0, 2);

  // verdict: one of the strings, or an array of acceptable strings
  const RUN_SCENARIOS = [
    { id: "accepted", label: "Accepted (5 cases)", pre: "", cases: sampleCases, expect: "Accepted" },
    { id: "wrong", label: "Wrong Answer", pre: "wrong", cases: sampleCases, expect: "Wrong Answer" },
    { id: "compile", label: "Compile / syntax error", full: "compileError", cases: two, expect: (lang) => SYNTAX_ERROR_VERDICT[lang] },
    { id: "runtime", label: "Runtime error (crash)", pre: "runtime", cases: two, expect: "Runtime Error" },
    { id: "tle", label: "Time Limit Exceeded", pre: "tle", cases: two, expect: "Time Limit Exceeded" },
    { id: "mle", label: "Memory limit (3 GB alloc)", pre: "mle", cases: two, expect: ["Memory Limit Exceeded", "Runtime Error"] },
    { id: "stderr", label: "Writes to stderr", pre: "stderr", cases: sampleCases, expect: "Accepted" },
    { id: "large", label: "Large input (5000 bits)", pre: "", cases: largeCases, expect: "Accepted", tag: "large" },
    { id: "many", label: "20 testcases", pre: "", cases: manyCases, expect: "Accepted", tag: "many" },
    { id: "again", label: "Same code again (cached)", pre: "", cases: sampleCases, expect: "Accepted", reuse: "accepted" },
  ];

  const tiered = manyCases.map((c, i) => ({ testIndex: i, input: c.stdin, output: c.expected, isVisible: i < 2 }));
  // tiers for 20 cases: tier 1 = #0-6, tier 2 = #7-13, tier 3 = #14-19
  const triggerPre = {
    cpp: (n, body) => `if (stoll(a, nullptr, 2) == ${n}) { ${body} }`,
    c: (n, body) => `if (strtoll(a, NULL, 2) == ${n}) { ${body} }`,
    java: (n, body) => `if (Long.parseLong(a, 2) == ${n}) { ${body} }`,
    // body on its own line: "if x: while True: pass" is not valid Python
    python: (n, body) => `if int(a, 2) == ${n}:\n            ${body}`,
    javascript: (n, body) => `if (parseInt(a, 2) === ${n}) { ${body} }`,
  };
  const SUBMIT_SCENARIOS = [
    { id: "submit-ok", label: "Submit: accepted (20 cases)", trigger: null, expect: { status: "ACCEPTED", tier: "Tier 3 (Optimal)", passed: 20, reported: 20 } },
    { id: "submit-tle", label: "Submit: TLE in tier 1 (#3)", trigger: [4, "tle"], expect: { status: "TIME_LIMIT_EXCEEDED", tier: "Tier 0 (Failed)", passed: 6, reported: 7 } },
    { id: "submit-crash", label: "Submit: crash in tier 2 (#9)", trigger: [10, "runtime"], expect: { status: "RUNTIME_ERROR", tier: "Tier 1 (Brute Force)", passed: 13, reported: 14 } },
    { id: "submit-wa", label: "Submit: wrong answer tier 3 (#16)", trigger: [17, "wrong"], expect: { status: "WRONG_ANSWER", tier: "Tier 2 (Better)", passed: 19, reported: 20 } },
  ];

  const records = [];
  const runTag = `${process.env.COMPARE_LABEL}-${Date.now()}`;

  for (const lang of langs) {
    const sol = SOLUTIONS[lang];
    const sourceFor = (scenarioId, userCode) => `${userCode}\n${sol.comment} scenario=${scenarioId} run=${runTag}`;
    const codeCache = {};

    for (const sc of RUN_SCENARIOS) {
      const expectList = [].concat(typeof sc.expect === "function" ? sc.expect(lang) : sc.expect);
      const record = { lang, kind: "run", id: sc.id, label: sc.label, expected: expectList.join(" or "), cases: sc.cases.length };
      try {
        let fullCode;
        if (sc.reuse) {
          fullCode = codeCache[sc.reuse];
        } else {
          const userCode = sc.full ? sol[sc.full] : sol.wrap(sc.pre ? sol.pre[sc.pre] : "");
          fullCode = buildFinalCode(problem, sourceFor(sc.id, userCode), lang);
          codeCache[sc.id] = fullCode;
        }
        const start = Date.now();
        const results = await executeCodeBatch({
          language: lang, fullCode, testcases: sc.cases.map((c) => ({ stdin: c.stdin })), timeLimit, memoryLimit,
        });
        record.ms = Date.now() - start;
        record.verdicts = results.map((r, i) =>
          r.status === "OK" ? (areOutputsEqual(r.actual, sc.cases[i].expected) ? "Accepted" : "Wrong Answer") : r.status);
        record.maxCpuMs = Math.max(0, ...results.map((r) => r.cpuTimeMs ?? r.timeMs ?? 0));
        record.maxMemKb = Math.max(0, ...results.map((r) => r.memoryKb ?? 0));
        record.sampleOutput = String(results[0]?.actual ?? "").slice(0, 40);
        record.errorSnippet = String(results.find((r) => r.errorText)?.errorText ?? "").split("\n").find((l) => l.trim())?.slice(0, 90) || "";
        record.ok = record.verdicts.every((v) => expectList.includes(v));
      } catch (err) {
        record.ok = false;
        record.error = `${err.code || ""} ${err.message}`.trim();
      }
      records.push(record);
      log(`${LANG_NAMES[lang].padEnd(10)} ${sc.label.padEnd(28)} ${record.ok ? "PASS" : "FAIL"} ${record.ms ?? "-"} ms`);
    }

    for (const sc of SUBMIT_SCENARIOS) {
      const record = {
        lang, kind: "submit", id: sc.id, label: sc.label, cases: tiered.length,
        expected: `${sc.expect.status} / ${sc.expect.tier} / ${sc.expect.passed}/20`,
      };
      try {
        const pre = sc.trigger ? triggerPre[lang](sc.trigger[0], sol.pre[sc.trigger[1]]) : "";
        const userCode = sourceFor(sc.id, sol.wrap(pre));
        const start = Date.now();
        const out = await evaluateAllTestcases({ ...problem, testcases: tiered }, lang, userCode);
        record.ms = Date.now() - start;
        record.verdicts = [`${out.status} / ${out.tierReached} / ${out.passedCount}/${out.totalCount}`];
        record.reported = out.results.length;
        record.firstFailure = out.firstFailure ? `#${out.firstFailure.testIndex} ${out.firstFailure.status}` : "-";
        record.maxCpuMs = out.maxTimeMs;
        record.maxMemKb = out.maxMemoryKb;
        record.ok = out.status === sc.expect.status && out.tierReached === sc.expect.tier &&
          out.passedCount === sc.expect.passed && out.results.length === sc.expect.reported;
      } catch (err) {
        record.ok = false;
        record.error = `${err.code || ""} ${err.message}`.trim();
      }
      records.push(record);
      log(`${LANG_NAMES[lang].padEnd(10)} ${sc.label.padEnd(28)} ${record.ok ? "PASS" : "FAIL"} ${record.ms ?? "-"} ms`);
    }
  }

  process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(records)}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner: health-checks each target, runs the worker per target, prints details.
// ─────────────────────────────────────────────────────────────────────────────
function targets() {
  const all = [
    { key: "vps", label: "VPS", url: process.env.CODEBOX_URL, token: process.env.CODEBOX_TOKEN },
    {
      key: "local", label: "Local",
      url: process.env.LOCAL_CODEBOX_URL || "http://localhost:2358",
      token: process.env.LOCAL_CODEBOX_TOKEN || "local-dev-token",
    },
  ];
  const wanted = (process.env.COMPARE_TARGETS || "vps,local").split(",");
  return all.filter((t) => wanted.includes(t.key));
}

async function healthCheck(url) {
  try {
    const res = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(8000) });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    return err.cause?.code || err.name || err.message;
  }
}

function runTarget(target) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      CODEBOX_URL: target.url,
      CODEBOX_TOKEN: target.token,
      CODEBOX_ALLOW_INSECURE_HTTP: target.url.startsWith("http://") ? "true" : process.env.CODEBOX_ALLOW_INSECURE_HTTP,
      COMPARE_LABEL: target.label,
    };
    delete env.NODE_TEST_CONTEXT; // the worker is a plain script, not a test file
    const child = spawn(process.execPath, [THIS_FILE, "--worker"], { cwd: BACKEND_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => {
      // live progress; drop the backend's own request logging noise
      const lines = String(d).split("\n").filter((l) => l.startsWith("  [") );
      if (lines.length) process.stderr.write(`${lines.join("\n")}\n`);
    });
    const timer = setTimeout(() => child.kill(), 30 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((l) => l.startsWith(RESULT_MARKER));
      if (!line) return reject(new Error(`worker for ${target.label} exited (${code}) without results`));
      resolve(JSON.parse(line.slice(RESULT_MARKER.length)));
    });
  });
}

function printDetails(label, records) {
  console.log(`\n${"═".repeat(100)}\n  ${label}: detailed results\n${"═".repeat(100)}`);
  for (const lang of ALL_LANGS) {
    const rows = records.filter((r) => r.lang === lang);
    if (!rows.length) continue;
    console.log(`\n  ${LANG_NAMES[lang]}`);
    console.table(rows.map((r) => ({
      scenario: r.label,
      result: r.ok ? "PASS" : "FAIL",
      "latency ms": r.ms ?? "-",
      verdict: r.error ? `ERROR: ${r.error}` : summarizeVerdicts(r.verdicts),
      expected: r.expected,
      "max cpu ms": r.maxCpuMs ?? "-",
      "max mem KB": r.maxMemKb ?? "-",
      details: r.kind === "submit"
        ? `reported ${r.reported ?? "-"}/20, first failure ${r.firstFailure ?? "-"}`
        : (r.errorSnippet || (r.sampleOutput ? `out: ${r.sampleOutput}` : "")),
    })));
  }
}

function summarizeVerdicts(verdicts = []) {
  const counts = {};
  for (const v of verdicts) counts[v] = (counts[v] || 0) + 1;
  return Object.entries(counts).map(([v, n]) => (verdicts.length > 1 ? `${v} x${n}` : v)).join(", ");
}

function printComparison(byTarget) {
  const [a, b] = byTarget;
  console.log(`\n${"═".repeat(100)}\n  ${a.label} vs ${b.label}: latency per scenario (same backend, same code)\n${"═".repeat(100)}`);
  const index = (records) => new Map(records.map((r) => [`${r.lang}|${r.id}`, r]));
  const ia = index(a.records), ib = index(b.records);
  const totals = {};
  for (const lang of ALL_LANGS) {
    const rows = [];
    for (const ra of a.records.filter((r) => r.lang === lang)) {
      const rb = ib.get(`${lang}|${ra.id}`);
      if (!rb) continue;
      const msA = ra.ms, msB = rb.ms;
      let faster = "-", speedup = "-";
      if (msA != null && msB != null) {
        faster = msA === msB ? "tie" : msA < msB ? a.label : b.label;
        speedup = `${(Math.max(msA, msB) / Math.max(1, Math.min(msA, msB))).toFixed(1)}x`;
        totals[lang] ??= { [a.label]: 0, [b.label]: 0 };
        totals[lang][a.label] += msA;
        totals[lang][b.label] += msB;
      }
      rows.push({
        scenario: ra.label,
        [`${a.label} ms`]: msA ?? "error",
        [`${b.label} ms`]: msB ?? "error",
        faster,
        speedup,
        [`${a.label} verdict ok`]: ra.ok ? "yes" : "NO",
        [`${b.label} verdict ok`]: rb.ok ? "yes" : "NO",
      });
    }
    if (rows.length) {
      console.log(`\n  ${LANG_NAMES[lang]}`);
      console.table(rows);
    }
  }
  console.log(`\n${"═".repeat(100)}\n  Overall: total time for all scenarios, per language\n${"═".repeat(100)}`);
  console.table(Object.entries(totals).map(([lang, t]) => {
    const ta = t[a.label], tb = t[b.label];
    return {
      language: LANG_NAMES[lang],
      [`${a.label} total ms`]: ta,
      [`${b.label} total ms`]: tb,
      fastest: ta === tb ? "tie" : ta < tb ? a.label : b.label,
      speedup: `${(Math.max(ta, tb) / Math.max(1, Math.min(ta, tb))).toFixed(1)}x`,
    };
  }));
}

if (process.argv.includes("--worker")) {
  await runWorker();
  process.exit(0);
} else {
  const { test, after } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;
  const results = [];

  for (const target of targets()) {
    test(`${target.label} CodeBox (${target.url || "not configured"}): every scenario returns the expected verdict`, { timeout: 30 * 60 * 1000 }, async (t) => {
      if (!target.url || !target.token) return t.skip(`${target.label} CodeBox URL/token not configured`);
      const down = await healthCheck(target.url);
      if (down) {
        const hint = target.key === "local" ? " (start it: cd ../codebox && docker compose -f docker-compose.local.yml up -d)" : "";
        return t.skip(`${target.label} CodeBox unreachable: ${down}${hint}`);
      }
      process.stderr.write(`\n▶ ${target.label}: ${target.url}\n`);
      const records = await runTarget(target);
      results.push({ label: target.label, records });
      printDetails(target.label, records);
      const failed = records.filter((r) => !r.ok);
      assert.equal(
        failed.length, 0,
        `${failed.length} scenario(s) failed on ${target.label}:\n${failed.map((r) => `  ${LANG_NAMES[r.lang]} / ${r.label}: got ${r.error || summarizeVerdicts(r.verdicts)}, expected ${r.expected}`).join("\n")}`,
      );
    });
  }

  after(() => {
    if (results.length === 2) printComparison(results);
    else console.log("\n(Comparison needs both targets reachable; only one ran.)");
  });
}
