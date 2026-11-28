// SA-H2 / FV-1 (round 2) against a REAL CodeBox sandbox: sleeping and
// CPU-burning submissions, four attacking accounts plus a legitimate user,
// several backend instances, a Redis outage and a worker crash.
//
// Skipped unless explicitly enabled against a DISPOSABLE CodeBox stack:
//   JUDGE_DOS_E2E=1 CODEBOX_URL=http://127.0.0.1:<port> CODEBOX_TOKEN=<token>
//   CODEBOX_ALLOW_INSECURE_HTTP=true JUDGE_DOS_WORKER=<worker container>
//   [JUDGE_DOS_DISRUPT=1 JUDGE_DOS_REDIS=<redis container>]  stops Redis, kills the worker
// Uses no database (DATABASE_URL may point anywhere unreachable). Never run
// it against a CodeBox other people use: it deliberately loads the judge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const enabled = process.env.JUDGE_DOS_E2E === "1"
  && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(process.env.CODEBOX_URL || "")
  && Boolean(process.env.JUDGE_DOS_WORKER);
const WORKER = process.env.JUDGE_DOS_WORKER;
const REDIS = process.env.JUDGE_DOS_REDIS;
const disruptiveEnabled = enabled && process.env.JUDGE_DOS_DISRUPT === "1" && Boolean(REDIS);
const e2e = enabled ? test : (name, fn) => test(name, { skip: "set JUDGE_DOS_E2E=1, a loopback CODEBOX_URL and JUDGE_DOS_WORKER" }, fn);
const disruptive = disruptiveEnabled ? test : (name, fn) => test(name, { skip: "set JUDGE_DOS_DISRUPT=1 and JUDGE_DOS_REDIS" }, fn);

process.env.CODEBOX_MULTICASE_ENABLED = "false";
const { evaluateAllTestcases, executeCodeBatch } = await import("../src/controllers/execution.controller.js");
const { openJudgeSession, runWithJudgeSession, judgeAdmissionStats, __resetJudgeAdmissionForTests } = await import("../src/utils/judgeAdmission.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).trim();
const problem = (count) => ({
  slug: "judge-dos-e2e", timeLimit: 2000, memoryLimit: 256,
  testcases: Array.from({ length: count }, (_, i) => ({ testIndex: i, isVisible: i < 2, stdinSmall: String(i), expectedSmall: String(i) })),
});
const SLEEP_WRONG = "import time\ntime.sleep(3.5)\nprint('wrong')\n";
const SLEEP_CORRECT = "import time, sys\nv = sys.stdin.read().strip()\ntime.sleep(3.5)\nprint(v)\n";
const CPU_LOOP = "while True:\n    pass\n";
const ECHO = "import sys\nprint(sys.stdin.read().strip())\n";

async function judge(userId, source, cases) {
  const session = openJudgeSession({ userId });
  const started = Date.now();
  try {
    const r = await runWithJudgeSession(session, () => evaluateAllTestcases(problem(cases), "python", "unused", source));
    return { ...r, elapsedMs: Date.now() - started };
  } finally {
    session.close();
  }
}

async function victimRun(userId) {
  const session = openJudgeSession({ userId });
  const started = Date.now();
  try {
    await session.reserve();
    const [result] = await runWithJudgeSession(session, () => executeCodeBatch({ language: "python", fullCode: ECHO, testcases: [{ stdin: "42" }], timeLimit: 2000 }));
    return { status: result.status, actual: result.actual, latencyMs: Date.now() - started };
  } finally {
    session.close();
  }
}

/** Processes still running as an isolate box user in the worker container. */
function boxProcesses() {
  return docker("exec", WORKER, "ps", "-eo", "uid=,args=").split("\n").map((l) => l.trim()).filter(Boolean)
    .filter((l) => { const uid = Number(l.split(/\s+/)[0]); return uid >= 60000 && uid < 61000; });
}
async function idleSandbox(timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  let procs = boxProcesses();
  while (procs.length && Date.now() < until) {
    await sleep(250);
    procs = boxProcesses();
  }
  return procs;
}

function spawnInstance(spec) {
  const script = fileURLToPath(new URL("./helpers/judgeInstance.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, JSON.stringify(spec)], { env: process.env, timeout: 600000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)));
    });
  });
}

