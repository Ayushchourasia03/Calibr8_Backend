// Worker-thread entry for password hashing (see passwordPool.js). bcrypt at
// cost 12 costs ~0.3-0.5 s of CPU per call; running it here keeps the API's
// event loop free (SA-M2). Same library and parameters as before, so existing
// hashes stay valid.
import { parentPort } from "worker_threads";
import bcrypt from "bcryptjs";

parentPort.on("message", async ({ id, op, password, hash, rounds }) => {
  try {
    let result;
    if (op === "hash") result = await bcrypt.hash(password, rounds);
    else if (op === "compare") result = await bcrypt.compare(password, hash);
    else throw new Error(`unknown op ${op}`);
    parentPort.postMessage({ id, result });
  } catch (err) {
    parentPort.postMessage({ id, error: err?.message || "password operation failed" });
  }
});
