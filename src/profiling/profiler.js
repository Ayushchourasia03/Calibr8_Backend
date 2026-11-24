// src/profiling/profiler.js
//
// Empirical complexity profiler. Runs an ACCEPTED solution on progressively
// larger generated inputs inside one CodeBox sandbox (compile once), measures
// only the solution's function call, and classifies time and auxiliary-space
// growth. It never influences a submission verdict: every failure here becomes
// an INCONCLUSIVE or FAILED profile.

import { buildFinalCode, LANGUAGE_IDS, normalizeLanguage } from "../utils/codeBuilder.js";
import { fetchCodeboxJson, getCodeboxUrl } from "../utils/codeboxClient.js";
import { isHarnessSafeUserCode } from "../utils/multiCaseHarness.js";
import { wrapWithProfileHarness, buildProfileStdin, parseProfileOutput } from "./profileHarness.js";
import { classifyGrowth, classifyTimeWithReference, downgrade, TIME_MODELS, SPACE_MODELS } from "./complexityFit.js";

/** Profiling configuration from the environment (read at call time). */
export function getProfilingConfig(env = process.env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    enabled: ["true", "1"].includes(String(env.COMPLEXITY_PROFILING_ENABLED ?? "false").toLowerCase()),
    concurrency: Math.max(1, Math.floor(num(env.COMPLEXITY_PROFILING_CONCURRENCY, 1))),
    // 16000 keeps a profiling request around 0.15 MB (CodeBox stores request
    // payloads in a 256 MB Redis) and measured best on the production VPS;
    // raise only together with Redis capacity.
    maxInputSize: num(env.COMPLEXITY_PROFILING_MAX_INPUT_SIZE, 16000),
    repetitions: Math.min(10, Math.max(1, Math.floor(num(env.COMPLEXITY_PROFILING_REPETITIONS, 3)))),
    timeoutMs: num(env.COMPLEXITY_PROFILING_TIMEOUT_MS, 90_000),
    maxPending: Math.max(1, Math.floor(num(env.COMPLEXITY_PROFILING_MAX_PENDING, 50))),
    maxAttempts: Math.max(1, Math.floor(num(env.COMPLEXITY_PROFILING_MAX_ATTEMPTS, 3))),
    // Sandbox limits for the whole profiling run (CodeBox caps: 15 s CPU, 20 s wall, 512 MB).
    cpuLimitSec: num(env.COMPLEXITY_PROFILING_CPU_LIMIT_SEC, 15),
    wallLimitSec: num(env.COMPLEXITY_PROFILING_WALL_LIMIT_SEC, 20),
    memoryLimitMb: num(env.COMPLEXITY_PROFILING_MEMORY_LIMIT_MB, 512),
    // Per-invocation limit, and the CPU time after which larger sizes are skipped.
    perRunTimeLimitMs: num(env.COMPLEXITY_PROFILING_PER_RUN_LIMIT_MS, 3000),
    stopAboveCpuMs: num(env.COMPLEXITY_PROFILING_STOP_ABOVE_MS, 1200),
  };
}

// Hard cap on the profiling stdin. CodeBox keeps every request payload in Redis
// (256 MB, no eviction) for up to an hour, so profiling requests stay small.
const MAX_STDIN_BYTES = 1024 * 1024;

