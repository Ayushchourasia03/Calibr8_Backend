// scripts/complexity-accuracy.mjs
//
// Measures the static complexity analyzer against the hand-verified benchmark
// in tests/fixtures/complexityCorpus.js.
//
//   node scripts/complexity-accuracy.mjs            summary + failures
//   node scripts/complexity-accuracy.mjs --json     machine-readable result
import { analyzeComplexity, clearComplexityCache } from "../src/services/complexityAnalyzer.service.js";
import { corpus, isCorrect } from "../tests/fixtures/complexityCorpus.js";

export async function measureAccuracy(cases = corpus) {
  clearComplexityCache();
  const rows = [];
  for (const c of cases) {
    const r = await analyzeComplexity({ code: c.code, language: c.lang, include: ["time", "space"] });
    const time = r.time?.bestEstimate || "Unknown";
    const space = r.space?.bestEstimate || "Unknown";
    rows.push({
      id: c.id,
      set: c.set,
      lang: c.lang,
      expectedTime: c.time,
      time,
      timeConfidence: r.time?.confidence,
      timeOk: isCorrect(time, c.time, c.timeAlt),
      expectedSpace: c.space,
      space,
      spaceConfidence: r.space?.confidence,
      spaceOk: isCorrect(space, c.space, c.spaceAlt),
    });
  }
  const pct = (xs, key) => (xs.length ? Math.round((xs.filter((x) => x[key]).length / xs.length) * 1000) / 10 : 0);
  const summarize = (xs) => ({
    cases: xs.length,
    time: pct(xs, "timeOk"),
    space: pct(xs, "spaceOk"),
    both: xs.length ? Math.round((xs.filter((x) => x.timeOk && x.spaceOk).length / xs.length) * 1000) / 10 : 0,
  });
  const bySet = Object.fromEntries(["dev", "holdout"].map((s) => [s, summarize(rows.filter((r) => r.set === s))]));
  const byLang = Object.fromEntries([...new Set(rows.map((r) => r.lang))].map((l) => [l, summarize(rows.filter((r) => r.lang === l))]));
  // How often each confidence level is right (calibration).
  const byConfidence = Object.fromEntries(
    ["high", "medium", "low"].map((lvl) => {
      const xs = rows.filter((r) => r.timeConfidence === lvl);
      return [lvl, { cases: xs.length, timeCorrect: pct(xs, "timeOk") }];
    }),
  );
  return { overall: summarize(rows), bySet, byLang, byConfidence, rows };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const result = await measureAccuracy();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const f = (s) => `${String(s.cases).padStart(3)} cases | time ${String(s.time).padStart(5)}% | space ${String(s.space).padStart(5)}% | both ${String(s.both).padStart(5)}%`;
    console.log(`OVERALL  ${f(result.overall)}`);
    for (const [k, v] of Object.entries(result.bySet)) console.log(`${k.padEnd(8)} ${f(v)}`);
    for (const [k, v] of Object.entries(result.byLang)) console.log(`  ${k.padEnd(10)} ${f(v)}`);
    console.log("time confidence calibration:", JSON.stringify(result.byConfidence));
    const bad = result.rows.filter((r) => !r.timeOk || !r.spaceOk);
    if (bad.length) console.log(`\nFailures (${bad.length}):`);
    for (const r of bad) {
      const parts = [];
      if (!r.timeOk) parts.push(`time ${r.time} (${r.timeConfidence}) expected ${r.expectedTime}`);
      if (!r.spaceOk) parts.push(`space ${r.space} expected ${r.expectedSpace}`);
      console.log(`  [${r.set}] ${r.id.padEnd(30)} ${parts.join(" | ")}`);
    }
  }
}
