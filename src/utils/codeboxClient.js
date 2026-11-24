// src/utils/codeboxClient.js
//
// Minimal HTTP client for the CodeBox execution service, shared by the
// execution controller and the complexity profiler.
import { ApiError } from "./ApiError.js";

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
  const host = runnerUrl.hostname.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";

  const httpPermitted = isHttp && allowInsecureHttp && (!isProduction || isLoopback);

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

  try {
    const response = await fetch(url, {
      ...options,
      redirect: "error",
      headers: {
        "X-Auth-Token": codeboxToken,
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
    if (!response.ok) {
      const statusErr = new ApiError(
        503,
        "Code execution service returned an error status.",
        "EXECUTION_UNAVAILABLE",
      );
      statusErr.httpStatus = response.status;
      throw statusErr;
    }
    return await response.json();
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
