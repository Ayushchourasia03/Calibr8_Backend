// src/utils/codeboxClient.js
//
// Minimal HTTP client for the CodeBox execution service, shared by the
// execution controller and the complexity profiler.
import net from "net";
import { ApiError } from "./ApiError.js";
import { readLimit } from "../config/limits.js";
import { currentJudgeSession } from "./judgeAdmission.js";

// Transport policy (SA-H3). CodeBox requests carry the CodeBox token, users'
// source code and hidden testcase inputs, and the backend trusts the verdict
// data that comes back, so:
//   - https:// is always allowed; certificate verification stays on (Node's
//     default; validateEnv refuses NODE_TLS_REJECT_UNAUTHORIZED=0 in production);
//   - plain http:// needs CODEBOX_ALLOW_INSECURE_HTTP=true AND a host that is
//     never routed over the internet: loopback in every environment, and, only
//     outside production, private/link-local addresses or single-label hosts
//     (Docker service names such as "codebox");
//   - http:// to any public host (e.g. a bare public IP) is always refused.
export function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(host)) return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (net.isIPv6(host)) return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  // A single-label name only resolves inside a private network (Docker DNS).
  return /^[a-z0-9-]+$/.test(host);
}

export function getCodeboxUrl(required = true) {
  const codeboxUrl = process.env.CODEBOX_URL;
  const codeboxToken = process.env.CODEBOX_TOKEN;

  if (!codeboxUrl || !codeboxToken) {
    if (!required) return null;
    throw new ApiError(
      503,
      "Code execution service is unavailable.",
      "EXECUTION_UNAVAILABLE",
    );
  }

  let runnerUrl;

  try {
    runnerUrl = new URL(codeboxUrl);
  } catch {
    if (!required) return null;
    throw new ApiError(
      503,
      "Code execution service is unavailable.",
      "EXECUTION_UNAVAILABLE",
    );
  }

  const isHttps = runnerUrl.protocol === "https:";
  const isHttp = runnerUrl.protocol === "http:";
  const allowInsecureHttp = process.env.CODEBOX_ALLOW_INSECURE_HTTP === "true";
  const isProduction = process.env.NODE_ENV === "production";
  const host = runnerUrl.hostname;

  const httpPermitted =
    isHttp && allowInsecureHttp && (isLoopbackHost(host) || (!isProduction && isPrivateHost(host)));

  // Credentials embedded in the URL would be sent with every request and
  // logged by proxies: the token travels in X-Auth-Token only.
  if (runnerUrl.username || runnerUrl.password) {
    if (!required) return null;
    throw new ApiError(503, "Code execution service is unavailable.", "EXECUTION_UNAVAILABLE");
  }

  if (!isHttps && !httpPermitted) {
    if (!required) return null;
    throw new ApiError(
      503,
      "Code execution service is unavailable.",
      "EXECUTION_UNAVAILABLE",
    );
  }

  return runnerUrl;
}

/** Parses a JSON body of at most maxBytes; larger bodies are an error. */
async function readJsonBounded(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("CodeBox response too large");
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("CodeBox response too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"));
}

export async function fetchCodeboxJson(url, options = {}) {
  const codeboxToken = process.env.CODEBOX_TOKEN;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs || 15_000,
  );
  // An external signal (e.g. a profiling job deadline) also aborts the request.
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener?.("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();

  // The end user this request runs for, as an opaque id: CodeBox enforces its
  // per-user cap, budget and priority across every backend instance (round 2).
  const tenant = currentJudgeSession()?.tenant;

  try {
    const response = await fetch(url, {
      ...options,
      redirect: "error",
      headers: {
        "X-Auth-Token": codeboxToken,
        ...(tenant ? { "X-Codebox-Tenant": tenant } : {}),
        ...options.headers,
      },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(
        500,
        "Code execution service authentication failed.",
        "EXECUTION_AUTH_FAILED",
      );
    }
    if (response.status === 429) {
      // Per-user limits enforced by CodeBox: the user's answer, not an outage
      // (never falls through to another execution path).
      const body = await readJsonBounded(response, 16 * 1024).catch(() => ({}));
      const retryAfterSeconds = Math.max(1, Number(body?.retryAfter) || Number(response.headers.get("retry-after")) || 5);
      if (body?.code === "TENANT_BUDGET_EXHAUSTED") {
        throw new ApiError(429, "You have used your code execution time for now. Please try again later.", "EXECUTION_BUDGET_EXHAUSTED", { retryAfterSeconds });
      }
      throw new ApiError(429, "You already have code running. Wait for it to finish before starting another run.", "JUDGE_USER_BUSY", { retryAfterSeconds });
    }
    if (!response.ok) {
      const statusErr = new ApiError(
        503,
        "Code execution service returned an error status.",
        "EXECUTION_UNAVAILABLE",
      );
      statusErr.httpStatus = response.status;
      throw statusErr;
    }
    return await readJsonBounded(response, readLimit("CODEBOX_MAX_RESPONSE_BYTES"));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(
      503,
      "Code execution service is unavailable.",
      "EXECUTION_UNAVAILABLE",
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener?.("abort", onExternalAbort);
  }
}
