// Worker-thread entry for the static complexity analyzer. The analyzer is
// CPU-bound (and super-linear on some inputs), so it must never run on the
// main event loop. See complexityPool.js.
import { parentPort } from "worker_threads";
import { analyzeComplexity } from "./complexityAnalyzer.service.js";

parentPort.on("message", async ({ id, options }) => {
  try {
    const result = await analyzeComplexity(options);
    parentPort.postMessage({ id, result });
  } catch (err) {
    parentPort.postMessage({ id, error: err?.message || "Analyzer failed" });
  }
});
