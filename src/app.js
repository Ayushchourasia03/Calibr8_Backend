import "dotenv/config";
import express from "express";
import morgan from "morgan";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import indexRouter from "./routers/index.router.js";
import { errorHandler } from "./middlewares/error.middleware.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Behind a reverse proxy / load balancer (Cloud Run, Render, Nginx...) req.ip
// is the proxy's address unless we trust X-Forwarded-For. Without this every
// client shares one IP-based rate-limit bucket. TRUST_PROXY accepts a hop
// count, "true"/"false", or an Express trust-proxy string.
function resolveTrustProxy() {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw) return process.env.NODE_ENV === "production" ? 1 : false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}
app.set("trust proxy", resolveTrustProxy());

// 1. Security headers
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' https:; connect-src 'self' https:; frame-ancestors 'self' https://*.run.app https://*.google.com https://*.aistudio.google.com https://*.googleusercontent.com;",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
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
  ...(process.env.NODE_ENV === "production"
    ? []
    : ["http://localhost:5173", "http://127.0.0.1:5173"]),
];

app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, !origin || configuredOrigins.includes(origin));
    },
    credentials: true,
  }),
);

// 3. Body parsing
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// 4. Log failed requests only; never print request bodies such as submitted code.
morgan.token("path", (req) => req.path);
app.use(
  morgan(":method :path :status :response-time ms", {
    skip: (_req, res) => res.statusCode < 400,
  }),
);

app.use(express.static(path.join(__dirname, "../public"), { index: false }));
app.use("/", indexRouter);

app.use(errorHandler);

export default app;
