// Bounded worker-thread pool for bcrypt (SA-M2).
//
// - PASSWORD_HASH_WORKERS workers, one job each at a time: password hashing
//   can use at most that many cores, whatever the request rate.
// - At most PASSWORD_HASH_MAX_QUEUE jobs wait; beyond that requests fail fast
//   with 503 AUTH_BUSY instead of piling up (login floods cannot exhaust
//   memory or delay every other request).
// - A job that takes longer than PASSWORD_HASH_TIMEOUT_MS terminates its
//   worker (a replacement is started) and fails with 503.
// - If worker threads cannot be started at all, jobs run in-thread (the
//   previous behaviour) rather than making login impossible; this is logged.
import { Worker } from "worker_threads";
import bcrypt from "bcryptjs";
import { ApiError } from "../utils/ApiError.js";
import { readLimit } from "../config/limits.js";

let workerUrl = new URL("./passwordWorker.js", import.meta.url);

const slots = []; // { worker, job, terminating }
const queue = []; // { op, args, resolve, reject }
let nextId = 1;
let workersUnavailable = false;
let closed = false;

// Circuit breaker: workers that keep crashing (not timeouts or shutdown) would
// otherwise be respawned forever while every login fails with 503. After
// CRASH_LIMIT crashes within CRASH_WINDOW_MS the pool hashes in-thread (the
// pre-remediation behaviour) and says so in the log.
const CRASH_LIMIT = 5;
const CRASH_WINDOW_MS = 60_000;
const crashTimes = [];

function recordCrash() {
  const now = Date.now();
  crashTimes.push(now);
  while (crashTimes.length && now - crashTimes[0] > CRASH_WINDOW_MS) crashTimes.shift();
  if (crashTimes.length >= CRASH_LIMIT && !workersUnavailable) {
    workersUnavailable = true;
    console.error(`[PasswordPool] ${crashTimes.length} worker crashes within ${CRASH_WINDOW_MS / 1000} s: hashing in-thread from now on.`);
  }
}

function busy() {
  return new ApiError(503, "Sign-in is busy right now. Please try again in a moment.", "AUTH_BUSY", {
    retryAfterSeconds: 2,
  });
}

function spawn() {
  let worker;
  try {
    worker = new Worker(workerUrl);
  } catch (err) {
    if (!workersUnavailable) console.error("[PasswordPool] worker threads unavailable, hashing in-thread:", err.message);
    workersUnavailable = true;
    return null;
  }
  const slot = { worker, job: null, terminating: false };
  worker.on("message", ({ id, result, error }) => {
    const job = slot.job;
    if (!job || job.id !== id) return;
    finish(slot);
    if (error) job.reject(new Error(error));
    else job.resolve(result);
  });
  worker.on("error", () => replace(slot));
  worker.on("exit", () => replace(slot));
  worker.unref();
  slots.push(slot);
  return slot;
}

function finish(slot) {
  const job = slot.job;
  slot.job = null;
  if (job) clearTimeout(job.timer);
  slot.worker.unref();
  pump();
}

function replace(slot) {
  const index = slots.indexOf(slot);
  if (index < 0) return;
  slots.splice(index, 1);
  if (!slot.terminating && !closed) recordCrash();
  const job = slot.job;
  slot.job = null;
  if (job) {
    clearTimeout(job.timer);
    job.reject(busy());
  }
  if (!closed) pump();
}

function pump() {
  if (closed) return;
  const size = readLimit("PASSWORD_HASH_WORKERS");
  while (!workersUnavailable && slots.length < size) {
    if (!spawn()) break;
  }
  if (workersUnavailable) {
    while (queue.length) runInThread(queue.shift());
    return;
  }
  for (const slot of slots) {
    if (slot.job || queue.length === 0) continue;
    const job = queue.shift();
    job.id = nextId++;
    slot.job = job;
    slot.worker.ref();
    job.timer = setTimeout(() => {
      // bcrypt cannot be interrupted: terminate the worker; replace() fails the job.
      slot.terminating = true;
      slot.worker.terminate().catch(() => {});
    }, readLimit("PASSWORD_HASH_TIMEOUT_MS"));
    job.timer.unref?.();
    slot.worker.postMessage({ id: job.id, op: job.op, ...job.args });
  }
}

function runInThread(job) {
  const work = job.op === "hash" ? bcrypt.hash(job.args.password, job.args.rounds) : bcrypt.compare(job.args.password, job.args.hash);
  work.then(job.resolve, job.reject);
}

function submit(op, args) {
  return new Promise((resolve, reject) => {
    const job = { op, args, resolve, reject };
    queue.push(job);
    pump(); // starts it at once when a worker is free
    // Only jobs that actually have to wait count against the queue limit.
    const index = queue.indexOf(job);
    if (index >= 0 && queue.length > readLimit("PASSWORD_HASH_MAX_QUEUE")) {
      queue.splice(index, 1);
      reject(busy());
    }
  });
}

/** bcrypt hash of `password` with `rounds`, computed off the event loop. */
export const hashInPool = (password, rounds) => submit("hash", { password, rounds });

/** bcrypt compare, computed off the event loop. */
export const compareInPool = (password, hash) => submit("compare", { password, hash });

/** Test hook: use a different worker script (e.g. one that crashes). */
export function __setPasswordWorkerUrlForTests(url) {
  workerUrl = url;
}

export function passwordPoolStats() {
  return { workers: slots.length, busy: slots.filter((s) => s.job).length, queued: queue.length, workersUnavailable };
}

/** Stops the workers (graceful shutdown and tests). */
export async function closePasswordPool() {
  closed = true;
  for (const job of queue.splice(0)) job.reject(busy());
  await Promise.all(
    slots.splice(0).map((slot) => {
      if (slot.job) {
        clearTimeout(slot.job.timer);
        slot.job.reject(busy());
      }
      return slot.worker.terminate().catch(() => {});
    }),
  );
}
