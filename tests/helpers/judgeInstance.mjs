// One extra "backend instance" for tests/judgeDos.e2e.js: a separate Node
// process with its own judge scheduler, judging against the same CodeBox.
//   node judgeInstance.mjs '<json: { users: [ids], source, cases, budgetMs }>'
// Prints one JSON line per finished evaluation.
const spec = JSON.parse(process.argv[2]);
if (spec.budgetMs) process.env.JUDGE_EVALUATION_BUDGET_MS = String(spec.budgetMs);
const { evaluateAllTestcases } = await import("../../src/controllers/execution.controller.js");
const { openJudgeSession, runWithJudgeSession } = await import("../../src/utils/judgeAdmission.js");

const problem = {
  slug: "judge-dos-e2e", timeLimit: 2000, memoryLimit: 256,
  testcases: Array.from({ length: spec.cases }, (_, i) => ({ testIndex: i, isVisible: i < 2, stdinSmall: String(i), expectedSmall: String(i) })),
};
await Promise.all(spec.users.map(async (userId) => {
  const started = Date.now();
  const session = openJudgeSession({ userId });
  try {
    const r = await runWithJudgeSession(session, () => evaluateAllTestcases(problem, "python", "unused", spec.source));
    console.log(JSON.stringify({ userId, status: r.status, executed: r.results.length, sandboxTimeMs: r.sandboxTimeMs, elapsedMs: Date.now() - started }));
  } catch (err) {
    console.log(JSON.stringify({ userId, error: err.code || err.message, elapsedMs: Date.now() - started }));
  } finally {
    session.close();
  }
}));
process.exit(0);