e2e("sleeping wrong answer (real sandbox): cut off after the post-failure budget, wall time counted", async () => {
  __resetJudgeAdmissionForTests();
  const r = await judge("e2e-sleeper", SLEEP_WRONG, 100);
  console.log(`[evidence] sleeping wrong answer: ${JSON.stringify({ status: r.status, executed: r.results.length, sandboxTimeMs: r.sandboxTimeMs, elapsedMs: r.elapsedMs })}`);
  assert.equal(r.status, "WRONG_ANSWER");
  assert.ok(r.results.length <= 10, `executed ${r.results.length} of 35 (round 1: 35)`);
  assert.ok(r.sandboxTimeMs < 45000, `sandbox time ${r.sandboxTimeMs} ms (round 1: 123,444 ms)`);
  assert.deepEqual(await idleSandbox(), []);
});

e2e("sleeping CORRECT answer (real sandbox): total budget stops it with Time Limit Exceeded", async () => {
  __resetJudgeAdmissionForTests();
  const budgetMs = Number(process.env.JUDGE_EVALUATION_BUDGET_MS || 120000);
  const r = await judge("e2e-correct-sleeper", SLEEP_CORRECT, 100);
  console.log(`[evidence] sleeping correct answer: ${JSON.stringify({ status: r.status, executed: r.results.length, sandboxTimeMs: r.sandboxTimeMs, budgetMs, elapsedMs: r.elapsedMs })}`);
  assert.equal(r.status, "TIME_LIMIT_EXCEEDED");
  assert.equal(r.budgetExceeded, true);
  assert.ok(r.sandboxTimeMs <= budgetMs + 2 * 9000, `sandbox time ${r.sandboxTimeMs} ms`);
  assert.deepEqual(await idleSandbox(), []);
});

e2e("infinite CPU loop: Time Limit Exceeded on the first case, nothing else runs", async () => {
  __resetJudgeAdmissionForTests();
  const r = await judge("e2e-cpu", CPU_LOOP, 100);
  console.log(`[evidence] infinite loop: ${JSON.stringify({ status: r.status, executed: r.results.filter((x) => x.status !== "Skipped").length, sandboxTimeMs: r.sandboxTimeMs })}`);
  assert.equal(r.status, "TIME_LIMIT_EXCEEDED");
  assert.ok(r.sandboxTimeMs < 30000);
  assert.deepEqual(await idleSandbox(), []);
});

e2e("FV-1: four accounts with sleeping submissions + a fifth user's Run: served quickly, never 503", async () => {
  __resetJudgeAdmissionForTests();
  const attackers = [1, 2, 3, 4].map((i) => judge(`e2e-attacker-${i}`, SLEEP_WRONG, 100));
  await sleep(4000);
  const statsDuringAttack = judgeAdmissionStats();
  const victims = [];
  for (let i = 0; i < 3; i++) {
    victims.push(await victimRun(`e2e-victim-${i}`));
    await sleep(2000);
  }
  const results = await Promise.all(attackers);
  console.log(`[evidence] 4 attackers + victims: ${JSON.stringify({ activeDuringAttack: statsDuringAttack.active, victims, attackers: results.map((r) => ({ status: r.status, executed: r.results.length, sandboxTimeMs: r.sandboxTimeMs, elapsedMs: r.elapsedMs })) })}`);
  for (const v of victims) {
    assert.equal(v.status, "OK");
    assert.equal(v.actual, "42");
    // Round 1: 503 JUDGE_BUSY after 30,007 ms.
    assert.ok(v.latencyMs < 15000, `victim latency ${v.latencyMs} ms`);
  }
  for (const r of results) assert.equal(r.status, "WRONG_ANSWER");
  assert.equal(judgeAdmissionStats().active, 0, "every slot is released");
  assert.deepEqual(await idleSandbox(), []);
});

