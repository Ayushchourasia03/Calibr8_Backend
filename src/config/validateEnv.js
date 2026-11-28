// src/config/validateEnv.js
//
// Startup validation of security-relevant configuration (SA-M3, SA-L3,
// SA-H3). Values of secrets are never printed, only names and problems.
//
//   fatal    refuses to start in production (logged as errors elsewhere):
//            settings that silently disable a security control.
//   error    logged at error level, never fatal: the affected feature fails
//            closed on its own (e.g. judging answers 503), and refusing to
//            start would also take down login and the catalog.
//   warning  logged once.
import jwt from "jsonwebtoken";
import { validateLimits } from "./limits.js";
import { isLoopbackHost, isPrivateHost } from "../utils/codeboxClient.js";

const DAY_SECONDS = 24 * 60 * 60;

function tokenLifetimeSeconds(expiresIn) {
  const value = /^\d+$/.test(String(expiresIn)) ? Number(expiresIn) : expiresIn;
  const token = jwt.sign({}, "lifetime-probe", { expiresIn: value, noTimestamp: false });
  const decoded = jwt.decode(token);
  return decoded.exp - decoded.iat;
}

export function validateEnvironment(env = process.env) {
  const fatal = [];
  const errors = [];
  const warnings = [];
  const production = env.NODE_ENV === "production";
  const prodFatal = (message) => (production ? fatal : errors).push(message);

  if (!env.NODE_ENV) {
    warnings.push("NODE_ENV is not set. Set NODE_ENV=production in production (proxy trust, HSTS, strict secrets and CodeBox TLS depend on it).");
  } else if (!["production", "development", "test"].includes(env.NODE_ENV)) {
    warnings.push(`NODE_ENV should be production, development or test.`);
  }

  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    prodFatal("NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate verification (CodeBox, GitHub). Remove it.");
  }

  const trustProxy = env.TRUST_PROXY?.trim();
  if (production && !trustProxy) {
    warnings.push("TRUST_PROXY is not set; assuming exactly 1 proxy hop. Set it to the real number of proxies in front of the API, or false if clients connect directly.");
  }
  if (production && trustProxy === "true") {
    fatal.push("TRUST_PROXY=true trusts every X-Forwarded-For entry, so any client can choose its own IP and bypass rate limits. Use the hop count instead.");
  }

  if (env.JWT_EXPIRES_IN) {
    try {
      const seconds = tokenLifetimeSeconds(env.JWT_EXPIRES_IN);
      if (!(seconds > 0)) throw new Error("not positive");
      if (production && seconds > 7 * DAY_SECONDS) {
        fatal.push("JWT_EXPIRES_IN is longer than 7 days. Access tokens live in browser storage; use 1d (refresh extends sessions up to SESSION_MAX_AGE_DAYS).");
      } else if (seconds > DAY_SECONDS) {
        warnings.push("JWT_EXPIRES_IN is longer than 1 day; prefer 1d or less.");
      }
    } catch {
      fatal.push("JWT_EXPIRES_IN is not a valid lifetime (e.g. 1d, 12h, 3600). Every login would fail.");
    }
  }

  if (env.CODEBOX_URL) {
    try {
      const url = new URL(env.CODEBOX_URL);
      if (url.username || url.password) errors.push("CODEBOX_URL must not contain credentials; the token goes in CODEBOX_TOKEN.");
      if (url.protocol === "http:") {
        const allowed =
          env.CODEBOX_ALLOW_INSECURE_HTTP === "true" &&
          (isLoopbackHost(url.hostname) || (!production && isPrivateHost(url.hostname)));
        if (!allowed) {
          errors.push(
            "CODEBOX_URL uses plain HTTP to a host that is not loopback" +
              (production ? "" : " or a private network") +
              " (or CODEBOX_ALLOW_INSECURE_HTTP is not true): judging will answer 503. Use https://.",
          );
        }
      } else if (url.protocol !== "https:") {
        errors.push("CODEBOX_URL must be an http(s) URL.");
      }
    } catch {
      errors.push("CODEBOX_URL is not a valid URL.");
    }
    if (production && String(env.CODEBOX_TOKEN || "").length < 32) {
      warnings.push("CODEBOX_TOKEN is shorter than 32 characters; use a long random token.");
    }
  }

  if (production && env.SERVE_API_CONSOLE === "true") {
    warnings.push("SERVE_API_CONSOLE=true serves the developer API console in production.");
  }

  for (const problem of validateLimits(env)) prodFatal(problem.message);

  return { fatal, errors, warnings };
}

/** Logs every problem; throws in production when a fatal problem exists. */
export function enforceEnvironment(env = process.env) {
  const { fatal, errors, warnings } = validateEnvironment(env);
  for (const message of warnings) console.warn(`⚠ [Config] ${message}`);
  for (const message of errors) console.error(`✖ [Config] ${message}`);
  if (fatal.length) {
    const text = fatal.map((m) => `  - ${m}`).join("\n");
    if (env.NODE_ENV === "production") {
      throw new Error(`[Config] Refusing to start with unsafe production settings:\n${text}`);
    }
    for (const message of fatal) console.error(`✖ [Config] ${message}`);
  }
  return { fatal, errors, warnings };
}
