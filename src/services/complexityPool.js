// Runs the static complexity analyzer in worker threads with a hard per-job
// timeout, so a slow or adversarial input can never block the API's event
// loop. A job that times out terminates its worker (the only way to stop
// synchronous code) and a fresh worker takes its place. When the queue is
// full, analysis is skipped: it is optional and never affects verdicts.
import { Worker } from "worker_threads";
import { readLimit } from "../config/limits.js";

const WORKER_URL = new URL("./complexityWorker.js", import.meta.url);

export const MAX_ANALYZE_CODE_BYTES = 64 * 1024;

const settings = () => ({
  size: Math.max(1, Number(process.env.COMPLEXITY_WORKERS) || 1),
  timeoutMs: Math.max(100, Number(process.env.COMPLEXITY_TIMEOUT_MS) || 2000),
  maxQueue: Math.max(0, Number(process.env.COMPLEXITY_MAX_QUEUE) || 50),
});

const workers = []; // { worker, job }
const queue = []; // { options, resolve, timeoutMs }
let nextId = 1;
let closed = false;

function unknown(reason) {
  return {
    status: "unknown",
    summary: "Complexity analysis unavailable",
    limitations: [reason],
    time: { bestEstimate: "Unknown", confidence: "unknown" },
    space: { bestEstimate: "Unknown", confidence: "unknown" },
  };
}

function spawn() {
  // Heap cap (SA-L4): an input that makes the analyzer allocate without bound
  // kills only this worker (ERR_WORKER_OUT_OF_MEMORY -> "unknown" result and
  // a fresh worker), never the API process.
  const heapMb = readLimit("COMPLEXITY_WORKER_MAX_HEAP_MB");
  const slot = {
    worker: new Worker(WORKER_URL, {
      resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: Math.max(16, Math.floor(heapMb / 8)) },
    }),
    job: null,
  };
  slot.worker.on("message", ({ id, result, error }) => {
    const job = slot.job;
    if (!job || job.id !== id) return;
    finish(slot, error ? unknown(`Analyzer error: ${error}`) : result);
  });
  slot.worker.on("error", () => replace(slot, "Analyzer worker crashed"));
  slot.worker.on("exit", () => replace(slot, "Analyzer worker exited"));
  // After the listeners: adding a "message" listener re-refs the port. Idle
  // workers must never keep the process (scripts, tests) alive.
  slot.worker.unref();
  workers.push(slot);
  return slot;
}

function replace(slot, reason) {
  const index = workers.indexOf(slot);
  if (index < 0) return; // already replaced
  workers.splice(index, 1);
  if (slot.job) {
    clearTimeout(slot.job.timer);
    slot.job.resolve(unknown(reason));
    slot.job = null;
  }
  if (!closed) {
    spawn();
    pump();
  }
}

function finish(slot, result) {
  const job = slot.job;
  slot.job = null;
  slot.worker.unref(); // idle again
  clearTimeout(job.timer);
  job.resolve(result);
  pump();
}

function pump() {
  if (closed) return;
  const { size } = settings();
  while (workers.length < size) spawn();
  for (const slot of workers) {
    if (slot.job || queue.length === 0) continue;
    const job = queue.shift();
    job.id = nextId++;
    slot.job = job;
    slot.worker.ref(); // a pending job keeps the process alive until it settles
    job.timer = setTimeout(() => {
      // Synchronous code cannot be interrupted: terminate the worker.
      const reason = `Analysis exceeded ${job.timeoutMs} ms`;
      const index = workers.indexOf(slot);
      if (index >= 0) workers.splice(index, 1);
      slot.job = null;
      job.resolve(unknown(reason));
      slot.worker.terminate().catch(() => {});
      if (!closed) {
        spawn();
        pump();
      }
    }, job.timeoutMs);
    job.timer.unref?.();
    slot.worker.postMessage({ id: job.id, options: job.options });
  }
}

/**
 * Analyzes code off the main thread. Never throws; resolves to an "unknown"
 * result on timeout, overload, oversized input or analyzer failure.
 */
export function analyzeComplexitySafe(options, { timeoutMs } = {}) {
  const code = options?.code;
  if (typeof code !== "string" || !code.trim()) {
    return Promise.resolve(unknown("Source code was empty or whitespace only"));
  }
  if (Buffer.byteLength(code, "utf-8") > MAX_ANALYZE_CODE_BYTES) {
    return Promise.resolve(unknown("Source code too large to analyze"));
  }
  const cfg = settings();
  if (queue.length >= cfg.maxQueue) {
    return Promise.resolve(unknown("Analyzer is busy"));
  }
  // Only plain data crosses the thread boundary.
  const plain = {
    code,
    language: String(options.language || ""),
    problemSlug: options.problemSlug ? String(options.problemSlug) : "",
    include: Array.isArray(options.include) ? options.include.map(String) : undefined,
    executionResult: options.executionResult
      ? {
          timeMs: Number(options.executionResult.timeMs) || 0,
          memoryKb: Number(options.executionResult.memoryKb) || 0,
        }
      : null,
  };
  return new Promise((resolve) => {
    queue.push({ options: plain, resolve, timeoutMs: timeoutMs ?? cfg.timeoutMs });
    pump();
  });
}

/** Stops all workers (graceful shutdown and tests). */
export async function closeComplexityPool() {
  closed = true;
  for (const job of queue.splice(0)) job.resolve(unknown("Shutting down"));
  await Promise.all(
    workers.splice(0).map((slot) => {
      if (slot.job) {
        clearTimeout(slot.job.timer);
        slot.job.resolve(unknown("Shutting down"));
      }
      return slot.worker.terminate().catch(() => {});
    }),
  );
}