for (const cases of [5, 15]) {
  e2e(`small problem (${cases} cases, one-shot path): 4 sleeping attackers + a 5th user's Run is served quickly`, async () => {
    __resetJudgeAdmissionForTests();
    const attackers = [1, 2, 3, 4].map((i) => judge(`e2e-os${cases}-attacker-${i}`, SLEEP_WRONG, cases));
    await sleep(3000);
    const victims = [];
    for (let i = 0; i < 3; i++) {
      victims.push(await victimRun(`e2e-os${cases}-victim-${i}`));
      await sleep(1500);
    }
    const results = await Promise.all(attackers);
    console.log(`[evidence] one-shot ${cases} cases: ${JSON.stringify({ victims, attackers: results.map((r) => ({ status: r.status, executed: r.results.length, sandboxTimeMs: r.sandboxTimeMs, elapsedMs: r.elapsedMs })) })}`);
    // Before the CodeBox duration cap: the first victim waited 18.6 s (5 cases) and 54 s (15 cases).
    for (const v of victims) {
      assert.equal(v.status, "OK");
      assert.ok(v.latencyMs < 15000, `victim latency ${v.latencyMs} ms`);
    }
    for (const r of results) assert.equal(r.status, "WRONG_ANSWER");
    assert.deepEqual(await idleSandbox(), []);
  });
}

e2e("several backend instances: attackers on two other instances cannot starve a user on this one", async () => {
  __resetJudgeAdmissionForTests();
  const instances = [
    spawnInstance({ users: ["e2e-mi-a1", "e2e-mi-a2"], source: SLEEP_WRONG, cases: 100 }),
    spawnInstance({ users: ["e2e-mi-b1", "e2e-mi-b2"], source: SLEEP_WRONG, cases: 100 }),
  ];
  await sleep(6000);
  const victims = [];
  for (let i = 0; i < 3; i++) {
    victims.push(await victimRun(`e2e-mi-victim-${i}`));
    await sleep(2000);
  }
  const others = (await Promise.all(instances)).flat();
  console.log(`[evidence] multi-instance: ${JSON.stringify({ victims, attackers: others })}`);
  for (const v of victims) {
    assert.equal(v.status, "OK");
    assert.ok(v.latencyMs < 15000, `victim latency ${v.latencyMs} ms`);
  }
  for (const o of others) assert.equal(o.status, "WRONG_ANSWER", JSON.stringify(o));
  assert.deepEqual(await idleSandbox(), []);
});

disruptive("Redis outage during admission: Run fails fast with 503 and the slot is released; service recovers", async () => {
  __resetJudgeAdmissionForTests();
  docker("stop", REDIS);
  let outcome;
  const started = Date.now();
  try {
    outcome = await victimRun("e2e-redis").catch((err) => ({ error: err.code, status: err.status }));
  } finally {
    docker("start", REDIS);
  }
  const elapsed = Date.now() - started;
  console.log(`[evidence] redis outage: ${JSON.stringify({ outcome, elapsedMs: elapsed })}`);
  assert.equal(outcome.error, "EXECUTION_UNAVAILABLE");
  assert.equal(outcome.status, 503);
  assert.ok(elapsed < 20000, `answered after ${elapsed} ms`);
  assert.equal(judgeAdmissionStats().active, 0);
  let recovered = null;
  for (let i = 0; i < 30 && !recovered; i++) {
    await sleep(2000);
    recovered = await victimRun("e2e-redis-after").catch(() => null);
  }
  assert.equal(recovered?.status, "OK", "judging works again once Redis is back");
});

disruptive("worker crash mid-evaluation: the evaluation settles, slots are released, no process or box is left", async () => {
  __resetJudgeAdmissionForTests();
  const running = judge("e2e-crash", "import time, sys\nv = sys.stdin.read().strip()\ntime.sleep(1)\nprint(v)\n", 10)
    .then((r) => ({ status: r.status }), (err) => ({ error: err.code }));
  await sleep(2500);
  docker("kill", WORKER);
  docker("start", WORKER);
  const outcome = await running;
  console.log(`[evidence] worker crash: ${JSON.stringify(outcome)}`);
  assert.ok(outcome.status === "ACCEPTED" || outcome.error === "EXECUTION_UNAVAILABLE", JSON.stringify(outcome));
  assert.equal(judgeAdmissionStats().active, 0);
  assert.deepEqual(await idleSandbox(30000), []);
  const boxes = docker("exec", WORKER, "sh", "-c", "ls /var/local/lib/isolate 2>/dev/null || true").split("\n").filter(Boolean);
  assert.deepEqual(boxes, [], "no box with another user's files is left on disk");
});
