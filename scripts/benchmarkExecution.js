// Measures how fast the backend executes testcases through CodeBox.
// Uses executeCodeBatch, the same function behind Run and Submit.
//
//   node scripts/benchmarkExecution.js                       # CodeBox from .env
//   node scripts/benchmarkExecution.js --url http://localhost:2358 --token local-dev-token
//   node scripts/benchmarkExecution.js --langs cpp,java --cases 40
//
// Columns:
//   "N cases"         new code (nothing cached) on the problem's testcases
//   "same code again" identical code re-run (what Submit right after Run costs)
//   "<cases> cases"   larger hidden-test style load
//   "submit"          full Submit evaluation (3 tiers) on <cases> testcases
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
if (arg("url")) process.env.CODEBOX_URL = arg("url");
if (arg("token")) process.env.CODEBOX_TOKEN = arg("token");
if (process.env.CODEBOX_URL?.startsWith("http://")) process.env.CODEBOX_ALLOW_INSECURE_HTTP = "true";

const { executeCodeBatch, evaluateAllTestcases } = await import("../src/controllers/execution.controller.js");
const { buildFinalCode } = await import("../src/utils/codeBuilder.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const problem = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../problems/add-binary.json"), "utf8"),
);

const SOLUTIONS = {
  cpp: `class Solution {
public:
    string addBinary(string a, string b) {
        string r; int i = a.size() - 1, j = b.size() - 1, c = 0;
        while (i >= 0 || j >= 0 || c) { int s = c; if (i >= 0) s += a[i--] - '0'; if (j >= 0) s += b[j--] - '0'; r += char('0' + s % 2); c = s / 2; }
        reverse(r.begin(), r.end()); return r;
    }
};`,
  c: `char* addBinary(char* a, char* b) {
    int la = strlen(a), lb = strlen(b), n = (la > lb ? la : lb) + 2; char* r = malloc(n); r[n - 1] = 0;
    int k = n - 2, i = la - 1, j = lb - 1, cy = 0;
    while (i >= 0 || j >= 0 || cy) { int s = cy; if (i >= 0) s += a[i--] - '0'; if (j >= 0) s += b[j--] - '0'; r[k--] = '0' + s % 2; cy = s / 2; }
    return r + k + 1;
}`,
  java: `class Solution {
    public String addBinary(String a, String b) {
        StringBuilder r = new StringBuilder(); int i = a.length() - 1, j = b.length() - 1, c = 0;
        while (i >= 0 || j >= 0 || c > 0) { int s = c; if (i >= 0) s += a.charAt(i--) - '0'; if (j >= 0) s += b.charAt(j--) - '0'; r.append(s % 2); c = s / 2; }
        return r.reverse().toString();
    }
}`,
  python: `class Solution:
    def addBinary(self, a: str, b: str) -> str:
        return bin(int(a, 2) + int(b, 2))[2:]`,
  javascript: `class Solution {
    addBinary(a, b) { return (BigInt('0b' + a) + BigInt('0b' + b)).toString(2); }
}`,
};

const langs = arg("langs", Object.keys(SOLUTIONS).join(",")).split(",");
const bigCount = Number(arg("cases", 40));
const testcases = problem.testcases.map((t) => ({ stdin: t.input }));
const expected = problem.testcases.map((t) => t.output);
const bigCases = Array.from({ length: bigCount }, (_, i) => ({ stdin: `${(i + 1).toString(2)}\n1` }));
const bigExpected = bigCases.map((_, i) => (i + 2).toString(2));

async function timed(code, lang, cases, want) {
  const start = Date.now();
  const results = await executeCodeBatch({
    language: lang, fullCode: code, testcases: cases,
    timeLimit: problem.timeLimit || 1000, memoryLimit: problem.memoryLimit || 256,
  });
  const ms = Date.now() - start;
  const ok = results.every((r, i) => r.status === "OK" && r.actual === want[i]);
  return { ms, ok, results };
}

console.log(`CodeBox: ${process.env.CODEBOX_URL}`);
console.log(`Problem: ${problem.slug} (${testcases.length} testcases, ${bigCount}-case load test)\n`);

const rows = {};
let allCorrect = true;
for (const lang of langs) {
  if (!SOLUTIONS[lang]) continue;
  // Unique comment => guaranteed cache miss, so "N cases" measures a real compile.
  const fresh = (tag) => buildFinalCode(problem, `${SOLUTIONS[lang]}\n${lang === "python" ? "#" : "//"} ${tag}`, lang);
  try {
    const code = fresh(`bench-${Date.now()}-${Math.random()}`);
    const first = await timed(code, lang, testcases, expected);
    const again = await timed(code, lang, testcases, expected);
    const big = await timed(fresh(`big-${Date.now()}-${Math.random()}`), lang, bigCases, bigExpected);

    // Full Submit: tiered evaluation over the load-test cases, fresh code.
    const submitProblem = {
      ...problem,
      testcases: bigCases.map((tc, i) => ({ testIndex: i, input: tc.stdin, output: bigExpected[i], isVisible: i < 2 })),
    };
    const submitStart = Date.now();
    const submitted = await evaluateAllTestcases(
      submitProblem, lang, `${SOLUTIONS[lang]}\n${lang === "python" ? "#" : "//"} submit-${Date.now()}-${Math.random()}`,
    );
    const submitMs = Date.now() - submitStart;
    const submitOk = submitted.status === "ACCEPTED" && submitted.passedCount === bigCount;

    const correct = first.ok && again.ok && big.ok && submitOk;
    allCorrect &&= correct;
    rows[lang] = {
      [`${testcases.length} cases`]: `${first.ms} ms`,
      "same code again": `${again.ms} ms`,
      [`${bigCount} cases`]: `${big.ms} ms`,
      submit: `${submitMs} ms`,
      correct: correct ? "yes" : `NO (${first.results.map((r) => r.status).join(",")})`,
    };
  } catch (err) {
    allCorrect = false;
    rows[lang] = { error: `${err.code || ""} ${err.message}` };
  }
}
console.table(rows);
process.exit(allCorrect ? 0 : 1);
