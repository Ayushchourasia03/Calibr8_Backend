import "dotenv/config";
import crypto from "crypto";
import express from "express";
import morgan from "morgan";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import indexRouter from "./routers/index.router.js";
import { errorHandler } from "./middlewares/error.middleware.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProduction = process.env.NODE_ENV === "production";
const app = express();
app.disable("x-powered-by");

// Behind a reverse proxy / load balancer (Cloud Run, Render, Nginx...) req.ip
// is the proxy's address unless we trust X-Forwarded-For. Without this every
// client shares one IP-based rate-limit bucket. TRUST_PROXY accepts a hop
// count, "true"/"false", or an Express trust-proxy string. It must equal the
// number of proxies in front of the app, or X-Forwarded-For can be spoofed.
function resolveTrustProxy() {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw) return isProduction ? 1 : false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}
app.set("trust proxy", resolveTrustProxy());

// 0. Request id: echoed in X-Request-Id and in error logs.
app.use((req, res, next) => {
  const incoming = req.get("x-request-id");
  req.id = incoming && /^[\w.:-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
});

// 1. Security headers
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' https:; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// 2. CORS
const configuredOrigins = [
  ...(process.env.FRONTEND_URL || "")
    .split(",")
    .map((origin) => {
      try {
        return new URL(origin.trim()).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean),
  ...(isProduction ? [] : ["http://localhost:5173", "http://127.0.0.1:5173"]),
];

app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, !origin || configuredOrigins.includes(origin));
    },
    credentials: true,
    exposedHeaders: ["X-Request-Id", "Retry-After"],
  }),
);

// 3. Body parsing
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// 4. Log failed requests only; never print request bodies such as submitted code.
morgan.token("path", (req) => req.path);
morgan.token("id", (req) => req.id);
app.use(
  morgan(":method :path :status :response-time ms :id", {
    skip: (_req, res) => res.statusCode < 400,
  }),
);

// The API explorer page is a development tool: not served in production
// unless explicitly enabled.
export const serveApiConsole = !isProduction || process.env.SERVE_API_CONSOLE === "true";
if (serveApiConsole) {
  app.use(express.static(path.join(__dirname, "../public"), { index: false }));
}
app.use("/", indexRouter);

app.use(errorHandler);

export default app;