/** Error raised for profiling problems that should not be retried. */
export class ProfilingError extends Error {
  constructor(message, { code = "PROFILING_FAILED", retryable = false } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

/** Extracts the header of a problem's structured template for a language. */
export function getTemplateHeader(problem, language) {
  let tmpl = problem?.templatesMap?.[language] ?? problem?.templates?.[language];
  if (!tmpl && Array.isArray(problem?.templates)) {
    const match = problem.templates.find((t) => normalizeLanguage(t.language) === language);
    tmpl = match?.header !== undefined ? match : match?.code;
  }
  if (typeof tmpl === "string" && tmpl.trim().startsWith("{")) {
    try {
      tmpl = JSON.parse(tmpl);
    } catch {
      tmpl = null;
    }
  }
  return tmpl && typeof tmpl === "object" ? tmpl.header || "" : "";
}

/** Parses a driver line "C8M v=1 key=value ..." into numbers. */
export function parseDriverLine(stdout) {
  const line = String(stdout || "").split("\n").find((l) => l.startsWith("C8M "));
  if (!line) return null;
  const out = {};
  for (const part of line.slice(4).trim().split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq)] = Number(part.slice(eq + 1));
  }
  return out;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Runs the profiling program on CodeBox and returns the parsed report. */
async function executeProfileRun({ source, stdin, language, config, signal }) {
  const runnerUrl = getCodeboxUrl(true);
  const created = await fetchCodeboxJson(new URL("/submissions?base64_encoded=true&wait=true", runnerUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    timeoutMs: 40_000,
    signal,
    body: JSON.stringify({
      source_code: Buffer.from(source).toString("base64"),
      language_id: LANGUAGE_IDS[language] || 54,
      stdin: stdin.toString("base64"),
      cpu_time_limit: config.cpuLimitSec,
      wall_time_limit: config.wallLimitSec,
      // CodeBox rejects anything above its MAX_MEMORY_LIMIT (default 512000 KB).
      memory_limit: Math.min(config.memoryLimitMb * 1024, 512000),
      max_processes_and_or_threads: 60,
    }),
  });
  const pending = (s) => !s?.status?.id || [1, 2].includes(Number(s.status.id));
  let sub = created;
  const deadline = Date.now() + 60_000;
  // Gentle polling: profiling shares CodeBox's per-client rate limit with
  // normal judging, so it must never burn through it.
  const interval = 2000;
  while (pending(sub)) {
    if (!created?.token) throw new ProfilingError("CodeBox returned no submission token.", { code: "EXECUTION_UNAVAILABLE", retryable: true });
    if (Date.now() > deadline) throw new ProfilingError("CodeBox did not finish the profiling run in time.", { code: "EXECUTION_UNAVAILABLE", retryable: true });
    await new Promise((r) => setTimeout(r, interval));
    const pollUrl = new URL(`/submissions/${created.token}`, runnerUrl);
    pollUrl.searchParams.set("base64_encoded", "true");
    sub = await fetchCodeboxJson(pollUrl, { signal });
  }
  // Drop the (large) request payload from CodeBox's Redis right away instead of
  // letting it occupy memory for the result-cache TTL. Best effort.
  if (created?.token) {
    fetchCodeboxJson(new URL(`/submissions/${created.token}`, runnerUrl), { method: "DELETE", timeoutMs: 5000 }).catch(() => {});
  }
  const decode = (v) => (v ? Buffer.from(v, "base64").toString("utf-8") : "");
  const statusId = Number(sub.status?.id);
  if (statusId === 6) {
    throw new ProfilingError(`Profiling program did not compile: ${decode(sub.compile_output).slice(0, 500)}`, { code: "PROFILE_COMPILE_FAILED" });
  }
  if (statusId === 13) throw new ProfilingError("CodeBox internal error.", { code: "EXECUTION_UNAVAILABLE", retryable: true });
  const parsed = parseProfileOutput(sub.stdout ? Buffer.from(sub.stdout, "base64") : Buffer.alloc(0));
  if (!parsed) {
    // The sandbox killed the harness before it reported anything (e.g. its
    // memory or time limit). Not retryable: the same code would do it again.
    throw new ProfilingError(
      `Profiling run produced no report (status: ${sub.status?.description || statusId}).`,
      { code: "PROFILE_NO_REPORT" },
    );
  }
  return { ...parsed, sandboxStatus: sub.status?.description || String(statusId), sandboxTimeSec: Number(sub.time) || null, sandboxMemoryKb: Number(sub.memory) || null };
}

/**
 * Turns harness invocations into per-size measurements.
 * runsMeta[i] = { n, tag } for harness run i.
 */
export function collectMeasurements(invocations, runsMeta) {
  const bySize = new Map();
  for (const inv of invocations) {
    const meta = runsMeta[inv.run];
    if (!meta) continue;
    if (!bySize.has(meta.n)) bySize.set(meta.n, { n: meta.n, baseline: [], user: [] });
    const d = parseDriverLine(inv.stdout);
    bySize.get(meta.n)[meta.tag].push({
      exitCode: inv.exitCode,
      signal: inv.signal,
      processCpuMs: inv.cpuMs,
      processWallMs: inv.wallMs,
      processMaxRssKb: inv.maxRssKb,
      stderr: inv.stderr ? inv.stderr.slice(0, 300) : "",
      ...(d
        ? {
            ok: d.ok === 1,
            firstNs: d.first_ns,
            cpuNs: d.cpu_ns,
            medianNs: d.median_ns,
            minNs: d.min_ns,
            calls: d.calls,
            timerNs: d.timer_ns,
            heapPeakBytes: d.heap_peak,
            outNodes: d.out_nodes,
            newOutNodes: d.new_out_nodes,
            nodeBytes: d.node_bytes,
            stackBytes: d.stack_bytes,
            rssBeforeKb: d.rss_before_kb,
            rssAfterKb: d.rss_after_kb,
            refMedianNs: d.ref_median_ns,
          }
        : { ok: false, driverOutputMissing: true }),
    });
  }
  return [...bySize.values()].sort((a, b) => a.n - b.n);
}

/** Classifies time and space from per-size measurements. */
export function analyzeMeasurements(sizes, { repetitions, definition }) {
  const valid = [];
  let invalidReason = null;
  for (const s of sizes) {
    const reps = s.user;
    const failure = reps.find((r) => r.exitCode !== 0 || r.signal !== 0);
    // Not run at all: the harness skipped larger sizes on purpose (a previous
    // size was slow, or the time budget ran out). That ends the curve but is
    // not a failure of the solution.
    if (reps.length === 0) break;
    if (failure) {
      invalidReason = `Solution failed on a profiling input of size ${s.n} (exit ${failure.exitCode}${failure.signal ? `, signal ${failure.signal}` : ""}).`;
      break;
    }
    if (reps.some((r) => !r.ok)) {
      invalidReason = reps.some((r) => r.driverOutputMissing)
        ? `No measurement was reported for n=${s.n}.`
        : `Solution returned an incorrect result for a profiling input of size ${s.n} (larger than the problem constraints).`;
      break;
    }
    valid.push(s);
    // Fewer repetitions than requested: the budget ran out during this size.
    if (reps.length < repetitions) break;
  }

  // Time: per repetition, median per-call time minus timer overhead; then the
  // fastest repetition (least scheduling noise). Spread across repetitions
  // feeds the confidence.
  const timePoints = valid.map((s) => {
    const perRep = s.user.map((r) => Math.max(0, r.medianNs - (r.timerNs || 0)));
    const refPerRep = s.user.map((r) => Math.max(0, (r.refMedianNs || 0) - (r.timerNs || 0))).filter((v) => v > 0);
    const best = Math.min(...perRep);
    const worst = Math.max(...perRep);
    // Solution and reference are timed interleaved in the same process, so the
    // per-repetition ratio cancels machine-level noise between processes.
    const pairedRatios = s.user
      .map((r) => {
        const ref = (r.refMedianNs || 0) - (r.timerNs || 0);
        return ref > 0 ? Math.max(0, r.medianNs - (r.timerNs || 0)) / ref : null;
      })
      .filter((v) => Number.isFinite(v));
    return {
      n: s.n,
      cost: best,
      refCost: refPerRep.length ? Math.min(...refPerRep) : null,
      ratio: pairedRatios.length ? median(pairedRatios) : null,
      spread: best > 0 ? (worst - best) / best : 0,
      raw: perRep,
      rawRef: refPerRep,
    };
  });
  const fitOpts = { floor: 40 /* ns: below this, timer jitter dominates */ };
  let time = definition?.referenceComplexity === "O(n)"
    ? classifyTimeWithReference(timePoints.map(({ n, cost, refCost, ratio, spread }) => ({ n, cost, refCost, ratio, spread })), fitOpts)
    : classifyGrowth(timePoints.map(({ n, cost, spread }) => ({ n, cost, spread })), { ...fitOpts, models: TIME_MODELS });
  // The solution failed on larger inputs: the curve is partial.
  if (invalidReason && time.confidence !== "Inconclusive") {
    const lowered = downgrade(time.confidence);
    time = lowered === "Inconclusive"
      ? { ...time, complexity: null, label: "Inconclusive", confidence: "Inconclusive", reason: invalidReason }
      : { ...time, confidence: lowered };
  }

  // Space: auxiliary = heap allocated during the call that is not part of the
  // returned result (newly created output nodes), plus stack used by the call.
  const spacePoints = valid.map((s) => {
    const aux = s.user.map((r) => {
      const outputBytes = (r.newOutNodes || 0) * (r.nodeBytes || 0);
      return Math.max(0, (r.heapPeakBytes || 0) - outputBytes) + (r.stackBytes || 0);
    });
    const baselineRss = median(s.baseline.map((b) => b.rssAfterKb).filter(Number.isFinite));
    const userRss = median(s.user.map((r) => r.rssAfterKb).filter(Number.isFinite));
    return {
      n: s.n,
      cost: median(aux),
      outputBytes: median(s.user.map((r) => (r.newOutNodes || 0) * (r.nodeBytes || 0))),
      heapBytes: median(s.user.map((r) => r.heapPeakBytes || 0)),
      stackBytes: median(s.user.map((r) => r.stackBytes || 0)),
      baselineRssKb: baselineRss,
      userRssKb: userRss,
      rssOverBaselineKb: Number.isFinite(baselineRss) && Number.isFinite(userRss) ? userRss - baselineRss : null,
    };
  });
  // Auxiliary space below ~4 KB at every size is constant (a few locals/frames).
  const space = classifyGrowth(
    spacePoints.map(({ n, cost }) => ({ n, cost })),
    // Byte counts are exact (not timing noise), so neighbouring classes must
    // fit almost as well as the best one to stay candidates.
    { models: SPACE_MODELS, floor: 4096, tolerance: { factor: 1.3, absolute: 0.01 } },
  );
  if (space.complexity === "O(1)" && spacePoints.every((p) => p.cost <= 4096)) {
    space.confidence = "High";
    space.label = "O(1)";
    space.reason = "Auxiliary memory stayed under 4 KB at every input size.";
  }

  const nMax = valid.length ? valid[valid.length - 1].n : 0;
  return {
    validSizes: valid.map((s) => s.n),
    invalidReason,
    largestSize: nMax,
    time: { ...time, unit: "ns", points: timePoints },
    space: {
      ...space,
      unit: "bytes",
      kind: "auxiliary",
      outputSpace: definition?.outputSpace || null,
      points: spacePoints,
    },
  };
}

const CONFIDENCE_ORDER = ["Inconclusive", "Low", "Medium", "High"];

/**
 * Profiles one accepted submission.
 * @returns {Promise<object>} profile result (status COMPLETED | INCONCLUSIVE)
 * @throws {ProfilingError} for failures (retryable ones are infrastructure errors)
 */
export async function runComplexityProfile({ definition, problem, language, userCode, config = getProfilingConfig(), signal }) {
  const started = Date.now();
  const lang = normalizeLanguage(language);
  const driver = definition?.drivers?.[lang];
  if (!driver) throw new ProfilingError(`Profiling is not available for ${language}.`, { code: "UNSUPPORTED" });
  if ((lang === "cpp" || lang === "c") && !isHarnessSafeUserCode(userCode)) {
    throw new ProfilingError("Submitted code uses constructs incompatible with complexity profiling.", {
      code: "UNSAFE_FOR_PROFILING",
      retryable: false,
    });
  }

  // 1. Generate and validate inputs (ascending sizes).
  const sizes = definition.sizes.filter((n) => n <= config.maxInputSize);
  const inputs = [];
  for (const n of sizes) {
    const stdin = definition.generateInput(n, definition.pattern);
    const check = definition.validateInput(stdin);
    if (!check.ok) throw new ProfilingError(`Generated input for n=${n} is invalid: ${check.reason}`, { code: "GENERATOR_INVALID" });
    inputs.push({ n, stdin });
  }
  // Keep the request small (drop the largest sizes).
  while (inputs.length > 4 && inputs.reduce((s, x) => s + Buffer.byteLength(x.stdin) + 32, 0) > MAX_STDIN_BYTES) inputs.pop();

  // 2. One harness run per (size, variant): baseline once, the solution N times.
  const runs = [];
  const runsMeta = [];
  for (const { n, stdin } of inputs) {
    runs.push({ input: stdin, repetitions: 1, tag: "baseline" });
    runsMeta.push({ n, tag: "baseline" });
    runs.push({ reusePrevious: true, repetitions: config.repetitions, tag: "user" });
    runsMeta.push({ n, tag: "user" });
  }

  // 3. Program = problem header + user code + profiling driver (+ harness).
  const header = definition.header ?? getTemplateHeader(problem, lang);
  const fullCode = buildFinalCode({ templatesMap: { [lang]: { header, footer: driver } } }, userCode, lang);
  const source = wrapWithProfileHarness(fullCode, lang);
  const budgetMs = Math.min(config.cpuLimitSec, config.wallLimitSec) * 1000 - 1500;
  const stdin = buildProfileStdin(runs, {
    timeLimitMs: config.perRunTimeLimitMs,
    budgetMs,
    stopAboveCpuMs: config.stopAboveCpuMs,
  });

  // 4. Execute (compile once, one sandbox).
  let report;
  try {
    report = await executeProfileRun({ source, stdin, language: lang, config, signal });
  } catch (err) {
    if (err instanceof ProfilingError) throw err;
    // CodeBox unreachable / HTTP errors / aborted: infrastructure, retryable.
    throw new ProfilingError(err.message || "Code execution service unavailable.", { code: "EXECUTION_UNAVAILABLE", retryable: true });
  }

  // 5. Analyse.
  const measurements = collectMeasurements(report.invocations, runsMeta);
  const analysis = analyzeMeasurements(measurements, { repetitions: config.repetitions, definition });
  const notes = [];
  if (report.endReason === "slow") notes.push("Larger sizes were skipped because a run exceeded the per-size time threshold.");
  if (report.endReason === "budget") notes.push("Larger sizes were skipped to stay within the sandbox time budget.");
  if (analysis.invalidReason) notes.push(analysis.invalidReason);
  notes.push(
    definition.worstCase
      ? `Worst-case inputs: ${String(definition.worstCaseNote || definition.pattern).replace(/\.$/, "")}.`
      : `Observed complexity under the tested input distribution (${definition.pattern}); not a worst-case guarantee.`,
  );
  notes.push("Space is an estimate: C++ heap allocations (operator new) during the call that are not part of the returned result, plus stack depth.");

  const timeOk = analysis.time.confidence !== "Inconclusive";
  const overall = timeOk
    ? CONFIDENCE_ORDER[Math.min(CONFIDENCE_ORDER.indexOf(analysis.time.confidence), Math.max(1, CONFIDENCE_ORDER.indexOf(analysis.space.confidence)))]
    : "Inconclusive";

  return {
    status: timeOk ? "COMPLETED" : "INCONCLUSIVE",
    language: lang,
    timeComplexity: timeOk ? analysis.time.label : null,
    timeConfidence: analysis.time.confidence,
    spaceComplexity: analysis.space.confidence !== "Inconclusive" ? analysis.space.label : null,
    spaceConfidence: analysis.space.confidence,
    confidence: overall,
    inputSizes: inputs.map((x) => x.n),
    validSizes: analysis.validSizes,
    analysis: {
      time: analysis.time,
      space: analysis.space,
      worstCase: Boolean(definition.worstCase),
      pattern: definition.pattern,
      notes,
      endReason: report.endReason,
    },
    measurements,
    baseline: measurements.map((m) => ({ n: m.n, rssAfterKb: m.baseline[0]?.rssAfterKb ?? null, rssBeforeKb: m.baseline[0]?.rssBeforeKb ?? null })),
    failureReason: timeOk ? null : analysis.time.reason || analysis.invalidReason,
    durationMs: Date.now() - started,
    sandbox: { status: report.sandboxStatus, timeSec: report.sandboxTimeSec, memoryKb: report.sandboxMemoryKb },
  };
}
