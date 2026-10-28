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
app.use(
  cors({
    origin: process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL.split(",").map((u) => u.trim())
      : true,
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

app.use(express.static(path.join(__dirname, "../public")));
app.use("/", indexRouter);

app.use(errorHandler);

export default app;
